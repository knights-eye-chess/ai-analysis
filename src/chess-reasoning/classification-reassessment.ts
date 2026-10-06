import type { SimpleBoardAnalysis } from './simple-board-analysis';

/** Preserve decision provenance without repeating the full board-analysis snapshots. */
export function classificationReassessment(previous: SimpleBoardAnalysis | undefined, current: SimpleBoardAnalysis | undefined) {
  const previousLabel = previous?.snapshot.classification;
  const currentLabel = current?.snapshot.classification;
  const sameContext = Boolean(previous && current && previous.record.contextHash === current.record.contextHash);
  const labelChanged = sameContext && Boolean(previousLabel && currentLabel && previousLabel !== currentLabel);
  const superseded = Boolean(sameContext && currentLabel && previous!.snapshot.evidenceId !== current!.snapshot.evidenceId);
  const summary = (analysis: NonNullable<SimpleBoardAnalysis>, role: 'previous-analysis' | 'current-analysis') => ({
    role,
    evidenceId: analysis.snapshot.evidenceId,
    classification: analysis.snapshot.classification,
    lossCp: analysis.snapshot.evaluation.lossCp,
    recordedRequestedDepth: analysis.snapshot.recordedRequestedDepth,
    beforeDepth: analysis.snapshot.beforeDepth,
    afterDepth: analysis.snapshot.afterDepth,
  });
  return {
    version: 'classification-reassessment/1',
    status: !currentLabel ? 'current-decision-unavailable' : !previousLabel ? 'original-decision-unavailable' : !sameContext ? 'context-mismatch' : labelChanged ? 'changed' : 'unchanged',
    labelChanged,
    preparationRequestedDepth: 18,
    ...(previous ? {previous: {
      ...summary(previous, 'previous-analysis'),
      ...(superseded ? {superseded: true, supersededBy: current!.snapshot.evidenceId} : {}),
      ...(labelChanged ? {recordedReason: previous.snapshot.recordedReason} : {}),
    }} : {}),
    ...(current && (sameContext || !previous) ? {current: summary(current, 'current-analysis')} : {}),
    limitation: 'These are attributed canonical decisions before and after preparation, not causal proof. preparationRequestedDepth is the preparation search request, not the recorded depth of every classification dependency. The full current analysis is in boardAnalysis; retrieve the previous evidenceId for omitted historical detail. A missing or mismatched decision does not establish a classification change.',
  };
}

export const CLASSIFICATION_REASSESSMENT_GUIDANCE = `For questions that include the selected move's classification, Knight's Eye may prepare a deeper before-position search and refresh the board's canonical classification before answering. classificationReassessment contains compact decision summaries: the current full analysis is in boardAnalysis; previous is an attributed historical summary, superseded only for a matching current context. retrieve_evidence with the previous evidenceId restores omitted historical details when needed. preparationRequestedDepth names the preparation request, not the recorded depth of either decision. When classificationReassessment.status is changed and labelChanged is true, acknowledge the change explicitly in first-person Knight's Eye language, for example: “I had a better look at this move and changed its classification from Great to Best because …”. Use the previous recordedReason and the current boardAnalysis decision details to explain the supported reason. Distinguish why we originally assigned the old label from why the refreshed decision differs; do not defend an outdated label as the current one. A changed score with an unchanged label is not a classification change. If the original or current decision, its reason, or the search is unavailable, state the material uncertainty and never invent a change or explanation. A recorded candidate-gap flag is a bounded policy signal, not proof that only one move preserves a favorable position.`;
