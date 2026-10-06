import { scoreComparisonNotices, type ScoreComparisonNotice } from './score-comparison-notices';
import { forcedWinPremiseFallback } from './simple-fallback-premise';
import type { ReasoningEvidenceRecord, ReasoningPositionContext } from './poc-contracts';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** Fresh, self-contained finalization: never truncate native encrypted state or
 * cut JSON records. Omitted records remain in diagnostics, not in model context. */
export function completionPacket(question: string, records: ReasoningEvidenceRecord[], gameRecord?: unknown, context?: unknown, attribution?: Record<string,unknown>) {
  const packet = {...attribution,scope:'CURRENT_QUESTION', question:question.slice(0,12000),
    instruction:'Investigation is closed. Give a concise final summary addressing the question using only these scoped records. Distinguish recorded play from engine proof. Explicitly state gaps; do not claim a comprehensive review if evidence is partial. No additional tools are available.',
    reason:'soft-investigation-limit', continuation:'Fresh summary request: previous conversation, opaque provider state and any omitted evidence are not included; do not reconstruct their contents.', questionTruncated:question.length>12000, context:undefined as unknown, gameRecord:undefined as unknown,
    scoreComparisonNotices:[] as ScoreComparisonNotice[], evidence:[] as ReasoningEvidenceRecord[], omittedRecords:0, omittedEvidenceIds:[] as string[], omittedGameRecord:false, omittedContext:false};
  if (context && bytes(context)<30000) packet.context=context; else packet.omittedContext=Boolean(context);
  if (gameRecord && bytes(gameRecord)<60000) packet.gameRecord=gameRecord; else packet.omittedGameRecord=Boolean(gameRecord);
  // Prefer recent acquired proof; retain each full record with its root/provenance.
  for(const record of [...records].reverse()) {
    packet.evidence.push(record);
    if(bytes(packet)>180000){packet.evidence.pop();packet.omittedRecords++; if(packet.omittedEvidenceIds.length<100)packet.omittedEvidenceIds.push(record.id);}
  }
  packet.scoreComparisonNotices=scoreComparisonNotices(packet.evidence);
  while(bytes(packet)>180000 && packet.evidence.length) { const removed=packet.evidence.pop()!;packet.omittedRecords++;if(packet.omittedEvidenceIds.length<100)packet.omittedEvidenceIds.push(removed.id);packet.scoreComparisonNotices=scoreComparisonNotices(packet.evidence); }
  return packet;
}

/** A provider-independent result when a final response cannot be obtained.
 * This reports existing evidence, never manufactures a chess conclusion. */
export function evidenceFallback(records: ReasoningEvidenceRecord[], searches: number, partial = '', question = '', context?: ReasoningPositionContext, selectedContextAvailable = true) {
  const evidence = records.filter(r=>r.kind!=='context' && r.summary.trim()).slice(-8);
  const plain = (s:string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[\r\n]+/g,' ').replace(/[<>`]/g,'');
  const lines = evidence.map(r=>`${plain(r.summary).slice(0,700)} (Source: ${plain(r.source)}; ${r.coverage?.complete ? 'record coverage complete' : 'coverage limited or unspecified'}.)`);
  const scope='The analysis is incomplete. Further analysis stopped, so this is a limited summary of the work already available—not a complete answer to your question.';
  const correction=forcedWinPremiseFallback(question,context,records,selectedContextAvailable);
  // An interrupted draft may itself repeat the false premise. Once a scoped
  // correction is available, use the admitted records instead of draft prose.
  if(partial.trim() && !correction) return `${scope}\n\nPartial draft (generation stopped before completion; this text is not a finished answer):\n\n${plain(partial.trim())}`;
  return `${scope}${correction ? '\n\n'+correction : ''}\n\n${searches} engine searches were recorded.${lines.length ? '\n\nRecorded evidence:\n'+lines.map(s=>'- '+s).join('\n') : ' There is not enough usable evidence to give a reliable chess conclusion.'}\n\nUnexamined moves and alternatives remain unresolved.`;
}
