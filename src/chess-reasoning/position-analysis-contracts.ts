import type {
  PositionAnalysisLine as LegacyPositionAnalysisLine,
  PositionAnalysisResult as LegacyPositionAnalysisResult,
  PositionAnalysisProvider as LegacyPositionAnalysisProvider,
  PositionAnalysisRequest,
} from './poc-tools';

export type { PositionAnalysisRequest } from './poc-tools';
/** Historical evidence uses matePly, whose values have always been signed moves. */
export type { LegacyPositionAnalysisLine, LegacyPositionAnalysisResult, LegacyPositionAnalysisProvider };

type LegacyCompletion = NonNullable<LegacyPositionAnalysisLine['pvCompletion']>;
type LegacySegment = LegacyCompletion['segments'][number];
/** Signed mate-in-moves relative to the declared score perspective; null is no mate score. */
export type PositionAnalysisSegment = Omit<LegacySegment, 'matePly'> & { mateInMoves: number | null };
export type PositionAnalysisLine = Omit<LegacyPositionAnalysisLine, 'matePly' | 'pvCompletion'> & {
  mateInMoves: number | null;
  pvCompletion?: Omit<LegacyCompletion, 'segments'> & { segments: PositionAnalysisSegment[] };
};
export type PositionAnalysisResult = Omit<LegacyPositionAnalysisResult, 'lines'> & { lines: PositionAnalysisLine[] };
export interface PositionAnalysisProvider {
  analyze(request: PositionAnalysisRequest): Promise<PositionAnalysisResult>;
}
export type CompatiblePositionAnalysisProvider = PositionAnalysisProvider | LegacyPositionAnalysisProvider;

const LEGACY_UNIT = 'signed mate-in-moves (legacy field name, not plies)';
const UNIT = 'signed mate-in-moves';
type ScoreAliases = { matePly?: number | null; mateInMoves?: number | null; scoreScope?: Record<string, string> };
function mateValue(score: ScoreAliases): number | null {
  const old = Object.hasOwn(score, 'matePly');
  const current = Object.hasOwn(score, 'mateInMoves');
  if (!old && !current) throw new TypeError('Missing mateInMoves (or legacy matePly).');
  for (const key of ['matePly', 'mateInMoves'] as const) {
    if (Object.hasOwn(score, key) && score[key] !== null && !Number.isSafeInteger(score[key])) {
      throw new TypeError(`Invalid ${key}: expected signed integer moves or null.`);
    }
  }
  if (old && current && score.matePly !== score.mateInMoves) throw new TypeError('Conflicting matePly and mateInMoves.');
  return (current ? score.mateInMoves : score.matePly) as number | null;
}
function scope(value: ScoreAliases['scoreScope'], legacy: boolean): ScoreAliases['scoreScope'] {
  if (!value) return value;
  const { matePlyUnit, mateInMovesUnit, ...rest } = value;
  if (matePlyUnit !== undefined && matePlyUnit !== LEGACY_UNIT) throw new TypeError('Invalid legacy mate score unit.');
  if (mateInMovesUnit !== undefined && mateInMovesUnit !== UNIT) throw new TypeError('Invalid mate score unit.');
  // Conversion does not invent missing scope or attest that scores are comparable.
  if (matePlyUnit === undefined && mateInMovesUnit === undefined) return { ...rest };
  return { ...rest, ...(legacy ? { matePlyUnit: LEGACY_UNIT } : { mateInMovesUnit: UNIT }) };
}
function convertScore<T extends ScoreAliases>(value: T, legacy: boolean) {
  const mate = mateValue(value);
  const { matePly: _old, mateInMoves: _current, scoreScope, ...rest } = value;
  void _old; void _current;
  return { ...rest, ...(legacy ? { matePly: mate } : { mateInMoves: mate }),
    ...(scoreScope !== undefined ? { scoreScope: scope(scoreScope, legacy) } : {}) };
}
function convert(result: PositionAnalysisResult | LegacyPositionAnalysisResult, legacy: boolean) {
  return { ...result, lines: result.lines.map(line => ({ ...convertScore(line, legacy),
    ...(line.pvCompletion ? { pvCompletion: { ...line.pvCompletion,
      segments: line.pvCompletion.segments.map(segment => convertScore(segment, legacy)) } } : {}) })) };
}

/** Rename only: no search, score reinterpretation, schema migration or evidence admission. */
export function toPositionAnalysis(result: PositionAnalysisResult | LegacyPositionAnalysisResult): PositionAnalysisResult {
  return convert(result, false) as PositionAnalysisResult;
}
/** Explicit compatibility conversion for current internal tool/trace wire schemas. */
export function toLegacyPositionAnalysis(result: PositionAnalysisResult | LegacyPositionAnalysisResult): LegacyPositionAnalysisResult {
  return convert(result, true) as LegacyPositionAnalysisResult;
}
/** Public/legacy input normalization; delegates the original request and cancellation signal. */
export function toLegacyPositionAnalysisProvider(provider: CompatiblePositionAnalysisProvider): LegacyPositionAnalysisProvider {
  return { async analyze(request) {
    request.signal?.throwIfAborted();
    const result = await provider.analyze(request);
    request.signal?.throwIfAborted();
    return toLegacyPositionAnalysis(result);
  } };
}
/** Adapt an existing legacy provider to the preferred public signed-moves contract. */
export function toPositionAnalysisProvider(provider: CompatiblePositionAnalysisProvider): PositionAnalysisProvider {
  return { async analyze(request) {
    request.signal?.throwIfAborted();
    const result = await provider.analyze(request);
    request.signal?.throwIfAborted();
    return toPositionAnalysis(result);
  } };
}
