import { Chess } from 'chess.js';
import type { PositionAnalysisLine } from './position-analysis-contracts';
import { reasoningContextHash, type ReasoningPositionContext } from './poc-contracts';

/** Host-only input, created from this answer's acquired engine results, never a saved snapshot. */
export type FreshEnginePvWitness = {
  version: 'fresh-engine-pv-witness/1'; acquisition: 'same-answer-engine'; acquisitionId: number;
  evidenceId: string; contextHash: string; phase: 'before' | 'after'; fen: string;
  engineBuild: string; command: string; requestedDepth: number; multiPv: number; rootMoves: string[];
  authority: 'bounded-engine'; licenses: ['engine.bounded-continuation'];
  lines: Pick<PositionAnalysisLine, 'rootMove' | 'pv' | 'depth' | 'scoreProvenance' | 'scoreCp' | 'mateInMoves'>[];
};

export type FreshEnginePvReferenceEvidence = {
  acquisitionId: number; evidenceId: string; rootFen: string; rootMove: string;
  depth: number; requestedDepth: number; engineBuild: string; command: string;
  scoreCp: number | null; mateInMoves: number | null;
  scoreProvenance: NonNullable<PositionAnalysisLine['scoreProvenance']>;
  conditional: true;
  scoreInterpretation: 'Root-search score only; the continuation is conditional, not forced and not a score for a later position.';
};

export type FreshEnginePvReferenceLine = {
  start: 'before' | 'after'; ucis: string[]; evidenceIds: string[]; authority: string;
  engineEvidence: FreshEnginePvReferenceEvidence[];
};

export const MAX_FRESH_ENGINE_WITNESS_ACQUISITIONS = 64;
export type FreshEnginePvRejectionReason =
  | 'invalid-acquisition' | 'missing-authority-license' | 'context-mismatch' | 'root-mismatch'
  | 'invalid-search-scope' | 'root-set-mismatch' | 'depth-mismatch' | 'provenance-mismatch'
  | 'score-mismatch' | 'invalid-pv' | 'illegal-pv' | 'audit-capacity-exceeded';
export type FreshEnginePvAdmissionAudit = {
  version: 'fresh-engine-pv-admission/1'; inputAcquisitions: number; inspectedAcquisitions: number;
  acceptedAcquisitions: number; rejectedAcquisitions: number; acceptedLines: number; omittedAcquisitions: number;
  acceptedAcquisitionIds: number[]; rejectedAcquisitionIds: (number | null)[];
  rejections: { acquisitionId: number | null; reason: FreshEnginePvRejectionReason }[];
  rejectionCounts: Partial<Record<FreshEnginePvRejectionReason, number>>;
};

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function rejectionReason(context: ReasoningPositionContext, hash: string, witness: FreshEnginePvWitness): FreshEnginePvRejectionReason | null {
  if (!witness || witness.version !== 'fresh-engine-pv-witness/1' || witness.acquisition !== 'same-answer-engine'
    || !positiveInteger(witness.acquisitionId) || typeof witness.evidenceId !== 'string' || !witness.evidenceId
    || witness.evidenceId.length > 200) return 'invalid-acquisition';
  if (witness.authority !== 'bounded-engine' || !Array.isArray(witness.licenses)
    || witness.licenses.length !== 1 || witness.licenses[0] !== 'engine.bounded-continuation') return 'missing-authority-license';
  if (witness.contextHash !== hash) return 'context-mismatch';
  if (!['before', 'after'].includes(witness.phase)
    || witness.fen !== (witness.phase === 'before' ? context.fenBefore : context.fenAfter)) return 'root-mismatch';
  if (typeof witness.engineBuild !== 'string' || !witness.engineBuild || typeof witness.command !== 'string' || !witness.command
    || !positiveInteger(witness.requestedDepth) || !positiveInteger(witness.multiPv) || witness.multiPv > 32
    || !Array.isArray(witness.lines) || witness.lines.length !== witness.multiPv
    || !Array.isArray(witness.rootMoves) || witness.rootMoves.length > 32
    || witness.rootMoves.some(root => typeof root !== 'string' || !UCI.test(root))
    || new Set(witness.rootMoves).size !== witness.rootMoves.length) return 'invalid-search-scope';
  if (witness.lines.some(line => !line || typeof line.rootMove !== 'string')) return 'invalid-pv';
  const roots = witness.lines.map(line => line.rootMove);
  if (new Set(roots).size !== roots.length || witness.rootMoves.some(root => !roots.includes(root))
    || (witness.rootMoves.length > 0 && roots.some(root => !witness.rootMoves.includes(root)))) return 'root-set-mismatch';
  // The acquisition is atomic: a malformed sibling or full tail rejects every line.
  for (const line of witness.lines) {
    if (!positiveInteger(line.depth) || line.depth < witness.requestedDepth) return 'depth-mismatch';
    const provenance = line.scoreProvenance;
    if (!provenance || provenance.kind !== 'root-search' || provenance.fen !== witness.fen
      || provenance.engineBuild !== witness.engineBuild
      || (provenance.command !== undefined && provenance.command !== witness.command)
      || provenance.originatingDepth !== line.depth || provenance.reportedDepth !== line.depth) return 'provenance-mismatch';
    if (!((Number.isFinite(line.scoreCp) && line.mateInMoves === null)
      || (line.scoreCp === null && Number.isSafeInteger(line.mateInMoves) && line.mateInMoves !== 0))) return 'score-mismatch';
    if (!Array.isArray(line.pv) || !line.pv.length || line.pv.length > 256
      || line.pv.some(uci => typeof uci !== 'string' || !UCI.test(uci)) || line.pv[0] !== line.rootMove) return 'invalid-pv';
    try {
      const board = new Chess(witness.fen);
      for (const uci of line.pv) board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    } catch { return 'illegal-pv'; }
    try { structuredClone(provenance); } catch { return 'provenance-mismatch'; }
  }
  return null;
}

/** Bounded, safe reason codes; no raw error message, board, path or private source in the audit. */
export function admitFreshEnginePvWitnesses(context: ReasoningPositionContext, witnesses: readonly FreshEnginePvWitness[]): {
  lines: FreshEnginePvReferenceLine[]; audit: FreshEnginePvAdmissionAudit;
} {
  const lines: FreshEnginePvReferenceLine[] = [];
  const inspected = witnesses.slice(0, MAX_FRESH_ENGINE_WITNESS_ACQUISITIONS);
  const audit: FreshEnginePvAdmissionAudit = {
    version: 'fresh-engine-pv-admission/1', inputAcquisitions: witnesses.length, inspectedAcquisitions: inspected.length,
    acceptedAcquisitions: 0, rejectedAcquisitions: 0, acceptedLines: 0,
    omittedAcquisitions: witnesses.length - inspected.length, acceptedAcquisitionIds: [], rejectedAcquisitionIds: [],
    rejections: [], rejectionCounts: {},
  };
  const hash = reasoningContextHash(context);
  for (const witness of inspected) {
    const reason = rejectionReason(context, hash, witness);
    if (reason) {
      const acquisitionId = positiveInteger(witness?.acquisitionId) ? witness.acquisitionId : null;
      audit.rejections.push({ acquisitionId, reason });
      audit.rejectedAcquisitionIds.push(acquisitionId);
      audit.rejectionCounts[reason] = (audit.rejectionCounts[reason] ?? 0) + 1;
      continue;
    }
    audit.acceptedAcquisitionIds.push(witness.acquisitionId);
    for (const line of witness.lines) {
      lines.push({ start: context.kind === 'position' ? 'after' : witness.phase, ucis: [...line.pv],
        evidenceIds: [witness.evidenceId], authority: 'Bounded engine line', engineEvidence: [{
          acquisitionId: witness.acquisitionId, evidenceId: witness.evidenceId, rootFen: witness.fen,
          rootMove: line.rootMove, depth: line.depth, requestedDepth: witness.requestedDepth,
          engineBuild: witness.engineBuild, command: witness.command,
          scoreCp: line.scoreCp, mateInMoves: line.mateInMoves, scoreProvenance: structuredClone(line.scoreProvenance!),
          conditional: true, scoreInterpretation: 'Root-search score only; the continuation is conditional, not forced and not a score for a later position.',
        }] });
    }
  }
  if (audit.omittedAcquisitions) audit.rejectionCounts['audit-capacity-exceeded'] = audit.omittedAcquisitions;
  audit.acceptedAcquisitions = audit.acceptedAcquisitionIds.length;
  audit.rejectedAcquisitions = audit.rejections.length + audit.omittedAcquisitions;
  audit.acceptedLines = lines.length;
  return { lines, audit };
}

/** Presentation witness admission. Scores retain their original root scope, without entailment claims. */
export function freshEnginePvReferenceLines(context: ReasoningPositionContext, witnesses: readonly FreshEnginePvWitness[]): FreshEnginePvReferenceLine[] {
  return admitFreshEnginePvWitnesses(context, witnesses).lines;
}
