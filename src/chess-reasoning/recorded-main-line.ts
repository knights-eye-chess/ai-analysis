import { savedScorePresentation } from './saved-score-presentation';
import { Chess } from "chess.js";
import type { RecordedMainLine, RecordedMoveAnalysis } from "./answer-host-contracts";
import { REASONING_POC_VERSION, reasoningContextHash, type ReasoningPositionContext, type ReasoningEvidenceRecord } from "./poc-contracts";

/** Recorded moves are legal witnesses, never best-play/score or intent evidence. */
function validRecordedAnalysis(value: RecordedMoveAnalysis | undefined, before: string, after: string, uci: string): value is RecordedMoveAnalysis {
  if (!value || value.version !== "recorded-move-analysis/1" || value.fenBefore !== before || value.fenAfter !== after || value.moveUci !== uci) return false;
  const boundedText = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max && /^[a-zA-Z0-9@._/ +:-]+$/.test(s);
  const depth = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 256;
  const score = (n: unknown) => n === null || (typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1_000_000);
  return boundedText(value.engine, 64) && boundedText(value.classification, 40) && depth(value.actualDepth)
    && depth(value.requestedDepth) && Number.isInteger(value.classifierVersion) && value.classifierVersion > 0 && value.classifierVersion <= 100_000
    && [value.beforeCp, value.afterCp, value.lossCp, value.mateBefore, value.mateAfter].every(score);
}

export function recordedMainLineResult(line: RecordedMainLine, context: ReasoningPositionContext) {
  if (!line || !Array.isArray(line.moves) || line.moves.length > 512 || !Number.isInteger(line.selectedIndex) || line.selectedIndex < -1
    || !Number.isInteger(line.totalPlies) || line.totalPlies < line.moves.length || line.selectedIndex >= line.totalPlies || line.truncated !== (line.totalPlies > line.moves.length)) throw Error("Invalid recorded main line.");
  const atStart = context.kind === "position";
  if (atStart && (line.selectedAtStart !== true || line.selectedIndex !== -1 || line.startFen !== context.fenAfter)) throw Error("Recorded starting-position scope mismatch.");
  if (!atStart && line.selectedAtStart) throw Error("Recorded anchor kind mismatch.");
  const chess = new Chess(line.startFen);
  // A branch has no selected main-line index, so its root must be checked directly.
  // Legacy move contexts omit historyStartFen and replay from the standard start.
  const historyRoot = new Chess(atStart ? context.fenAfter : context.historyStartFen).fen();
  if (chess.fen() !== historyRoot) throw Error("Recorded main-line root mismatch.");
  const rows: Array<[number, string, number, number, number, string, number | null, number | null, number | null, number | null, number | null]> = [];
  const moves = line.moves.map((item, index) => {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(item.uci)) throw Error("Invalid recorded move.");
    const before = chess.fen(), move = chess.move({ from: item.uci.slice(0, 2), to: item.uci.slice(2, 4), promotion: item.uci.slice(4) || undefined });
    if (move.san !== item.san) throw Error("Recorded SAN mismatch.");
    if (index === line.selectedIndex && (before !== context.fenBefore || chess.fen() !== context.fenAfter || item.uci !== context.moveUci
      || index !== context.historyUci.length || line.moves.slice(0, index).some((m, i) => m.uci !== context.historyUci[i]))) throw Error("Recorded question scope mismatch.");
    const a = item.analysis;
    if (validRecordedAnalysis(a, before, chess.fen(), item.uci)) { const score=savedScorePresentation(a); rows.push([index + 1, a.engine, a.actualDepth,
      a.requestedDepth, a.classifierVersion, a.classification, score.beforeCp, score.afterCp, score.lossCp, score.mateBefore, score.mateAfter]); }
    return { uci: item.uci, san: move.san, moveNumber: Number(before.split(" ")[5]), color: move.color };
  });
  const continuation = atStart ? moves.map(move => move.uci) : line.selectedIndex >= 0 && line.selectedIndex < moves.length ? moves.slice(line.selectedIndex + 1).map(move => move.uci) : [];
  const contextHash = reasoningContextHash(context);
  const evidence: ReasoningEvidenceRecord[] = continuation.length ? [{ schemaVersion: REASONING_POC_VERSION,
    id: `evidence:recorded-main-line:${contextHash}:${continuation.slice(0, 32).join("-")}`, contextHash, kind: "fact", source: "loaded-game-main-line", proofStrength: "observed",
    licenses: ["chess.legality", "chess.identity"], summary: "Legally replayed recorded main-line continuation; not an engine recommendation or proof of intent.",
    data: { authority: "legal-exact", scope: "sequence-legality-and-identity", phase: "after" },
    coverage: { complete: false, covered: [], unresolved: ["No optimality or human-intent claim."] },
    replay: { fen: context.fenAfter, movesUci: continuation.slice(0, 32) } }] : [];
  const reported = line.reportedResult;
  if (reported && (!['1-0', '0-1', '1/2-1/2', '*'].includes(reported.result) || !['PGN', 'Lichess', 'Chess.com'].includes(reported.source))) throw Error('Invalid reported game result.');
  const reportedResult = reported?.result ?? '*';
  let verifiedResult: string | null = null, ending = 'unknown';
  if (!line.truncated) {
    if (chess.isCheckmate()) { verifiedResult = chess.turn() === 'w' ? '0-1' : '1-0'; ending = 'checkmate'; }
    else if (chess.isStalemate()) { verifiedResult = '1/2-1/2'; ending = 'stalemate'; }
    else if (chess.isInsufficientMaterial()) { verifiedResult = '1/2-1/2'; ending = 'insufficient material'; }
    else if (reportedResult === '1/2-1/2' && chess.isThreefoldRepetition()) ending = 'draw; threefold repetition available in recorded history';
    else if (reportedResult === '1/2-1/2' && chess.isDrawByFiftyMoves()) ending = 'draw; fifty-move rule available in final position';
  }
  const result = verifiedResult ?? reportedResult;
  if (ending === 'unknown' && result === '1/2-1/2') ending = 'draw (agreed or unrecorded)';
  else if (ending === 'unknown' && result !== '*') ending = line.truncated ? 'decisive result; final position unavailable' : 'decisive result, no checkmate; resignation, time or abandonment reason not recorded';
  const outcome = { result, reportedResult, reportedSource: reported?.source ?? 'PGN', authority: verifiedResult ? 'verified-board-state' : 'source-reported',
    ending, mismatch: verifiedResult !== null && reportedResult !== '*' && verifiedResult !== reportedResult };
  // A partial replay must not assign the full game's result to its truncated PGN.
  if (!line.truncated) chess.setHeader('Result', result);
  return { contextHash, evidence, recordedAnalysis: { source: "Current loaded game's stored per-move analysis snapshots", authority: "attributed-existing-analysis",
    scorePerspective: "mover-at-each-recorded-ply", units: "centipawns; mate separate", coverage: { analyzedPlies: rows.length, totalPlies: line.totalPlies, complete: !line.truncated && rows.length === line.totalPlies },
    columns: ["ply", "engine", "reportedDepth", "recordedRequestedDepth", "classifierVersion", "classification", "beforeCp", "afterCp", "lossCp", "mateBefore", "mateAfter"], rows,
    limitations: ["reportedDepth is the stored classification depth, not a verified root-search depth; recordedRequestedDepth is the board setting recorded when classified.", "Matching stored edge analyses are included even when their engine, classifier version or dependency fingerprint is no longer current; missing or invalid plies have no analysis row.", "Scores are from the mover's perspective at each row's ply: positive favors that move's color; lossCp is a saved before/after search delta for that mover, not a controlled regret comparison. Mate-related/sentinel centipawn fields are null; use mateBefore/mateAfter. Best or Forced labels can coexist with search-score changes.", "Classification is a historical decision from the reported classifier version, not necessarily current policy or proof of its explanation. Saved scores may differ from fresh searches.", ...(line.truncated ? ["Analysis is limited to the first 512 recorded plies."] : [])] },
    recordedMainLine: { source: "Current loaded game's recorded primary line (may contain user edits)", startFen: line.startFen, moves, outcome,
    selectedIndex: line.selectedIndex, selectedAtStart: atStart, selectedOnMainLine: atStart || line.selectedIndex >= 0, totalPlies: line.totalPlies, truncated: line.truncated, pgn: chess.pgn() },
    limitations: ["PGN is reconstructed from recorded moves; result provenance and verified ending are provided separately in outcome. Other original headers and clocks are not included.", "Recorded play is not engine evidence of best play, force, safety or human intent.", ...(!atStart && line.selectedIndex < 0 ? ["The question is on a branch; this main line is not its continuation."] : []), ...(line.truncated ? ["Only the first 512 plies are returned."] : [])] };
}
