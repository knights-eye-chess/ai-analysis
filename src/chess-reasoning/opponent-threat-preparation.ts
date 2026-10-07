import { Chess } from "chess.js";
import type { ReasoningPositionContext } from "./poc-contracts";
import type { PositionAnalysisProvider, PositionAnalysisRequest, PositionAnalysisResult } from "./poc-tools";
import { SIMPLE_EVIDENCE_PREPARATION_VERSION, type SimpleEvidencePreparation } from "./simple-evidence-preparation";
import { engineSearchFailure } from './engine-search-failure';

type Scope = "hypothetical-opponent-turn-before" | "actual-after";
type LeadLine = { root: string; uci: string; san: string; depth: number; scoreCp: number | null; matePly: number | null; shorterThanRequested: boolean };

/** Cheap engine acquisition only. These leads do not register evidence or UI witnesses. */
export async function prepareOpponentThreats(context: ReasoningPositionContext, engine: PositionAnalysisProvider,
  signal?: AbortSignal, onProgress?: (message: string) => void): Promise<SimpleEvidencePreparation | undefined> {
  if (context.kind === "position") return undefined;
  const started = performance.now();
  const rawRecords: { scope: Scope; fen: string; request: Omit<PositionAnalysisRequest, "signal">; result: PositionAnalysisResult }[] = [];
  const probes: Record<string, unknown>[] = [];
  const unavailable: ({ scope: Scope; reason: string } & Partial<ReturnType<typeof engineSearchFailure>>)[] = [];
  let searchCount: 0 | 1 | 2 = 0;
  let searchesSucceeded = 0, searchesFailed = 0;
  const targets: { scope: Scope; fen: string; depth: number }[] = [];
  try {
    const before = new Chess(context.fenBefore);
    if (before.isCheck()) unavailable.push({ scope: "hypothetical-opponent-turn-before", reason: "cannot-skip-check" });
    else {
      const fields = context.fenBefore.split(" ");
      fields[1] = before.turn() === "w" ? "b" : "w";
      fields[3] = "-";
      targets.push({ scope: "hypothetical-opponent-turn-before", fen: fields.join(" "), depth: 18 });
    }
  } catch { unavailable.push({ scope: "hypothetical-opponent-turn-before", reason: "invalid-position" }); }
  targets.push({ scope: "actual-after", fen: context.fenAfter, depth: 20 });
  for (const target of targets) {
    signal?.throwIfAborted();
    let dispatched = false, completed = false;
    try {
      if (new Chess(target.fen).isGameOver()) {
        unavailable.push({ scope: target.scope, reason: "terminal-position" });
        continue;
      }
      const request = { fen: target.fen, rootMoves: [], depth: target.depth, multiPv: 3, minimumPvPlies: 10 };
      dispatched = true;
      searchCount = (searchCount + 1) as 1 | 2;
      onProgress?.(`Examining ${target.scope === "actual-after" ? "opponent responses" : "potential opponent plans"} · depth ${target.depth}`);
      const result = await engine.analyze({ ...request, signal });
      signal?.throwIfAborted();
      searchesSucceeded++;
      completed = true;
      rawRecords.push({ scope: target.scope, fen: target.fen, request, result });
      const lines: LeadLine[] = [];
      for (const line of result.lines) {
        try {
          const board = new Chess(target.fen);
          const san = line.pv.map(move => board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move.slice(4) || undefined }).san);
          if (!line.pv.length || line.pv[0] !== line.rootMove) throw Error("invalid-root");
          lines.push({ root: line.rootMove, uci: line.pv.join(" "), san: san.join(" "), depth: line.depth,
            scoreCp: line.scoreCp, matePly: line.matePly, shorterThanRequested: line.pv.length < 10 });
        } catch { unavailable.push({ scope: target.scope, reason: "invalid-continuation-omitted" }); }
      }
      probes.push({ scope: target.scope, fen: target.fen,
        requested: { depth: request.depth, multiPv: request.multiPv, minimumPvPlies: request.minimumPvPlies },
        engine: result.engine, engineBuild: result.engineBuild, provenance: result.cacheProvenance,
        sourceProvenance: result.sourceCacheProvenance, command: result.command,
        perspective: target.fen.split(" ")[1] === "w" ? "white" : "black",
        units: "centipawns; positive favors perspective; matePly is signed mate-in-moves (legacy name)",
        coveredRoots: lines.map(line => line.root), lines });
    } catch (error) {
      signal?.throwIfAborted();
      if (dispatched && !completed) searchesFailed++;
      unavailable.push({ scope: target.scope, reason: "probe-unavailable", ...engineSearchFailure(error) });
    }
  }
  return { version: SIMPLE_EVIDENCE_PREPARATION_VERSION, searchCount, searchesSucceeded, searchesFailed, elapsedMs: performance.now() - started,
    rawRecords, investigationLeads: { version: "opponent-threat-leads/2", fenBefore: context.fenBefore, fenAfter: context.fenAfter, probes, unavailable,
      limitation: "Investigation leads, NOT registered/citable evidence. Hypothetical before flips only turn and clears en-passant: skipping is not a legal move. FEN-root searches omit prior repetition history. These scores are not a measured value of the selected move. Top 3 roots only, not exhaustive defense coverage. Raw engine records retained in diagnostic; tactical geometry omitted here. Use ordinary tools to validate relevant actual lines, captures, checks and recaptures and register interactive references. Do not turn an incidental opponent blunder into the purpose of the move." } };
}
