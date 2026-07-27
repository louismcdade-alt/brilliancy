import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pure static SPA. We deliberately do NOT set COOP/COEP cross-origin-isolation
// headers: that would require single-threaded Stockfish anyway, and COEP would
// block cross-origin chess.com avatar images. Engine runs single-threaded.
export default defineConfig({
  plugins: [react()],
  worker: {
    format: "es",
  },
});
