import type { Brilliancy } from "../types";
import type { Stage } from "./cardScene";
import { bakePieces, drawCard, loadPieces, W, waitForFonts } from "./cardScene";
import { buildPalette, GifWriter, PaletteMap } from "./gif";
import { cardFileStem, deliver } from "./shareImage";

/**
 * The animated version of the share card: the position holds, the piece moves,
 * the move gets written down, the `!!` and the red circle land, and the
 * annotator's verdict is written along the foot. Then it loops.
 *
 * ── Why GIF ────────────────────────────────────────────────────────────────
 *
 * The backlog said "animated GIF" and the alternatives were tested rather than
 * assumed. On Chrome 2026, `MediaRecorder.isTypeSupported` returns true for
 * video/mp4 as well as WebM, so the two-line `captureStream()` route genuinely
 * works — but recording a 2.9 s animation in a backgrounded tab took **35
 * seconds of wall clock** and produced a file whose frame timing was whatever
 * the throttled scheduler handed out. MediaRecorder is a real-time capture: it
 * cannot go faster than the clip, it cannot go slower without the clip being
 * wrong, and it records the jank. On a phone that has just pulled down a 40 MB
 * engine that is not a trade worth making. The encoder below is deterministic —
 * it renders 33 frames as fast as the device can and the output is identical
 * every time.
 *
 * GIF also wins on where the artifact can go. WebM is rejected outright by both
 * Instagram and TikTok's upload flows; MP4 works there but does not autoplay
 * inline when pasted into Discord, Slack, X or iMessage, which is where a
 * "look at this move" actually gets pasted. `navigator.canShare` accepts
 * image/gif (verified in-browser), so the native share sheet path is unchanged.
 *
 * The usual objection to GIF — 256 colours — is not a cost here. The scoresheet
 * is deliberately flat: two square tints, two pens, ink on paper, no glows and
 * no gradients beyond one very low-contrast paper ramp. See buildPalette in
 * gif.ts for how that ramp is preserved.
 *
 * ── Cost ───────────────────────────────────────────────────────────────────
 *
 * 640×800 rather than the still card's 1080×1350. Frame area is what everything
 * downstream scales with, and 640 wide is past the point where a social client
 * shows a GIF any bigger. Every frame after the first is written as a bounding
 * box of what actually changed, so the long holds cost nothing and the glide
 * costs an ~90 px square.
 */

const GIF_W = 640;
const GIF_H = 800; // 4:5, same crop as the still card
const SCALE = GIF_W / W;

/** One rendered frame and how long it sits on screen. */
interface Beat {
  stage: Stage;
  delayMs: number;
}

/**
 * The shape of the loop.
 *
 * Roughly 4.6 s, which is the window where a looping clip reads as deliberate
 * rather than as a stutter. The proportions matter more than the total: a long
 * opening hold so the eye can take in the position before anything moves, a
 * fast glide, then the annotation landing in three separate beats — mark, then
 * circle, then verdict — because they are three different claims and running
 * them together makes the card look like it simply appeared.
 *
 * Frame counts are chosen against the delays, not the other way round. GIF
 * delays are centiseconds and browsers clamp anything under 20 ms up to 100 ms,
 * so 60 ms (≈16 fps) is the fastest step that is safe to rely on.
 */
function timeline(b: Brilliancy): Beat[] {
  const beats: Beat[] = [];
  const cur: Stage = { travel: 0, box: 0, arrow: 0, san: 0, bang: 0, ink: 0, why: 0 };
  const push = (delayMs: number) => beats.push({ stage: { ...cur }, delayMs });

  push(900); // the position, alone, before anything is claimed about it

  for (let i = 1; i <= 8; i++) {
    cur.travel = i / 8;
    cur.san = i / 8;
    push(80);
  }
  for (let i = 1; i <= 4; i++) {
    cur.box = i / 4;
    cur.arrow = i / 4;
    push(80);
  }
  for (let i = 1; i <= 2; i++) {
    cur.bang = i / 2;
    push(100);
  }

  // The red circle only exists when the sacrificed man is somewhere other than
  // the destination square — which is the minority of brilliancies, since most
  // of them hang the piece they just moved. When there is nothing to circle the
  // beat is skipped and its time is given to the final rest, rather than
  // holding on a frame where nothing is happening.
  const hasInk = !!b.sacSquare && b.sacSquare !== b.to;
  if (hasInk) {
    for (let i = 1; i <= 10; i++) {
      cur.ink = i / 10;
      push(60);
    }
  } else {
    cur.ink = 1;
  }

  for (let i = 1; i <= 8; i++) {
    cur.why = i / 8;
    push(60);
  }

  // The rest at the end is what makes it a card and not a jitter. It encodes to
  // nothing: the stage is unchanged, so GifWriter drops the frame and hands the
  // time to the one before it.
  push(hasInk ? 1500 : 2000);
  return beats;
}

export interface GifProgress {
  /** 0→1 across the whole encode. */
  (fraction: number): void;
}

/**
 * Render the animated card. `onProgress` is called between frames; the encoder
 * yields to the event loop at the same points, which is what keeps the page
 * responsive without a worker.
 *
 * A worker WAS considered — CSP already allows `worker-src 'self' blob:` — but
 * it would need OffscreenCanvas plus the brand fonts re-registered inside the
 * worker (FontFace in a worker scope is still uneven on mobile Safari), and the
 * measured main-thread cost per frame is ~25 ms. Yielding between frames keeps
 * every busy stretch under a rendered frame's budget, which is enough: the
 * spinner keeps spinning and scrolling never locks.
 */
export async function renderBrilliancyGif(
  b: Brilliancy,
  username: string,
  onProgress?: GifProgress,
): Promise<Blob> {
  await waitForFonts();
  const images = bakePieces(await loadPieces([b.fenBefore, b.fenAfter]), SCALE);

  const canvas = document.createElement("canvas");
  canvas.width = GIF_W;
  canvas.height = GIF_H;
  // getImageData is called once per frame, which is exactly the access pattern
  // this hint exists for — without it Chrome keeps the canvas GPU-side and each
  // read costs a full readback.
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.scale(SCALE, SCALE);

  const beats = timeline(b);
  const render = (stage: Stage) => {
    drawCard(ctx, b, username, { stage, images, inkStyle: "hand" });
    return ctx.getImageData(0, 0, GIF_W, GIF_H).data;
  };

  // ── pass one: the palette ────────────────────────────────────────────────
  // Building the histogram from every frame would mean either keeping 33 × 2 MB
  // of pixels alive or rendering everything twice. Four frames covers the whole
  // colour story: the bare position (paper, both square tints, both piece
  // colours), two points mid-glide (a man antialiased over each square tint and
  // over another man), and the finished card (pen, red, every annotation). Any
  // colour those miss lands on its nearest neighbour, which for an antialiased
  // edge is the neighbouring shade of the same edge.
  const sampleAt = [0, 4, 7, beats.length - 1];
  const samples: Uint8ClampedArray[] = [];
  for (const i of sampleAt) {
    samples.push(new Uint8ClampedArray(render(beats[i].stage)));
    await yieldToPage();
  }
  // 255, not 256: index 255 is reserved so diff frames can say "unchanged".
  const palette = buildPalette(samples, 255);
  samples.length = 0;
  const mapper = new PaletteMap(palette);

  // ── pass two: quantise and encode ────────────────────────────────────────
  const writer = new GifWriter(GIF_W, GIF_H, palette, 255);
  const indices = new Uint8Array(GIF_W * GIF_H);
  for (let i = 0; i < beats.length; i++) {
    mapper.quantize(render(beats[i].stage), indices);
    writer.addFrame(indices, beats[i].delayMs);
    onProgress?.((i + 1) / beats.length);
    await yieldToPage();
  }

  const bytes = writer.finish();
  // finish() returns a freshly sliced array, so its buffer is exactly the file
  // and handing the ArrayBuffer straight over avoids another copy. The cast is
  // only to satisfy TS 5.7's ArrayBufferLike/ArrayBuffer split on typed arrays.
  return new Blob([bytes.buffer as ArrayBuffer], { type: "image/gif" });
}

/**
 * Hand the main thread back between frames.
 *
 * Neither of the obvious primitives survives the case that matters. rAF stops
 * firing entirely in a backgrounded tab, and setTimeout(0) is clamped to ~1 s
 * there — measured: the same encode that takes 1.1 s in a foreground tab took
 * 21 s with the tab in the background, purely in timer clamp. That is not a
 * hypothetical: the whole point of this button is that you tap it and then
 * switch to Instagram, which backgrounds the tab immediately.
 *
 * A MessageChannel round-trip is a macrotask like setTimeout — it lets rendering,
 * input and the progress repaint in — but it is not throttled. It is the same
 * trick React's scheduler uses, for the same reason.
 */
const yieldWaiters: Array<() => void> = [];
const yieldChannel = typeof MessageChannel === "function" ? new MessageChannel() : null;
if (yieldChannel) {
  yieldChannel.port1.onmessage = () => yieldWaiters.shift()?.();
  yieldChannel.port1.start();
}

function yieldToPage(): Promise<void> {
  if (!yieldChannel) return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    yieldWaiters.push(resolve);
    yieldChannel.port2.postMessage(0);
  });
}

/**
 * Render and hand off the animated card — native share sheet where available,
 * download everywhere else. Same delivery path as the still PNG.
 */
export async function shareBrilliancyGif(
  b: Brilliancy,
  username: string,
  onProgress?: GifProgress,
): Promise<"shared" | "downloaded"> {
  const blob = await renderBrilliancyGif(b, username, onProgress);
  return deliver(
    blob,
    `${cardFileStem(b, username)}.gif`,
    "image/gif",
    `${b.san}!! — a sound sacrifice found by Brilliancy`,
  );
}
