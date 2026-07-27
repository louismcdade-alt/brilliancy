import type { Brilliancy } from "../types";
import { formatEval, timeClassLabel } from "./format";

/**
 * Renders a brilliancy as a self-contained 1080×1350 PNG "card" — the board with
 * the move's arrow and !! seal, plus the stats and branding — sized for Instagram
 * (4:5) and fine for TikTok. Everything is drawn on a canvas so the export is a
 * clean raster with no DOM/CSS dependency; pieces are the same /public/pieces
 * SVGs the live board uses (same-origin, so the canvas isn't tainted and toBlob
 * works). Share-as-image is the growth hook: a one-tap "show off your !!".
 *
 * Palette mirrors the CSS tokens in src/index.css (canvas can't read CSS vars).
 */

const W = 1080;
const H = 1350;
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
type Orientation = "white" | "black";

function parseFen(fen: string): Map<string, { type: string; color: "w" | "b" }> {
  const map = new Map<string, { type: string; color: "w" | "b" }>();
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

function loadPiece(color: "w" | "b", type: string): Promise<HTMLImageElement> {
  const src = `/pieces/${color}${PIECE_LETTER[type]}.svg`;
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


function moveLabel(b: Brilliancy): string {
  return b.game.userColor === "w" ? `${b.moveNumber}.` : `${b.moveNumber}…`;
}

/** Draw the arrow from→to on the board, in pen, with a filled head. */
function drawArrow(ctx: CanvasRenderingContext2D, b: Brilliancy, orientation: Orientation) {
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
  ctx.lineTo(base.x, base.y);
  ctx.stroke();

  const px = -uy;
  const py = ux;
  const hw = head * 0.62;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(base.x + px * hw, base.y + py * hw);
  ctx.lineTo(base.x - px * hw, base.y - py * hw);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Render the card to a PNG blob. Resolves once fonts/pieces are ready. */
export async function renderBrilliancyCard(b: Brilliancy, username: string): Promise<Blob> {
  const dpr = 2; // export at 2× for crisp social uploads
  const canvas = document.createElement("canvas");
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  // make sure the brand fonts are available before any fillText
  try {
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  } catch {
    /* fonts API unavailable — fall back to system fonts */
  }

  const orientation: Orientation = b.game.userColor === "w" ? "white" : "black";
  const pieces = parseFen(b.fenBefore);

  // preload every piece on the board
  await Promise.all(
    [...pieces.values()].map((p) => loadPiece(p.color, p.type).catch(() => null)),
  );

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
  ctx.fillText(moveText, PAD, 228);
  const mw = ctx.measureText(moveText).width;
  ctx.fillStyle = C.mark;
  ctx.font = `bold italic 56px ${display}`;
  ctx.fillText("!!", PAD + mw + 18, 226);

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
  {
    const { x, y } = cellXY(b.to, orientation);
    ctx.strokeStyle = C.bril;
    ctx.lineWidth = 4;
    ctx.setLineDash([12, 8]);
    ctx.strokeRect(x + 8, y + 8, CELL - 16, CELL - 16);
    ctx.setLineDash([]);
  }

  // pieces
  for (const [sq, p] of pieces) {
    const img = pieceCache.get(`/pieces/${p.color}${PIECE_LETTER[p.type]}.svg`);
    if (!img) continue;
    const { x, y } = cellXY(sq, orientation);
    const inset = CELL * 0.06;
    ctx.drawImage(img, x + inset, y + inset, CELL - inset * 2, CELL - inset * 2);
  }

  drawArrow(ctx, b, orientation);

  // the piece being given up, circled in red — the mark the card is about
  if (b.sacSquare && b.sacSquare !== b.to) {
    const { x, y } = cellXY(b.sacSquare, orientation);
    ctx.strokeStyle = C.mark;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(x + CELL / 2, y + CELL / 2, CELL * 0.44, CELL * 0.42, -0.05, 0, Math.PI * 2);
    ctx.stroke();
  }

  // !! written beside the destination square
  {
    const { x, y } = cellXY(b.to, orientation);
    ctx.save();
    ctx.translate(x + CELL - 20, y + 30);
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

  // footer, set as printed small caps
  ctx.fillStyle = C.dim;
  ctx.font = `400 22px ${display}`;
  ctx.textAlign = "center";
  ctx.fillText(
    `${timeClassLabel(b.game.timeClass)} · every move gets written down. almost none get circled.`,
    W / 2,
    H - 40,
  );
  ctx.textAlign = "left";

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not render image"))),
      "image/png",
    ),
  );
}

function allSquares(): string[] {
  const out: string[] = [];
  for (let r = 1; r <= 8; r++) for (const f of FILES) out.push(`${f}${r}`);
  return out;
}

/**
 * Share a brilliancy as an image. On mobile (and any browser supporting the Web
 * Share API with files) this opens the native share sheet — straight into
 * Instagram/TikTok. Everywhere else it downloads the PNG. Returns how it was
 * delivered so the UI can give feedback.
 */
export async function shareBrilliancy(
  b: Brilliancy,
  username: string,
): Promise<"shared" | "downloaded"> {
  const blob = await renderBrilliancyCard(b, username);
  const name = `brilliancy-${username || "move"}-${b.san.replace(/[^a-z0-9]/gi, "")}.png`;
  const file = new File([blob], name, { type: "image/png" });

  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
    share?: (data?: ShareData) => Promise<void>;
  };
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({
        files: [file],
        title: "My brilliant move",
        text: `${b.san}!! — a sound sacrifice found by Brilliancy`,
      });
      return "shared";
    } catch (e) {
      // user cancelled the share sheet — don't fall through to a download
      if (e instanceof DOMException && e.name === "AbortError") return "shared";
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}
