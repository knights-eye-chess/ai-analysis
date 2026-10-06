import { createPocToolHost as createInternalToolHost, type PocToolHostOptions } from './poc-tools';
import type { ReasoningPositionContext } from './poc-contracts';
import { toLegacyPositionAnalysisProvider, type CompatiblePositionAnalysisProvider } from './position-analysis-contracts';

export type AnswerToolHostOptions = Omit<PocToolHostOptions, 'analyzer'> & { analyzer?: CompatiblePositionAnalysisProvider };
/** Public analyzer contract; the existing evidence protocol retains its versioned legacy spelling. */
export function createPocToolHost(context: ReasoningPositionContext, options: AnswerToolHostOptions = {}) {
  return createInternalToolHost(context, { ...options,
    analyzer: options.analyzer ? toLegacyPositionAnalysisProvider(options.analyzer) : undefined });
}
