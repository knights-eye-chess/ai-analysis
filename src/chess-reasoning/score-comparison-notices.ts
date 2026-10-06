import type { ReasoningEvidenceRecord } from './poc-contracts';
import { matchedRootComparison } from './matched-comparison';
import type { PositionAnalysisResult } from './poc-tools';

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
type Score = { unit: 'centipawns' | 'mate-in-moves'; value: number };
type Observation = {
  evidenceId: string; source: string; score: Score; reportedDepth: number | null; actualDepth: number | null;
  requestedDepth: number | null; requestedMultiPv: number | null;
  rootScope: 'restricted' | 'unrestricted'; requestedRootMoves: string[];
  cacheProvenance: string; sourceCacheProvenance: string;
  engine: string | null; engineBuild: string | null;
  scoreProvenance?: Record<string, unknown>;
};
export type ScoreComparisonNotice = {
  fen: string; rootMove: string; perspective: 'white' | 'black';
  disagreementKind: 'centipawn-variation' | 'mate-status-disagreement' | 'opposite-mate-sign' | 'mate-distance-variation';
  observations: Observation[]; preferredWithinSearchComparisonEvidenceIds: string[];
  interpretation: string;
};

function disagreementKind(observations: Observation[]): ScoreComparisonNotice['disagreementKind'] {
  const mates = observations.filter(observation => observation.score.unit === 'mate-in-moves').map(observation => observation.score.value);
  if (mates.length !== observations.length) return mates.length ? 'mate-status-disagreement' : 'centipawn-variation';
  if (mates.some(value => value > 0) && mates.some(value => value < 0)) return 'opposite-mate-sign';
  return 'mate-distance-variation';
}

const sharedInterpretation = 'Different search results for the same root move; equal requested depth does not make their search scope, actual depth, cache or search history equivalent. Preserve each scoped score. For relative move comparisons prefer alternatives covered together at the same actual depth in the identified comparison records; this supports a relative claim within that search, not independent confirmation or rejection of a mate result. Do not combine scores from separate searches into a move-loss estimate. This notice alone does not require another search.';
const interpretationFor = (kind: ScoreComparisonNotice['disagreementKind']): string => {
  const qualification = kind === 'mate-status-disagreement'
    ? 'Mate status differs: a centipawn score in another search does not refute its mating continuation, and mate distances cannot be converted to centipawns. '
    : kind === 'opposite-mate-sign'
      ? 'The mate signs oppose, indicating different reported mating sides; retain each search scope and inspect the underlying continuations. '
      : kind === 'mate-distance-variation'
        ? 'The searches report different mate distances; mate distances are not centipawns. '
        : 'The searches report different centipawn evaluations. ';
  return qualification + sharedInterpretation;
};

function originatingRootDepth(line: Record<string, unknown>, search: Record<string, unknown>, fen: string): number | null {
  const provenance = object(line.scoreProvenance);
  if (provenance) return provenance.kind === 'root-search' && provenance.fen === fen &&
    finite(provenance.originatingDepth) && Number.isInteger(provenance.originatingDepth) && provenance.originatingDepth > 0
    && provenance.originatingDepth === line.depth ? provenance.originatingDepth : null;
  // Old direct engine records predate scoreProvenance. Widget display-cache
  // depths may instead describe a later position and cannot be promoted here.
  const source = search.sourceCacheProvenance ?? search.cacheProvenance;
  return source === 'engine' && finite(line.depth) && Number.isInteger(line.depth) && line.depth > 0 ? line.depth : null;
}

/** Presentation-only qualification. Does not reconcile numeric truth or initiate searches. */
export function scoreComparisonNotices(records: readonly ReasoningEvidenceRecord[]): ScoreComparisonNotice[] {
  const groups = new Map<string, { fen: string; rootMove: string; perspective: 'white' | 'black'; observations: Observation[]; matched: Set<string> }>();
  for (const record of records) {
    const wrapper = object(record.data);
    const data = object(wrapper?.details) ?? wrapper;
    const search = object(data?.searchScope);
    if (!data || !search || typeof search.fen !== 'string' || !Array.isArray(data.lines)) continue;
    const fen = search.fen;
    const perspective = fen.split(' ')[1] === 'w' ? 'white' : fen.split(' ')[1] === 'b' ? 'black' : null;
    if (!perspective) continue;
    const roots = strings(search.requestedRootMoves);
    const lines = data.lines.map(object).filter((line): line is Record<string, unknown> => !!line);
    const scoped = (line: Record<string, unknown>) => {
      const scope = object(line.scoreScope);
      return scope?.fen === fen && scope.perspective === perspective && scope.positiveMeans === 'advantage for perspective color';
    };
    // A restricted probe is useful for relative comparisons only if all requested
    // alternatives were returned with a common actual depth and explicit root scope.
    const comparedRoots = roots.length ? roots : lines.map(line => String(line.rootMove));
    const matched = (!roots.length || record.coverage?.complete === true && roots.every(root => record.coverage!.covered.includes(root))) &&
      matchedRootComparison({...data,command:search.command,cacheProvenance:search.cacheProvenance,sourceCacheProvenance:search.sourceCacheProvenance} as unknown as PositionAnalysisResult,fen,comparedRoots).status === 'matched';
    for (const line of lines) {
      if (typeof line.rootMove !== 'string' || !scoped(line)) continue;
      const scope = object(line.scoreScope)!;
      let score: Score;
      if (finite(line.matePly) && scope.matePlyUnit === 'signed mate-in-moves (legacy field name, not plies)') {
        score = { unit: 'mate-in-moves', value: line.matePly };
      } else if (line.matePly == null && finite(line.scoreCp) && Math.abs(line.scoreCp) < 100000 && scope.scoreCpUnit === 'centipawns') {
        score = { unit: 'centipawns', value: line.scoreCp };
      } else continue;
      const key = JSON.stringify([fen, line.rootMove, perspective]);
      let group = groups.get(key);
      if (!group) { group = { fen, rootMove: line.rootMove, perspective, observations: [], matched: new Set() }; groups.set(key, group); }
      // Reusing an evidence record is not a second independent evaluation.
      if (group.observations.some(observation => observation.evidenceId === record.id)) continue;
      group.observations.push({ evidenceId: record.id, source: record.source, score,
        reportedDepth: finite(line.depth) ? line.depth : null,
        actualDepth: originatingRootDepth(line, search, fen),
        requestedDepth: finite(search.requestedDepth) ? search.requestedDepth : null,
        requestedMultiPv: finite(search.requestedMultiPv) ? search.requestedMultiPv : null,
        rootScope: roots.length ? 'restricted' : 'unrestricted', requestedRootMoves: roots,
        cacheProvenance: typeof search.cacheProvenance === 'string' ? search.cacheProvenance : 'unreported',
        sourceCacheProvenance: typeof search.sourceCacheProvenance === 'string' ? search.sourceCacheProvenance : 'unreported',
        engine: typeof data.engine === 'string' ? data.engine : null,
        engineBuild: typeof data.engineBuild === 'string' ? data.engineBuild : null,
        ...(object(line.scoreProvenance) ? { scoreProvenance: line.scoreProvenance as Record<string, unknown> } : {}),
      });
      if (matched && comparedRoots.includes(line.rootMove)) group.matched.add(record.id);
    }
  }
  return [...groups.values()].filter(group => new Set(group.observations.map(observation => JSON.stringify(observation.score))).size > 1)
    .map(group => {
      const kind = disagreementKind(group.observations);
      return { fen: group.fen, rootMove: group.rootMove, perspective: group.perspective,
        disagreementKind: kind,
        observations: group.observations, preferredWithinSearchComparisonEvidenceIds: [...group.matched],
        interpretation: interpretationFor(kind),
      };
    });
}
