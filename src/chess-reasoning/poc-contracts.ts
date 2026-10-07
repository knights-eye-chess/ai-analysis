import { materialAlongLine } from './material-accounting';
import { Chess, type Square } from "chess.js";
import { createPocIdentityTimeline } from "./poc-piece-refs";
import { moveMechanismFacts } from "./move-mechanism-facts";
import { withEvidenceLicenses, type EvidenceLicense } from "./evidence-licenses";
import { stableHash } from "./stable";
import type { ProofStrength, SemanticAttributes, SemanticEntity, SemanticParticipant, SemanticRelation, SemanticValue } from "./types";

export const REASONING_POC_VERSION = "conceptual-explanation-poc/57" as const;
export const REASONING_POC_MAX_OUTPUT_TOKENS = 2_000;
export const REASONING_POC_MAX_HYPOTHESIS_OUTPUT_TOKENS = 4_000;
export const REASONING_POC_MAX_CRITIC_OUTPUT_TOKENS = 7_000;
export const REASONING_POC_MAX_TERMINAL_REVIEW_OUTPUT_TOKENS = 4_000;
export const REASONING_POC_MAX_RESOLUTION_AUDIT_OUTPUT_TOKENS = 3_000;
/**
 * The optional future-purpose planner may choose one already-supported,
 * bounded probe. It never writes semantic hypotheses, so it gets a smaller
 * transport budget than the hypothesis and critic stages.
 */
export const REASONING_POC_MAX_PURPOSE_PROBE_OUTPUT_TOKENS = 1_500;
export const REASONING_POC_MAX_GRAPH_SELECTION_OUTPUT_TOKENS = 2_000;
export const REASONING_POC_MAX_DISCOURSE_OUTPUT_TOKENS = 2_500;
export const REASONING_POC_MAX_RENDER_OUTPUT_TOKENS = 4_000;
export const REASONING_POC_MAX_HYPOTHESIS_BATCHES = 2;
export const REASONING_POC_RESERVED_MANDATORY_STEPS = 11;
export const REASONING_POC_REVISION_EVIDENCE_ALLOWANCE = 1;
/** One opt-in slot for the bounded future-purpose planner; base profiles stay unchanged. */
export const REASONING_POC_PURPOSE_PROBE_ALLOWANCE = 1;
/** One opt-in slot for a complete replacement of structurally invalid critic output. */
export const REASONING_POC_CRITIC_CORRECTION_ALLOWANCE = 1;

export type ReasoningPositionContext = {
  kind?: "position"; // Explicit root-position question; absent means the existing move contract.
  nodeId: string;
  parentNodeId?: string;
  historyStartFen?: string;
  fenBefore: string;
  fenAfter: string;
  historyUci: string[];
  moveUci: string;
  moveSan: string;
};

export type ReasoningAudience = "beginner" | "intermediate" | "advanced";

export type ReasoningGraphRequirements = {
  minimumEntities: number;
  minimumRelations: number;
};

export type QueryContract = {
  schemaVersion: typeof REASONING_POC_VERSION;
  requestId: string;
  question: string;
  requestedConclusion: "move-idea" | "position-question";
  responseCoverageRequirement: "none" | "bounded-class";
  continuationCoverageRequirement: "none" | "principal-variation";
  minimumContinuationLines: number;
  graphRequirements: ReasoningGraphRequirements;
  audience: ReasoningAudience;
  concise: boolean;
  nodeId: string;
};

export type ReasoningRunControls = {
  maxModelSteps: number;
  maxToolCalls: number;
  maxProbeCalls: number;
  maxEvidenceRecords: number;
  maxObservationRecords: number;
  maxObservationsPresented: number;
  maxHypotheses: number;
  maxOutputChars: number;
  maxProviderOutputChars: number;
  maxWallTimeMs: number;
};

export const DEFAULT_REASONING_RUN_CONTROLS: Readonly<ReasoningRunControls> = Object.freeze({
  maxModelSteps: 15,
  maxToolCalls: 16,
  maxProbeCalls: 5,
  maxEvidenceRecords: 48,
  maxObservationRecords: 48,
  maxObservationsPresented: 16,
  maxHypotheses: 16,
  maxOutputChars: 2_400,
  maxProviderOutputChars: 64_000,
  maxWallTimeMs: 30_000,
});

export type ReasoningEvidenceKind = "context" | "fact" | "probe" | "graph" | "observation-review" | "reasoning-challenge" | "hypothesis-review" | "critic-resolution-audit";

export type ReasoningEvidenceRecord = {
  schemaVersion: typeof REASONING_POC_VERSION;
  id: string;
  contextHash: string;
  kind: ReasoningEvidenceKind;
  source: string;
  proofStrength: ProofStrength | null;
  licenses?: EvidenceLicense[];
  summary: string;
  data: Record<string, SemanticValue>;
  coverage: {
    complete: boolean;
    covered: string[];
    unresolved: string[];
  } | null;
  replay: Record<string, SemanticValue> | null;
};

export type ReasoningToolName =
  | "finish_evidence_collection"
  | "review_observations"
  | "challenge_reasoning"
  | "record_hypotheses"
  | "review_hypotheses"
  | "finalize_reasoning_review"
  | "audit_critic_resolutions"
  | "analyze_game_position"
  | "test_game_line"
  | "inspect_position"
  | "analyze_move"
  | "explore_continuations"
  | "compare_moves"
  | "enumerate_defenses"
  | "test_line"
  | "trace_idea"
  | "explain_plan";

export type ReasoningToolSupport = "supported" | "insufficient-evidence" | "unsupported";

export type ReasoningToolResult = {
  schemaVersion: typeof REASONING_POC_VERSION;
  callId: string;
  tool: ReasoningToolName;
  contextHash: string;
  support: ReasoningToolSupport;
  data: Record<string, SemanticValue>;
  evidence: ReasoningEvidenceRecord[];
  limitations: string[];
  durationMs: number;
};

export type ReasoningToolDescriptor = {
  name: ReasoningToolName;
  description: string;
  category: "fact" | "probe" | "graph";
  inputSchema: Record<string, unknown>;
};

export interface ReasoningToolSet {
  /** Native hosts reserve engine slots after legality checks, at dispatch. */
  reservesSearchAtDispatch?: boolean;
  descriptors(): ReasoningToolDescriptor[];
  execute(
    name: ReasoningToolName,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    execution?: ReasoningToolExecutionContext,
  ): Promise<ReasoningToolResult>;
  seedEvidence?(records: Iterable<ReasoningEvidenceRecord>): void;
}

export type ReasoningHypothesisProvenance = {
  provider: string;
  version: string;
  origin: "model" | "learned-provider" | "reviewed-annotation" | "user";
};

export type ReasoningToolExecutionContext = {
  hypothesisProvenance?: ReasoningHypothesisProvenance;
  /** Reserve an answer-budgeted engine search after input/legality validation. */
  reserveSearch?: () => boolean;
  /** Reserve one answer-budgeted engine search before a PV endpoint continuation. */
  reserveAdditionalSearch?: () => boolean;
  /** Actual completed analyzer outcome; failed dispatches still consume attempts. */
  recordSearchOutcome?: (outcome: 'succeeded' | 'failed') => void;
};

export type ReasoningProbeRecipe = {
  tool: "inspect_position" | "analyze_move" | "enumerate_defenses" | "test_line";
  input: Record<string, SemanticValue>;
  purpose: string;
};

export type ReasoningObservation = {
  schemaVersion: typeof REASONING_POC_VERSION;
  id: string;
  contextHash: string;
  observationType: string;
  participants: SemanticParticipant[];
  attributes: Record<string, SemanticValue>;
  exactness: "exact" | "heuristic";
  provenance: {
    provider: string;
    version: string;
    trust: "deterministic" | "learned" | "external";
    methods: string[];
  };
  factEvidenceIds: string[];
  probeRecipes: ReasoningProbeRecipe[];
};

export type ReasoningObservationSet = {
  schemaVersion: typeof REASONING_POC_VERSION;
  contextHash: string;
  observations: ReasoningObservation[];
  evidence: ReasoningEvidenceRecord[];
  providers: Array<{ provider: string; version: string }>;
  limitations: string[];
};

export type ReasoningRankedObservation = ReasoningObservation & {
  salience: number;
  salienceReasons: string[];
  presentedToModel: boolean;
};

export type ReasoningRankedObservationSet = Omit<ReasoningObservationSet, "observations"> & {
  observations: ReasoningRankedObservation[];
  saliencePolicy: string;
};

/**
 * The model-facing observation catalogue deliberately excludes the embedded
 * evidence array. Evidence is transmitted once, through the separately
 * licensed `evidence` field on HypothesisProviderInput. Keeping this shape
 * explicit prevents an omitted observation or a duplicate evidence payload
 * from leaking back into an isolated semantic stage.
 */
export type ReasoningProviderObservationSet = Omit<ReasoningRankedObservationSet, "observations" | "evidence"> & {
  observations: Array<Pick<ReasoningRankedObservation,
    "id" | "observationType" | "participants" | "attributes" | "exactness" |
    "provenance" | "factEvidenceIds" | "probeRecipes" | "salience" |
    "salienceReasons" | "presentedToModel"
  >>;
};

export interface ObservationProvider {
  readonly id: string;
  readonly version: string;
  observe(context: ReasoningPositionContext, controls: ReasoningRunControls, signal?: AbortSignal): Promise<ReasoningObservationSet> | ReasoningObservationSet;
}

export interface SaliencePolicy {
  readonly id: string;
  rank(observations: ReasoningObservationSet, contract: QueryContract, graphContext?: Record<string, SemanticValue>): ReasoningRankedObservationSet;
}

export type ReasoningHypothesisRelationProposal = {
  relationType: string;
  from: string;
  to: string;
  attributes: SemanticAttributes;
  evidenceIds: string[];
  sourceObservationIds: string[];
};

export type HypothesisProviderInput = {
  mode: "initial" | "revision";
  correction?: {
    attempt: 1;
    rejectionStage: string;
    rejectionCode: string;
    rejectionDetails: string;
    previousInvalidBatch: {
      hypotheses: ReasoningHypothesisProposal[];
      relations: ReasoningHypothesisRelationProposal[];
    };
    instruction: string;
  };
  revisionObligations: {
    minimumNewHypotheses: 1;
    reopenedGaps: Array<Pick<ReasoningChallengeDecision["observationAudits"][number],
      "observationId" | "missingLink" | "omissionImpact" | "representedHypothesisIds"
    >>;
    novelHypothesisNeeded: boolean;
    questionCoverageRationale: string;
    hypothesisFindings: ReasoningCriticFinding[];
  } | null;
  contract: QueryContract;
  context: ReasoningPositionContext;
  observations: ReasoningProviderObservationSet;
  evidence: Array<Pick<ReasoningEvidenceRecord, "id" | "kind" | "source" | "proofStrength" | "licenses" | "summary" | "data" | "coverage" | "replay">>;
  existingHypotheses: Array<Pick<ReasoningHypothesisRecord,
    "id" | "localId" | "entityType" | "concepts" | "owner" | "participants" | "attributes" |
    "proofStrength" | "evidenceIds" | "sourceObservationIds" | "parentHypothesisIds" |
    "anchorRequirements" | "origin" | "provenance" | "status"
  >>;
  existingRelations: Array<Pick<ReasoningHypothesisRelationRecord,
    "id" | "relationType" | "fromHypothesisId" | "toHypothesisId" | "attributes" |
    "evidenceIds" | "sourceObservationIds"
  >>;
  challenge: ReasoningChallengeDecision | null;
  inspectionLenses: {
    version: string;
    authority: "non-evidentiary";
    items: Array<{ id: string; families: string[]; text: string }>;
  };
  allowedVocabulary: {
    entityTypes: string[];
    concepts: string[];
    relationTypes: string[];
    participantRoles: string[];
  };
  allowedEvidenceIds: string[];
  allowedReferences: Array<{ domain: string; id: string }>;
  maxOutputTokens: number;
};

export type HypothesisProviderResult = {
  batch: {
    hypotheses: ReasoningHypothesisProposal[];
    relations: ReasoningHypothesisRelationProposal[];
  };
  provenance: ReasoningHypothesisProvenance;
  steps?: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  diagnostics?: ReasoningRuntimeDiagnostic[];
};

export interface HypothesisProvider {
  readonly id: string;
  readonly version: string;
  propose(input: HypothesisProviderInput, signal?: AbortSignal): Promise<HypothesisProviderResult>;
}

export type ReasoningAnchorRequirement = {
  participant: SemanticParticipant;
  disposition: "required";
};

export type ReasoningHypothesisProposal = {
  localId: string;
  entityType: string;
  concepts: string[];
  owner: "w" | "b" | null;
  participants: SemanticParticipant[];
  attributes: SemanticAttributes;
  proofStrength: ProofStrength | null;
  evidenceIds: string[];
  sourceObservationIds: string[];
  parentHypothesisIds: string[];
  anchorRequirements: ReasoningAnchorRequirement[];
};

export type ReasoningHypothesisStatus = "proposed" | "needs-probe" | "accepted" | "rejected" | "superseded";

export type ReasoningHypothesisRecord = ReasoningHypothesisProposal & {
  schemaVersion: typeof REASONING_POC_VERSION;
  id: string;
  contextHash: string;
  origin: "model" | "learned-provider" | "reviewed-annotation" | "user";
  provenance: { provider: string; version: string };
  status: ReasoningHypothesisStatus;
  review: { rationale: string; supersededBy: string[] } | null;
};

export type ReasoningHypothesisRelationRecord = {
  schemaVersion: typeof REASONING_POC_VERSION;
  id: string;
  contextHash: string;
  relationType: string;
  fromHypothesisId: string;
  toHypothesisId: string;
  attributes: SemanticAttributes;
  evidenceIds: string[];
  sourceObservationIds: string[];
};

export type ReasoningHypothesisDecision = {
  hypothesisId: string;
  disposition: "accept" | "reject" | "needs-probe" | "supersede";
  rationale: string;
  supersededBy: string[];
};

export type ReasoningObservationDispositionState =
  | "used"
  | "irrelevant"
  | "duplicate"
  | "needs-probe"
  | "unaddressed"
  | "deferred-by-harness-budget"
  | "not-presented-to-model";

export type ReasoningObservationDecision = {
  observationId: string;
  disposition: "used" | "irrelevant" | "duplicate" | "needs-probe";
  rationale: string;
  hypothesisIds: string[];
  duplicateOfObservationId: string | null;
  probeCallIds: string[];
};

export type ReasoningObservationCoverage = {
  observationId: string;
  state: ReasoningObservationDispositionState;
  rationale: string | null;
  hypothesisIds: string[];
  duplicateOfObservationId: string | null;
  probeCallIds: string[];
};

export type ReasoningChallengeObservationAudit = {
  observationId: string;
  action: "retain" | "reopen";
  rationale: string;
  missingLink: string | null;
  omissionImpact: "preserves-conclusion" | "weakens-conclusion" | "uncertain";
  representedHypothesisIds: string[];
};

export type ReasoningCriticFindingKind =
  | "missing-link"
  | "evidence-mismatch"
  | "question-irrelevant"
  | "overstated"
  | "redundant";

export type ReasoningCriticFinding = {
  id: string;
  hypothesisId: string;
  kind: ReasoningCriticFindingKind;
  issue: string;
};

export type ReasoningCriticFindingResolutionDisposition =
  | "rejected"
  | "superseded"
  | "retained-with-new-evidence"
  | "retained-safe-to-omit"
  | "resolved-by-associated-hypotheses"
  | "resolved-existing-evidence";

export type ReasoningCriticFindingResolution = {
  findingId: string;
  hypothesisId: string;
  disposition: ReasoningCriticFindingResolutionDisposition;
  rationale: string;
  evidenceIds: string[];
  supersededBy: string[];
  resolvedByHypothesisIds: string[];
};

export type ReasoningCriticResolutionAuditDecision = {
  findingId: string;
  hypothesisId: string;
  outcome: "resolved" | "unresolved";
  rationale: string;
};

export type ReasoningCriticResolutionAudit = {
  decisions: ReasoningCriticResolutionAuditDecision[];
  batchRationale: string;
};

/**
 * Compact provenance that a completed critic audit found an already accepted
 * hypothesis to represent a bounded causal or continuation meaning. It is an
 * omission-audit signal only: it adds neither chess proof nor evidence
 * authority, and is deliberately not a retained copy of the raw critic row.
 */
export type ReasoningSemanticPreservationSignal = {
  hypothesisId: string;
  auditKind: "causal-evidence" | "continuation-activity";
  evidenceId: string;
  rootMove: string | null;
  routeMoves: string[];
  contact: {
    attackedSquare: string;
    targetMoverPieceId: string | null;
    targetMoveUci: string | null;
    continuationPieceId: string;
    contactMoveUci: string;
  } | null;
  rationale: string;
};

export type ReasoningChallengeDecision = {
  hypothesisIds: string[];
  observationAudits: ReasoningChallengeObservationAudit[];
  hypothesisFindings: ReasoningCriticFinding[];
  semanticPreservationSignals: ReasoningSemanticPreservationSignal[];
  novelHypothesisNeeded: boolean;
  questionCoverageRationale: string;
};

export type ReasoningClaimKind = "fact" | "interpretation" | "consequence" | "defense" | "uncertainty";

export type ReasoningPieceKind = "bishop" | "king" | "knight" | "pawn" | "queen" | "rook";
export type ReasoningPieceReferenceForm = "definite" | "color-qualified" | "square-qualified" | "canonical" | "bare" | "bare-square-qualified";

export type ReasoningNarrativeSegment =
  | { type: "text"; text: string }
  | { type: "piece"; pieceId: string; form?: ReasoningPieceReferenceForm; capitalize?: boolean; label?: string }
  | { type: "piece-kind"; pieceKind: ReasoningPieceKind; color: "w" | "b" | null; label?: string }
  | { type: "square"; square: string; label?: string }
  | { type: "move"; uci: string; pieceId: string; san?: string; label?: string }
  | { type: "entity"; entityId: string; label?: string }
  | { type: "relation"; relationId: string; fromEntityId: string; toEntityId: string; label?: string };

export type ResolvedReasoningNarrativeSegment =
  | { type: "text"; text: string }
  | { type: "piece"; pieceId: string; square: string | null; label: string }
  | { type: "piece-kind"; pieceKind: ReasoningPieceKind; color: "w" | "b" | null; label: string }
  | { type: "square"; square: string; label: string }
  | { type: "move"; uci: string; pieceId: string; from: string; to: string; san: string; label: string }
  | { type: "entity"; entityId: string; label: string }
  | { type: "relation"; relationId: string; fromEntityId: string; toEntityId: string; relationType: string; label: string };

export type ReasoningGraphReference =
  | { type: "entity"; entityId: string }
  | { type: "relation"; relationId: string; fromEntityId: string; toEntityId: string };

export type ReasoningClaim = {
  id: string;
  kind: ReasoningClaimKind;
  content: ReasoningNarrativeSegment[];
  proofStrength: ProofStrength | null;
  evidenceIds: string[];
  graphRefs: ReasoningGraphReference[];
};

export type ValidatedReasoningClaim = Omit<ReasoningClaim, "content"> & {
  content: ResolvedReasoningNarrativeSegment[];
  text: string;
  graphEvidenceId: string | null;
};

export type ReasoningMoveInput = { uci: string; pieceId: string };

type ReasoningDraftGraphCoverage = { graphRefs: ReasoningGraphReference[]; intentId?: string };

export type ReasoningDraftDemonstration =
  | ({ id: string; type: "legal-variation"; start: "before" | "after"; moves: ReasoningMoveInput[]; label: string; evidenceIds: string[] } & ReasoningDraftGraphCoverage)
  | ({ id: string; type: "conditional-route"; pieceId: string; waypoints: string[]; prerequisiteRefs: ReasoningNarrativeSegment[]; label: string; evidenceIds: string[] } & ReasoningDraftGraphCoverage)
  | ({ id: string; type: "static-relationship"; from: ReasoningNarrativeSegment; to: ReasoningNarrativeSegment; relationType: string; label: string; evidenceIds: string[] } & ReasoningDraftGraphCoverage);

export type ResolvedReasoningMove = ReasoningMoveInput & { from: string; to: string; san: string; resultingFen: string };

export type ReasoningDemonstration =
  ((Omit<Extract<ReasoningDraftDemonstration, { type: "legal-variation" }>, "moves"> & { moves: ResolvedReasoningMove[] })
   | (Omit<Extract<ReasoningDraftDemonstration, { type: "conditional-route" }>, "prerequisiteRefs"> & { prerequisiteRefs: ResolvedReasoningNarrativeSegment[] })
   | (Omit<Extract<ReasoningDraftDemonstration, { type: "static-relationship" }>, "from" | "to"> & { from: ResolvedReasoningNarrativeSegment; to: ResolvedReasoningNarrativeSegment }))
  & { graphEvidenceId: string | null };

export type BoardAnnotation = { kind: "arrow" | "highlight"; from?: string; to: string; sourceRefType: "move" | "piece" | "square" | "route" };

export type ReasoningClaimScope = "conditional-plan" | "bounded-consequence" | "position-fact";

export type ReasoningDefenseCoverage = {
  completeWithinClass: boolean;
  completeForAllResponses: boolean;
  coveredClasses: string[];
  unresolvedClasses: string[];
  evidenceIds: string[];
};

export type ReasoningValidationIssue = {
  path: string;
  code: string;
  message: string;
  permittedReferences: string[];
};

export type ReasoningDraft = {
  claimScope: ReasoningClaimScope;
  defenseCoverage: ReasoningDefenseCoverage;
  claims: ReasoningClaim[];
  demonstrations: ReasoningDraftDemonstration[];
  limitations: string[];
};

export type ReasoningModelNarrativeSegment =
  | Extract<ReasoningNarrativeSegment, { type: "text" }>
  | Omit<Extract<ReasoningNarrativeSegment, { type: "piece" }>, "label">
  | Omit<Extract<ReasoningNarrativeSegment, { type: "piece-kind" }>, "label">
  | Omit<Extract<ReasoningNarrativeSegment, { type: "square" }>, "label">
  | Omit<Extract<ReasoningNarrativeSegment, { type: "move" }>, "label">
  | Omit<Extract<ReasoningNarrativeSegment, { type: "entity" }>, "label">
  | Omit<Extract<ReasoningNarrativeSegment, { type: "relation" }>, "label">;

export type ReasoningModelDraftClaim = Omit<ReasoningClaim, "content" | "graphRefs"> & {
  content: ReasoningModelNarrativeSegment[];
};

export type ReasoningModelDraftDemonstration =
  | Omit<Extract<ReasoningDraftDemonstration, { type: "legal-variation" }>, "graphRefs">
  | (Omit<Extract<ReasoningDraftDemonstration, { type: "conditional-route" }>, "graphRefs" | "prerequisiteRefs"> & {
      prerequisiteRefs: ReasoningModelNarrativeSegment[];
    })
  | {
      id: string;
      type: "static-relationship";
      relation: Extract<ReasoningModelNarrativeSegment, { type: "relation" }>;
      label: string;
      evidenceIds: string[];
    };

export type ReasoningModelDraft = {
  claimScope: ReasoningClaimScope;
  defenseCoverage: ReasoningDefenseCoverage;
  claims: ReasoningModelDraftClaim[];
  demonstrations: ReasoningModelDraftDemonstration[];
  limitations: string[];
};

export type ReasoningRenderNarrativeSegment =
  | Exclude<ReasoningModelNarrativeSegment, { type: "relation" | "entity" }>
  | { type: "entity"; entityId: string; label?: string };

export type ReasoningRenderDraftClaim = Omit<ReasoningModelDraftClaim, "content"> & {
  content: ReasoningRenderNarrativeSegment[];
  entityIds: string[];
};

export type ReasoningRenderDraftDemonstration =
  // A legal variation is selected, not re-authored, by the presentation model.
  // The frozen discourse intent identifies the bounded witness; the Harness
  // replays that witness and attaches its exact moves, stable identities,
  // evidence, and display label after structured output is parsed.
  | { type: "legal-variation"; intentId: string }
  | (Omit<Extract<ReasoningModelDraftDemonstration, { type: "conditional-route" }>, "prerequisiteRefs"> & {
      intentId?: string;
      prerequisiteRefs: ReasoningRenderNarrativeSegment[];
    });

export type ReasoningRenderDraft = {
  claims: ReasoningRenderDraftClaim[];
  demonstrations: ReasoningRenderDraftDemonstration[];
};

export const REASONING_DISCOURSE_PLAN_VERSION = "reasoning-discourse-plan/2" as const;

export type ReasoningDiscourseRole = "main-idea" | "mechanism" | "practical-consequence" | "qualification";

export type ReasoningDiscourseParagraph = {
  id: string;
  role: ReasoningDiscourseRole;
  claimKind: ReasoningClaimKind;
  objective: string;
  entityIds: string[];
  relationIds: string[];
  evidenceIds: string[];
};

export type ReasoningDiscourseRelationAction = {
  relationId: string;
  label: string;
};

export type ReasoningDiscourseDemonstrationIntent = {
  id: string;
  paragraphId: string;
  type: "legal-variation" | "conditional-route";
  evidenceIds: string[];
  objective: string;
};

export type ReasoningDiscoursePlan = {
  schemaVersion: typeof REASONING_POC_VERSION;
  planVersion: typeof REASONING_DISCOURSE_PLAN_VERSION;
  id: string;
  checkpointId: string;
  paragraphs: ReasoningDiscourseParagraph[];
  relationActions: ReasoningDiscourseRelationAction[];
  demonstrationIntents: ReasoningDiscourseDemonstrationIntent[];
};

export type ReasoningDiscoursePlanDraft = Pick<ReasoningDiscoursePlan, "paragraphs" | "relationActions" | "demonstrationIntents">;

export type ReasoningCheckpointEvidenceSummary = {
  id: string;
  kind: ReasoningEvidenceKind;
  source: string;
  proofStrength: ProofStrength | null;
  licenses: EvidenceLicense[];
  summary: string;
  details: Record<string, SemanticValue>;
  coverage: ReasoningEvidenceRecord["coverage"];
};

export type ReasoningReferenceScope = {
  pieceIds: string[];
  squares: string[];
  moves: Array<ReasoningMoveInput & { san: string }>;
};

export type ReasoningCheckpointReferenceBindings = {
  target: ReasoningReferenceScope;
  evidence: Array<{ evidenceId: string } & ReasoningReferenceScope>;
  entities: Array<{ entityId: string } & ReasoningReferenceScope>;
  relations: Array<{ relationId: string } & ReasoningReferenceScope>;
};

export type ReasoningCheckpoint = {
  schemaVersion: typeof REASONING_POC_VERSION;
  checkpointVersion: "reasoning-checkpoint/5";
  id: string;
  requestId: string;
  contextHash: string;
  question: string;
  audience: ReasoningAudience;
  concise: boolean;
  requestedConclusion: QueryContract["requestedConclusion"];
  hypothesisLedgerRevision: string;
  observationCoverage: ReasoningObservationCoverage[];
  reviewedHypotheses: ReasoningHypothesisRecord[];
  selectedGraph: {
    evidenceId: string;
    graphHash: string;
    entities: SemanticEntity[];
    relations: SemanticRelation[];
  };
  presentation: {
    entities: Array<{ entityId: string; label: string }>;
    relations: Array<{ relationId: string; fromEntityId: string; toEntityId: string; label: string }>;
  };
  approvedEvidence: ReasoningCheckpointEvidenceSummary[];
  claimScope: ReasoningClaimScope;
  defenseCoverage: ReasoningDefenseCoverage;
  limitations: string[];
  referenceBindings: ReasoningCheckpointReferenceBindings;
  allowlists: {
    evidenceIds: string[];
    pieceIds: string[];
    squares: string[];
    moves: Array<ReasoningMoveInput & { san: string }>;
    entityIds: string[];
    relations: Array<{ relationId: string; fromEntityId: string; toEntityId: string }>;
  };
  obligations: {
    requestedConclusion: QueryContract["requestedConclusion"];
    responseCoverageRequirement: QueryContract["responseCoverageRequirement"];
    continuationCoverageRequirement: QueryContract["continuationCoverageRequirement"];
    minimumContinuationLines: number;
    graphRequirements: ReasoningGraphRequirements;
    entityIds: string[];
    relations: Array<{ relationId: string; fromEntityId: string; toEntityId: string }>;
    requireInterpretationClaim: boolean;
    requireConditionalQualification: boolean;
  };
};

export type ReasoningCompletionStage = "semantic-incomplete" | "reasoned-unrendered" | "render-invalid" | "complete";

export type ReasoningStructuralOutcome = "incomplete" | "complete";
export type ReasoningNarrativeOutcome = "not-attempted" | "unrendered" | "invalid" | "valid";
export type ReasoningInteractionCoverage = {
  status: "not-assessed" | "partial" | "complete";
  semanticReferenceCount: number;
  interactiveReferenceCount: number;
  genericReferenceCount: number;
  coverageRatio: number | null;
  gaps: Array<{ path: string; type: "piece-kind" | "off-board-piece" | "unbound-entity" | "unbound-relation" | "indistinguishable-entity-label"; label: string }>;
};

export type ReasoningRenderMetrics = {
  inputBytes: number | null;
  generatedJsonBytes: number;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
  validationResult: "not-attempted" | "unparseable" | "invalid" | "valid";
};

export type ReasoningToolTrace = {
  callId: string;
  tool: ReasoningToolName;
  input: Record<string, unknown>;
  support: ReasoningToolSupport;
  evidenceIds: string[];
  durationMs: number;
  error?: string;
};

export type ReasoningHarnessPhase =
  | "observations-presented"
  | "hypothesis-submission-required"
  | "hypotheses-recorded"
  | "observations-reviewed"
  | "future-purpose-planning"
  | "reasoning-challenged"
  | "hypotheses-revised"
  | "hypotheses-reviewed"
  | "critic-resolutions-audited"
  | "graph-materialized"
  | "checkpoint-frozen"
  | "discourse-planning"
  | "discourse-planning-repair"
  | "discourse-planned"
  | "draft-render"
  | "draft-generated"
  | "draft-repair";

export type ReasoningRuntimeDiagnostic = {
  step: number;
  provider: string;
  model: string;
  route: string;
  sdkRuntime: string;
  reasoningEffort: string;
  outcome: "succeeded" | "failed" | "aborted";
  httpStatus: number | null;
  providerRequestId: string | null;
  latencyMs: number | null;
  retryCount: number | null;
  finishReason: string | null;
  contentPartCount: number;
  textBytes: number;
  toolCallCount: number;
  toolCallBytes: number;
  structuredOutputBytes: number;
  reasoningPartCount: number;
  reasoningBytes: number;
  reasoningDetailsPresent: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  outputTokenLimit: number;
  requestContextBytes: number | null;
  requestMessageCount: number | null;
  contextCompacted: boolean;
  lastHarnessPhase: ReasoningHarnessPhase;
  errorCategory: string | null;
  structuredOutputRecovery?: "locally-validated-json" | null;
  /** Transport-only structured-output retry metadata for bounded stage recovery. */
  recoveryAttempt?: number | null;
  recoveryTrigger?: "output-truncated" | "output-missing" | null;
  hypothesisRejectionStage?: "provider-structured-output" | "schema-validation" | "harness-validation" | null;
  hypothesisRejectionCode?: "no-output" | "parse" | "schema" | "unknown-reference-or-evidence" | "unsupported-concept" | "anchor-incompatibility" | "supersession-lineage" | "critic-resolution-evidence" | "critic-resolution-incompatibility" | "used-observation-orphaned" | "empty-batch" | "evidence-license" | "proof-overstatement" | "malformed-structure" | "relation-or-budget" | "harness-validation" | null;
  abortSource: "external" | "wall-time" | "provider" | null;
};

export class ModelRuntimeFailure extends Error {
  readonly runtime: string;
  readonly model: string;
  readonly diagnostics: ReasoningRuntimeDiagnostic[];
  readonly usage: { inputTokens: number | null; outputTokens: number | null };

  constructor(input: {
    runtime: string;
    model: string;
    diagnostics: ReasoningRuntimeDiagnostic[];
    usage: { inputTokens: number | null; outputTokens: number | null };
  }) {
    super(`Model runtime failed: ${input.diagnostics.at(-1)?.errorCategory || "unknown"}`);
    this.name = "ModelRuntimeFailure";
    this.runtime = input.runtime;
    this.model = input.model;
    this.diagnostics = input.diagnostics.map((item) => ({ ...item }));
    this.usage = { ...input.usage };
  }
}

export type ModelRunRequest = {
  schemaVersion: typeof REASONING_POC_VERSION;
  contract: QueryContract;
  context: ReasoningPositionContext;
  contextHash: string;
  observations: ReasoningRankedObservationSet;
  controls: ReasoningRunControls;
};

export type ModelRunResult = {
  runtime: string;
  model: string;
  draft?: ReasoningDraft;
  trace: ReasoningToolTrace[];
  steps: number;
  usage: { inputTokens: number | null; outputTokens: number | null };
  diagnostics?: ReasoningRuntimeDiagnostic[];
};

export interface ModelRuntime {
  run(request: ModelRunRequest, tools: ReasoningToolSet, signal?: AbortSignal): Promise<ModelRunResult>;
  replaySemanticStage?(request: ModelSemanticStageReplayRequest, signal?: AbortSignal): Promise<ModelSemanticStageReplayResult>;
  planDiscourse?(request: ModelDiscoursePlanRequest, signal?: AbortSignal): Promise<ModelDiscoursePlanResult>;
  renderCheckpoint?(request: ModelRenderRequest, signal?: AbortSignal): Promise<ModelRenderResult>;
  repairDraft?(request: ModelDraftRepairRequest, signal?: AbortSignal): Promise<ModelDraftRepairResult>;
}

export type ReasoningSemanticReplayStage =
  | "hypothesis-initial"
  | "hypothesis-revision"
  | "future-purpose-probe"
  | "reasoning-critic"
  | "critic-resolution-audit"
  | "answer-obligation-and-graph-selection"
  | "graph-selection";

export type ModelSemanticStageReplayRequest = {
  schemaVersion: typeof REASONING_POC_VERSION;
  stage: ReasoningSemanticReplayStage;
  input: Record<string, unknown>;
};

export type ModelSemanticStageReplayResult = {
  runtime: string;
  model: string;
  stage: ReasoningSemanticReplayStage;
  output: Record<string, unknown>;
  usage: { inputTokens: number | null; outputTokens: number | null };
  diagnostics?: ReasoningRuntimeDiagnostic[];
};

export type ModelDiscoursePlanRequest = {
  schemaVersion: typeof REASONING_POC_VERSION;
  contract: QueryContract;
  context: ReasoningPositionContext;
  contextHash: string;
  checkpoint: ReasoningCheckpoint;
};

export type ModelDiscoursePlanResult = {
  runtime: string;
  model: string;
  plan: ReasoningDiscoursePlan;
  usage: { inputTokens: number | null; outputTokens: number | null };
  diagnostics?: ReasoningRuntimeDiagnostic[];
};

export type ModelRenderRequest = {
  schemaVersion: typeof REASONING_POC_VERSION;
  contract: QueryContract;
  context: ReasoningPositionContext;
  contextHash: string;
  checkpoint: ReasoningCheckpoint;
  discoursePlan?: ReasoningDiscoursePlan;
  maxOutputChars: number;
  previousValidationIssues?: ReasoningValidationIssue[];
};

export type ModelRenderResult = {
  runtime: string;
  model: string;
  draft: ReasoningDraft;
  usage: { inputTokens: number | null; outputTokens: number | null };
  diagnostics?: ReasoningRuntimeDiagnostic[];
  metrics: ReasoningRenderMetrics;
};

export type ModelDraftRepairRequest = {
  schemaVersion: typeof REASONING_POC_VERSION;
  contract: QueryContract;
  context: ReasoningPositionContext;
  contextHash: string;
  originalDraft: ReasoningDraft;
  issues: ReasoningValidationIssue[];
  frozen: {
    observationCoverage: ReasoningObservationCoverage[];
    hypothesisLedgerRevision: string;
    hypothesisIds: string[];
    relationIds: string[];
    graphEvidenceIds: string[];
    evidenceIds: string[];
    referenceAllowlists: {
      pieceIds: string[];
      squares: string[];
      moves: Array<{ uci: string; pieceId: string; san: string }>;
    };
    referenceBindings: ReasoningCheckpointReferenceBindings;
    claimScope: ReasoningClaimScope;
    defenseCoverage: ReasoningDefenseCoverage;
  };
  maxOutputChars: number;
};

export type ModelDraftRepairResult = {
  runtime: string;
  model: string;
  draft: ReasoningDraft;
  usage: { inputTokens: number | null; outputTokens: number | null };
  diagnostics?: ReasoningRuntimeDiagnostic[];
};

export type ValidatedReasoningAnswer = {
  schemaVersion: typeof REASONING_POC_VERSION;
  requestId: string;
  contextHash: string;
  status: "supported" | "partial" | "fact-only";
  completionStage: ReasoningCompletionStage;
  reasoningOutcome: ReasoningStructuralOutcome;
  narrativeOutcome: ReasoningNarrativeOutcome;
  interactionCoverage: ReasoningInteractionCoverage;
  reasoningCheckpoint: ReasoningCheckpoint | null;
  discoursePlan: ReasoningDiscoursePlan | null;
  renderMetrics: ReasoningRenderMetrics;
  claimScope: ReasoningClaimScope;
  defenseCoverage: ReasoningDefenseCoverage;
  answer: string;
  claims: ValidatedReasoningClaim[];
  rejectedClaims: Array<{ claim: ReasoningClaim; reasons: string[] }>;
  rejectedDemonstrations: Array<{ demonstration: ReasoningDraftDemonstration; issues: ReasoningValidationIssue[] }>;
  validationIssues: ReasoningValidationIssue[];
  repair: { attempted: boolean; succeeded: boolean };
  demonstrations: ReasoningDemonstration[];
  annotations: BoardAnnotation[];
  observationCoverage: ReasoningObservationCoverage[];
  hypotheses: ReasoningHypothesisRecord[];
  unverifiedCandidateHypothesisIds: string[];
  evidence: ReasoningEvidenceRecord[];
  limitations: string[];
  trace: ReasoningToolTrace[];
  runtime: string;
  model: string;
  usage: ModelRunResult["usage"];
  runtimeDiagnostics: ReasoningRuntimeDiagnostic[];
};

const POSITION_CONTEXT_KEYS = new Set(["kind", "nodeId", "parentNodeId", "historyStartFen", "fenBefore", "fenAfter", "historyUci", "moveUci", "moveSan"]);

export function validateReasoningPositionContext(value: ReasoningPositionContext): ReasoningPositionContext {
  if (!value || typeof value !== "object") throw new Error("Reasoning position context must be an object");
  for (const key of Object.keys(value)) if (!POSITION_CONTEXT_KEYS.has(key)) throw new Error(`Unsupported reasoning position context field: ${key}`);
  if (!value.nodeId?.trim()) throw new Error("Reasoning position context requires nodeId");
  if (!Array.isArray(value.historyUci) || value.historyUci.some((move) => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))) throw new Error("Reasoning position context historyUci must contain UCI moves");
  if (value.kind !== undefined && value.kind !== "position") throw new Error("Invalid context kind");
  if (!value.kind && !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value.moveUci)) throw new Error("Reasoning position context moveUci is invalid");
  if (!value.kind && !value.moveSan?.trim()) throw new Error("Reasoning position context requires moveSan");
  const history = value.historyStartFen ? new Chess(value.historyStartFen) : new Chess();
  for (const [index, moveUci] of value.historyUci.entries()) {
    let replayed;
    try {
      replayed = history.move({ from: moveUci.slice(0, 2), to: moveUci.slice(2, 4), promotion: moveUci.slice(4) || undefined });
    } catch {
      replayed = null;
    }
    if (!replayed) throw new Error(`Reasoning position context historyUci is illegal at index ${index}`);
  }
  if (history.fen() !== new Chess(value.fenBefore).fen()) throw new Error("Reasoning position context historyUci does not replay to fenBefore");
  if (value.kind === "position") {
    if (value.moveUci !== "" || value.moveSan !== "" || value.parentNodeId || value.historyUci.length
      || value.fenBefore !== value.fenAfter || !value.historyStartFen || new Chess(value.historyStartFen).fen() !== value.fenBefore)
      throw new Error("Invalid starting-position context");
    return { ...value, historyUci: [] };
  }
  const before = new Chess(value.fenBefore);
  let applied;
  try {
    applied = before.move({ from: value.moveUci.slice(0, 2), to: value.moveUci.slice(2, 4), promotion: value.moveUci.slice(4) || undefined });
  } catch {
    applied = null;
  }
  if (!applied) throw new Error("Reasoning position context target move is illegal in fenBefore");
  if (applied.san !== value.moveSan) throw new Error("Reasoning position context moveSan does not match the target move");
  if (before.fen() !== value.fenAfter) throw new Error("Reasoning position context fenAfter does not match the target move");
  return { ...value, historyUci: [...value.historyUci] };
}

export function reasoningContextHash(context: ReasoningPositionContext): string {
  const checked = validateReasoningPositionContext(context);
  return stableHash({ nodeId: checked.nodeId, parentNodeId: checked.parentNodeId || null, historyStartFen: checked.historyStartFen || null, fenBefore: checked.fenBefore, fenAfter: checked.fenAfter, historyUci: checked.historyUci, moveUci: checked.moveUci });
}

export function createQueryContract(input: { requestId: string; question: string; audience?: ReasoningAudience; concise?: boolean; responseCoverageRequirement?: QueryContract["responseCoverageRequirement"]; continuationCoverageRequirement?: QueryContract["continuationCoverageRequirement"]; minimumContinuationLines?: number; graphRequirements?: Partial<ReasoningGraphRequirements>; context: ReasoningPositionContext }): QueryContract {
  if (!input.requestId?.trim()) throw new Error("Query contract requires requestId");
  if (!input.question?.trim()) throw new Error("Query contract requires a question");
  validateReasoningPositionContext(input.context);
  const responseCoverageRequirement = input.responseCoverageRequirement || "none";
  if (responseCoverageRequirement !== "none" && responseCoverageRequirement !== "bounded-class") throw new Error("Unsupported response coverage requirement");
  const continuationCoverageRequirement = input.continuationCoverageRequirement || "none";
  if (continuationCoverageRequirement !== "none" && continuationCoverageRequirement !== "principal-variation") throw new Error("Unsupported continuation coverage requirement");
  const minimumContinuationLines = input.minimumContinuationLines ?? (continuationCoverageRequirement === "principal-variation" ? 1 : 0);
  if (!Number.isInteger(minimumContinuationLines) || minimumContinuationLines < 0 || minimumContinuationLines > 3) throw new Error("minimumContinuationLines must be an integer from 0 through 3");
  if (continuationCoverageRequirement === "none" && minimumContinuationLines !== 0) throw new Error("minimumContinuationLines must be 0 when continuation coverage is not requested");
  if (continuationCoverageRequirement === "principal-variation" && minimumContinuationLines < 1) throw new Error("minimumContinuationLines must be at least 1 when principal-variation coverage is requested");
  const graphRequirements: ReasoningGraphRequirements = {
    minimumEntities: input.graphRequirements?.minimumEntities ?? 1,
    minimumRelations: input.graphRequirements?.minimumRelations ?? 0,
  };
  if (!Number.isInteger(graphRequirements.minimumEntities) || graphRequirements.minimumEntities < 1 || graphRequirements.minimumEntities > 12) throw new Error("minimumEntities must be an integer from 1 through 12");
  if (!Number.isInteger(graphRequirements.minimumRelations) || graphRequirements.minimumRelations < 0 || graphRequirements.minimumRelations > 20) throw new Error("minimumRelations must be an integer from 0 through 20");
  return { schemaVersion: REASONING_POC_VERSION, requestId: input.requestId, question: input.question.trim(), requestedConclusion: input.context.kind === "position" ? "position-question" : "move-idea", responseCoverageRequirement, continuationCoverageRequirement, minimumContinuationLines, graphRequirements, audience: input.audience || "intermediate", concise: input.concise ?? true, nodeId: input.context.nodeId };
}

export function createContextEvidence(context: ReasoningPositionContext, contextHash = reasoningContextHash(context)): ReasoningEvidenceRecord {
  validateReasoningPositionContext(context);
  const identities = context.kind === "position" ? undefined : createPocIdentityTimeline(context);
  const selectedMoveMechanism = identities ? moveMechanismFacts(
    new Chess(context.fenBefore), new Chess(context.fenAfter),
    context.moveUci.slice(0, 2) as Square, context.moveUci.slice(2, 4) as Square,
    identities.before, identities.after,
  ) : undefined;
  return withEvidenceLicenses<ReasoningEvidenceRecord>({
    schemaVersion: REASONING_POC_VERSION,
    id: `evidence:context:${contextHash}`,
    contextHash,
    kind: "context",
    source: "validated-position-context",
    proofStrength: "observed",
    summary: context.kind === "position" ? "The supplied legal starting position is the question anchor; no target move has been played." : `${context.moveSan} (${context.moveUci}) is the target move in the supplied legal position.`,
    data: { ...(selectedMoveMechanism ? { selectedMoveMechanism } : {}), material: materialAlongLine(context.fenBefore, context.kind === "position" ? [] : [context.moveUci]), authority: "legal-exact", scope: "sequence-legality-and-identity", nodeId: context.nodeId, parentNodeId: context.parentNodeId || null, historyStartFen: context.historyStartFen || null, moveUci: context.moveUci, moveSan: context.moveSan, fenBefore: context.fenBefore, fenAfter: context.fenAfter },
    coverage: null,
    replay: context.kind === "position" ? { fen: context.fenBefore } : { fen: context.fenBefore, move: context.moveUci },
  });
}
