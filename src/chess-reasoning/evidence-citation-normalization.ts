import type { ReasoningEvidenceRecord } from './poc-contracts';

/** Repair syntax only when the exact supplied identifier makes it unambiguous. */
export function normalizedEvidenceCitations(answer: string, records: readonly Pick<ReasoningEvidenceRecord, 'id'>[]) {
  const ids = new Set(records.map(record => record.id));
  const repairs: Array<{originalId:string;canonicalId:string}> = [];
  const normalized = answer.replace(/\b(?:evidence:){2,}[\w:-]+/g, originalId => {
    if (ids.has(originalId)) return originalId;
    const canonicalId = originalId.replace(/^(?:evidence:)+/, 'evidence:');
    if (!ids.has(canonicalId)) return originalId;
    repairs.push({originalId,canonicalId});
    return canonicalId;
  });
  return {answer:normalized,repairs};
}
