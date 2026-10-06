import {
  EXISTING_ANALYSIS_CONTEXT_MODE,
  ExistingAnalysisObservationProvider,
  normalizeExistingAnalysisContext,
  type ExistingAnalysisContextMode,
} from "./existing-analysis-context";
import { ChessFactObservationProvider } from "./fact-observation-provider";
import { MechanicalChessFactProvider } from "./mechanical-fact-provider";
import { CompositeObservationProvider, DeterministicObservationProvider } from "./poc-observations";
import type { ReasoningPositionContext } from "./poc-contracts";

/**
 * The production pre-semantic observation composition.  It is deliberately
 * environment-neutral: browser and evaluation callers share exactly the same
 * deterministic, mechanical-fact, and attributed-existing-analysis inputs.
 */
export const PRODUCTION_OBSERVATION_PROVIDER_VERSION = "production-observation-provider/1" as const;

export type ProductionObservationProviderInput = {
  existingAnalysis?: unknown;
  context?: ReasoningPositionContext;
  question?: string;
  existingAnalysisContextMode?: ExistingAnalysisContextMode;
};

export function createProductionObservationProvider(input: ProductionObservationProviderInput = {}) {
  const context = input.context;
  const question = input.question || "";
  const mode = input.existingAnalysisContextMode || EXISTING_ANALYSIS_CONTEXT_MODE.FULL;
  return new CompositeObservationProvider([
    new DeterministicObservationProvider(),
    new ChessFactObservationProvider(new MechanicalChessFactProvider(), {
      maxRecords: 24,
      maxBytes: 20_000,
    }),
    new ExistingAnalysisObservationProvider(
      context ? normalizeExistingAnalysisContext(input.existingAnalysis ?? null, context, { question }) : null,
      mode,
    ),
  ]);
}
