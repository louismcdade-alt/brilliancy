/**
 * A static server for dist/, so more than one check can look at what actually
 * ships.
 *
 * This was csp-check.mjs's private server until a second script needed one.
 * `vite preview` is not a substitute: the two would serve different headers, and
 * the whole point of csp-check is that the headers are exactly the ones in
 * public/_headers. Two hand-rolled servers would drift the same way.
 *
 * `headers` is a parameter and not a constant BECAUSE the CSP is optional here.
 * csp-check owns the "does the policy break the app" question and passes the real
 * policy; a copy check has no business failing red for a CSP reason, so it passes
 * nothing and gets a bare origin.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolved from this file, not from cwd, so a caller can be run from anywhere.
 * fileURLToPath rather than URL.pathname, which on Windows hands back
 * "/C:/Users/..." and needs the leading slash chewed off by hand.
 */
export const DIST = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "dist");

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".woff2": "font/woff2", ".svg": "image/svg+xml",
  ".nnue": "application/octet-stream", ".png": "image/png", ".json": "application/json",
};

/**
 * Serve dist/ on `port` with `headers` added to every 200. Resolves once the
 * socket is listening, so the caller can navigate immediately. Pass port 0 and
 * read `server.address().port` if you have no reason to want a fixed one — a
 * fixed port that happens to be taken fails the CALLER, and a copy check going
 * red with EADDRINUSE is the least useful red there is.
 */
export async function serveDist({ port = 0, headers = {} } = {}) {
  const server = createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    const rel = normalize(url === "/" ? "index.html" : url.replace(/^\/+/, ""));
    try {
      const buf = await readFile(join(DIST, rel));
      res.setHeader("Content-Type", TYPES[extname(rel)] || "application/octet-stream");
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise((r) => server.listen(port, r));
  return server;
}
