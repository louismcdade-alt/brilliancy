/**
 * Thin UCI wrapper around the single-threaded Stockfish 16 WASM build that ships
 * in /public/engine. The engine runs in a Web Worker; calls are serialized so we
 * only ever have one search in flight.
 */

export interface EvalResult {
  /** Centipawns from the side-to-move's perspective. Mates are mapped to large cp. */
  cp: number;
  /** Mate distance (signed) if the position is a forced mate, else null. */
  mate: number | null;
  bestMove: string;
}

/** One principal variation from a MultiPV search (best line = index 0). */
export interface PvLine {
  /** Centipawns from the side-to-move's perspective. */
  cp: number;
  mate: number | null;
  /** First move of the line, in UCI (e.g. "g1f3"). */
  move: string;
}

const ENGINE_URL = "/engine/stockfish-nnue-16-single.js";
const MATE_CP = 100000;

function mateToCp(m: number): number {
  return m > 0 ? MATE_CP - m * 10 : -MATE_CP - m * 10;
}

type Line = string;

class Engine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private listeners = new Set<(line: Line) => void>();
  private chain: Promise<unknown> = Promise.resolve();

  /** Whether init() has been attempted (used by UI to show a one-time loader). */
  loadStarted = false;

  private send(cmd: string) {
    this.worker?.postMessage(cmd);
  }

  private waitFor(test: (line: Line) => boolean, timeoutMs = 20000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error("Engine timed out."));
      }, timeoutMs);
      const fn = (line: Line) => {
        if (test(line)) {
          clearTimeout(timer);
          this.listeners.delete(fn);
          resolve();
        }
      };
      this.listeners.add(fn);
    });
  }

  /**
   * Reset the transposition table so a search can't inherit anything from the
   * position before it.
   *
   * This is not a nicety. Without it, a move's evaluation depends on how many
   * games were scanned ahead of it: `6...Bxf2+` in one of the test accounts came
   * out at +36cp partway through a 120-game sweep and +17cp from a cold engine —
   * astride the `STILL_GOOD` threshold, so the same move was brilliant or not
   * depending on scan order. A detector whose answer changes with batch size
   * can't be compared against chess.com, or against its own fixtures.
   *
   * The cost is the transposition reuse we give up; correctness is worth more
   * than the milliseconds, and the searches are of unrelated positions anyway.
   */
  private async freshSearch(): Promise<void> {
    this.send("ucinewgame");
    this.send("isready");
    await this.waitFor((l) => l.includes("readyok"));
  }

  init(): Promise<void> {
    if (this.ready) return this.ready;
    this.loadStarted = true;
    this.ready = new Promise<void>((resolve, reject) => {
      try {
        this.worker = new Worker(ENGINE_URL);
      } catch (e) {
        reject(new Error("Could not start the chess engine in this browser."));
        return;
      }
      this.worker.onmessage = (e: MessageEvent) => {
        const line: string =
          typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
        for (const fn of this.listeners) fn(line);
      };
      this.worker.onerror = () => reject(new Error("The chess engine failed to load."));

      this.send("uci");
      this.waitFor((l) => l.includes("uciok"))
        .then(() => {
          this.send("setoption name Hash value 64");
          this.send("setoption name UCI_AnalyseMode value true");
          this.send("isready");
          return this.waitFor((l) => l.includes("readyok"));
        })
        .then(() => resolve())
        .catch(reject);
    });
    return this.ready;
  }

  /** Analyze a single position to a fixed depth. Serialized behind prior calls. */
  analyze(fen: string, depth = 14): Promise<EvalResult> {
    const run = async (): Promise<EvalResult> => {
      await this.init();
      await this.freshSearch();
      return new Promise<EvalResult>((resolve) => {
        let cp = 0;
        let mate: number | null = null;
        const onLine = (line: Line) => {
          if (line.startsWith("info") && line.includes(" score ")) {
            const mm = line.match(/score mate (-?\d+)/);
            const cm = line.match(/score cp (-?\d+)/);
            if (mm) {
              mate = parseInt(mm[1], 10);
              cp = mateToCp(mate);
            } else if (cm) {
              cp = parseInt(cm[1], 10);
              mate = null;
            }
          } else if (line.startsWith("bestmove")) {
            this.listeners.delete(onLine);
            resolve({ cp, mate, bestMove: line.split(/\s+/)[1] ?? "" });
          }
        };
        this.listeners.add(onLine);
        this.send("setoption name MultiPV value 1"); // undo any prior MultiPV search
        this.send("position fen " + fen);
        this.send("go depth " + depth);
      });
    };
    // serialize
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result as Promise<EvalResult>;
  }

  /**
   * Analyze to a fixed depth returning the top `multiPv` lines, best first. Used
   * to read the gap between the best move and the best *alternative* — e.g. to
   * tell "the only way to keep the advantage" (brilliant) from "one of several
   * winning moves" (not brilliant). Serialized behind prior calls.
   */
  analyzeMultiPV(fen: string, depth = 14, multiPv = 2): Promise<PvLine[]> {
    const run = async (): Promise<PvLine[]> => {
      await this.init();
      await this.freshSearch();
      return new Promise<PvLine[]>((resolve) => {
        const latest = new Map<number, PvLine>(); // multipv index (1-based) -> line
        const onLine = (line: Line) => {
          if (line.startsWith("info") && line.includes(" multipv ") && line.includes(" score ")) {
            const pv = line.match(/ multipv (\d+)/);
            const mm = line.match(/score mate (-?\d+)/);
            const cm = line.match(/score cp (-?\d+)/);
            const mv = line.match(/ pv (\S+)/);
            if (!pv) return;
            const idx = parseInt(pv[1], 10);
            let cp = 0;
            let mate: number | null = null;
            if (mm) {
              mate = parseInt(mm[1], 10);
              cp = mateToCp(mate);
            } else if (cm) {
              cp = parseInt(cm[1], 10);
            } else return;
            latest.set(idx, { cp, mate, move: mv ? mv[1] : "" });
          } else if (line.startsWith("bestmove")) {
            this.listeners.delete(onLine);
            const lines = [...latest.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, l]) => l);
            resolve(lines);
          }
        };
        this.listeners.add(onLine);
        this.send("setoption name MultiPV value " + multiPv);
        this.send("position fen " + fen);
        this.send("go depth " + depth);
      });
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result as Promise<PvLine[]>;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.listeners.clear();
  }
}

/** Shared singleton — one engine for the whole app. */
export const engine = new Engine();
