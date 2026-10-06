import { Chess } from 'chess.js';
import type { RecordedMainLine } from './answer-host-contracts';
import { recordedMainLineResult } from './recorded-main-line';
import { REASONING_POC_VERSION, reasoningContextHash, validateReasoningPositionContext, type ReasoningPositionContext, type ReasoningEvidenceRecord } from './poc-contracts';
import { EVIDENCE_LICENSE } from './evidence-licenses';
import { stableHash } from './stable';

/** A historical badge is not a refreshed board analysis or a new classification. */
export function recordedSelectedClassification(context: ReasoningPositionContext, line: RecordedMainLine | undefined) {
  if (context.kind === 'position' || !line || line.selectedAtStart || !Array.isArray(line.moves)
    || !Number.isInteger(line.selectedIndex) || line.selectedIndex < 0 || line.selectedIndex >= line.moves.length
    || line.selectedIndex !== context.historyUci.length || line.moves.length > 512
    || line.startFen !== (context.historyStartFen ?? new Chess().fen())) return undefined;
  try {
    validateReasoningPositionContext(context);
    const selected = line.moves[line.selectedIndex];
    if (selected.san !== context.moveSan || selected.uci !== context.moveUci) return undefined;
    // Replay only the observed prefix. Neither validation nor output requires future play.
    const prefix = line.moves.slice(0, line.selectedIndex + 1);
    const validated = recordedMainLineResult({...line, moves: prefix, totalPlies: prefix.length, truncated: false}, context);
    const row = validated.recordedAnalysis.rows.find(item => item[0] === line.selectedIndex + 1);
    if (!row) return undefined;
    const [ply, engine, recordedDepth, requestedDepth, classifierVersion, classification,
      beforeCp, afterCp, lossCp, mateBefore, mateAfter] = row;
    const snapshot = {
      version: 'recorded-selected-classification/1' as const,
      authority: 'historical-reported-label-only',
      source: 'loaded-game-stored-selected-move-analysis',
      position: { fenBefore: context.fenBefore, fenAfter: context.fenAfter, moveUci: context.moveUci, moveSan: context.moveSan, ply },
      classification, classifierVersion, engine, reportedDepth: recordedDepth, recordedRequestedDepth: requestedDepth,
      freshlyRecomputed: false,
      savedEvaluation: { perspective: 'selected-mover', units: 'centipawns; mate separate', beforeCp, afterCp, lossCp, mateBefore, mateAfter },
      limitations: [
        'This is the recorded classification under the supplied historical classifier version, not necessarily the current app badge or current policy.',
        'Preparation and subsequent engine searches do not recompute this stored label. Prefer a separately supplied refreshed board classification when available.',
        'The label is not proof of its chess explanation. Saved scores may differ from fresh searches; lossCp is a saved search delta, not a matched comparison.',
        'No future recorded moves, alternative candidates or other moves\' classifications are included.',
      ],
    };
    const contextHash = reasoningContextHash(context);
    const record: ReasoningEvidenceRecord = {
      schemaVersion: REASONING_POC_VERSION, id: `evidence:recorded-selected-classification:${stableHash({contextHash,snapshot})}`,
      contextHash, kind: 'context', source: snapshot.source, proofStrength: null,
      summary: `The stored analysis labelled ${context.moveSan} ${classification} under classifier version ${classifierVersion}; this is historical reported context, not a new classification.`,
      data: snapshot, coverage: {complete:false, covered:['historical-selected-classification'], unresolved:['current-policy-classification','causal-explanation']},
      replay: {fen:context.fenBefore,moveUci:context.moveUci}, licenses:[EVIDENCE_LICENSE.ATTENTION_AFFORDANCE],
    };
    return { record, snapshot: {...snapshot, evidenceId:record.id} };
  } catch {
    return undefined;
  }
}

export type RecordedSelectedClassification = ReturnType<typeof recordedSelectedClassification>;
