import { checkCausalClaims } from './causal-claim-checks';
import { normalizedEvidenceCitations } from './evidence-citation-normalization';
import { reasoningContextHash } from './poc-contracts';
import { Chess } from 'chess.js';
import { historicalProseRoots } from './historical-prose';
import { simpleProseReferences, SIMPLE_REFERENCE_VERSION } from './simple-prose-references';
import { MAX_INTERACTIVE_LINE_PLIES } from './reference-limits';
import type { RecordedReferenceLine } from './historical-prose';
import type { AuthoredReferenceResult } from './simple-prose-references';
import type { ReasoningPositionContext, ReasoningEvidenceRecord } from './poc-contracts';

/** Deterministic presentation repair, never new analytical evidence. */
export function validateAnswerReferences(answer: string, context: ReasoningPositionContext,
  records: readonly ReasoningEvidenceRecord[], recordedLine?: RecordedReferenceLine) {
  const citationResult = normalizedEvidenceCitations(answer, records.filter(record => record.contextHash === reasoningContextHash(context)));
  answer = citationResult.answer;
  const historical = historicalProseRoots(context, records, recordedLine);
  const repairs: Array<{ originalTarget: string; repairedTarget: string; label: string; evidenceIds: string[]; authority: string }> = [];
  const repairedGaps = new Map<string,number>();
  const repairedNotationCorrections: string[] = [];
  const gameReferences: Array<{ target: string; status: 'resolved' | 'repaired' | 'unresolved'; reason?: string }> = [];
  const admitted = (text: string) => {
    const view = simpleProseReferences(text, context, records, recordedLine);
    return { view, valid: view.coverage.resolved === 1 && view.notationCorrections.length === 0 && !view.blocks.some(block => block.tokens.some(token => token.reference?.kind === 'sequence')) && !view.gaps.some(g => !g.startsWith('Unbound text:')) };
  };
  const originalReferences = new Map<string,AuthoredReferenceResult>();
  const originalView = simpleProseReferences(answer, context, records, recordedLine, undefined, r => originalReferences.set(JSON.stringify([r.label,r.target]),r));
  const targetRepairedAnswer = answer.replace(/\[([^\]\n]+)\]\((game:[^)\n]*)\)/g, (original, label: string, target: string) => {
    const initial = originalReferences.get(JSON.stringify([label,target]));
    if (initial?.resolved) { gameReferences.push({target, status:'resolved'}); return original; }
    try {
      const parsed = /^game:(\d+):[^:\n]*$/.exec(target);
      const root = parsed && historical.roots.get(Number(parsed[1]));
      if (!parsed || !root) throw Error('Unknown recorded position');
      // A cumulative path may repeat an earlier UCI accidentally. Delete at
      // most one such occurrence, never insert/reorder moves or change roots.
      // The complete repaired path must independently pass the same witnessed
      // replay and SAN-label checks as rendering. Ambiguous repairs stay plain.
      const authoredPath = target.split(':')[2].split(',');
      const duplicateCandidates = new Map<string, ReturnType<typeof admitted>>();
      if (authoredPath.length <= MAX_INTERACTIVE_LINE_PLIES + 1) {
        for (let i = 1; i < authoredPath.length; i++) {
          if (!authoredPath.slice(0, i).includes(authoredPath[i])) continue;
          const path = authoredPath.filter((_, index) => index !== i);
          const candidateTarget = `game:${parsed[1]}:${path.join(',')}`;
          const checked = admitted(`[${label}](${candidateTarget})`);
          const ids = checked.view.blocks.flatMap(b => b.tokens.flatMap(t => t.reference?.evidenceIds ?? []));
          const actual = historical.recorded?.slice(Number(parsed[1]), Number(parsed[1]) + path.length);
          const isActual = actual?.length === path.length && actual.every((uci, index) => uci === path[index]);
          if (checked.valid && (isActual || ids.length)) duplicateCandidates.set(candidateTarget, checked);
        }
      }
      if (duplicateCandidates.size === 1) {
        const [repairedTarget, checked] = [...duplicateCandidates][0];
        const evidenceIds = [...new Set(checked.view.blocks.flatMap(b => b.tokens.flatMap(t => t.reference?.evidenceIds ?? [])))];
        repairs.push({originalTarget:target,repairedTarget,label,evidenceIds,authority:evidenceIds.length?'supplied-evidence':'recorded-play'});
        if (initial?.reason) repairedGaps.set(initial.reason,(repairedGaps.get(initial.reason) ?? 0)+1);
        repairedNotationCorrections.push(...checked.view.notationCorrections);
        gameReferences.push({target,status:'repaired'});
        return `[${label}](${repairedTarget})`;
      }
      if (duplicateCandidates.size > 1) throw Error('Ambiguous witnessed replacement');
      // Parse the WHOLE label from its stated root; no suffix guessing, skipped
      // words, root search, or joining independent engine paths.
      const tokens = [...label.trim().matchAll(/(?:(\d+)(\.{1,3}|…)\s*)?([^\s.]+)/g)];
      if (!tokens.length || tokens.length > MAX_INTERACTIVE_LINE_PLIES
        || tokens.map(t => t[0]).join('').replace(/\s/g,'') !== label.replace(/\s/g,'')) throw Error('Incomplete SAN label');
      const board = new Chess(root.context.fenAfter);
      const path = tokens.map(t => {
        const fields = board.fen().split(' ');
        if (t[1] && (Number(t[1]) !== Number(fields[5]) || (t[2] === '.' ? 'w' : 'b') !== fields[1])) throw Error('Wrong move number');
        const san = t[3].replace(/[!?]+$/,'');
        const move = board.move(san, {strict:true});
        if (move.san !== san) throw Error('Noncanonical SAN label');
        return move.from + move.to + (move.promotion ?? '');
      });
      const repairedTarget = `game:${parsed[1]}:${path.join(',')}`;
      const candidate = `[${label}](${repairedTarget})`;
      const checked = admitted(candidate);
      const evidenceIds = [...new Set(checked.view.blocks.flatMap(b => b.tokens.flatMap(t => t.reference?.evidenceIds ?? [])))];
      const actual = historical.recorded?.slice(Number(parsed[1]), Number(parsed[1]) + path.length);
      const isActual = actual?.length === path.length && actual.every((uci,i) => uci === path[i]);
      if (!checked.valid || (!isActual && !evidenceIds.length)) throw Error('Replacement path is not witnessed');
      repairs.push({originalTarget:target,repairedTarget,label,evidenceIds,authority:isActual?'recorded-play':'supplied-evidence'});
      if(initial?.reason) repairedGaps.set(initial.reason,(repairedGaps.get(initial.reason) ?? 0)+1);
      repairedNotationCorrections.push(...checked.view.notationCorrections);
      gameReferences.push({target, status:'repaired'});
      return candidate;
    } catch {
      gameReferences.push({target,status:'unresolved',reason:initial?.reason ?? 'Unresolved historical reference'});
      return original; // Renderer retains its readable noninteractive fallback.
    }
  });
  // Only a fully resolved original link can contribute a canonical label.
  // Repaired historical targets already require complete strict canonical SAN.
  // Keep the raw model output in its earlier trace.
  const labelCorrections: Array<{originalLabel:string;canonicalLabel:string;target:string}> = [];
  const repairedAnswer = targetRepairedAnswer.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (original, label: string, target: string) => {
    const reference = originalReferences.get(JSON.stringify([label,target]));
    const canonicalLabel = reference?.resolved && reference.canonicalLabel;
    if (!canonicalLabel || canonicalLabel === label) return original;
    labelCorrections.push({originalLabel:label,canonicalLabel,target});
    return `[${canonicalLabel}](${target})`;
  });
  // Target and label changes are already validated above. Reuse the full initial
  // rendering pass instead of replaying every unaffected historical path twice.
  const gaps = originalView.gaps.filter(gap => {
    const repaired = repairedGaps.get(gap) ?? 0;
    if (!repaired) return true;
    repairedGaps.set(gap,repaired-1); return false;
  });
  let causalClaimChecks: ReturnType<typeof checkCausalClaims> = [];
  let causalClaimCheckStatus: 'completed' | 'unavailable' = 'completed';
  try { causalClaimChecks = checkCausalClaims(repairedAnswer,context,records,recordedLine); }
  catch { causalClaimCheckStatus = 'unavailable'; } // A diagnostic failure never discards reference validation or prose.
  return { answer: repairedAnswer, referenceValidation: {
    version:SIMPLE_REFERENCE_VERSION, citationRepairs:citationResult.repairs, interactionCoverage:{...originalView.coverage,resolved:originalView.coverage.resolved+repairs.length},
    unresolvedReferences:gaps.filter(g => !g.startsWith('Unbound text:')),
    unboundMentions:gaps.filter(g => g.startsWith('Unbound text:')),
    notationCorrections:[...new Set([...originalView.notationCorrections,...repairedNotationCorrections])], labelCorrections, gameReferences, repairs,
    causalClaimChecks, causalClaimCheckStatus,
    causalClaimCheckScope:'Witnessed single moves with explicit piece bindings or a direct move-as-subject escape clause only; ambiguous claims remain unresolved. Ranges are half-open UTF-16 offsets into the final reference-repaired answer; sentenceContext preserves surrounding text. Unlisted claims are not certified. Diagnostic only: no suppression or regeneration.',
  } };
}
