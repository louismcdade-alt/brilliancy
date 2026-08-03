import type { Brilliancy } from "../types";
import { formatEval, sacrificeLabel, timeClassLabel, whyLabel } from "./format";

/**
 * The share card, drawn as a function of TIME rather than as a fixed picture.
 *
 * This used to live inline in shareImage.ts as one long procedure. It was pulled
 * out and parameterised by a `Stage` so the still PNG and the animated GIF are
 * literally the same drawing code — the card is one artifact, and the clip is
 * that artifact being filled in. Every animated element is written so that its
 * stage value of exactly 1 takes the ORIGINAL code path verbatim, which is what
 * guarantees the PNG did not change a pixel when this refactor landed. (The PNG
 * asks for `STILL_STAGE`, which is every field at 1 except `travel`, because the
 * still card has always shown the position BEFORE the move with an arrow, not
 * the position after.)
 *
 * Everything is drawn on canvas with same-origin assets only: no SVG strings
 * rasterised through data: URLs, no remote images. That is load-bearing — one
 * cross-origin pixel taints the canvas and `toBlob`/`getImageData` start
 * throwing SecurityError, which would kill both the PNG and the GIF.
 *
 * Palette mirrors the CSS tokens in src/index.css (canvas can't read CSS vars).
 */

export const W = 1080;
export const H = 1350;
const PAD = 72; // left/right margin for text
const BOARD = 900; // board edge length
const BOARD_X = (W - BOARD) / 2; // 90 — board horizontally centered
const CELL = BOARD / 8; // 112.5
const BOARD_Y = 232;
const BOARD_BOTTOM = BOARD_Y + BOARD; // 1132

/**
 * The card is a torn-off sheet, so it uses the same two pens as the site: the
 * move is written in ballpoint, and red is spent only on the mark.
 */
const C = {
  bgTop: "#f2eee4",
  bgBot: "#e7e1d3",
  line: "#c8d4d9",
  rule: "#9fb6c0",
  textHi: "#22201c",
  text: "#3c382f",
  dim: "#6b6558",
  bril: "#23407e", // ballpoint — the written voice
  brilDeep: "#23407e",
  brilWash: "rgba(35,64,126,0.14)",
  mark: "#bc2e24", // red pen — the !! only
  sqLight: "#efe9db",
  sqDark: "#b6c5cb",
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
export type Orientation = "white" | "black";

/**
 * How far through each beat of the card we are. Each field is 0→1 and each one
 * is independent, so the timeline in shareGif.ts can overlap them freely.
 */
export interface Stage {
  /** The moving piece travelling from `from` to `to`. 0 = it hasn't left. */
  travel: number;
  /** The dashed pen box round the destination square, snapping in. */
  box: number;
  /** Fraction of the pen arrow's shaft drawn, tail to head. */
  arrow: number;
  /** The SAN being written into the MOVE field, left to right. */
  san: number;
  /** The red `!!` landing — header and board together. */
  bang: number;
  /** Fraction of the red ink ellipse traced round the sacrificed piece. */
  ink: number;
  /** The annotator's why-line at the foot, revealed left to right. */
  why: number;
}

/**
 * What the still PNG asks for. `travel: 0` is not an oversight — the still card
 * has always shown the position before the move, with the arrow saying where
 * the piece is going. The clip is the thing that gets to play it.
 */
export const STILL_STAGE: Stage = {
  travel: 0,
  box: 1,
  arrow: 1,
  san: 1,
  bang: 1,
  ink: 1,
  why: 1,
};

export interface Piece {
  type: string;
  color: "w" | "b";
}

export function parseFen(fen: string): Map<string, Piece> {
  const map = new Map<string, Piece>();
  fen.split(" ")[0].split("/").forEach((rankStr, ri) => {
    const rank = 8 - ri;
    let file = 0;
    for (const ch of rankStr) {
      if (/\d/.test(ch)) file += parseInt(ch, 10);
      else {
        const color = ch === ch.toUpperCase() ? "w" : "b";
        map.set(`${FILES[file]}${rank}`, { type: ch.toLowerCase(), color });
        file += 1;
      }
    }
  });
  return map;
}

/** Top-left pixel of a square's cell, respecting orientation. */
function cellXY(square: string, orientation: Orientation) {
  const fileIdx = FILES.indexOf(square[0]);
  const rankIdx = parseInt(square[1], 10) - 1;
  const col = orientation === "white" ? fileIdx : 7 - fileIdx;
  const row = orientation === "white" ? 7 - rankIdx : rankIdx;
  return { x: BOARD_X + col * CELL, y: BOARD_Y + row * CELL };
}

function centerOf(square: string, orientation: Orientation) {
  const { x, y } = cellXY(square, orientation);
  return { x: x + CELL / 2, y: y + CELL / 2 };
}

const PIECE_LETTER: Record<string, string> = { k: "K", q: "Q", r: "R", b: "B", n: "N", p: "P" };
const pieceCache = new Map<string, HTMLImageElement>();

export function pieceKey(color: "w" | "b", type: string): string {
  return `${color}${PIECE_LETTER[type]}`;
}

function loadPiece(color: "w" | "b", type: string): Promise<HTMLImageElement> {
  const src = `/pieces/${pieceKey(color, type)}.svg`;
  const cached = pieceCache.get(src);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      pieceCache.set(src, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`piece ${src} failed to load`));
    img.src = src;
  });
}

/** Every piece image the two positions need, keyed "wN" / "bQ" / … */
export async function loadPieces(fens: string[]): Promise<Map<string, CanvasImageSource>> {
  const need = new Map<string, Piece>();
  for (const fen of fens) for (const p of parseFen(fen).values()) need.set(pieceKey(p.color, p.type), p);
  const out = new Map<string, CanvasImageSource>();
  await Promise.all(
    [...need.entries()].map(async ([key, p]) => {
      try {
        out.set(key, await loadPiece(p.color, p.type));
      } catch {
        /* a missing piece file is survivable — the square just draws empty */
      }
    }),
  );
  return out;
}

/**
 * Bake the piece SVGs into bitmaps at the exact size they'll be blitted at.
 *
 * Only the GIF path uses this. Drawing an <img> backed by an SVG re-runs the
 * rasteriser on every drawImage, and the clip draws ~32 pieces × ~35 frames.
 * Measured on this card that was the single biggest cost in the render loop;
 * pre-baking took the per-frame draw from ~34 ms to ~7 ms. The still PNG keeps
 * drawing the SVGs directly, because it draws each one exactly once and a
 * bitmap round-trip could only lose it quality.
 */
export function bakePieces(
  images: Map<string, CanvasImageSource>,
  scale: number,
): Map<string, CanvasImageSource> {
  const size = Math.ceil(CELL * scale);
  const out = new Map<string, CanvasImageSource>();
  for (const [key, img] of images) {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d");
    if (!g) continue;
    g.drawImage(img, 0, 0, size, size);
    out.set(key, c);
  }
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => v * v * (3 - 2 * v);

function moveLabel(b: Brilliancy): string {
  return b.game.userColor === "w" ? `${b.moveNumber}.` : `${b.moveNumber}…`;
}

/**
 * The red pen coming back round past where it started.
 *
 * This is the site's signature mark — the same overshoot the InkCircle SVG in
 * BoardViewer draws round a move in the movelist. A perfect `ctx.ellipse` reads
 * as a rounded rectangle drawn by a machine; what makes it read as a pen is
 * (a) the radius wobbling as the hand goes round and (b) the stroke continuing
 * past its own start for a fifth of a turn, slightly wide of it. Returning
 * POINTS rather than stroking directly is deliberate: it lets the clip draw only
 * the first `fraction` of the path, so the circle draws itself.
 */
function inkEllipsePoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  tilt: number,
  fraction: number,
): Array<{ x: number; y: number }> {
  const turns = 1.19; // one lap plus the overshoot
  const steps = 96;
  const last = Math.max(1, Math.round(steps * clamp01(fraction)));
  const pts: Array<{ x: number; y: number }> = [];
  const start = -0.55; // start the stroke at roughly 10 o'clock, as a hand would
  for (let i = 0; i <= last; i++) {
    const a = start + (i / steps) * turns * Math.PI * 2;
    const t = i / steps;
    // wobble: two low harmonics, plus a slow outward drift so the overshoot
    // passes OUTSIDE where it began instead of retracing it
    const wob = 1 + 0.045 * Math.sin(a * 3 + 0.7) - 0.028 * Math.cos(a * 2 - 0.3) + 0.075 * t;
    const ex = Math.cos(a) * rx * wob;
    const ey = Math.sin(a) * ry * wob;
    pts.push({
      x: cx + ex * Math.cos(tilt) - ey * Math.sin(tilt),
      y: cy + ex * Math.sin(tilt) + ey * Math.cos(tilt),
    });
  }
  return pts;
}

function strokePoints(ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

/** Draw the arrow from→to on the board, in pen, with a filled head. */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  b: Brilliancy,
  orientation: Orientation,
  progress: number,
) {
  if (progress <= 0) return;
  const a = centerOf(b.from, orientation);
  const z = centerOf(b.to, orientation);
  const dx = z.x - a.x;
  const dy = z.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const head = CELL * 0.42;
  const start = { x: a.x + ux * CELL * 0.32, y: a.y + uy * CELL * 0.32 };
  const tip = { x: z.x - ux * CELL * 0.18, y: z.y - uy * CELL * 0.18 };
  const base = { x: tip.x - ux * head, y: tip.y - uy * head };

  ctx.strokeStyle = C.bril;
  ctx.fillStyle = C.bril;
  ctx.lineWidth = CELL * 0.17;
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  if (progress >= 1) {
    ctx.lineTo(base.x, base.y);
  } else {
    // the shaft grows out of the origin square, the way a pen lays it down
    ctx.lineTo(start.x + (base.x - start.x) * progress, start.y + (base.y - start.y) * progress);
  }
  ctx.stroke();

  // the head only lands once the shaft has nearly arrived — an arrowhead
  // leading a growing line looks like a cursor, not a pen stroke
  const headAlpha = progress >= 1 ? 1 : clamp01((progress - 0.75) / 0.25);
  if (headAlpha > 0) {
    ctx.globalAlpha = 0.95 * headAlpha;
    const px = -uy;
    const py = ux;
    const hw = head * 0.62;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(base.x + px * hw, base.y + py * hw);
    ctx.lineTo(base.x - px * hw, base.y - py * hw);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPieceAt(
  ctx: CanvasRenderingContext2D,
  images: Map<string, CanvasImageSource>,
  piece: Piece,
  x: number,
  y: number,
  alpha = 1,
) {
  if (alpha <= 0) return;
  const img = images.get(pieceKey(piece.color, piece.type));
  if (!img) return;
  const inset = CELL * 0.06;
  if (alpha < 1) ctx.globalAlpha = alpha;
  ctx.drawImage(img, x + inset, y + inset, CELL - inset * 2, CELL - inset * 2);
  if (alpha < 1) ctx.globalAlpha = 1;
}

/**
 * Lay out the men for a given point in the move.
 *
 * Rather than special-casing captures, castling and promotion, this diffs the
 * two FENs the detector already gives us. Anything that leaves a square between
 * `fenBefore` and `fenAfter` fades out (the captured man, including an en
 * passant pawn that isn't on the destination square, and a castling rook's
 * origin); anything that appears fades in (the rook's new square). The piece on
 * `from` is the traveller and slides. At travel === 0 this reduces exactly to
 * fenBefore, which is what keeps the still PNG unchanged.
 */
function drawMen(
  ctx: CanvasRenderingContext2D,
  b: Brilliancy,
  orientation: Orientation,
  images: Map<string, CanvasImageSource>,
  travel: number,
) {
  const before = parseFen(b.fenBefore);
  const after = parseFen(b.fenAfter);
  const same = (a: Piece | undefined, c: Piece | undefined) =>
    !!a && !!c && a.type === c.type && a.color === c.color;

  const leaving = 1 - clamp01((travel - 0.45) / 0.3);
  const arriving = clamp01((travel - 0.7) / 0.3);

  for (const [sq, p] of before) {
    if (sq === b.from) continue; // the traveller, drawn last so it passes over
    if (sq === b.to) continue; // captured man, handled below with the traveller
    const alpha = same(p, after.get(sq)) ? 1 : leaving;
    const { x, y } = cellXY(sq, orientation);
    drawPieceAt(ctx, images, p, x, y, alpha);
  }

  // a man standing on the destination square is about to be taken
  const victim = before.get(b.to);
  if (victim) {
    const { x, y } = cellXY(b.to, orientation);
    drawPieceAt(ctx, images, victim, x, y, leaving);
  }

  for (const [sq, p] of after) {
    if (sq === b.to || sq === b.from) continue;
    if (same(p, before.get(sq))) continue;
    const { x, y } = cellXY(sq, orientation);
    drawPieceAt(ctx, images, p, x, y, arriving);
  }

  // the traveller. Past 85% it swaps to whatever is on the destination square
  // in fenAfter, which is how a promotion resolves without extra machinery.
  const mover = (travel >= 0.85 ? after.get(b.to) : undefined) ?? before.get(b.from);
  if (mover) {
    const a = cellXY(b.from, orientation);
    const z = cellXY(b.to, orientation);
    const t = smooth(clamp01(travel));
    drawPieceAt(ctx, images, mover, a.x + (z.x - a.x) * t, a.y + (z.y - a.y) * t);
  }
}

export interface DrawOptions {
  stage: Stage;
  /** Piece bitmaps keyed "wN"/"bQ"; see loadPieces / bakePieces. */
  images: Map<string, CanvasImageSource>;
  /**
   * The still card marks the sacrificed piece with a plain ellipse, and that is
   * left exactly as it shipped. The clip uses the hand-drawn overshoot instead,
   * because a circle that draws itself is the whole reason to animate this card.
   * Flip the still to "hand" if you want the two to match perfectly.
   */
  inkStyle: "plain" | "hand";
}

/**
 * Draw the whole card into `ctx`, which must already be scaled so that the
 * logical 1080×1350 co-ordinate space maps onto the target surface.
 */
export function drawCard(
  ctx: CanvasRenderingContext2D,
  b: Brilliancy,
  username: string,
  { stage, images, inkStyle }: DrawOptions,
) {
  const orientation: Orientation = b.game.userColor === "w" ? "white" : "black";

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, C.bgTop);
  bg.addColorStop(1, C.bgBot);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const display = '"Newsreader", Georgia, serif';
  const mono = '"JetBrains Mono", ui-monospace, monospace';

  // ── printed head of the form ────────────────────────────────────────────
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.textHi;
  ctx.font = `600 30px ${display}`;
  ctx.fillText("B R I L L I A N C Y", PAD, 104);
  ctx.fillStyle = C.dim;
  ctx.font = `400 22px ${display}`;
  ctx.textAlign = "right";
  ctx.fillText("F O R   C H E S S . C O M", W - PAD, 104);
  ctx.textAlign = "left";
  ctx.fillStyle = C.textHi;
  ctx.fillRect(PAD, 122, W - PAD * 2, 3);

  // the move, written in pen, with the mark beside it in red
  ctx.fillStyle = C.dim;
  ctx.font = `600 22px ${display}`;
  ctx.fillText("M O V E", PAD, 178);
  ctx.fillStyle = C.bril;
  ctx.font = `600 56px ${mono}`;
  const moveText = `${moveLabel(b)} ${b.san}`;
  const mw = ctx.measureText(moveText).width;
  if (stage.san >= 1) {
    ctx.fillText(moveText, PAD, 228);
  } else if (stage.san > 0) {
    // clipped left-to-right: the scribe writing the move as it is played
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD - 4, 178, mw * stage.san + 6, 66);
    ctx.clip();
    ctx.fillText(moveText, PAD, 228);
    ctx.restore();
  }
  if (stage.bang >= 1) {
    ctx.fillStyle = C.mark;
    ctx.font = `bold italic 56px ${display}`;
    ctx.fillText("!!", PAD + mw + 18, 226);
  } else if (stage.bang > 0) {
    // the mark is stamped, not faded in — it overshoots its size and settles
    ctx.save();
    const k = stage.bang;
    ctx.globalAlpha = k;
    ctx.translate(PAD + mw + 18, 226);
    ctx.scale(1 + (1 - k) * 0.5, 1 + (1 - k) * 0.5);
    ctx.rotate((1 - k) * 0.16);
    ctx.fillStyle = C.mark;
    ctx.font = `bold italic 56px ${display}`;
    ctx.fillText("!!", 0, 0);
    ctx.restore();
  }

  // ── board ───────────────────────────────────────────────────────────────
  for (const sq of allSquares()) {
    const { x, y } = cellXY(sq, orientation);
    const fileIdx = FILES.indexOf(sq[0]);
    const rank = parseInt(sq[1], 10);
    const light = (fileIdx + rank) % 2 === 1;
    ctx.fillStyle = light ? C.sqLight : C.sqDark;
    ctx.fillRect(x, y, CELL + 0.5, CELL + 0.5);
  }

  // the square moved to: pen, dashed, the way you'd box it on a diagram
  if (stage.box > 0) {
    const { x, y } = cellXY(b.to, orientation);
    ctx.strokeStyle = C.bril;
    ctx.lineWidth = 4;
    ctx.setLineDash([12, 8]);
    if (stage.box >= 1) {
      ctx.strokeRect(x + 8, y + 8, CELL - 16, CELL - 16);
    } else {
      // snaps inward onto the square rather than fading — a box you draw round
      // something arrives, it doesn't materialise
      const inset = 8 + (1 - stage.box) * 22;
      ctx.globalAlpha = stage.box;
      ctx.strokeRect(x + inset, y + inset, CELL - inset * 2, CELL - inset * 2);
      ctx.globalAlpha = 1;
    }
    ctx.setLineDash([]);
  }

  drawMen(ctx, b, orientation, images, stage.travel);
  drawArrow(ctx, b, orientation, stage.arrow);

  // the piece being given up, circled in red — the mark the card is about
  if (b.sacSquare && b.sacSquare !== b.to && stage.ink > 0) {
    const { x, y } = cellXY(b.sacSquare, orientation);
    ctx.strokeStyle = C.mark;
    ctx.lineWidth = 5;
    if (inkStyle === "plain") {
      ctx.beginPath();
      ctx.ellipse(x + CELL / 2, y + CELL / 2, CELL * 0.44, CELL * 0.42, -0.05, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      strokePoints(
        ctx,
        inkEllipsePoints(x + CELL / 2, y + CELL / 2, CELL * 0.42, CELL * 0.4, -0.05, stage.ink),
      );
    }
  }

  // !! written beside the destination square
  if (stage.bang > 0) {
    const { x, y } = cellXY(b.to, orientation);
    ctx.save();
    ctx.translate(x + CELL - 20, y + 30);
    if (stage.bang < 1) {
      ctx.globalAlpha = stage.bang;
      ctx.scale(1 + (1 - stage.bang) * 0.6, 1 + (1 - stage.bang) * 0.6);
    }
    ctx.rotate(-0.14);
    ctx.fillStyle = C.mark;
    ctx.font = `bold italic 44px ${display}`;
    ctx.textAlign = "center";
    ctx.fillText("!!", 0, 0);
    ctx.restore();
    ctx.textAlign = "left";
  }

  // board keyline — ink on paper
  ctx.strokeStyle = C.textHi;
  ctx.lineWidth = 3;
  ctx.strokeRect(BOARD_X, BOARD_Y, BOARD, BOARD);

  // ── caption ─────────────────────────────────────────────────────────────
  // the filled-in fields along the foot of the sheet
  const rowY = BOARD_BOTTOM + 34;
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(PAD, rowY, W - PAD * 2, 96);

  const fields: Array<[string, string]> = [
    ["PLAYER", username ? `@${username}` : "—"],
    ["OPPONENT", b.game.oppUsername],
    ["OFFERED", String(b.sacrifice)],
    ["EVAL", formatEval(b.evalAfter, null)],
  ];
  const colW = (W - PAD * 2) / fields.length;
  fields.forEach(([label, value], i) => {
    const x = PAD + colW * i;
    if (i > 0) {
      ctx.strokeStyle = C.line;
      ctx.beginPath();
      ctx.moveTo(x, rowY);
      ctx.lineTo(x, rowY + 96);
      ctx.stroke();
    }
    ctx.fillStyle = C.dim;
    ctx.font = `600 19px ${display}`;
    ctx.fillText(label, x + 18, rowY + 34);
    ctx.fillStyle = C.bril;
    ctx.font = `600 30px ${mono}`;
    ctx.fillText(value, x + 18, rowY + 74);
  });

  // footer, set as printed small caps. When the move has a measured story —
  // a forced mate, a mate that landed, material that came back — the annotator's
  // note replaces the brand line: a share card that says WHY travels further
  // than a slogan, and the slogan still covers the quiet cases.
  const why = whyLabel(b);
  const footer = why
    ? `${timeClassLabel(b.game.timeClass)} · ${sacrificeLabel(b.sacPiece, b.sacSquare, b.sacrifice)}, ${why}.`
    : `${timeClassLabel(b.game.timeClass)} · every move gets written down. almost none get circled.`;
  ctx.fillStyle = C.dim;
  ctx.font = `400 22px ${display}`;
  ctx.textAlign = "center";
  if (stage.why >= 1) {
    ctx.fillText(footer, W / 2, H - 40);
  } else if (stage.why > 0) {
    // the verdict is written, not revealed: clip from the left edge of the line
    const fw = ctx.measureText(footer).width;
    ctx.save();
    ctx.beginPath();
    ctx.rect(W / 2 - fw / 2 - 4, H - 76, fw * stage.why + 8, 50);
    ctx.clip();
    ctx.fillText(footer, W / 2, H - 40);
    ctx.restore();
  }
  ctx.textAlign = "left";
}

function allSquares(): string[] {
  const out: string[] = [];
  for (let r = 1; r <= 8; r++) for (const f of FILES) out.push(`${f}${r}`);
  return out;
}

/** Make sure the brand fonts are available before any fillText. */
export async function waitForFonts(): Promise<void> {
  try {
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  } catch {
    /* fonts API unavailable — fall back to system fonts */
  }
}
