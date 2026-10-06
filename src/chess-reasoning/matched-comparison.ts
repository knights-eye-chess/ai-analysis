import { Chess } from 'chess.js';
import type { PositionAnalysisResult } from './poc-tools';

export type MatchedComparison = {
  status: 'matched' | 'unmatched';
  actualDepth: number | null;
  rootMoves: string[];
  reason: string;
};

/** One retained engine response establishes search identity; candidate caches do not. */
export function matchedRootComparison(result: PositionAnalysisResult, fen: string, requiredRoots: readonly string[] = []): MatchedComparison {
  const lines = Array.isArray(result.lines) ? result.lines : [];
  const rootMoves = lines.flatMap(line => line && typeof line.rootMove === 'string' ? [line.rootMove] : []);
  const unmatched = (reason: string): MatchedComparison => ({status:'unmatched',actualDepth:null,rootMoves,reason});
  if ((result.sourceCacheProvenance ?? result.cacheProvenance) !== 'engine') return unmatched('Common engine search identity is unavailable.');
  if (rootMoves.length !== lines.length) return unmatched('A compared root is malformed.');
  if (lines.length < 2 || new Set(rootMoves).size !== rootMoves.length || requiredRoots.some(root => !rootMoves.includes(root))) return unmatched('The search does not cover all compared moves.');
  try {
    const legal = new Set(new Chess(fen).moves({verbose:true}).map(move => move.from + move.to + (move.promotion || '')));
    if (rootMoves.some(root => !legal.has(root))) return unmatched('A compared move is not legal at this root.');
  } catch { return unmatched('The comparison root is invalid.'); }
  const depth = lines[0].depth, perspective = fen.split(' ')[1] === 'w' ? 'white' : fen.split(' ')[1] === 'b' ? 'black' : null;
  if (!perspective || !Number.isSafeInteger(depth) || depth < 1 || lines.some(line => line.depth !== depth)) return unmatched('The moves have no common achieved depth.');
  for (const line of lines) {
    if (line.scoreScope?.fen !== fen || line.scoreScope.perspective !== perspective || line.scoreScope.positiveMeans !== 'advantage for perspective color') return unmatched('The score roots or perspectives differ.');
    if (line.matePly == null ? !Number.isFinite(line.scoreCp) || Math.abs(line.scoreCp!) >= 100000 : !Number.isFinite(line.matePly)) return unmatched('A compared score is unavailable.');
    if (line.matePly == null ? line.scoreScope.scoreCpUnit !== 'centipawns' : line.scoreScope.matePlyUnit !== 'signed mate-in-moves (legacy field name, not plies)') return unmatched('The score units are unknown.');
    const origin = line.scoreProvenance;
    if (origin && (origin.kind !== 'root-search' || origin.fen !== fen || origin.originatingDepth !== depth)) return unmatched('A score is not a matching root-search measurement.');
    // Old direct engine responses have known single-dispatch identity even when
    // they predate per-line origin metadata. A cache of saved candidates does not.
    if (origin?.engineBuild != null && origin.engineBuild !== result.engineBuild) return unmatched('The engine builds differ.');
    if (origin?.command != null && result.command && origin.command !== result.command) return unmatched('The search commands differ.');
  }
  if (new Set(lines.flatMap(line => typeof line.scoreProvenance?.command === 'string' ? [line.scoreProvenance.command] : [])).size > 1) return unmatched('The search commands differ.');
  return {status:'matched',actualDepth:depth,rootMoves,reason:'These root scores came from one engine search at a common achieved depth.'};
}

export const MATCHED_COMPARISON_GUIDANCE = `For an explicit claim that one move is better than another, use and cite a matched comparison covering both moves at the same exact root, from one engine search at a common achieved depth. searchScope.comparison identifies matched or unmatched results. A completed engine comparison can be reused. Stored board alternatives are historical observations; their greater reported depth does not supersede a matched comparison or establish a precise relative advantage. Reuse initial preparation when its matched search already covers both choices. Otherwise request compare_moves (or the appropriate recorded-position comparison) while investigation is open. Never subtract separately cached candidate scores to support a better-than claim. If a matched comparison is unavailable or searches disagree, explain the supported chess mechanism and qualify the ranking; do not claim an absolute ordering or search again merely to resolve small cross-depth differences.`;
