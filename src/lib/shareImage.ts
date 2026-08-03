import type { Brilliancy } from "../types";
import { drawCard, H, loadPieces, STILL_STAGE, W, waitForFonts } from "./cardScene";

/**
 * Renders a brilliancy as a self-contained 1080×1350 PNG "card" — the board with
 * the move's arrow and !! seal, plus the stats and branding — sized for Instagram
 * (4:5) and fine for TikTok. Everything is drawn on a canvas so the export is a
 * clean raster with no DOM/CSS dependency; pieces are the same /public/pieces
 * SVGs the live board uses (same-origin, so the canvas isn't tainted and toBlob
 * works). Share-as-image is the growth hook: a one-tap "show off your !!".
 *
 * The drawing itself now lives in cardScene.ts, parameterised by a `Stage`, so
 * the animated clip in shareGif.ts renders from the identical code rather than
 * a copy that drifts. This file is only the still frame and the delivery path.
 * `STILL_STAGE` reproduces what this card has always drawn, pixel for pixel.
 */

/** Render the card to a PNG blob. Resolves once fonts/pieces are ready. */
export async function renderBrilliancyCard(b: Brilliancy, username: string): Promise<Blob> {
  const dpr = 2; // export at 2× for crisp social uploads
  const canvas = document.createElement("canvas");
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  await waitForFonts();
  // Only fenBefore matters for the still — STILL_STAGE has travel at 0 — but
  // loading both costs nothing (they share almost every piece) and keeps this
  // symmetric with the clip.
  const images = await loadPieces([b.fenBefore, b.fenAfter]);

  drawCard(ctx, b, username, { stage: STILL_STAGE, images, inkStyle: "plain" });

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not render image"))),
      "image/png",
    ),
  );
}

/**
 * Hand a rendered card to the OS.
 *
 * On mobile (and any browser supporting the Web Share API with files) this opens
 * the native share sheet — straight into Instagram/TikTok. Everywhere else it
 * downloads. Shared by the PNG and the GIF paths so there is one place that
 * knows about AbortError, object-URL cleanup and the download fallback.
 */
export async function deliver(
  blob: Blob,
  name: string,
  type: string,
  text: string,
): Promise<"shared" | "downloaded"> {
  const file = new File([blob], name, { type });

  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
    share?: (data?: ShareData) => Promise<void>;
  };
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: "My brilliant move", text });
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

/** A filesystem-safe stem like "brilliancy-hikaru-Qxh7". */
export function cardFileStem(b: Brilliancy, username: string): string {
  return `brilliancy-${username || "move"}-${b.san.replace(/[^a-z0-9]/gi, "")}`;
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
  return deliver(
    blob,
    `${cardFileStem(b, username)}.png`,
    "image/png",
    `${b.san}!! — a sound sacrifice found by Brilliancy`,
  );
}
