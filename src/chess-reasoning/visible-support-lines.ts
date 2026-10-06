import { Chess } from 'chess.js';
import { historicalProseRoots, type RecordedReferenceLine } from './historical-prose';
import { simpleProseReferences, type SimpleReference } from './simple-prose-references';
import { reasoningContextHash, type ReasoningPositionContext, type ReasoningEvidenceRecord } from './poc-contracts';

/** Expose only a path the answer already explicitly referenced and admission verified. */
export function visibleSupportLines(answer: string, context: ReasoningPositionContext,
  records: readonly ReasoningEvidenceRecord[], recordedLine?: RecordedReferenceLine) {
  const view = simpleProseReferences(answer, context, records, recordedLine);
  const historical = historicalProseRoots(context, records, recordedLine);
  const refs = view.blocks.flatMap(block => block.tokens.flatMap(token => token.reference ? [token.reference] : []));
  const rootKey = (r: SimpleReference) => JSON.stringify([reasoningContextHash(r.position.recordedContext ?? context), r.position.start]);
  const path = (r: SimpleReference) => r.position.moves.map(m => m.uci);
  const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((m,i) => m === b[i]);
  const candidates = refs.filter(r => path(r).length > 1);
  const maximal = candidates.filter((r,i) => !candidates.some((other,j) => rootKey(r) === rootKey(other)
    && isPrefix(path(r),path(other)) && (path(r).length < path(other).length || j < i)));
  const additions: Array<{target:string;label:string;evidenceIds:string[];authority:string}> = [];
  for (const ref of maximal) {
    const moves = path(ref);
    const visible = new Set(refs.filter(r => r.kind === 'move' && rootKey(r) === rootKey(ref)
      && isPrefix(path(r),moves)).map(r => path(r).length));
    if (moves.every((_,i) => visible.has(i+1))) continue;
    const rootContext = ref.position.recordedContext ?? context;
    let target = `move:${ref.position.start}:${moves.join(',')}`;
    if (ref.position.recordedContext) {
      const root = [...historical.roots].find(([,value]) => reasoningContextHash(value.context) === reasoningContextHash(rootContext));
      if (!root) continue;
      target = `game:${root[0]}:${moves.join(',')}`;
    }
    const board = new Chess(ref.position.start === 'before' ? rootContext.fenBefore : rootContext.fenAfter);
    const label = moves.map(uci => {
      const [,turn,,,,number] = board.fen().split(' ');
      const san = board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}).san;
      return `${number}${turn === 'w' ? '.' : '...'}${san}`;
    }).join(' ');
    const line = `[${label}](${target})`;
    // Square/piece admission alone must never broaden move-path authority.
    const checked = simpleProseReferences(line,context,records,recordedLine);
    if (checked.coverage.resolved !== 1 || checked.gaps.some(g => !g.startsWith('Unbound text:'))) continue;
    additions.push({target,label,evidenceIds:ref.evidenceIds,authority:'Existing admitted reference path; not proof of best play, force or purpose.'});
  }
  return {answer: answer + additions.map(a => `\n\nReferenced line: [${a.label}](${a.target}).`).join(''), additions};
}
