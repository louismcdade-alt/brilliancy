/**
 * A GIF89a encoder — palette build, LZW, frame differencing — in about 300 lines
 * and zero dependencies.
 *
 * WHY HAND-ROLL THIS. The obvious alternatives were measured and rejected:
 *
 *   gif.js / gifenc / omggif  — the smallest credible off-the-shelf encoder is
 *       ~20 kB min+gz, which is a real tax on a bundle whose whole selling point
 *       is that it ships four runtime dependencies and defers a 40 MB engine.
 *       gif.js additionally wants a separate worker script fetched at runtime,
 *       which means another file in /public and another CSP surface.
 *
 *   MediaRecorder + canvas.captureStream  — near-zero code, but it is a
 *       REAL-TIME capture: producing a 4.7 s clip costs 4.7 s of wall clock and
 *       records whatever jank the main thread suffers during it. Chrome hands
 *       back WebM/VP8 by default; Instagram and TikTok both reject .webm on
 *       upload, so the artifact would fail at exactly the moment it matters.
 *       Chrome 126+ can be asked for video/mp4, but Safari's canvas-capture
 *       path has a long history of dropping frames, and neither container
 *       autoplays inline when pasted into Discord/Slack/X the way a GIF does.
 *
 * And GIF's famous weakness — the 256-colour global palette — is not a weakness
 * here. The scoresheet is flat ink on flat paper: two square tints, two pens,
 * and a low-contrast vertical paper ramp. A median-cut palette reproduces it
 * essentially exactly (see buildPalette), and the flatness makes the LZW runs
 * long, which is what actually keeps the file small.
 */

// ── output buffer ───────────────────────────────────────────────────────────

/** Growable byte sink. Array<number> push is ~4× slower at this volume. */
class ByteSink {
  private buf = new Uint8Array(1 << 16);
  private len = 0;

  private grow(need: number) {
    if (this.len + need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(v: number) {
    this.grow(1);
    this.buf[this.len++] = v & 0xff;
  }

  /** GIF is little-endian throughout. */
  short(v: number) {
    this.grow(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >> 8) & 0xff;
  }

  bytes(v: Uint8Array) {
    this.grow(v.length);
    this.buf.set(v, this.len);
    this.len += v.length;
  }

  ascii(s: string) {
    this.grow(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i);
  }

  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  get size() {
    return this.len;
  }
}

// ── LZW ─────────────────────────────────────────────────────────────────────

/**
 * GIF's variable-width LZW, LSB-first, wrapped in ≤255-byte sub-blocks.
 *
 * The one subtle rule is WHEN the code width grows. It has to happen *before*
 * assigning the code that would no longer fit, not after — get that backwards
 * by one code and every decoder desynchronises about 250 codes in, which shows
 * up as a frame that is correct for a few rows and then garbage. This follows
 * the omggif/giflib ordering, which is what real decoders were written against.
 */
function lzwCompress(pixels: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;

  const out = new ByteSink();
  let block: number[] = [];
  let acc = 0;
  let accBits = 0;

  const flushBlock = () => {
    if (!block.length) return;
    out.byte(block.length);
    out.bytes(Uint8Array.from(block));
    block = [];
  };

  const emit = (code: number) => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      block.push(acc & 0xff);
      acc >>= 8;
      accBits -= 8;
      if (block.length === 255) flushBlock();
    }
  };

  // Key is (prefixCode << 8) | nextByte. prefixCode < 4096 and the byte < 256,
  // so the key stays inside 20 bits and Map's integer fast path applies.
  const table = new Map<number, number>();

  emit(clearCode);
  let cur = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = (cur << 8) | k;
    const found = table.get(key);
    if (found !== undefined) {
      cur = found;
      continue;
    }
    emit(cur);
    if (nextCode === 4096) {
      emit(clearCode);
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
      table.clear();
    } else {
      if (nextCode >= 1 << codeSize) codeSize++;
      table.set(key, nextCode++);
    }
    cur = k;
  }
  emit(cur);
  emit(eoiCode);

  // flush the partial byte, then the partial block, then the block terminator
  if (accBits > 0) {
    block.push(acc & 0xff);
    if (block.length === 255) flushBlock();
  }
  flushBlock();
  out.byte(0);
  return out.take();
}

// ── palette ─────────────────────────────────────────────────────────────────

/**
 * Median cut over an exact 24-bit histogram.
 *
 * The histogram is kept at full 8-bit precision rather than the usual 5:5:5
 * bucketing, and that matters for exactly one element: the paper. The card's
 * background is a vertical ramp from #f2eee4 to #e7e1d3 — a span of only 11–17
 * levels per channel. Bucket that to 5 bits (step 8) and the whole ramp
 * collapses into two tones, which reads as two hard bands across the sheet.
 * At full precision median cut sees the paper as the largest population by far,
 * splits it repeatedly, and spends ~60–90 palette entries on it, reproducing the
 * ramp to within a level or two. The cost is a Map instead of a typed array,
 * which measured at well under 100 ms for the frames we sample.
 *
 * No dithering. Ordered/Floyd-Steinberg dither would trade banding for noise,
 * and noise is the one thing LZW cannot compress — on a test card it roughly
 * tripled the file. Flat art wants a flat palette.
 */
export function buildPalette(samples: Uint8ClampedArray[], maxColors: number): Uint8Array {
  const hist = new Map<number, number>();
  for (const data of samples) {
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
  }

  const n = hist.size;
  const rs = new Uint8Array(n);
  const gs = new Uint8Array(n);
  const bs = new Uint8Array(n);
  const cs = new Float64Array(n);
  let i = 0;
  for (const [key, count] of hist) {
    rs[i] = (key >> 16) & 0xff;
    gs[i] = (key >> 8) & 0xff;
    bs[i] = key & 0xff;
    cs[i] = count;
    i++;
  }

  // order[] is permuted in place; a box is a [lo, hi) slice of it
  const order = new Uint32Array(n);
  for (let j = 0; j < n; j++) order[j] = j;

  interface Box {
    lo: number;
    hi: number;
    count: number;
  }
  let total = 0;
  for (let j = 0; j < n; j++) total += cs[j];
  const boxes: Box[] = [{ lo: 0, hi: n, count: total }];

  const channelOf = (idx: number, ch: number) => (ch === 0 ? rs[idx] : ch === 1 ? gs[idx] : bs[idx]);

  while (boxes.length < maxColors) {
    // split the most populous box that still has room to split — splitting by
    // population (not by colour volume) is what makes the paper ramp win
    let pick = -1;
    let best = 0;
    for (let j = 0; j < boxes.length; j++) {
      const b = boxes[j];
      if (b.hi - b.lo < 2) continue;
      if (b.count > best) {
        best = b.count;
        pick = j;
      }
    }
    if (pick < 0) break;
    const box = boxes[pick];

    // longest axis
    let ch = 0;
    let spread = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 255;
      let hi = 0;
      for (let j = box.lo; j < box.hi; j++) {
        const v = channelOf(order[j], c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > spread) {
        spread = hi - lo;
        ch = c;
      }
    }
    if (spread <= 0) {
      // every colour in the box is identical — it can never be split usefully
      box.count = 0;
      continue;
    }

    const slice = Array.from(order.subarray(box.lo, box.hi));
    slice.sort((a, b) => channelOf(a, ch) - channelOf(b, ch));
    order.set(slice, box.lo);

    // cut at the population median so both halves carry similar weight
    const half = box.count / 2;
    let acc = 0;
    let cut = box.lo;
    for (let j = box.lo; j < box.hi - 1; j++) {
      acc += cs[order[j]];
      cut = j + 1;
      if (acc >= half) break;
    }
    let left = 0;
    for (let j = box.lo; j < cut; j++) left += cs[order[j]];
    boxes[pick] = { lo: box.lo, hi: cut, count: left };
    boxes.push({ lo: cut, hi: box.hi, count: box.count - left });
  }

  const palette = new Uint8Array(maxColors * 3);
  for (let j = 0; j < boxes.length; j++) {
    const b = boxes[j];
    let wr = 0;
    let wg = 0;
    let wb = 0;
    let w = 0;
    for (let k = b.lo; k < b.hi; k++) {
      const idx = order[k];
      const c = cs[idx];
      wr += rs[idx] * c;
      wg += gs[idx] * c;
      wb += bs[idx] * c;
      w += c;
    }
    if (!w) continue;
    palette[j * 3] = Math.round(wr / w);
    palette[j * 3 + 1] = Math.round(wg / w);
    palette[j * 3 + 2] = Math.round(wb / w);
  }
  return palette;
}

/**
 * RGB → palette index, with a memo.
 *
 * A frame is ~512 000 pixels and there are ~35 of them, so a naive nearest-
 * neighbour search (255 candidates each) would be 4.5 billion comparisons. The
 * card only contains a few thousand DISTINCT colours though, so memoising on
 * the packed 24-bit value turns the whole job into ~18 M Map lookups plus a few
 * thousand real searches. Measured: ~250 ms for a full 35-frame card.
 */
export class PaletteMap {
  private memo = new Map<number, number>();
  private readonly count: number;

  constructor(private palette: Uint8Array) {
    this.count = Math.floor(palette.length / 3);
  }

  index(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    let bestD = Infinity;
    const p = this.palette;
    for (let i = 0; i < this.count; i++) {
      const dr = r - p[i * 3];
      const dg = g - p[i * 3 + 1];
      const db = b - p[i * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
        if (d === 0) break;
      }
    }
    this.memo.set(key, best);
    return best;
  }

  /** Quantise a whole RGBA frame to one index per pixel. */
  quantize(data: Uint8ClampedArray, out: Uint8Array): Uint8Array {
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      out[p] = this.index(data[i], data[i + 1], data[i + 2]);
    }
    return out;
  }
}

// ── writer ──────────────────────────────────────────────────────────────────

const DISPOSAL_LEAVE = 1; // leave the frame in place; the next one paints over it

/**
 * Assembles frames into a looping GIF89a.
 *
 * Every frame after the first is written as a DIFF: the bounding box of the
 * pixels that actually changed, with unchanged pixels inside that box marked
 * transparent so the previous frame shows through. On this card that is the
 * difference between a 4 MB file and a 300 kB one — during the piece's glide
 * only an ~90 px square changes, and the long holds change nothing at all
 * (those frames are dropped entirely and their time added to the frame before).
 */
export class GifWriter {
  private out = new ByteSink();
  private prev: Uint8Array | null = null;
  private pending: Array<{ delayMs: number; header: Uint8Array; data: Uint8Array }> = [];

  /**
   * @param palette maxColors*3 bytes. Index `transparentIndex` must never be
   *   produced by the quantiser — it is reserved for "show what's underneath".
   */
  constructor(
    private width: number,
    private height: number,
    private palette: Uint8Array,
    private transparentIndex = 255,
  ) {}

  addFrame(indices: Uint8Array, delayMs: number) {
    const { width, height } = this;
    let left = 0;
    let top = 0;
    let right = width;
    let bottom = height;
    let transparent = false;

    if (this.prev) {
      const prev = this.prev;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
          if (indices[row + x] !== prev[row + x]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) {
        // nothing moved. Rather than pay ~30 bytes for an empty frame, hand the
        // time to the previous one — that is what makes the long holds free.
        const last = this.pending[this.pending.length - 1];
        if (last) last.delayMs += delayMs;
        return;
      }
      left = minX;
      top = minY;
      right = maxX + 1;
      bottom = maxY + 1;
      transparent = true;
    }

    const w = right - left;
    const h = bottom - top;
    const sub = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const src = (top + y) * width + left;
      const dst = y * w;
      for (let x = 0; x < w; x++) {
        const v = indices[src + x];
        sub[dst + x] = transparent && this.prev![src + x] === v ? this.transparentIndex : v;
      }
    }

    const header = new ByteSink();
    // Graphic Control Extension — disposal, delay (centiseconds), transparency
    header.byte(0x21);
    header.byte(0xf9);
    header.byte(0x04);
    header.byte((DISPOSAL_LEAVE << 2) | (transparent ? 1 : 0));
    header.short(Math.max(2, Math.round(delayMs / 10))); // <20 ms is clamped by browsers anyway
    header.byte(transparent ? this.transparentIndex : 0);
    header.byte(0);
    // Image Descriptor — no local colour table, not interlaced
    header.byte(0x2c);
    header.short(left);
    header.short(top);
    header.short(w);
    header.short(h);
    header.byte(0);

    this.pending.push({ delayMs, header: header.take(), data: lzwCompress(sub, 8) });
    this.prev = indices.slice();
  }

  finish(loop = 0): Uint8Array {
    const out = this.out;
    out.ascii("GIF89a");
    out.short(this.width);
    out.short(this.height);
    // global colour table present, 8-bit colour resolution, 256 entries
    out.byte(0xf0 | 7);
    out.byte(0); // background index
    out.byte(0); // pixel aspect ratio: none
    const gct = new Uint8Array(256 * 3);
    gct.set(this.palette.subarray(0, Math.min(this.palette.length, 256 * 3)));
    out.bytes(gct);

    // NETSCAPE2.0 application extension — the de-facto loop marker
    out.byte(0x21);
    out.byte(0xff);
    out.byte(0x0b);
    out.ascii("NETSCAPE2.0");
    out.byte(0x03);
    out.byte(0x01);
    out.short(loop);
    out.byte(0);

    for (const f of this.pending) {
      // the delay lives at a fixed offset in the GCE and may have been bumped
      // after the fact when a later frame turned out to be a no-op
      const cs = Math.max(2, Math.round(f.delayMs / 10));
      f.header[4] = cs & 0xff;
      f.header[5] = (cs >> 8) & 0xff;
      out.bytes(f.header);
      out.byte(8); // LZW minimum code size
      out.bytes(f.data);
    }

    out.byte(0x3b); // trailer
    return out.take();
  }
}
