import { Chess } from 'chess.js';
import type { ReasoningEvidenceRecord, ReasoningPositionContext } from './poc-contracts';

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uci = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** A deliberately narrow correction for an asserted forced win. The finite
 * search only limits what this fallback can support; it is no proof that a
 * different search could never find a forced win. */
export function forcedWinPremiseFallback(question: string, context: ReasoningPositionContext | undefined,
  records: readonly ReasoningEvidenceRecord[], selectedContextAvailable = true): string | null {
  if (!selectedContextAvailable || !context || context.kind === 'position') return null;
  const q = question.trim();
  if (!/\b(?:wins? by force|forced win|guaranteed win|forces? (?:a )?win)\b/i.test(q)
    || /\b(?:does(?:n't| not)|is(?:n't| not)|cannot|can't)\b.{0,50}\b(?:win by force|forced win)\b/i.test(q)
    || /\b(?:not|never) win by force\b/i.test(q)) return null;
  const san = context.moveSan.replace(/[+#?!]+$/g, '');
  if (!san || !new RegExp(`(^|[^a-z0-9])${san.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i').test(q)) return null;
  let after: Chess;
  try {
    const before = new Chess(context.fenBefore);
    if (!uci.test(context.moveUci)) return null;
    const played = before.move({from:context.moveUci.slice(0,2),to:context.moveUci.slice(2,4),promotion:context.moveUci.slice(4)||undefined});
    if (!played || played.san.replace(/[+#?!]+$/g, '') !== san || before.fen() !== context.fenAfter) return null;
    after = new Chess(context.fenAfter);
  } catch { return null; }
  const opponent = after.turn() === 'w' ? 'White' : 'Black';
  const fen = after.fen();
  const candidates: Array<{san:string; scoreCp:number; depth:number}> = [];
  for (const record of records) {
    if (record.kind !== 'probe' || !record.source.endsWith('/compare_moves') || record.coverage?.complete !== true) continue;
    const wrapper = object(record.data);
    const data = object(wrapper?.details) ?? wrapper;
    const search = object(data?.searchScope);
    const roots = Array.isArray(search?.requestedRootMoves) ? search.requestedRootMoves : [];
    if (search?.fen !== fen || roots.length < 2 || !roots.every(root => typeof root === 'string' && record.coverage?.covered.includes(root))) continue;
    const perspective = opponent.toLowerCase();
    for (const value of Array.isArray(data?.lines) ? data.lines : []) {
      const line = object(value), scope = object(line?.scoreScope), provenance = object(line?.scoreProvenance);
      if (!line || !roots.includes(line.rootMove) || !record.coverage.covered.includes(String(line.rootMove))
        || scope?.fen !== fen || scope.perspective !== perspective || scope.positiveMeans !== 'advantage for perspective color'
        || scope.scoreCpUnit !== 'centipawns' || line.matePly !== null
        || typeof line.scoreCp !== 'number' || !Number.isFinite(line.scoreCp) || line.scoreCp < 100 || line.scoreCp >= 100000
        || !Number.isInteger(line.depth) || (line.depth as number) < 8 || !Array.isArray(line.pv) || line.pv[0] !== line.rootMove) continue;
      if (provenance ? provenance.kind !== 'root-search' || provenance.fen !== fen || provenance.originatingDepth !== line.depth
        : search?.sourceCacheProvenance !== 'engine') continue;
      try {
        const board = new Chess(fen);
        let reply = '';
        for (const [i, move] of line.pv.entries()) {
          if (typeof move !== 'string' || !uci.test(move)) throw Error('invalid continuation');
          const played = board.move({from:move.slice(0,2),to:move.slice(2,4),promotion:move.slice(4)||undefined});
          if (!played) throw Error('illegal continuation');
          if (i === 0) reply = played.san;
        }
        candidates.push({san:reply,scoreCp:line.scoreCp,depth:line.depth as number});
      } catch { /* A malformed PV cannot support a prose correction. */ }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a,b) => b.scoreCp-a.scoreCp || b.depth-a.depth);
  const best = candidates[0];
  return `The available analysis does not support the premise that ${san} wins by force. At the selected position after ${san}, ${opponent} can answer ${best.san}; the recorded depth-${best.depth} comparison scores that continuation +${(best.scoreCp/100).toFixed(2)} from ${opponent}'s perspective. This is a bounded engine result, not proof that no forced win exists; a mating line after a different reply does not make that reply compulsory.`;
}
