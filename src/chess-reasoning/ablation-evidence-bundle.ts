import {
  REASONING_POC_VERSION,
  reasoningContextHash,
  validateReasoningPositionContext,
  type ReasoningEvidenceRecord,
  type ReasoningObservation,
  type ReasoningPositionContext,
  type ReasoningToolDescriptor,
  type ReasoningToolName,
} from "./poc-contracts";
import { effectiveLicensesForRecord } from "./evidence-licenses";
import { REFERENCE_DOMAINS } from "./concept-registry";
import { collectReasoningMoveWitnesses, type ReasoningMoveWitness } from "./poc-move-witnesses";
import { createPocIdentityTimeline } from "./poc-piece-refs";
import { stableHash, stableJson } from "./stable";
import { SQUARES } from "chess.js";

/**
 * A deliberately pre-semantic snapshot for the architecture ablation.  This
 * is not a replay/checkpoint format: hypothesis, graph, and disposition
 * state must remain outside the acquisition/deliberation boundary.
 */
export const ABLATION_EVIDENCE_BUNDLE_VERSION = "architecture-ablation-evidence-bundle/1" as const;
export const ABLATION_PROBE_TELEMETRY_VERSION = "architecture-ablation-probe-telemetry/2" as const;

export const PRECOMMITTED_PROBE_ATTRIBUTION_CATEGORIES = Object.freeze([
  "fact-unavailable",
  "fact-available-not-presented",
  "fact-presented-ignored",
  "fact-recognized-not-probed",
  "hypothesis-formed-later-discarded",
  "correct-graph-poor-rendering",
  "unsupported-claim-admitted",
  "safe-fail-closed-termination",
] as const);

export type ProbeAttributionCategory = typeof PRECOMMITTED_PROBE_ATTRIBUTION_CATEGORIES[number];
export type AblationBundleOmissionReason = "budget" | "not-requested" | "unavailable" | "withheld";

export type AblationEvidenceClosureCoverage = {
  complete: boolean;
  covered: string[];
  omitted: Array<{ domain: "observation" | "evidence" | "tool"; id: string; reason: AblationBundleOmissionReason }>;
  unavailable: Array<{ id: string; reason: string }>;
  limitations: string[];
};

export type AblationEvidenceReferenceAllowlists = {
  evidenceIds: string[];
  observationIds: string[];
  toolNames: ReasoningToolName[];
  semanticReferences: Array<{ domain: "piece" | "square" | "move"; id: string }>;
  moveWitnesses: ReasoningMoveWitness[];
};

export type AblationEvidenceBundleLineage =
  | { kind: "original" }
  | {
    kind: "enriched";
    originalBundleHash: string;
    acquiredEvidenceIds: string[];
    acquiredObservationIds: string[];
  };

export type AblationEvidenceClosureBundle = {
  schemaVersion: typeof ABLATION_EVIDENCE_BUNDLE_VERSION;
  contextHash: string;
  context: ReasoningPositionContext;
  question: string;
  observations: ReasoningObservation[];
  evidence: ReasoningEvidenceRecord[];
  referenceAllowlists: AblationEvidenceReferenceAllowlists;
  coverage: AblationEvidenceClosureCoverage;
  lineage: AblationEvidenceBundleLineage;
  bundleHash: string;
};

export type CreateAblationEvidenceClosureBundleInput = Omit<AblationEvidenceClosureBundle, "schemaVersion" | "contextHash" | "lineage" | "bundleHash">;

export type EnrichAblationEvidenceClosureBundleInput = {
  observations: ReasoningObservation[];
  evidence: ReasoningEvidenceRecord[];
  referenceAllowlists?: Partial<AblationEvidenceReferenceAllowlists>;
  coverage: AblationEvidenceClosureCoverage;
};

export type AblationAnchorAcquirability = {
  /** Evaluator metadata only; no evaluator anchor is carried in this value. */
  telemetryOnly: true;
  status: "not-applicable" | "acquirable-from-admitted-evidence" | "requires-probe" | "unacquirable-within-budget";
  basisEvidenceIds: string[];
  rationale: string;
};

export type AblationProbeEffect = "materially-changed" | "supported" | "narrowed" | "rejected" | "no-change" | "failure";

export type AblationCalledProbe = {
  callId: string;
  requestId: string;
  tool: ReasoningToolName;
  request: {
    descriptor: ReasoningToolDescriptor;
    input: Record<string, unknown>;
    selectionRationale: string;
  };
  target: { fen: string; historyThroughTargetHash: string };
  permittedLimits: {
    maxToolCalls: number;
    maxProbeCalls: number;
    engine: { depth: number | null; multiPv: number | null; threads: number | null; rootMoves: string[] } | null;
  };
  approval: { approved: boolean; budgetReason: string; remainingToolCalls: number; remainingProbeCalls: number };
  status: { started: boolean; finished: "not-started" | "returned" | "failed" | "cancelled" };
  returned: { lines: number; coverage: { complete: boolean; covered: string[]; unresolved: string[] } } | null;
  admission: { status: "admitted" | "withheld" | "rejected" | "not-produced"; reason: string };
  admittedEvidence: Array<{ evidenceId: string; licenses: string[] }>;
  presentation: { presentedToModel: boolean; reason: string };
  semanticConsumption: { status: "not-reached" | "not-consumed" | "consumed" | "misused"; hypothesisIds: string[] };
  modelStatedRationale: string | null;
  effect: AblationProbeEffect;
  hypothesisIds: string[];
  usage: { inputTokens: number | null; outputTokens: number | null; latencyMs: number | null; cache: { hits: number; misses: number }; cost: number | null; corrections: number };
};

export type AblationProbeTelemetry = {
  schemaVersion: typeof ABLATION_PROBE_TELEMETRY_VERSION;
  bundleHash: string;
  beforeProbeEvidenceIds: string[];
  postSaliencePresentedFactIds: string[];
  availableTools: ReasoningToolDescriptor[];
  calledProbes: AblationCalledProbe[];
  missedAnchorAttributions: Array<{
    /** Opaque evaluator-side handle; it never identifies or carries the anchor. */
    anchorId: string;
    category: ProbeAttributionCategory;
    acquirability: AblationAnchorAcquirability;
    unusedRelevantTools: ReasoningToolName[];
  }>;
  stopping: { rationale: string; unusedRelevantTools: ReasoningToolName[] };
  usage: {
    modelCalls: number;
    toolCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number | null;
    cache: { hits: number; misses: number };
    cost: number | null;
    corrections: number;
  };
  telemetryHash: string;
};

export type CreateAblationProbeTelemetryInput = Omit<AblationProbeTelemetry, "schemaVersion" | "bundleHash" | "telemetryHash">;

const BUNDLE_KEYS = new Set([
  "schemaVersion", "contextHash", "context", "question", "observations", "evidence",
  "referenceAllowlists", "coverage", "lineage", "bundleHash",
]);
const TELEMETRY_KEYS = new Set([
  "schemaVersion", "bundleHash", "beforeProbeEvidenceIds", "postSaliencePresentedFactIds",
  "availableTools", "calledProbes", "missedAnchorAttributions",
  "stopping", "usage", "telemetryHash",
]);
const FORBIDDEN_BUNDLE_TOP_LEVEL_KEYS = new Set([
  "hypothesis", "hypotheses", "relation", "relations", "graph", "graphs", "disposition",
  "dispositions", "claim", "claims", "answer", "answers", "evaluatorAnchor", "evaluatorAnchors",
  "idealProse", "answerKey", "laterMoves",
]);
const FORBIDDEN_C_ARTIFACT_KEYS = new Set([
  "selectedEntities", "selectedRelations", "sourceHypothesisIds", "hypothesisLedgerRevision",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function assertDeepFrozen(value: unknown, path = "bundle"): void {
  if (!value || typeof value !== "object") return;
  if (!Object.isFrozen(value)) throw new Error(`Ablation evidence bundle mutation detected at ${path}`);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) assertDeepFrozen(child, `${path}.${key}`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function uniqueSorted(values: readonly string[], label: string): string[] {
  if (values.some((value) => typeof value !== "string" || !value.trim())) throw new Error(`${label} must contain non-empty strings`);
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertNoSemanticArtifacts(value: unknown, path = "bundle"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSemanticArtifacts(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_C_ARTIFACT_KEYS.has(key)) throw new Error(`Ablation evidence closure cannot contain semantic artifact ${path}.${key}`);
    // Existing C records have graph/review transport envelopes. Generic
    // provider dictionaries may legitimately use ordinary words such as
    // relation or candidate, so reject the known artifact shape, not prose.
    if ((key === "review" && isRecord(child) && ("hypotheses" in child || "selectedEntities" in child))
      || (key === "evidence" && isRecord(child) && child.kind === "graph")) {
      throw new Error(`Ablation evidence closure cannot contain semantic artifact ${path}.${key}`);
    }
    assertNoSemanticArtifacts(child, `${path}.${key}`);
  }
}

function assertNoEvaluatorPayload(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEvaluatorPayload(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (["evaluatorAnchor", "evaluatorAnchors", "idealProse", "answerKey", "laterMoves"].includes(key)) {
      throw new Error(`Ablation probe telemetry cannot carry evaluator payload at ${path}.${key}`);
    }
    assertNoEvaluatorPayload(child, `${path}.${key}`);
  }
}

function bundleHash(value: Omit<AblationEvidenceClosureBundle, "bundleHash">): string {
  return stableHash(value);
}

function telemetryHash(value: Omit<AblationProbeTelemetry, "telemetryHash">): string {
  return stableHash(value);
}

export function ablationHistoryThroughTargetHash(context: ReasoningPositionContext): string {
  const checked = validateReasoningPositionContext(context);
  return stableHash({ historyStartFen: checked.historyStartFen || null, historyUci: [...checked.historyUci, ...(checked.kind === "position" ? [] : [checked.moveUci])] });
}

function normalizeCoverage(value: AblationEvidenceClosureCoverage): AblationEvidenceClosureCoverage {
  if (!isRecord(value) || typeof value.complete !== "boolean" || !Array.isArray(value.covered)
    || !Array.isArray(value.omitted) || !Array.isArray(value.unavailable) || !Array.isArray(value.limitations)) {
    throw new Error("Ablation evidence closure requires explicit coverage metadata");
  }
  const omitted = value.omitted.map((item) => {
    if (!isRecord(item) || (item.domain !== "observation" && item.domain !== "evidence" && item.domain !== "tool")
      || typeof item.id !== "string" || !item.id.trim()
      || (item.reason !== "budget" && item.reason !== "not-requested" && item.reason !== "unavailable" && item.reason !== "withheld")) {
      throw new Error("Ablation evidence closure has malformed omission metadata");
    }
    return { domain: item.domain, id: item.id, reason: item.reason };
  }).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const unavailable = value.unavailable.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim() || typeof item.reason !== "string" || !item.reason.trim()) {
      throw new Error("Ablation evidence closure has malformed unavailable metadata");
    }
    return { id: item.id, reason: item.reason };
  }).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const normalized = {
    complete: value.complete,
    covered: uniqueSorted(value.covered, "Ablation evidence closure coverage"),
    omitted,
    unavailable,
    limitations: uniqueSorted(value.limitations, "Ablation evidence closure limitations"),
  };
  if (normalized.complete && (normalized.omitted.length || normalized.unavailable.length)) {
    throw new Error("Complete ablation evidence closure cannot report omissions or unavailable coverage");
  }
  if (!normalized.complete && !normalized.omitted.length && !normalized.unavailable.length && !normalized.limitations.length) {
    throw new Error("Incomplete ablation evidence closure must state an omission, unavailable domain, or limitation");
  }
  return normalized;
}

function normalizeObservations(value: readonly ReasoningObservation[], contextHash: string, evidenceById: Map<string, ReasoningEvidenceRecord>): ReasoningObservation[] {
  const ids = new Set<string>();
  return value.map((observation) => {
    if (!observation || observation.schemaVersion !== REASONING_POC_VERSION || observation.contextHash !== contextHash
      || !observation.id?.trim() || !observation.observationType?.trim() || !Array.isArray(observation.participants)
      || !isRecord(observation.attributes) || !isRecord(observation.provenance) || !Array.isArray(observation.factEvidenceIds)
      || !Array.isArray(observation.probeRecipes) || ids.has(observation.id)) {
      throw new Error("Ablation evidence closure contains malformed or duplicate admitted observation");
    }
    ids.add(observation.id);
    if (!observation.factEvidenceIds.length || observation.factEvidenceIds.some((id) => !evidenceById.has(id))) {
      throw new Error(`Ablation observation ${observation.id} references evidence outside the closure`);
    }
    return clone(observation);
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeEvidence(value: readonly ReasoningEvidenceRecord[], contextHash: string): ReasoningEvidenceRecord[] {
  const ids = new Set<string>();
  return value.map((record) => {
    if (!record || record.schemaVersion !== REASONING_POC_VERSION || record.contextHash !== contextHash
      || !record.id?.trim() || !record.source?.trim() || !record.summary?.trim() || !isRecord(record.data)
      || !Array.isArray(record.licenses) || (record.kind !== "context" && record.kind !== "fact" && record.kind !== "probe")
      || ids.has(record.id)) {
      throw new Error("Ablation evidence closure contains malformed, duplicate, or semantic evidence");
    }
    ids.add(record.id);
    // This is the production central ceiling, not a second license policy.
    effectiveLicensesForRecord(record);
    return clone(record);
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeAllowlists(
  value: AblationEvidenceReferenceAllowlists,
  evidence: readonly ReasoningEvidenceRecord[],
  observations: readonly ReasoningObservation[],
  context: ReasoningPositionContext,
): AblationEvidenceReferenceAllowlists {
  if (!isRecord(value) || !Array.isArray(value.evidenceIds) || !Array.isArray(value.observationIds)
    || !Array.isArray(value.toolNames) || !Array.isArray(value.semanticReferences) || !Array.isArray(value.moveWitnesses)) {
    throw new Error("Ablation evidence closure requires reference allowlists");
  }
  const evidenceIds = uniqueSorted(value.evidenceIds, "Evidence reference allowlist");
  const observationIds = uniqueSorted(value.observationIds, "Observation reference allowlist");
  const toolNames = uniqueSorted(value.toolNames, "Tool reference allowlist") as ReasoningToolName[];
  const admittedEvidence = new Set(evidence.map((record) => record.id));
  const admittedObservations = new Set(observations.map((observation) => observation.id));
  if (evidenceIds.some((id) => !admittedEvidence.has(id)) || observationIds.some((id) => !admittedObservations.has(id))) {
    throw new Error("Ablation reference allowlist cannot name unadmitted records");
  }
  const timeline = createPocIdentityTimeline(context);
  const knownPieces = new Set([...Object.keys(timeline.before.pieces), ...Object.keys(timeline.after.pieces)]);
  const knownMoves = new Set([...context.historyUci, ...(context.kind === "position" ? [] : [context.moveUci]), ...collectReasoningMoveWitnesses(evidence, context).map((witness) => witness.uci)]);
  const semanticReferences = [...new Map(value.semanticReferences.map((reference) => {
    if (!isRecord(reference) || (reference.domain !== REFERENCE_DOMAINS.PIECE && reference.domain !== REFERENCE_DOMAINS.SQUARE && reference.domain !== REFERENCE_DOMAINS.MOVE)
      || typeof reference.id !== "string" || !reference.id.trim()) {
      throw new Error("Ablation semantic reference allowlist requires production domain/id references");
    }
    if ((reference.domain === REFERENCE_DOMAINS.PIECE && !knownPieces.has(reference.id))
      || (reference.domain === REFERENCE_DOMAINS.SQUARE && !SQUARES.includes(reference.id as typeof SQUARES[number]))
      || (reference.domain === REFERENCE_DOMAINS.MOVE && !knownMoves.has(reference.id))) {
      throw new Error(`Ablation semantic reference is not grounded by the context or admitted evidence: ${reference.domain}:${reference.id}`);
    }
    const normalized = { domain: reference.domain, id: reference.id } as { domain: "piece" | "square" | "move"; id: string };
    return [`${normalized.domain}:${normalized.id}`, normalized] as const;
  })).values()].sort((left, right) => `${left.domain}:${left.id}`.localeCompare(`${right.domain}:${right.id}`));
  const admittedWitnesses = new Map(collectReasoningMoveWitnesses(evidence, context).map((witness) => [
    `${witness.evidenceId}:${witness.uci}:${witness.pieceId}:${witness.san}`,
    witness,
  ]));
  const moveWitnesses = [...new Map(value.moveWitnesses.map((witness) => {
    if (!isRecord(witness) || typeof witness.evidenceId !== "string" || typeof witness.uci !== "string"
      || typeof witness.pieceId !== "string" || typeof witness.san !== "string") {
      throw new Error("Ablation move witness allowlist is malformed");
    }
    const key = `${witness.evidenceId}:${witness.uci}:${witness.pieceId}:${witness.san}`;
    if (!admittedWitnesses.has(key)) throw new Error("Ablation move witness must be replayable from admitted evidence with stable identity and SAN");
    return [key, clone(admittedWitnesses.get(key)!)] as const;
  })).values()].sort((left, right) => `${left.evidenceId}:${left.uci}:${left.pieceId}:${left.san}`.localeCompare(`${right.evidenceId}:${right.uci}:${right.pieceId}:${right.san}`));
  return { evidenceIds, observationIds, toolNames, semanticReferences, moveWitnesses };
}

function normalizedBundle(input: Omit<AblationEvidenceClosureBundle, "schemaVersion" | "contextHash" | "bundleHash">): Omit<AblationEvidenceClosureBundle, "bundleHash"> {
  if (!isRecord(input)) throw new Error("Ablation evidence closure must be an object");
  if (Object.keys(input).some((key) => FORBIDDEN_BUNDLE_TOP_LEVEL_KEYS.has(key))) throw new Error("Ablation evidence closure cannot contain top-level semantic artifacts");
  if (Object.keys(input).some((key) => !BUNDLE_KEYS.has(key))) throw new Error("Ablation evidence closure contains unsupported fields");
  assertNoSemanticArtifacts({ observations: input.observations, evidence: input.evidence });
  const context = validateReasoningPositionContext(clone(input.context));
  const contextHash = reasoningContextHash(context);
  if (typeof input.question !== "string" || !input.question.trim() || input.question.length > 4_000) {
    throw new Error("Ablation evidence closure requires a bounded question");
  }
  const evidence = normalizeEvidence(input.evidence, contextHash);
  const observations = normalizeObservations(input.observations, contextHash, new Map(evidence.map((record) => [record.id, record])));
  const referenceAllowlists = normalizeAllowlists(input.referenceAllowlists, evidence, observations, context);
  const coverage = normalizeCoverage(input.coverage);
  if (!isRecord(input.lineage) || (input.lineage.kind !== "original" && input.lineage.kind !== "enriched")) {
    throw new Error("Ablation evidence closure has malformed lineage");
  }
  const lineage = input.lineage.kind === "original"
    ? { kind: "original" as const }
    : {
      kind: "enriched" as const,
      originalBundleHash: typeof input.lineage.originalBundleHash === "string" ? input.lineage.originalBundleHash : "",
      acquiredEvidenceIds: uniqueSorted(input.lineage.acquiredEvidenceIds || [], "Acquired evidence lineage"),
      acquiredObservationIds: uniqueSorted(input.lineage.acquiredObservationIds || [], "Acquired observation lineage"),
    };
  if (lineage.kind === "enriched") {
    if (!lineage.originalBundleHash || !lineage.acquiredEvidenceIds.length) throw new Error("Enriched ablation evidence closure requires original lineage and acquired evidence");
    const evidenceIds = new Set(evidence.map((record) => record.id));
    const observationIds = new Set(observations.map((observation) => observation.id));
    if (lineage.acquiredEvidenceIds.some((id) => !evidenceIds.has(id)) || lineage.acquiredObservationIds.some((id) => !observationIds.has(id))) {
      throw new Error("Enriched ablation lineage references records outside the closure");
    }
  }
  return {
    schemaVersion: ABLATION_EVIDENCE_BUNDLE_VERSION,
    contextHash,
    context,
    question: input.question,
    observations,
    evidence,
    referenceAllowlists,
    coverage,
    lineage,
  };
}

export function createAblationEvidenceClosureBundle(input: CreateAblationEvidenceClosureBundleInput): Readonly<AblationEvidenceClosureBundle> {
  const normalized = normalizedBundle({ ...input, lineage: { kind: "original" } });
  return deepFreeze({ ...normalized, bundleHash: bundleHash(normalized) });
}

export function enrichAblationEvidenceClosureBundle(
  original: Readonly<AblationEvidenceClosureBundle>,
  input: EnrichAblationEvidenceClosureBundleInput,
): Readonly<AblationEvidenceClosureBundle> {
  validateAblationEvidenceClosureBundle(original);
  if (original.lineage.kind !== "original") throw new Error("An ablation evidence closure can only be enriched from its original bundle");
  const priorEvidenceIds = new Set(original.evidence.map((record) => record.id));
  const priorObservationIds = new Set(original.observations.map((observation) => observation.id));
  const addedEvidence = input.evidence.filter((record) => !priorEvidenceIds.has(record.id));
  const addedObservations = input.observations.filter((observation) => !priorObservationIds.has(observation.id));
  if (!addedEvidence.length) throw new Error("An enriched ablation evidence closure requires newly acquired evidence");
  const evidence = [...original.evidence, ...input.evidence];
  const observations = [...original.observations, ...input.observations];
  const defaultAllowlists = {
    evidenceIds: evidence.map((record) => record.id),
    observationIds: observations.map((observation) => observation.id),
    toolNames: original.referenceAllowlists.toolNames,
    semanticReferences: original.referenceAllowlists.semanticReferences,
    moveWitnesses: original.referenceAllowlists.moveWitnesses,
  };
  const normalized = normalizedBundle({
    context: original.context,
    question: original.question,
    observations,
    evidence,
    referenceAllowlists: { ...defaultAllowlists, ...(input.referenceAllowlists || {}) },
    coverage: input.coverage,
    lineage: {
      kind: "enriched",
      originalBundleHash: original.bundleHash,
      acquiredEvidenceIds: addedEvidence.map((record) => record.id),
      acquiredObservationIds: addedObservations.map((observation) => observation.id),
    },
  });
  return deepFreeze({ ...normalized, bundleHash: bundleHash(normalized) });
}

export function validateAblationEvidenceClosureBundle(value: unknown): asserts value is Readonly<AblationEvidenceClosureBundle> {
  if (!isRecord(value) || Object.keys(value).some((key) => !BUNDLE_KEYS.has(key)) || value.schemaVersion !== ABLATION_EVIDENCE_BUNDLE_VERSION) {
    throw new Error("Unsupported ablation evidence closure bundle");
  }
  assertDeepFrozen(value);
  const { bundleHash: suppliedHash, schemaVersion: _schemaVersion, contextHash: _contextHash, ...unhashed } = value as AblationEvidenceClosureBundle;
  void _schemaVersion;
  void _contextHash;
  const normalized = normalizedBundle(unhashed);
  const expectedHash = bundleHash(normalized);
  if (value.contextHash !== normalized.contextHash || suppliedHash !== expectedHash || stableJson(value) !== stableJson({ ...normalized, bundleHash: expectedHash })) {
    throw new Error("Ablation evidence closure bundle integrity check failed");
  }
}

function normalizeTelemetry(
  bundle: Readonly<AblationEvidenceClosureBundle>,
  input: Omit<AblationProbeTelemetry, "schemaVersion" | "bundleHash" | "telemetryHash">,
): Omit<AblationProbeTelemetry, "telemetryHash"> {
  if (!isRecord(input) || Object.keys(input).some((key) => !TELEMETRY_KEYS.has(key))) throw new Error("Ablation probe telemetry contains unsupported fields");
  const evidenceById = new Map(bundle.evidence.map((record) => [record.id, record]));
  const beforeProbeEvidenceIds = uniqueSorted(input.beforeProbeEvidenceIds, "Before-probe evidence");
  const postSaliencePresentedFactIds = uniqueSorted(input.postSaliencePresentedFactIds, "Post-salience presented facts");
  if (beforeProbeEvidenceIds.some((id) => !evidenceById.has(id)) || postSaliencePresentedFactIds.some((id) => !evidenceById.has(id))) {
    throw new Error("Ablation probe telemetry references evidence outside its bundle");
  }
  if (postSaliencePresentedFactIds.some((id) => !["context", "fact", "probe"].includes(evidenceById.get(id)!.kind))) {
    throw new Error("Post-salience telemetry must reference admitted factual evidence");
  }
  if (!Array.isArray(input.availableTools) || !Array.isArray(input.calledProbes) || !Array.isArray(input.missedAnchorAttributions)) {
    throw new Error("Ablation probe telemetry requires live tool availability and call sequence");
  }
  const availableTools = input.availableTools.map((descriptor) => {
    if (!descriptor || typeof descriptor.name !== "string" || !descriptor.description?.trim()
      || (descriptor.category !== "fact" && descriptor.category !== "probe" && descriptor.category !== "graph") || !isRecord(descriptor.inputSchema)) {
      throw new Error("Ablation probe telemetry received malformed live tool descriptor");
    }
    return clone(descriptor);
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(availableTools.map((tool) => tool.name)).size !== availableTools.length) throw new Error("Ablation probe telemetry has duplicate available tools");
  const availableNames = new Set<ReasoningToolName>(availableTools.map((tool) => tool.name));
  const expectedTargetHistoryHash = ablationHistoryThroughTargetHash(bundle.context);
  const calledProbes = input.calledProbes.map((call, index) => {
    if (!isRecord(call) || typeof call.callId !== "string" || !call.callId.trim() || typeof call.tool !== "string" || !availableNames.has(call.tool as ReasoningToolName)) {
      throw new Error(`Ablation probe telemetry call ${index} is not a live available tool`);
    }
    if (call.modelStatedRationale !== null && (typeof call.modelStatedRationale !== "string" || call.modelStatedRationale.length > 500)) {
      throw new Error(`Ablation probe telemetry call ${index} has an invalid stated rationale`);
    }
    if (typeof call.requestId !== "string" || !call.requestId.trim() || !isRecord(call.request)
      || !isRecord(call.request.descriptor) || !isRecord(call.request.input) || typeof call.request.selectionRationale !== "string" || !call.request.selectionRationale.trim() || call.request.selectionRationale.length > 500) {
      throw new Error(`Ablation probe telemetry call ${index} has an incomplete immutable request`);
    }
    const liveDescriptor = availableTools.find((descriptor) => descriptor.name === call.tool);
    if (!liveDescriptor || (liveDescriptor.category !== "fact" && liveDescriptor.category !== "probe") || stableJson(call.request.descriptor) !== stableJson(liveDescriptor)) {
      throw new Error(`Ablation probe telemetry call ${index} request descriptor is not the live descriptor`);
    }
    assertNoEvaluatorPayload(call.request.input, `calledProbes[${index}].request.input`);
    if (!isRecord(call.target) || call.target.fen !== bundle.context.fenAfter || call.target.historyThroughTargetHash !== expectedTargetHistoryHash) {
      throw new Error(`Ablation probe telemetry call ${index} target is not bound to the bundle context`);
    }
    if (!isRecord(call.permittedLimits) || !Number.isInteger(call.permittedLimits.maxToolCalls) || call.permittedLimits.maxToolCalls < 0
      || !Number.isInteger(call.permittedLimits.maxProbeCalls) || call.permittedLimits.maxProbeCalls < 0) {
      throw new Error(`Ablation probe telemetry call ${index} has malformed permitted limits`);
    }
    const engine = call.permittedLimits.engine;
    if (engine !== null && (!isRecord(engine) || !Array.isArray(engine.rootMoves)
      || [engine.depth, engine.multiPv, engine.threads].some((value) => value !== null && (!Number.isInteger(value) || value < 1))
      || engine.rootMoves.some((move) => typeof move !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)))) {
      throw new Error(`Ablation probe telemetry call ${index} has malformed engine limits`);
    }
    if (!isRecord(call.approval) || typeof call.approval.approved !== "boolean" || typeof call.approval.budgetReason !== "string" || !call.approval.budgetReason.trim()
      || !Number.isInteger(call.approval.remainingToolCalls) || call.approval.remainingToolCalls < 0 || !Number.isInteger(call.approval.remainingProbeCalls) || call.approval.remainingProbeCalls < 0) {
      throw new Error(`Ablation probe telemetry call ${index} has malformed approval/budget decision`);
    }
    if (!isRecord(call.status) || typeof call.status.started !== "boolean" || !["not-started", "returned", "failed", "cancelled"].includes(String(call.status.finished))
      || (!call.status.started && call.status.finished !== "not-started")) {
      throw new Error(`Ablation probe telemetry call ${index} has malformed execution status`);
    }
    if (!call.approval.approved && call.status.started) throw new Error(`Ablation probe telemetry call ${index} started without approval`);
    if (call.status.finished === "returned" && (!call.approval.approved || !call.status.started)) {
      throw new Error(`Ablation probe telemetry call ${index} returned without approved execution`);
    }
    if (call.returned !== null && (!isRecord(call.returned) || !Number.isInteger(call.returned.lines) || call.returned.lines < 0 || !isRecord(call.returned.coverage)
      || typeof call.returned.coverage.complete !== "boolean" || !Array.isArray(call.returned.coverage.covered) || !Array.isArray(call.returned.coverage.unresolved))) {
      throw new Error(`Ablation probe telemetry call ${index} has malformed returned-line coverage`);
    }
    if (call.status.finished === "returned" && call.returned === null) throw new Error(`Ablation probe telemetry call ${index} returned without a coverage summary`);
    if (!isRecord(call.admission) || !["admitted", "withheld", "rejected", "not-produced"].includes(String(call.admission.status))
      || typeof call.admission.reason !== "string" || !call.admission.reason.trim() || !Array.isArray(call.admittedEvidence)) {
      throw new Error(`Ablation probe telemetry call ${index} has malformed admission result`);
    }
    const admittedEvidence = call.admittedEvidence.map((item) => {
      if (!isRecord(item) || typeof item.evidenceId !== "string" || !evidenceById.has(item.evidenceId) || !Array.isArray(item.licenses)) {
        throw new Error(`Ablation probe telemetry call ${index} names unadmitted evidence`);
      }
      const licenses = uniqueSorted(item.licenses, "Admitted evidence licenses");
      if (!sameStrings(licenses, effectiveLicensesForRecord(evidenceById.get(item.evidenceId)!))) {
        throw new Error(`Ablation probe telemetry call ${index} evidence licenses do not match admission`);
      }
      return { evidenceId: item.evidenceId, licenses };
    }).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    if (new Set(admittedEvidence.map((item) => item.evidenceId)).size !== admittedEvidence.length) throw new Error(`Ablation probe telemetry call ${index} has duplicate admitted evidence`);
    if ((call.admission.status === "admitted") !== Boolean(admittedEvidence.length)) throw new Error(`Ablation probe telemetry call ${index} admission must exactly match admitted evidence`);
    if (admittedEvidence.length && (call.status.finished !== "returned" || call.admission.status !== "admitted")) {
      throw new Error(`Ablation probe telemetry call ${index} admitted evidence without a returned admitted result`);
    }
    if (!isRecord(call.presentation) || typeof call.presentation.presentedToModel !== "boolean" || typeof call.presentation.reason !== "string" || !call.presentation.reason.trim()) {
      throw new Error(`Ablation probe telemetry call ${index} has malformed presentation result`);
    }
    if (call.presentation.presentedToModel && !admittedEvidence.length) throw new Error(`Ablation probe telemetry call ${index} presented evidence without admission`);
    if (!isRecord(call.semanticConsumption) || !["not-reached", "not-consumed", "consumed", "misused"].includes(String(call.semanticConsumption.status))
      || !Array.isArray(call.semanticConsumption.hypothesisIds)) {
      throw new Error(`Ablation probe telemetry call ${index} has malformed semantic consumption`);
    }
    const consumedHypothesisIds = uniqueSorted(call.semanticConsumption.hypothesisIds, "Semantic consumption hypothesis IDs");
    if ((call.semanticConsumption.status === "not-reached" || call.semanticConsumption.status === "not-consumed") && consumedHypothesisIds.length) {
      throw new Error(`Ablation probe telemetry call ${index} attaches hypotheses without semantic consumption`);
    }
    if ((call.semanticConsumption.status === "consumed" || call.semanticConsumption.status === "misused")
      && (!call.presentation.presentedToModel || !consumedHypothesisIds.length)) {
      throw new Error(`Ablation probe telemetry call ${index} consumed evidence without presented hypotheses`);
    }
    if (!Array.isArray(call.hypothesisIds) || !["materially-changed", "supported", "narrowed", "rejected", "no-change", "failure"].includes(String(call.effect))) {
      throw new Error(`Ablation probe telemetry call ${index} has an invalid probe effect`);
    }
    const hypothesisIds = uniqueSorted(call.hypothesisIds, "Probe effect hypothesis IDs");
    if ((call.effect === "no-change" || call.effect === "failure") && hypothesisIds.length) {
      throw new Error(`Ablation probe telemetry call ${index} cannot attach hypotheses to ${call.effect}`);
    }
    if (call.effect !== "no-change" && call.effect !== "failure" && !hypothesisIds.length) {
      throw new Error(`Ablation probe telemetry call ${index} must identify affected hypotheses`);
    }
    const materialEffect = call.effect === "materially-changed" || call.effect === "supported" || call.effect === "narrowed" || call.effect === "rejected";
    if (materialEffect && (call.semanticConsumption.status !== "consumed" && call.semanticConsumption.status !== "misused"
      || !sameStrings(hypothesisIds, consumedHypothesisIds))) {
      throw new Error(`Ablation probe telemetry call ${index} material effect must match consumed hypotheses`);
    }
    if ((call.semanticConsumption.status === "not-reached" || call.semanticConsumption.status === "not-consumed")
      && (call.effect !== "no-change" && call.effect !== "failure" || hypothesisIds.length)) {
      throw new Error(`Ablation probe telemetry call ${index} unconsumed evidence must have no material hypothesis effect`);
    }
    if (!isRecord(call.usage) || !isRecord(call.usage.cache) || !Number.isInteger(call.usage.cache.hits) || !Number.isInteger(call.usage.cache.misses)
      || call.usage.cache.hits < 0 || call.usage.cache.misses < 0 || !Number.isInteger(call.usage.corrections) || call.usage.corrections < 0
      || [call.usage.inputTokens, call.usage.outputTokens, call.usage.latencyMs, call.usage.cost].some((value) => value !== null && (!Number.isFinite(value) || value < 0))) {
      throw new Error(`Ablation probe telemetry call ${index} has malformed per-call usage`);
    }
    return {
      callId: call.callId, requestId: call.requestId, tool: call.tool as ReasoningToolName,
      request: { descriptor: clone(liveDescriptor), input: clone(call.request.input), selectionRationale: call.request.selectionRationale },
      target: { fen: bundle.context.fenAfter, historyThroughTargetHash: expectedTargetHistoryHash },
      permittedLimits: { maxToolCalls: call.permittedLimits.maxToolCalls, maxProbeCalls: call.permittedLimits.maxProbeCalls, engine: engine === null ? null : { depth: engine.depth as number | null, multiPv: engine.multiPv as number | null, threads: engine.threads as number | null, rootMoves: uniqueSorted(engine.rootMoves, "Engine root moves") } },
      approval: { approved: call.approval.approved, budgetReason: call.approval.budgetReason, remainingToolCalls: call.approval.remainingToolCalls, remainingProbeCalls: call.approval.remainingProbeCalls },
      status: { started: call.status.started, finished: call.status.finished as AblationCalledProbe["status"]["finished"] },
      returned: call.returned === null ? null : { lines: call.returned.lines, coverage: { complete: call.returned.coverage.complete, covered: uniqueSorted(call.returned.coverage.covered, "Returned coverage"), unresolved: uniqueSorted(call.returned.coverage.unresolved, "Returned coverage") } },
      admission: { status: call.admission.status as AblationCalledProbe["admission"]["status"], reason: call.admission.reason },
      admittedEvidence,
      presentation: { presentedToModel: call.presentation.presentedToModel, reason: call.presentation.reason },
      semanticConsumption: { status: call.semanticConsumption.status as AblationCalledProbe["semanticConsumption"]["status"], hypothesisIds: consumedHypothesisIds },
      modelStatedRationale: call.modelStatedRationale, effect: call.effect as AblationProbeEffect, hypothesisIds,
      usage: { inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens, latencyMs: call.usage.latencyMs, cache: { hits: call.usage.cache.hits, misses: call.usage.cache.misses }, cost: call.usage.cost, corrections: call.usage.corrections },
    };
  });
  if (new Set(calledProbes.map((call) => call.callId)).size !== calledProbes.length) throw new Error("Ablation probe telemetry call IDs must be unique");
  const missedAnchorAttributions = input.missedAnchorAttributions.map((row, index) => {
    if (!isRecord(row) || typeof row.anchorId !== "string" || !row.anchorId.trim()
      || !PRECOMMITTED_PROBE_ATTRIBUTION_CATEGORIES.includes(row.category as ProbeAttributionCategory)
      || !isRecord(row.acquirability) || row.acquirability.telemetryOnly !== true
      || !["not-applicable", "acquirable-from-admitted-evidence", "requires-probe", "unacquirable-within-budget"].includes(String(row.acquirability.status))
      || !Array.isArray(row.acquirability.basisEvidenceIds) || typeof row.acquirability.rationale !== "string" || !row.acquirability.rationale.trim()
      || !Array.isArray(row.unusedRelevantTools)
      || Object.keys(row).some((key) => !["anchorId", "category", "acquirability", "unusedRelevantTools"].includes(key))
      || Object.keys(row.acquirability).some((key) => !["telemetryOnly", "status", "basisEvidenceIds", "rationale"].includes(key))) {
      throw new Error(`Ablation missed-anchor attribution ${index} is malformed`);
    }
    const basisEvidenceIds = uniqueSorted(row.acquirability.basisEvidenceIds, "Anchor acquirability evidence");
    if (basisEvidenceIds.some((id) => !evidenceById.has(id))) throw new Error("Anchor acquirability cannot cite evidence outside the bundle");
    const unusedRelevantTools = uniqueSorted(row.unusedRelevantTools, "Unused relevant tools") as ReasoningToolName[];
    if (unusedRelevantTools.some((tool) => !availableNames.has(tool)) || unusedRelevantTools.some((tool) => calledProbes.some((call) => call.tool === tool))) {
      throw new Error("Unused relevant tool telemetry conflicts with the live call sequence");
    }
    return {
      anchorId: row.anchorId,
      category: row.category as ProbeAttributionCategory,
      acquirability: {
        telemetryOnly: true as const,
        status: row.acquirability.status as AblationAnchorAcquirability["status"],
        basisEvidenceIds,
        rationale: row.acquirability.rationale,
      },
      unusedRelevantTools,
    };
  }).sort((left, right) => left.anchorId.localeCompare(right.anchorId));
  if (new Set(missedAnchorAttributions.map((row) => row.anchorId)).size !== missedAnchorAttributions.length) {
    throw new Error("Ablation missed-anchor attribution requires one row per unique anchor ID");
  }
  if (!isRecord(input.stopping) || typeof input.stopping.rationale !== "string" || !input.stopping.rationale.trim()
    || !Array.isArray(input.stopping.unusedRelevantTools)
    || Object.keys(input.stopping).some((key) => key !== "rationale" && key !== "unusedRelevantTools")) {
    throw new Error("Ablation probe telemetry requires a final stopping rationale");
  }
  const stoppingUnusedTools = uniqueSorted(input.stopping.unusedRelevantTools, "Stopping unused relevant tools") as ReasoningToolName[];
  if (stoppingUnusedTools.some((tool) => !availableNames.has(tool)) || stoppingUnusedTools.some((tool) => calledProbes.some((call) => call.tool === tool))) {
    throw new Error("Ablation stopping rationale names invalid unused relevant tools");
  }
  const usage = input.usage;
  if (!isRecord(usage) || !Number.isInteger(usage.modelCalls) || usage.modelCalls < 0
    || !Number.isInteger(usage.toolCalls) || usage.toolCalls !== calledProbes.length || usage.toolCalls < 0
    || !isRecord(usage.cache) || !Number.isInteger(usage.cache.hits) || !Number.isInteger(usage.cache.misses)
    || usage.cache.hits < 0 || usage.cache.misses < 0 || !Number.isInteger(usage.corrections) || usage.corrections < 0
    || [usage.inputTokens, usage.outputTokens, usage.latencyMs, usage.cost].some((value) => value !== null && (!Number.isFinite(value) || value < 0))) {
    throw new Error("Ablation probe telemetry usage is malformed");
  }
  const minimum = (field: "inputTokens" | "outputTokens" | "cost" | "latencyMs") => calledProbes.reduce((total, call) => total + (call.usage[field] || 0), 0);
  if ((usage.inputTokens !== null && usage.inputTokens < minimum("inputTokens"))
    || (usage.outputTokens !== null && usage.outputTokens < minimum("outputTokens"))
    || (usage.cost !== null && usage.cost < minimum("cost"))
    || (usage.latencyMs !== null && calledProbes.some((call) => call.usage.latencyMs !== null && usage.latencyMs! < call.usage.latencyMs))) {
    throw new Error("Ablation probe telemetry totals are smaller than recorded per-call usage");
  }
  const probeCacheHits = calledProbes.reduce((total, call) => total + call.usage.cache.hits, 0);
  const probeCacheMisses = calledProbes.reduce((total, call) => total + call.usage.cache.misses, 0);
  const probeCorrections = calledProbes.reduce((total, call) => total + call.usage.corrections, 0);
  if (usage.cache.hits < probeCacheHits || usage.cache.misses < probeCacheMisses || usage.corrections < probeCorrections) {
    throw new Error("Ablation probe telemetry totals are smaller than recorded per-call counters");
  }
  return {
    schemaVersion: ABLATION_PROBE_TELEMETRY_VERSION,
    bundleHash: bundle.bundleHash,
    beforeProbeEvidenceIds,
    postSaliencePresentedFactIds,
    availableTools,
    calledProbes,
    missedAnchorAttributions,
    stopping: { rationale: input.stopping.rationale, unusedRelevantTools: stoppingUnusedTools },
    usage: { modelCalls: usage.modelCalls, toolCalls: usage.toolCalls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: usage.latencyMs, cache: { hits: usage.cache.hits, misses: usage.cache.misses }, cost: usage.cost, corrections: usage.corrections },
  };
}

export function createAblationProbeTelemetry(
  bundle: Readonly<AblationEvidenceClosureBundle>,
  input: CreateAblationProbeTelemetryInput,
): Readonly<AblationProbeTelemetry> {
  validateAblationEvidenceClosureBundle(bundle);
  const normalized = normalizeTelemetry(bundle, input);
  return deepFreeze({ ...normalized, telemetryHash: telemetryHash(normalized) });
}

export function validateAblationProbeTelemetry(
  bundle: Readonly<AblationEvidenceClosureBundle>,
  value: unknown,
): asserts value is Readonly<AblationProbeTelemetry> {
  validateAblationEvidenceClosureBundle(bundle);
  if (!isRecord(value) || Object.keys(value).some((key) => !TELEMETRY_KEYS.has(key))
    || value.schemaVersion !== ABLATION_PROBE_TELEMETRY_VERSION || value.bundleHash !== bundle.bundleHash) {
    throw new Error("Unsupported ablation probe telemetry");
  }
  assertDeepFrozen(value, "telemetry");
  const { telemetryHash: suppliedHash, schemaVersion: _schemaVersion, bundleHash: _bundleHash, ...unhashed } = value as AblationProbeTelemetry;
  void _schemaVersion;
  void _bundleHash;
  const normalized = normalizeTelemetry(bundle, unhashed);
  const expectedHash = telemetryHash(normalized);
  if (suppliedHash !== expectedHash || stableJson(value) !== stableJson({ ...normalized, telemetryHash: expectedHash })) {
    throw new Error("Ablation probe telemetry integrity check failed");
  }
}

/** The fixed category order makes reporting stable and prevents ad-hoc labels. */
export function precommittedProbeAttributionCategories(): readonly ProbeAttributionCategory[] {
  return PRECOMMITTED_PROBE_ATTRIBUTION_CATEGORIES;
}
