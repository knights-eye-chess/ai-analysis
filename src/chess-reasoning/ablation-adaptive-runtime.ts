import { Output, generateText, jsonSchema, type LanguageModel, type LanguageModelCallOptions } from "ai";
import {
  DIRECT_SYNTHESIS_PROPOSAL_JSON_SCHEMA,
  materializeDirectSynthesis,
  type DirectSynthesisArtifact,
  type DirectSynthesisIssue,
} from "./ablation-direct-synthesis";
import {
  ablationHistoryThroughTargetHash,
  createAblationProbeTelemetry,
  enrichAblationEvidenceClosureBundle,
  validateAblationEvidenceClosureBundle,
  type AblationCalledProbe,
  type AblationEvidenceClosureBundle,
  type AblationEvidenceClosureCoverage,
  type AblationProbeTelemetry,
} from "./ablation-evidence-bundle";
import { projectAblationEvidenceForModel } from "./ablation-model-facing-evidence";
import { effectiveLicensesForRecord } from "./evidence-licenses";
import { collectReasoningMoveWitnesses } from "./poc-move-witnesses";
import type {
  ReasoningObservation,
  ReasoningToolDescriptor,
  ReasoningToolName,
  ReasoningToolResult,
} from "./poc-contracts";
import { REASONING_POC_VERSION } from "./poc-contracts";
import { stableJson } from "./stable";
import {
  AblationTransportCorrectionError,
  assertTransportOnlyDirectCorrection,
  isTransportCorrectableDirectSynthesisIssues,
} from "./ablation-transport-correction";

export { AblationTransportCorrectionError, assertTransportOnlyDirectCorrection } from "./ablation-transport-correction";
/** @deprecated Use AblationTransportCorrectionError from the shared module. */
export { AblationTransportCorrectionError as AdaptiveTransportCorrectionError } from "./ablation-transport-correction";

/**
 * Adaptive direct arms remain deliberately outside the staged-C review chain.
 * The evidence-loop boundary is injectable so the browser and Node adapters can
 * drive the same episode without giving this experiment its own tool runtime.
 */
export const ABLATION_ADAPTIVE_RUNTIME_VERSION = "architecture-ablation-adaptive-runtime/2" as const;

export const ABLATION_B_SYSTEM = `You are Knight's Eye in adaptive direct arm B. You may use only the supplied bounded fact and probe tools to acquire evidence about the selected move. Work iteratively, stop as soon as the available evidence is sufficient, and do not infer purpose, safety, forcedness, or a plan merely from a legal move. The verbatim user question is authoritative. You receive no later game history, evaluator answer keys, graph, critic, review, checkpoint, or render state.`;

export const ABLATION_B_DIRECT_SYSTEM = `You are Knight's Eye in adaptive direct arm B. Return exactly one object matching the direct-synthesis schema over the frozen evidence closure. This is a pre-checkpoint proposal, not a supported product answer. Cite only allowed evidence and observations. Evidence licenses are strict ceilings: legal sequence evidence establishes legality and identity, and bounded engine evidence establishes only the recorded bounded line, score, comparison, or response coverage. Do not claim intent, a forced plan, or strategic relevance unless the evidence itself licenses the bounded claim.`;

export const ABLATION_B_PRIME_CRITIC_SYSTEM = `You are the single bounded semantic reconsideration for Knight's Eye architecture-ablation arm B-prime. You have no tools and may not acquire evidence. Given a frozen direct proposal, explicit generic trigger values, and the same frozen evidence closure, decide whether the proposal can be retained or needs one corrected replacement. A correction may only use existing IDs and evidence licenses; it may narrow, qualify, or remove unsupported meaning but may not add evidence, broaden authority, change the user question, or invoke another critic. Return exactly the required object.`;

export const ABLATION_B_PRIME_TRIGGER_VALUES = Object.freeze([
  "claim.forced-best-unique-safe-winning-principal-purpose",
  "coverage.requested-defense-or-continuation-incomplete",
  "evidence.conflict",
  "claim.sacrifice-or-long-multistep",
  "plan.legal-affordance-only",
  "model.high-uncertainty",
  "validation.semantic-reconsideration-required",
] as const);

export type AblationAdaptiveArm = "B" | "B-prime";
export type AblationBPrimeTrigger = typeof ABLATION_B_PRIME_TRIGGER_VALUES[number];

export type AdaptiveCallUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  cache: { hits: number; misses: number };
  cost: number | null;
};

export type AdaptiveEvidenceToolRound = {
  /** Monotonic across both returned and failed tool executions. */
  attempt: number;
  callId: string;
  requestId: string;
  tool: ReasoningToolName;
  input: Record<string, unknown>;
  selectionRationale: string;
  modelStatedRationale: string | null;
  result: ReasoningToolResult;
  usage: AdaptiveCallUsage;
};

/**
 * A requested tool is still a telemetry event when its host execution fails.
 * Keep this transport-only record separate from a valid tool result: inventing
 * a result/evidence record for a failure would make the closure dishonest.
 */
export type AdaptiveEvidenceToolFailure = {
  attempt: number;
  callId: string;
  requestId: string;
  tool: ReasoningToolName;
  input: Record<string, unknown>;
  selectionRationale: string;
  modelStatedRationale: string | null;
  failureCode: "tool-execution-failed";
  usage: AdaptiveCallUsage;
};

export type AdaptiveEvidenceStoppingReason =
  | "model-finished"
  | "tool-budget-exhausted"
  | "probe-budget-exhausted"
  | "model-decision-budget-exhausted";

export type AdaptiveEvidenceLoopResult = {
  /** Only already-executed presemantic fact/probe calls may cross this boundary. */
  rounds: readonly AdaptiveEvidenceToolRound[];
  /** Requested executions that started but did not return an admissible result. */
  failedToolCalls: readonly AdaptiveEvidenceToolFailure[];
  /** Exact descriptors advertised to the model for this bounded episode. */
  availableTools: readonly ReasoningToolDescriptor[];
  /** Fact/probe evidence actually retained by the existing salience policy. */
  saliencePresentedFactIds: readonly string[];
  addedObservations?: readonly ReasoningObservation[];
  coverage: AblationEvidenceClosureCoverage;
  stopping: { reason: AdaptiveEvidenceStoppingReason; rationale: string; unusedRelevantTools: ReasoningToolName[] };
  /** Counts provider calls made by the injected model-owned loop. */
  modelCalls: number;
  usage: AdaptiveCallUsage & { corrections: number };
};

export type AdaptiveEvidenceLoopInput = {
  arm: AblationAdaptiveArm;
  system: string;
  /** The first provider-visible bytes of every loop call must be this prefix. */
  firstProviderVisiblePrefix: string;
  /** Call once for every additional provider attempt/retry after the first. */
  nextProviderVisiblePrefix: () => string;
  bundle: Readonly<AblationEvidenceClosureBundle>;
  tools: readonly ReasoningToolDescriptor[];
  maxToolCalls: number;
  maxProbeCalls: number;
  maxModelSteps: number;
  signal?: AbortSignal;
};

/**
 * Adapters own tool-call transport and may use ToolLoopAgent. This contract
 * makes its evidence output auditable while forbidding it from adding semantic
 * state or bypassing production evidence records.
 */
export interface AdaptiveEvidenceLoop {
  run(input: AdaptiveEvidenceLoopInput): Promise<AdaptiveEvidenceLoopResult>;
}

export type AblationAdaptiveCallDiagnostic = {
  stage: "B-evidence" | "B-direct" | "B-prime-critic" | "B-transport-correction";
  nonce: string;
  inputBytes: number;
  outputBytes: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  cost: number | null;
  correctionCount: number;
  outcome: "succeeded" | "failed" | "skipped" | "aborted";
  failureCode: string | null;
};

export type AblationAdaptiveRuntimeOptions = {
  model: LanguageModel;
  /**
   * Optional isolated B-prime critic transport.  The original adaptive model
   * and reasoning setting remain the backwards-compatible default for every
   * stage unless the bounded critic explicitly supplies its own profile.
   */
  criticModel?: LanguageModel;
  evidenceLoop: AdaptiveEvidenceLoop;
  /** The exact fact/probe descriptor set exposed to the model-owned loop. */
  evidenceTools: readonly ReasoningToolDescriptor[];
  /** Fresh, opaque, unique values supplied by the benchmark runner. */
  benchmarkNonceForCall: (stage: "evidence" | "direct" | "critic" | "transport-correction", ordinal: number) => string;
  modelName?: string;
  providerRoute?: string;
  reasoning?: NonNullable<LanguageModelCallOptions["reasoning"]>;
  criticReasoning?: NonNullable<LanguageModelCallOptions["reasoning"]>;
  temperature?: number;
  maxOutputTokens: number;
  /** One precommitted wall-time envelope for the complete B/B′ episode. */
  maxWallTimeMs: number;
  maxToolCalls: number;
  maxProbeCalls: number;
  maxModelSteps: number;
  triggerPolicy?: (input: AdaptiveTriggerPolicyInput) => readonly AblationBPrimeTrigger[];
};

export type AdaptiveTriggerPolicyInput = {
  bundle: Readonly<AblationEvidenceClosureBundle>;
  proposal: unknown;
  artifact: DirectSynthesisArtifact | null;
  initialIssues: readonly DirectSynthesisIssue[];
};

export type AblationAdaptiveFailure = {
  code: "adaptive-evidence-loop-rejected" | "direct-synthesis-rejected" | "transport-correction-rejected" | "critic-rejected" | "provider-or-structured-output" | "adaptive-timeout" | "adaptive-aborted";
  issues?: DirectSynthesisIssue[];
};

/** B/B′ deliberately start from the frozen initial-exact cell, never a prior enrichment. */
export class AdaptiveAblationPreconditionError extends Error {
  readonly code = "starting-bundle-must-be-original" as const;
  constructor() {
    super("Adaptive ablation B/B-prime must start from an original initial-exact evidence bundle");
    this.name = "AdaptiveAblationPreconditionError";
  }
}

export type AblationAdaptiveResult = {
  arm: AblationAdaptiveArm;
  ok: boolean;
  bundle: Readonly<AblationEvidenceClosureBundle>;
  artifact?: DirectSynthesisArtifact;
  telemetry: Readonly<AblationProbeTelemetry>;
  triggers: readonly AblationBPrimeTrigger[];
  diagnostics: AblationAdaptiveCallDiagnostic[];
  failure?: AblationAdaptiveFailure;
};

type CriticDecision = {
  schemaVersion: typeof ABLATION_ADAPTIVE_RUNTIME_VERSION;
  decision: "retain" | "replace";
  rationale: string;
  replacement?: unknown;
};

const CRITIC_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "decision", "rationale"],
  properties: {
    schemaVersion: { const: ABLATION_ADAPTIVE_RUNTIME_VERSION },
    decision: { enum: ["retain", "replace"] },
    rationale: { type: "string", minLength: 1, maxLength: 2_000 },
    replacement: DIRECT_SYNTHESIS_PROPOSAL_JSON_SCHEMA,
  },
} as const;

const PRESEMANTIC_TOOLS = new Set<ReasoningToolName>([
  "inspect_position", "analyze_move", "explore_continuations", "compare_moves", "enumerate_defenses", "test_line",
]);
const FORBIDDEN_ADAPTIVE_TELEMETRY_KEYS = new Set([
  "evaluatorAnchor", "evaluatorAnchors", "idealProse", "answerKey", "laterMoves",
]);

function bytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

function nonEmptyNonce(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error("Adaptive ablation calls require a bounded supplied benchmark nonce");
  return value;
}

function firstPrefix(nonce: string, body: string): string {
  return `[Benchmark cache-isolation nonce: ${nonce}. Ignore this opaque identifier; it has no chess, workflow, or output meaning.]\n\n${body}`;
}

function sum(values: readonly (number | null)[]): number | null {
  return values.every((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value || 0), 0);
}

function sameRecord(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function assertNoEvaluatorTelemetryPayload(value: unknown, path = "adaptive loop telemetry"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEvaluatorTelemetryPayload(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_ADAPTIVE_TELEMETRY_KEYS.has(key)) throw new Error(`Adaptive loop telemetry contains evaluator-only payload at ${path}.${key}`);
    assertNoEvaluatorTelemetryPayload(child, `${path}.${key}`);
  }
}

type AdaptiveAbortCode = "adaptive-timeout" | "adaptive-aborted";

type AdaptiveAbortScope = {
  signal: AbortSignal;
  code(): AdaptiveAbortCode | null;
  dispose(): void;
};

function createAdaptiveAbortScope(external: AbortSignal | undefined, maxWallTimeMs: number): AdaptiveAbortScope {
  const controller = new AbortController();
  let stopped: AdaptiveAbortCode | null = null;
  const abortExternally = () => {
    if (stopped) return;
    stopped = "adaptive-aborted";
    controller.abort(new Error("Adaptive ablation episode cancelled"));
  };
  if (external?.aborted) abortExternally();
  else external?.addEventListener("abort", abortExternally, { once: true });
  const timer = setTimeout(() => {
    if (stopped) return;
    stopped = "adaptive-timeout";
    controller.abort(new Error("Adaptive ablation episode exceeded its wall-time budget"));
  }, maxWallTimeMs);
  return {
    signal: controller.signal,
    code: () => stopped,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", abortExternally);
    },
  };
}

function throwIfAdaptiveStopped(scope: AdaptiveAbortScope): void {
  const code = scope.code();
  if (code) throw Object.assign(new Error("Adaptive ablation episode stopped"), { adaptiveAbortCode: code });
}

function adaptiveAbortCode(scope: AdaptiveAbortScope, error?: unknown): AdaptiveAbortCode | null {
  const explicit = error && typeof error === "object" ? (error as { adaptiveAbortCode?: unknown }).adaptiveAbortCode : null;
  return explicit === "adaptive-timeout" || explicit === "adaptive-aborted" ? explicit : scope.code();
}

async function abortable<T>(scope: AdaptiveAbortScope, work: Promise<T>): Promise<T> {
  // `work` may have observed the signal while the call expression was being
  // evaluated. Consume that late provider/loop rejection before returning the
  // sanitized episode status; otherwise it becomes an unhandled rejection.
  if (scope.signal.aborted) {
    void work.catch(() => undefined);
    throwIfAdaptiveStopped(scope);
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("Adaptive ablation episode stopped"), { adaptiveAbortCode: scope.code() || "adaptive-aborted" }));
    scope.signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => { scope.signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { scope.signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export function deriveAblationBPrimeTriggers(input: AdaptiveTriggerPolicyInput): AblationBPrimeTrigger[] {
  const triggers = new Set<AblationBPrimeTrigger>();
  // Trigger policy intentionally reads only structured semantic payloads. It
  // must never rediscover words in an evidence summary or scrape a raw prompt.
  const claimText = input.artifact?.claims.flatMap((claim) => [
    ...claim.content.filter((segment) => segment.type === "text").map((segment) => segment.text),
    ...claim.qualifications.flatMap((qualification) => qualification.filter((segment) => segment.type === "text").map((segment) => segment.text)),
  ]).join(" ").toLowerCase() || "";
  const riskReasons = input.artifact?.riskProfile.reasons.join(" ").toLowerCase() || "";
  if (/\b(forced|best|unique|safe|winning|principal purpose)\b/.test(claimText)) triggers.add("claim.forced-best-unique-safe-winning-principal-purpose");
  if (input.artifact && (input.artifact.coverage.responseCoverage.status !== "complete" || input.artifact.coverage.continuationCoverage.status !== "complete")) {
    triggers.add("coverage.requested-defense-or-continuation-incomplete");
  }
  if (input.artifact && input.artifact.coverage.unresolvedEvidenceObligations.length > 0 && /\b(always|only|must|cannot)\b/.test(claimText)) triggers.add("evidence.conflict");
  if (/\b(sacrifice|sac|long[- ]term|multi[- ]step)\b/.test(claimText)) triggers.add("claim.sacrifice-or-long-multistep");
  const planHypotheses = input.artifact?.hypotheses.filter((hypothesis) => hypothesis.entityType === "plan" || hypothesis.concepts.some((concept) => concept.startsWith("plan."))) || [];
  if (planHypotheses.length && input.artifact && !planHypotheses.some((hypothesis) => hypothesis.evidenceIds.some((id) => {
    const evidence = input.bundle.evidence.find((record) => record.id === id);
    return evidence ? effectiveLicensesForRecord(evidence).some((license) => license.startsWith("engine.bounded-")) : false;
  }))) {
    triggers.add("plan.legal-affordance-only");
  }
  if (input.artifact?.riskProfile.level === "high" || /\b(uncertain|unclear|unknown|insufficient)\b/.test(riskReasons)) triggers.add("model.high-uncertainty");
  if (input.initialIssues.length) triggers.add("validation.semantic-reconsideration-required");
  return [...triggers].sort() as AblationBPrimeTrigger[];
}

function exactTriggers(values: readonly AblationBPrimeTrigger[]): AblationBPrimeTrigger[] {
  if (values.some((value) => !ABLATION_B_PRIME_TRIGGER_VALUES.includes(value))) throw new Error("Adaptive B-prime trigger policy returned an unsupported trigger");
  return [...new Set(values)].sort() as AblationBPrimeTrigger[];
}

function normalizedDescriptors(values: readonly ReasoningToolDescriptor[]): ReasoningToolDescriptor[] {
  return [...values].map((value) => structuredClone(value)).sort((left, right) => left.name.localeCompare(right.name));
}

function validateLoopResult(
  original: Readonly<AblationEvidenceClosureBundle>,
  result: AdaptiveEvidenceLoopResult,
  limits: Pick<AblationAdaptiveRuntimeOptions, "maxToolCalls" | "maxProbeCalls" | "maxModelSteps">,
  advertisedTools: readonly ReasoningToolDescriptor[],
): ReasoningToolDescriptor[] {
  if (!Number.isInteger(result.modelCalls) || result.modelCalls < 0 || result.modelCalls > limits.maxModelSteps || !Array.isArray(result.rounds) || !Array.isArray(result.failedToolCalls)
    || result.rounds.length + result.failedToolCalls.length > limits.maxToolCalls) {
    throw new Error("Adaptive evidence loop exceeded its model or tool budget");
  }
  if (!result.coverage || !result.stopping?.rationale?.trim() || !Array.isArray(result.stopping.unusedRelevantTools)
    || !["model-finished", "tool-budget-exhausted", "probe-budget-exhausted", "model-decision-budget-exhausted"].includes(result.stopping.reason)) {
    throw new Error("Adaptive evidence loop omitted explicit stopping telemetry");
  }
  if (!Array.isArray(result.coverage.covered) || !Array.isArray(result.coverage.omitted) || !Array.isArray(result.coverage.unavailable) || !Array.isArray(result.coverage.limitations)) {
    throw new Error("Adaptive evidence loop omitted explicit coverage telemetry");
  }
  if (!Array.isArray(result.saliencePresentedFactIds) || result.saliencePresentedFactIds.some((id) => typeof id !== "string" || !id.trim())) throw new Error("Adaptive evidence loop omitted salience membership");
  const descriptors = normalizedDescriptors(result.availableTools);
  if (sameRecord(descriptors, normalizedDescriptors(advertisedTools)) === false) throw new Error("Adaptive evidence loop changed the advertised tool set");
  const descriptorByName = new Map(descriptors.map((item) => [item.name, item]));
  const calls = new Set<string>();
  const attempts = new Set<number>();
  let probes = 0;
  for (const round of result.rounds) {
    if (!Number.isInteger(round.attempt) || round.attempt < 1 || attempts.has(round.attempt)
      || !round.callId?.trim() || calls.has(round.callId) || !round.requestId?.trim() || !PRESEMANTIC_TOOLS.has(round.tool)) {
      throw new Error("Adaptive evidence loop returned an invalid tool round");
    }
    attempts.add(round.attempt);
    calls.add(round.callId);
    assertNoEvaluatorTelemetryPayload(round.input, `adaptive tool round ${round.callId}.input`);
    assertNoEvaluatorTelemetryPayload(round.result, `adaptive tool round ${round.callId}.result`);
    if (!descriptorByName.has(round.tool) || round.result.schemaVersion !== REASONING_POC_VERSION || round.result.callId !== round.callId || round.result.tool !== round.tool || round.result.contextHash !== original.contextHash) throw new Error("Adaptive evidence loop returned a cross-context or unadvertised tool result");
    if (round.tool !== "inspect_position" && round.tool !== "analyze_move") probes += 1;
    if (!round.selectionRationale?.trim() || !round.result || !Array.isArray(round.result.evidence)) throw new Error("Adaptive evidence loop round lacks its model-owned selection rationale");
  }
  for (const failed of result.failedToolCalls) {
    if (!Number.isInteger(failed.attempt) || failed.attempt < 1 || attempts.has(failed.attempt)
      || !failed.callId?.trim() || calls.has(failed.callId) || !failed.requestId?.trim() || !PRESEMANTIC_TOOLS.has(failed.tool)
      || !descriptorByName.has(failed.tool) || !failed.selectionRationale?.trim() || !failed.input || typeof failed.input !== "object" || Array.isArray(failed.input)
      || failed.failureCode !== "tool-execution-failed") {
      throw new Error("Adaptive evidence loop returned malformed failed-tool telemetry");
    }
    attempts.add(failed.attempt);
    calls.add(failed.callId);
    assertNoEvaluatorTelemetryPayload(failed.input, `adaptive failed tool ${failed.callId}.input`);
    if (failed.tool !== "inspect_position" && failed.tool !== "analyze_move") probes += 1;
  }
  if (probes > limits.maxProbeCalls) throw new Error("Adaptive evidence loop exceeded its probe budget");
  if (result.stopping.unusedRelevantTools.some((tool) => !descriptorByName.has(tool) || result.rounds.some((round) => round.tool === tool) || result.failedToolCalls.some((failed) => failed.tool === tool))) {
    throw new Error("Adaptive evidence loop reported invalid unused tools");
  }
  const attemptedToolCalls = result.rounds.length + result.failedToolCalls.length;
  if ((result.stopping.reason === "tool-budget-exhausted" && attemptedToolCalls !== limits.maxToolCalls)
    || (result.stopping.reason === "model-decision-budget-exhausted" && result.modelCalls !== limits.maxModelSteps)
    || (result.stopping.reason === "probe-budget-exhausted" && (probes < limits.maxProbeCalls || descriptors.some((descriptor) => descriptor.name === "inspect_position" || descriptor.name === "analyze_move")))) {
    throw new Error("Adaptive evidence loop stopping reason does not match its recorded budget state");
  }
  const modelFacingIds = new Set(projectAblationEvidenceForModel(original).visibleEvidenceIds);
  for (const round of result.rounds) for (const evidence of round.result.evidence) modelFacingIds.add(evidence.id);
  if (result.saliencePresentedFactIds.some((id) => !modelFacingIds.has(id))) throw new Error("Adaptive evidence loop presented evidence that was never available to the model");
  return descriptors;
}

function enrichedBundle(
  original: Readonly<AblationEvidenceClosureBundle>,
  result: AdaptiveEvidenceLoopResult,
): Readonly<AblationEvidenceClosureBundle> {
  const additions = result.rounds.flatMap((round) => round.result.evidence);
  if (!additions.length) return original;
  const allEvidence = [...original.evidence, ...additions];
  const witnesses = collectReasoningMoveWitnesses(allEvidence, original.context);
  const addedReferences = witnesses.flatMap((witness) => [
    { domain: "move" as const, id: witness.uci },
    { domain: "piece" as const, id: witness.pieceId },
  ]);
  const oldReferences = original.referenceAllowlists.semanticReferences;
  const references = [...new Map([...oldReferences, ...addedReferences].map((value) => [`${value.domain}:${value.id}`, value] as const)).values()];
  return enrichAblationEvidenceClosureBundle(original, {
    observations: [...(result.addedObservations || [])],
    evidence: additions,
    coverage: mergedCoverage(original.coverage, result.coverage),
    referenceAllowlists: {
      evidenceIds: allEvidence.map((record) => record.id),
      observationIds: [...original.observations, ...(result.addedObservations || [])].map((observation) => observation.id),
      toolNames: [...new Set([...original.referenceAllowlists.toolNames, ...result.rounds.map((round) => round.tool)])].sort(),
      semanticReferences: references,
      moveWitnesses: witnesses,
    },
  });
}

function mergedCoverage(
  original: AblationEvidenceClosureCoverage,
  acquired: AblationEvidenceClosureCoverage,
): AblationEvidenceClosureCoverage {
  const union = <T,>(items: readonly T[], key: (item: T) => string) => [...new Map(items.map((item) => [key(item), item] as const)).values()];
  const omitted = union([...original.omitted, ...acquired.omitted], (item) => `${item.domain}:${item.id}`)
    .sort((left, right) => `${left.domain}:${left.id}`.localeCompare(`${right.domain}:${right.id}`));
  const unavailable = union([...original.unavailable, ...acquired.unavailable], (item) => item.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    // An acquisition pass can add coverage but cannot erase inherited scope
    // limits or turn an incomplete starting cell into an exhaustive closure.
    complete: original.complete && acquired.complete && !omitted.length && !unavailable.length,
    covered: [...new Set([...original.covered, ...acquired.covered])].sort(),
    omitted,
    unavailable,
    limitations: [...new Set([...original.limitations, ...acquired.limitations])].sort(),
  };
}

function probeTelemetry(
  bundle: Readonly<AblationEvidenceClosureBundle>,
  descriptors: readonly ReasoningToolDescriptor[],
  result: AdaptiveEvidenceLoopResult,
  artifact: DirectSynthesisArtifact | undefined,
  diagnostics: readonly AblationAdaptiveCallDiagnostic[],
  limits: Pick<AblationAdaptiveRuntimeOptions, "maxToolCalls" | "maxProbeCalls">,
): Readonly<AblationProbeTelemetry> {
  const modelView = projectAblationEvidenceForModel(bundle);
  const modelBundle = modelView.bundle;
  const hypothesisIdsForEvidence = (evidenceIds: readonly string[]) => artifact
    ? artifact.hypotheses.filter((hypothesis) => hypothesis.evidenceIds.some((id) => evidenceIds.includes(id))).map((hypothesis) => hypothesis.id).sort()
    : [];
  const priorEvidenceIds = new Set(modelView.visibleEvidenceIds.filter((id) => bundle.lineage.kind !== "enriched" || !bundle.lineage.acquiredEvidenceIds.includes(id)));
  const beforeProbeEvidenceIds = new Set(priorEvidenceIds);
  const effectForRound = (
    round: AdaptiveEvidenceToolRound,
    evidenceIds: readonly string[],
    hypotheses: readonly string[],
    hypothesesWithCompleteBasis: readonly string[],
  ): "materially-changed" | "supported" | "rejected" | "no-change" => {
    if (!evidenceIds.length || !hypotheses.length) return "no-change";
    if (round.result.support === "unsupported") return "rejected";
    const complete = artifact!.hypotheses.filter((hypothesis) => hypothesesWithCompleteBasis.includes(hypothesis.id));
    // This is the narrow case where the telemetry can prove a before/after
    // difference from recorded citations: the whole cited basis is now
    // present, and none of that basis was in the pre-probe closure. A cited
    // result that is still awaiting another cited result remains support, not
    // a no-op; citations do not establish causal necessity by themselves.
    return complete.some((hypothesis) => hypothesis.evidenceIds.every((id) => !beforeProbeEvidenceIds.has(id)))
      ? "materially-changed"
      : "supported";
  };
  const calls: Array<{ attempt: number; call: AblationCalledProbe }> = [...result.rounds].sort((left, right) => left.attempt - right.attempt).map((round, callIndex) => {
    const evidenceIds = round.result.evidence.map((record) => record.id).filter((id) => modelBundle.referenceAllowlists.evidenceIds.includes(id));
    const candidateHypotheses = hypothesisIdsForEvidence(evidenceIds);
    const availableAfterThisRound = new Set([...priorEvidenceIds, ...evidenceIds]);
    const hypothesesWithCompleteBasis = artifact
      ? artifact.hypotheses.filter((hypothesis) => candidateHypotheses.includes(hypothesis.id) && hypothesis.evidenceIds.every((id) => availableAfterThisRound.has(id))).map((hypothesis) => hypothesis.id).sort()
      : [];
    // Every admitted final citation is semantic consumption. A later cited
    // result may be needed before the final basis is complete, but that does
    // not turn this earlier supporting result into a no-change event.
    const hypotheses = candidateHypotheses;
    const admitted = evidenceIds.length > 0;
    const consumed = admitted && hypotheses.length > 0;
    const descriptor = descriptors.find((item) => item.name === round.tool)!;
    const lineRecord = round.result.evidence.find((record) => Array.isArray(record.data.lines));
    const coverage = lineRecord?.coverage || { complete: false, covered: [], unresolved: [] };
    const effect = artifact ? effectForRound(round, evidenceIds, hypotheses, hypothesesWithCompleteBasis) : "no-change";
    for (const evidenceId of evidenceIds) priorEvidenceIds.add(evidenceId);
    return { attempt: round.attempt, call: {
      callId: round.callId,
      requestId: round.requestId,
      tool: round.tool,
      request: { descriptor, input: structuredClone(round.input), selectionRationale: round.selectionRationale },
      target: { fen: bundle.context.fenAfter, historyThroughTargetHash: ablationHistoryThroughTargetHash(bundle.context) },
      permittedLimits: { maxToolCalls: limits.maxToolCalls, maxProbeCalls: limits.maxProbeCalls, engine: null },
      approval: {
        approved: true,
        budgetReason: "within-frozen-adaptive-budget",
        remainingToolCalls: Math.max(0, limits.maxToolCalls - callIndex - 1),
        remainingProbeCalls: Math.max(0, limits.maxProbeCalls - result.rounds.slice(0, callIndex + 1).filter((item) => item.tool !== "inspect_position" && item.tool !== "analyze_move").length),
      },
      status: { started: true, finished: "returned" },
      returned: { lines: Array.isArray(lineRecord?.data.lines) ? lineRecord!.data.lines.length : 0, coverage },
      admission: { status: admitted ? "admitted" : "not-produced", reason: admitted ? "admitted-into-frozen-direct-closure" : "tool-returned-no-admissible-evidence" },
      admittedEvidence: evidenceIds.map((evidenceId) => ({ evidenceId, licenses: effectiveLicensesForRecord(modelBundle.evidence.find((record) => record.id === evidenceId)!) })),
      presentation: { presentedToModel: admitted, reason: admitted ? "frozen-direct-submission-context" : "no-admitted-evidence" },
      semanticConsumption: { status: consumed ? "consumed" : "not-consumed", hypothesisIds: hypotheses },
      modelStatedRationale: round.modelStatedRationale,
      effect,
      hypothesisIds: hypotheses,
      usage: { ...round.usage, corrections: 0 },
    } };
  });
  for (const failed of result.failedToolCalls) {
    const descriptor = descriptors.find((item) => item.name === failed.tool)!;
    calls.push({ attempt: failed.attempt, call: {
      callId: failed.callId,
      requestId: failed.requestId,
      tool: failed.tool,
      request: { descriptor, input: structuredClone(failed.input), selectionRationale: failed.selectionRationale },
      target: { fen: bundle.context.fenAfter, historyThroughTargetHash: ablationHistoryThroughTargetHash(bundle.context) },
      permittedLimits: { maxToolCalls: limits.maxToolCalls, maxProbeCalls: limits.maxProbeCalls, engine: null },
      approval: { approved: true, budgetReason: "within-frozen-adaptive-budget", remainingToolCalls: Math.max(0, limits.maxToolCalls - failed.attempt), remainingProbeCalls: Math.max(0, limits.maxProbeCalls - result.rounds.filter((round) => round.attempt <= failed.attempt && round.tool !== "inspect_position" && round.tool !== "analyze_move").length) },
      status: { started: true, finished: "failed" },
      returned: null,
      admission: { status: "not-produced", reason: failed.failureCode },
      admittedEvidence: [],
      presentation: { presentedToModel: false, reason: failed.failureCode },
      semanticConsumption: { status: "not-reached", hypothesisIds: [] },
      modelStatedRationale: failed.modelStatedRationale,
      effect: "failure",
      hypothesisIds: [],
      usage: { ...failed.usage, corrections: 0 },
    } });
  }
  const orderedCalls = calls.sort((left, right) => left.attempt - right.attempt).map((item) => item.call);
  const modelDiagnostics = diagnostics.filter((item) => item.stage !== "B-evidence");
  const acquiredEvidenceIds = bundle.lineage.kind === "enriched" ? bundle.lineage.acquiredEvidenceIds : [];
  return createAblationProbeTelemetry(bundle, {
    beforeProbeEvidenceIds: modelView.visibleEvidenceIds.filter((id) => !acquiredEvidenceIds.includes(id)),
    postSaliencePresentedFactIds: [...result.saliencePresentedFactIds].filter((id) => modelView.visibleEvidenceIds.includes(id)),
    availableTools: [...descriptors],
    calledProbes: orderedCalls,
    missedAnchorAttributions: [],
    stopping: { rationale: result.stopping.rationale, unusedRelevantTools: result.stopping.unusedRelevantTools },
    usage: {
      modelCalls: result.modelCalls + modelDiagnostics.filter((item) => item.outcome !== "skipped").length,
      toolCalls: orderedCalls.length,
      // `result.usage` is the loop's complete evidence-decision accounting.
      // Round usage is only the tool execution view and must not replace it.
      inputTokens: sum([result.usage.inputTokens, ...modelDiagnostics.map((item) => item.inputTokens)]),
      outputTokens: sum([result.usage.outputTokens, ...modelDiagnostics.map((item) => item.outputTokens)]),
      latencyMs: sum([result.usage.latencyMs, ...modelDiagnostics.map((item) => item.latencyMs)]),
      cache: { hits: result.usage.cache.hits, misses: result.usage.cache.misses },
      cost: sum([result.usage.cost, ...modelDiagnostics.map((item) => item.cost)]),
      corrections: result.usage.corrections + modelDiagnostics.reduce((total, item) => total + item.correctionCount, 0),
    },
  });
}

/**
 * C-plus consumes exactly B's model-owned evidence episode, then hands its
 * admitted closure to the frozen C chain.  Keeping this adapter here prevents
 * a second, subtly different evidence-to-bundle conversion in Gate 2.
 */
export function prepareAblationAdaptiveEvidenceForStagedReference(
  original: Readonly<AblationEvidenceClosureBundle>,
  loop: AdaptiveEvidenceLoopResult,
  evidenceTools: readonly ReasoningToolDescriptor[],
  limits: Pick<AblationAdaptiveRuntimeOptions, "maxToolCalls" | "maxProbeCalls" | "maxModelSteps">,
): Readonly<{ bundle: Readonly<AblationEvidenceClosureBundle>; telemetry: Readonly<AblationProbeTelemetry> }> {
  validateAblationEvidenceClosureBundle(original);
  if (original.lineage.kind !== "original") throw new AdaptiveAblationPreconditionError();
  const descriptors = validateLoopResult(original, loop, limits, evidenceTools);
  const bundle = enrichedBundle(original, loop);
  return Object.freeze({ bundle, telemetry: probeTelemetry(bundle, descriptors, loop, undefined, [], limits) });
}

function providerDiagnostic(stage: AblationAdaptiveCallDiagnostic["stage"], nonce: string, input: unknown): AblationAdaptiveCallDiagnostic {
  return { stage, nonce, inputBytes: bytes(input), outputBytes: null, latencyMs: null, inputTokens: null, outputTokens: null, cacheTokens: null, cost: null, correctionCount: 0, outcome: "failed", failureCode: null };
}

function abortedAfterValidLoop(
  scope: AdaptiveAbortScope,
  arm: AblationAdaptiveArm,
  bundle: Readonly<AblationEvidenceClosureBundle>,
  descriptors: readonly ReasoningToolDescriptor[],
  loop: AdaptiveEvidenceLoopResult,
  diagnostics: readonly AblationAdaptiveCallDiagnostic[],
  options: AblationAdaptiveRuntimeOptions,
  triggers: readonly AblationBPrimeTrigger[] = [],
): AblationAdaptiveResult {
  const code = scope.code();
  if (!code) throw new Error("Adaptive abort result requires a stopped episode");
  return {
    arm,
    ok: false,
    bundle,
    telemetry: probeTelemetry(bundle, descriptors, loop, undefined, diagnostics, options),
    triggers,
    diagnostics: [...diagnostics],
    failure: { code },
  };
}

function finishDiagnostic(diagnostic: AblationAdaptiveCallDiagnostic, result: Awaited<ReturnType<typeof generateText>>): void {
  diagnostic.outputBytes = bytes(result.output ?? result.text);
  const input = result.usage.inputTokens as unknown;
  const output = result.usage.outputTokens as unknown;
  diagnostic.inputTokens = typeof input === "number" ? input : input && typeof input === "object" && typeof (input as { total?: unknown }).total === "number" ? (input as { total: number }).total : null;
  diagnostic.outputTokens = typeof output === "number" ? output : output && typeof output === "object" && typeof (output as { total?: unknown }).total === "number" ? (output as { total: number }).total : null;
  diagnostic.latencyMs = result.steps.at(-1)?.performance.responseTimeMs ?? null;
  diagnostic.outcome = "succeeded";
}

async function directCall(
  options: AblationAdaptiveRuntimeOptions,
  abort: AdaptiveAbortScope,
  arm: AblationAdaptiveArm,
  bundle: Readonly<AblationEvidenceClosureBundle>,
  nonce: string,
  stage: "B-direct" | "B-transport-correction",
  correction: DirectSynthesisIssue[] | null,
): Promise<{ proposal: unknown; diagnostic: AblationAdaptiveCallDiagnostic }> {
  throwIfAdaptiveStopped(abort);
  const modelView = projectAblationEvidenceForModel(bundle);
  const modelFacingBundle = modelView.bundle;
  const prompt = correction
    ? JSON.stringify({ sourceBundleHash: modelView.sourceBundleHash, modelFacingEvidenceViewVersion: modelView.schemaVersion, modelFacingEvidenceViewHash: modelView.viewHash, bundle: modelFacingBundle, correction: { issues: correction, instruction: "Return a complete replacement. Fix only the listed transport/reference/schema paths; do not add evidence, observations, concepts, claims, relations, or demonstrations. For raw_chess_reference in a qualification text segment, retain the qualification's bounded meaning but replace only that raw text with a narrower generic text phrase that omits the unsupported concrete reference. Preserve all item IDs, evidence IDs, scope, and every other semantic association." } })
    : JSON.stringify({ schemaVersion: ABLATION_ADAPTIVE_RUNTIME_VERSION, arm, sourceBundleHash: modelView.sourceBundleHash, modelFacingEvidenceViewVersion: modelView.schemaVersion, modelFacingEvidenceViewHash: modelView.viewHash, bundle: modelFacingBundle });
  const system = firstPrefix(nonce, ABLATION_B_DIRECT_SYSTEM);
  const diagnostic = providerDiagnostic(stage, nonce, { system, prompt, schema: DIRECT_SYNTHESIS_PROPOSAL_JSON_SCHEMA });
  const started = performance.now();
  try {
    const result = await abortable(abort, generateText({
      model: options.model,
      system,
      prompt,
      output: Output.object({ schema: jsonSchema<Record<string, unknown>>(DIRECT_SYNTHESIS_PROPOSAL_JSON_SCHEMA as never), name: "knights_eye_ablation_adaptive_direct", description: "Pre-checkpoint direct synthesis proposal." }),
      abortSignal: abort.signal,
      maxOutputTokens: options.maxOutputTokens,
      maxRetries: 0,
      reasoning: options.reasoning || "provider-default",
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    }));
    diagnostic.latencyMs = Math.round(performance.now() - started);
    finishDiagnostic(diagnostic, result);
    if (correction) diagnostic.correctionCount = 1;
    return { proposal: result.output, diagnostic };
  } catch (error) {
    diagnostic.latencyMs = Math.round(performance.now() - started);
    const code = adaptiveAbortCode(abort, error);
    diagnostic.outcome = code ? "aborted" : "failed";
    diagnostic.failureCode = code || "provider-or-structured-output";
    throw Object.assign(error instanceof Error ? error : new Error("Adaptive direct provider failure"), { adaptiveDiagnostic: diagnostic });
  }
}


function ensureUniqueNonce(used: Set<string>, options: AblationAdaptiveRuntimeOptions, stage: Parameters<AblationAdaptiveRuntimeOptions["benchmarkNonceForCall"]>[0]): string {
  const nonce = nonEmptyNonce(options.benchmarkNonceForCall(stage, used.size));
  if (used.has(nonce)) throw new Error("Every adaptive provider call requires a distinct benchmark nonce");
  used.add(nonce);
  return nonce;
}

function criticPayload(bundle: Readonly<AblationEvidenceClosureBundle>, proposal: unknown, triggers: readonly AblationBPrimeTrigger[], initialIssues: readonly DirectSynthesisIssue[]): Record<string, unknown> {
  const modelView = projectAblationEvidenceForModel(bundle);
  return {
    schemaVersion: ABLATION_ADAPTIVE_RUNTIME_VERSION,
    sourceBundleHash: modelView.sourceBundleHash,
    modelFacingEvidenceViewVersion: modelView.schemaVersion,
    modelFacingEvidenceViewHash: modelView.viewHash,
    bundle: modelView.bundle,
    proposal,
    triggers,
    validationIssues: initialIssues,
  };
}

function assertCriticDecision(value: unknown): asserts value is CriticDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("B-prime critic returned no object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== ABLATION_ADAPTIVE_RUNTIME_VERSION || (record.decision !== "retain" && record.decision !== "replace") || typeof record.rationale !== "string" || !record.rationale.trim()) throw new Error("B-prime critic returned an invalid decision");
  if (record.decision === "replace" && !("replacement" in record)) throw new Error("B-prime critic replacement is missing");
  if (record.decision === "retain" && "replacement" in record) throw new Error("B-prime critic retain decision cannot rewrite the proposal");
}

export async function runAblationAdaptiveDirect(
  options: AblationAdaptiveRuntimeOptions,
  arm: AblationAdaptiveArm,
  original: Readonly<AblationEvidenceClosureBundle>,
  signal?: AbortSignal,
): Promise<AblationAdaptiveResult> {
  if (arm !== "B" && arm !== "B-prime") throw new Error("Adaptive ablation arm must be B or B-prime");
  if (!Number.isInteger(options.maxToolCalls) || options.maxToolCalls < 0 || !Number.isInteger(options.maxProbeCalls) || options.maxProbeCalls < 0 || !Number.isInteger(options.maxModelSteps) || options.maxModelSteps < 1 || !Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || !Number.isInteger(options.maxWallTimeMs) || options.maxWallTimeMs < 1) throw new Error("Adaptive ablation runtime requires bounded positive budgets and a positive wall-time budget");
  validateAblationEvidenceClosureBundle(original);
  if (original.lineage.kind !== "original") throw new AdaptiveAblationPreconditionError();
  const abort = createAdaptiveAbortScope(signal, options.maxWallTimeMs);
  try {
  const diagnostics: AblationAdaptiveCallDiagnostic[] = [];
  const usedNonces = new Set<string>();
  const evidenceNonce = ensureUniqueNonce(usedNonces, options, "evidence");
  const originalModelView = projectAblationEvidenceForModel(original);
  const evidenceDiagnostic = providerDiagnostic("B-evidence", evidenceNonce, {
    system: firstPrefix(evidenceNonce, ABLATION_B_SYSTEM),
    sourceBundleHash: originalModelView.sourceBundleHash,
    modelFacingEvidenceViewVersion: originalModelView.schemaVersion,
    modelFacingEvidenceViewHash: originalModelView.viewHash,
    bundle: originalModelView.bundle,
  });
  if (abort.code()) {
    evidenceDiagnostic.outcome = "aborted";
    evidenceDiagnostic.failureCode = abort.code();
    diagnostics.push(evidenceDiagnostic);
    const telemetry = createAblationProbeTelemetry(original, {
      beforeProbeEvidenceIds: [...originalModelView.visibleEvidenceIds],
      postSaliencePresentedFactIds: [...originalModelView.visibleEvidenceIds],
      availableTools: [],
      calledProbes: [],
      missedAnchorAttributions: [],
      stopping: { rationale: "Adaptive ablation stopped before evidence collection began.", unusedRelevantTools: [] },
      usage: { modelCalls: 0, toolCalls: 0, inputTokens: null, outputTokens: null, latencyMs: null, cache: { hits: 0, misses: 0 }, cost: null, corrections: 0 },
    });
    return { arm, ok: false, bundle: original, telemetry, triggers: [], diagnostics, failure: { code: abort.code()! } };
  }
  let loop: AdaptiveEvidenceLoopResult;
  let descriptors: ReasoningToolDescriptor[];
  let bundle: Readonly<AblationEvidenceClosureBundle> = original;
  try {
    loop = await abortable(abort, options.evidenceLoop.run({
      arm,
      system: firstPrefix(evidenceNonce, ABLATION_B_SYSTEM),
      firstProviderVisiblePrefix: `[Benchmark cache-isolation nonce: ${evidenceNonce}. Ignore this opaque identifier; it has no chess, workflow, or output meaning.]`,
      nextProviderVisiblePrefix: () => {
        const nonce = ensureUniqueNonce(usedNonces, options, "evidence");
        return `[Benchmark cache-isolation nonce: ${nonce}. Ignore this opaque identifier; it has no chess, workflow, or output meaning.]`;
      },
      bundle: original,
      tools: options.evidenceTools,
      maxToolCalls: options.maxToolCalls,
      maxProbeCalls: options.maxProbeCalls,
      maxModelSteps: options.maxModelSteps,
      signal: abort.signal,
    }));
    descriptors = validateLoopResult(original, loop, options, options.evidenceTools);
    bundle = enrichedBundle(original, loop);
    evidenceDiagnostic.outcome = "succeeded";
    evidenceDiagnostic.latencyMs = loop.usage.latencyMs;
    evidenceDiagnostic.inputTokens = loop.usage.inputTokens;
    evidenceDiagnostic.outputTokens = loop.usage.outputTokens;
    evidenceDiagnostic.cost = loop.usage.cost;
  } catch (error) {
    const code = adaptiveAbortCode(abort, error);
    evidenceDiagnostic.failureCode = code || "adaptive-evidence-loop-rejected";
    evidenceDiagnostic.outcome = code ? "aborted" : "failed";
    diagnostics.push(evidenceDiagnostic);
    const emptyLoop: AdaptiveEvidenceLoopResult = { rounds: [], failedToolCalls: [], availableTools: [], saliencePresentedFactIds: [], coverage: original.coverage, stopping: { reason: "model-finished", rationale: "Adaptive evidence loop failed before a valid closure was available.", unusedRelevantTools: [] }, modelCalls: 0, usage: { inputTokens: null, outputTokens: null, latencyMs: null, cache: { hits: 0, misses: 0 }, cost: null, corrections: 0 } };
    const telemetry = createAblationProbeTelemetry(original, { beforeProbeEvidenceIds: [...originalModelView.visibleEvidenceIds], postSaliencePresentedFactIds: [...originalModelView.visibleEvidenceIds], availableTools: [], calledProbes: [], missedAnchorAttributions: [], stopping: { rationale: emptyLoop.stopping.rationale, unusedRelevantTools: emptyLoop.stopping.unusedRelevantTools }, usage: { modelCalls: 0, toolCalls: 0, inputTokens: null, outputTokens: null, latencyMs: null, cache: { hits: 0, misses: 0 }, cost: null, corrections: 0 } });
    return { arm, ok: false, bundle: original, telemetry, triggers: [], diagnostics, failure: { code: code || "adaptive-evidence-loop-rejected" } };
  }
  diagnostics.push(evidenceDiagnostic);
  if (abort.code()) return abortedAfterValidLoop(abort, arm, bundle, descriptors, loop, diagnostics, options);

  let proposal: unknown;
  let initialIssues: DirectSynthesisIssue[] = [];
  let artifact: DirectSynthesisArtifact | undefined;
  let transportCorrectionAttempted = false;
  try {
    const direct = await directCall(options, abort, arm, bundle, ensureUniqueNonce(usedNonces, options, "direct"), "B-direct", null);
    diagnostics.push(direct.diagnostic);
    proposal = direct.proposal;
    const admission = materializeDirectSynthesis({ arm, bundle, proposal, provenance: { provider: `knights-eye/ablation-${arm}`, version: ABLATION_ADAPTIVE_RUNTIME_VERSION, origin: "model" } });
    if (admission.ok) artifact = admission.artifact;
    else initialIssues = admission.issues;
  } catch (error) {
    const diagnostic = (error as { adaptiveDiagnostic?: AblationAdaptiveCallDiagnostic }).adaptiveDiagnostic;
    if (diagnostic) diagnostics.push(diagnostic);
    const telemetry = probeTelemetry(bundle, descriptors, loop, undefined, diagnostics, options);
    const code = adaptiveAbortCode(abort, error);
    return code
      ? abortedAfterValidLoop(abort, arm, bundle, descriptors, loop, diagnostics, options)
      : { arm, ok: false, bundle, telemetry, triggers: [], diagnostics, failure: { code: "provider-or-structured-output" } };
  }
  if (abort.code()) return abortedAfterValidLoop(abort, arm, bundle, descriptors, loop, diagnostics, options);

  // A single explicit transport correction is permitted only for machine-level
  // proposal admission defects. It is neither a semantic review nor recursion.
  if (!artifact && isTransportCorrectableDirectSynthesisIssues(initialIssues)) {
    try {
      const corrected = await directCall(options, abort, arm, bundle, ensureUniqueNonce(usedNonces, options, "transport-correction"), "B-transport-correction", initialIssues);
      diagnostics.push(corrected.diagnostic);
      transportCorrectionAttempted = true;
      assertTransportOnlyDirectCorrection(proposal, corrected.proposal, initialIssues);
      proposal = corrected.proposal;
      const admission = materializeDirectSynthesis({ arm, bundle, proposal, provenance: { provider: `knights-eye/ablation-${arm}`, version: ABLATION_ADAPTIVE_RUNTIME_VERSION, origin: "model" } });
      if (admission.ok) artifact = admission.artifact;
      else {
        initialIssues = admission.issues;
        diagnostics[diagnostics.length - 1] = { ...diagnostics.at(-1)!, outcome: "failed", failureCode: "transport-correction-rejected" };
      }
    } catch (error) {
      const diagnostic = (error as { adaptiveDiagnostic?: AblationAdaptiveCallDiagnostic }).adaptiveDiagnostic;
      if (diagnostic) diagnostics.push(diagnostic);
      else if (diagnostics.at(-1)?.stage === "B-transport-correction") {
        diagnostics[diagnostics.length - 1] = { ...diagnostics.at(-1)!, outcome: "failed", failureCode: error instanceof AblationTransportCorrectionError ? error.code : "transport-correction-rejected" };
      }
      if (adaptiveAbortCode(abort, error)) return abortedAfterValidLoop(abort, arm, bundle, descriptors, loop, diagnostics, options);
    }
  }
  if (abort.code()) return abortedAfterValidLoop(abort, arm, bundle, descriptors, loop, diagnostics, options);

  let triggers: AblationBPrimeTrigger[] = [];
  if (arm === "B-prime") {
    triggers = exactTriggers((options.triggerPolicy || deriveAblationBPrimeTriggers)({ bundle, proposal, artifact: artifact || null, initialIssues }));
    if (triggers.length && (artifact || initialIssues.length)) {
      const nonce = ensureUniqueNonce(usedNonces, options, "critic");
      const payload = criticPayload(bundle, proposal, triggers, initialIssues);
      const diagnostic = providerDiagnostic("B-prime-critic", nonce, { system: firstPrefix(nonce, ABLATION_B_PRIME_CRITIC_SYSTEM), payload, schema: CRITIC_SCHEMA });
      const started = performance.now();
      try {
        throwIfAdaptiveStopped(abort);
        const result = await abortable(abort, generateText({
          model: options.criticModel || options.model,
          system: firstPrefix(nonce, ABLATION_B_PRIME_CRITIC_SYSTEM),
          prompt: JSON.stringify(payload),
          output: Output.object({ schema: jsonSchema<Record<string, unknown>>(CRITIC_SCHEMA as never), name: "knights_eye_ablation_b_prime_critic", description: "One bounded tool-free semantic reconsideration." }),
          abortSignal: abort.signal,
          maxOutputTokens: options.maxOutputTokens,
          maxRetries: 0,
          reasoning: options.criticReasoning || options.reasoning || "provider-default",
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        }));
        diagnostic.latencyMs = Math.round(performance.now() - started);
        finishDiagnostic(diagnostic, result);
        assertCriticDecision(result.output);
        if (result.output.decision === "replace") {
          const reconsidered = materializeDirectSynthesis({ arm, bundle, proposal: result.output.replacement, provenance: { provider: "knights-eye/ablation-b-prime-critic", version: ABLATION_ADAPTIVE_RUNTIME_VERSION, origin: "model" } });
          if (!reconsidered.ok) {
            diagnostic.outcome = "failed";
            diagnostic.failureCode = "critic-rejected";
            artifact = undefined;
            initialIssues = reconsidered.issues;
          } else artifact = reconsidered.artifact;
        } else if (!artifact) {
          diagnostic.outcome = "failed";
          diagnostic.failureCode = "critic-rejected";
        }
      } catch (error) {
        diagnostic.latencyMs = Math.round(performance.now() - started);
        const code = adaptiveAbortCode(abort, error);
        diagnostic.outcome = code ? "aborted" : "failed";
        diagnostic.failureCode = code || "critic-rejected";
        artifact = undefined;
      }
      diagnostics.push(diagnostic);
      if (abort.code()) return abortedAfterValidLoop(abort, arm, bundle, descriptors, loop, diagnostics, options, triggers);
    } else {
      diagnostics.push({ ...providerDiagnostic("B-prime-critic", "skipped", {}), outcome: "skipped" });
    }
  }
  const telemetry = probeTelemetry(bundle, descriptors, loop, artifact, diagnostics, options);
  if (!artifact) {
    return { arm, ok: false, bundle, telemetry, triggers, diagnostics, failure: { code: transportCorrectionAttempted ? "transport-correction-rejected" : "direct-synthesis-rejected", issues: initialIssues } };
  }
  return { arm, ok: true, bundle, artifact, telemetry, triggers, diagnostics };
  } finally {
    abort.dispose();
  }
}
