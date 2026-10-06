import { Output, generateText, jsonSchema, type LanguageModel, type LanguageModelCallOptions } from "ai";
import type {
  AdaptiveCallUsage,
  AdaptiveEvidenceLoop,
  AdaptiveEvidenceLoopInput,
  AdaptiveEvidenceLoopResult,
  AdaptiveEvidenceToolFailure,
  AdaptiveEvidenceToolRound,
} from "./ablation-adaptive-runtime";
import {
  validateAblationEvidenceClosureBundle,
  type AblationEvidenceClosureCoverage,
  type AblationEvidenceClosureBundle,
} from "./ablation-evidence-bundle";
import { compactLeanEvidencePacket, projectAblationEvidenceForModel } from "./ablation-model-facing-evidence";
import { emitObservableTrace, type ObservableLlmTraceSink, numericUsage } from "./ai-sdk-runtime-support";
import {
  REASONING_POC_VERSION,
  type ReasoningPositionContext,
  type ReasoningToolDescriptor,
  type ReasoningToolName,
  type ReasoningToolResult,
} from "./poc-contracts";

/**
 * A deliberately transparent evidence adapter for B/B′. Unlike ToolLoopAgent,
 * it makes one provider request for each decision, so an ablation runner can
 * put a fresh cache-isolation nonce at the start of every provider request.
 */
export const ABLATION_ADAPTIVE_EVIDENCE_LOOP_VERSION = "architecture-ablation-adaptive-evidence-loop/2" as const;

const PRESEMANTIC_TOOLS = new Set<ReasoningToolName>([
  "inspect_position", "analyze_move", "explore_continuations", "compare_moves", "enumerate_defenses", "test_line",
]);
const FACT_TOOLS = new Set<ReasoningToolName>(["inspect_position", "analyze_move"]);
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "laterMoves", "evaluatorAnchor", "evaluatorAnchors", "idealProse", "answerKey",
  "hypotheses", "selectedEntities", "selectedRelations", "graph", "critic", "checkpoint",
]);

export const ADAPTIVE_EVIDENCE_DECISION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "decision"],
  properties: {
    schemaVersion: { const: ABLATION_ADAPTIVE_EVIDENCE_LOOP_VERSION },
    decision: {
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["type", "tool", "input", "selectionRationale", "modelStatedRationale"],
          properties: {
            type: { const: "tool" }, tool: { type: "string", minLength: 1, maxLength: 120 }, input: { type: "object" },
            selectionRationale: { type: "string", minLength: 1, maxLength: 1_000 },
            modelStatedRationale: { type: "string", minLength: 1, maxLength: 1_000 },
          },
        },
        {
          type: "object", additionalProperties: false,
          required: ["type", "rationale", "modelStatedRationale"],
          properties: {
            type: { const: "finish" }, rationale: { type: "string", minLength: 1, maxLength: 1_000 },
            modelStatedRationale: { type: "string", minLength: 1, maxLength: 1_000 },
          },
        },
      ],
    },
  },
});

type ToolDecision = Readonly<{
  type: "tool";
  tool: ReasoningToolName;
  input: Record<string, unknown>;
  selectionRationale: string;
  modelStatedRationale: string;
}>;
type FinishDecision = Readonly<{ type: "finish"; rationale: string; modelStatedRationale: string }>;
type AdaptiveEvidenceDecision = ToolDecision | FinishDecision;

export type AdaptiveEvidenceToolExecutorInput = Readonly<{
  callId: string;
  requestId: string;
  tool: ReasoningToolName;
  input: Record<string, unknown>;
  context: Readonly<ReasoningPositionContext>;
  signal?: AbortSignal;
}>;

/** Browser and Node hosts adapt their existing exact fact/probe toolset here. */
export interface AdaptiveEvidenceToolExecutor {
  execute(input: AdaptiveEvidenceToolExecutorInput): Promise<ReasoningToolResult>;
}

export type AdaptiveEvidenceProviderMetadata = Readonly<{
  cost?: number | null;
  cacheTokens?: number | null;
}>;

export type AdaptiveEvidenceLoopOptions = Readonly<{
  model: LanguageModel;
  toolExecutor: AdaptiveEvidenceToolExecutor;
  maxOutputTokens: number;
  /** Optional compact, immutable subset; the full source stays local for retrieval. */
  initialEvidenceView?: Readonly<AblationEvidenceClosureBundle>;
  discoverRetainedEvidence?: boolean;
  observableTraceSink?: ObservableLlmTraceSink;
  reasoning?: NonNullable<LanguageModelCallOptions["reasoning"]>;
  temperature?: number;
  /** Optional sanitized relay metadata; never provider bodies or credentials. */
  consumeProviderMetadata?: () => readonly AdaptiveEvidenceProviderMetadata[];
}>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, label: string, max = 1_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be a bounded non-empty string`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error(`${label} has unsupported or missing fields`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function assertNoForbiddenPayload(value: unknown, path = "adaptive evidence"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenPayload(item, `${path}[${index}]`));
    return;
  }
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) throw new Error(`Adaptive evidence payload contains forbidden state at ${path}.${key}`);
    assertNoForbiddenPayload(child, `${path}.${key}`);
  }
}

function normalizedDescriptors(tools: readonly ReasoningToolDescriptor[]): readonly ReasoningToolDescriptor[] {
  const names = new Set<string>();
  const normalized = tools.map((descriptor) => {
    if (!record(descriptor) || typeof descriptor.name !== "string" || !PRESEMANTIC_TOOLS.has(descriptor.name as ReasoningToolName)
      || (descriptor.category !== "fact" && descriptor.category !== "probe") || !record(descriptor.inputSchema)
      || names.has(descriptor.name)) {
      throw new Error("Adaptive evidence loop accepts only unique supplied fact/probe descriptors");
    }
    names.add(descriptor.name);
    return clone(descriptor);
  });
  return Object.freeze(normalized.sort((left, right) => left.name.localeCompare(right.name)));
}

function validateLimits(input: AdaptiveEvidenceLoopInput, options: AdaptiveEvidenceLoopOptions): void {
  if (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) throw new Error("Adaptive evidence loop needs a positive output-token budget");
  for (const [label, value, minimum] of [
    ["maxToolCalls", input.maxToolCalls, 0], ["maxProbeCalls", input.maxProbeCalls, 0], ["maxModelSteps", input.maxModelSteps, 1],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum) throw new Error(`Adaptive evidence loop ${label} is invalid`);
  }
  if (!input.firstProviderVisiblePrefix.trim() || typeof input.nextProviderVisiblePrefix !== "function") throw new Error("Adaptive evidence loop requires nonce prefixes");
}

function baseSystem(input: AdaptiveEvidenceLoopInput): string {
  if (!input.system.startsWith(input.firstProviderVisiblePrefix)) throw new Error("First adaptive provider system must begin with the supplied nonce prefix");
  const body = input.system.slice(input.firstProviderVisiblePrefix.length).trimStart();
  if (!body) throw new Error("Adaptive evidence loop system body is missing");
  return body;
}

function systemForDecision(input: AdaptiveEvidenceLoopInput, body: string, decisionIndex: number, usedPrefixes: Set<string>): string {
  const prefix = decisionIndex === 0 ? input.firstProviderVisiblePrefix : input.nextProviderVisiblePrefix();
  if (typeof prefix !== "string" || !prefix.trim()) throw new Error("Adaptive evidence loop received an invalid fresh provider prefix");
  if (usedPrefixes.has(prefix)) throw new Error("Every adaptive evidence provider request requires a fresh cache-isolation prefix");
  usedPrefixes.add(prefix);
  return `${prefix}\n\n${body}`;
}

function parseDecision(value: unknown, descriptors: readonly ReasoningToolDescriptor[]): AdaptiveEvidenceDecision {
  if (!record(value)) throw new Error("Adaptive evidence decision must be an object");
  exactKeys(value, ["schemaVersion", "decision"], "Adaptive evidence decision envelope");
  if (value.schemaVersion !== ABLATION_ADAPTIVE_EVIDENCE_LOOP_VERSION || !record(value.decision)) throw new Error("Adaptive evidence decision version or payload is invalid");
  const decision = value.decision;
  if (decision.type === "tool") {
    exactKeys(decision, ["type", "tool", "input", "selectionRationale", "modelStatedRationale"], "Adaptive tool decision");
    const tool = text(decision.tool, "Adaptive tool name", 120) as ReasoningToolName;
    if (!descriptors.some((descriptor) => descriptor.name === tool)) throw new Error("Adaptive evidence decision selected an unadvertised tool");
    if (!record(decision.input)) throw new Error("Adaptive evidence tool input must be an object");
    assertNoForbiddenPayload(decision.input, "adaptive tool input");
    return Object.freeze({
      type: "tool", tool, input: clone(decision.input), selectionRationale: text(decision.selectionRationale, "Adaptive selection rationale"),
      modelStatedRationale: text(decision.modelStatedRationale, "Adaptive model rationale"),
    });
  }
  if (decision.type === "finish") {
    exactKeys(decision, ["type", "rationale", "modelStatedRationale"], "Adaptive finish decision");
    return Object.freeze({ type: "finish", rationale: text(decision.rationale, "Adaptive finish rationale"), modelStatedRationale: text(decision.modelStatedRationale, "Adaptive finish model rationale") });
  }
  throw new Error("Adaptive evidence decision must select exactly one tool or finish_evidence_collection");
}

function cacheUsage(usage: unknown, metadata: AdaptiveEvidenceProviderMetadata | undefined): { hits: number; misses: number } {
  const fromMetadata = metadata?.cacheTokens;
  const recordUsage = record(usage) ? usage : null;
  const direct = recordUsage ? ["cachedInputTokens", "cacheReadInputTokens", "cacheTokens"].map((key) => numericUsage(recordUsage[key])).find((value) => value !== null) : null;
  const tokens = typeof fromMetadata === "number" ? fromMetadata : direct;
  // Every provider decision is either evidenced as a prefix-cache hit or is a
  // measured miss. Do not leave cold calls invisible in ablation telemetry.
  return typeof tokens === "number" && tokens > 0 ? { hits: 1, misses: 0 } : { hits: 0, misses: 1 };
}

function usageFromResult(result: Awaited<ReturnType<typeof generateText>>, startedAt: number, metadata: AdaptiveEvidenceProviderMetadata | undefined): AdaptiveCallUsage {
  const last = result.steps.at(-1);
  return {
    inputTokens: numericUsage(result.usage.inputTokens),
    outputTokens: numericUsage(result.usage.outputTokens),
    latencyMs: last?.performance.responseTimeMs ?? Math.round(now() - startedAt),
    cache: cacheUsage(result.usage, metadata),
    cost: typeof metadata?.cost === "number" && Number.isFinite(metadata.cost) ? metadata.cost : null,
  };
}

function sum(values: readonly (number | null)[]): number | null {
  return values.every((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value || 0), 0);
}

function aggregateUsage(rounds: readonly AdaptiveEvidenceToolRound[], failures: readonly AdaptiveEvidenceToolFailure[], decisionUsage: readonly AdaptiveCallUsage[]): AdaptiveEvidenceLoopResult["usage"] {
  const all = [...rounds.map((round) => round.usage), ...failures.map((failure) => failure.usage), ...decisionUsage];
  return {
    inputTokens: sum(all.map((item) => item.inputTokens)),
    outputTokens: sum(all.map((item) => item.outputTokens)),
    latencyMs: sum(all.map((item) => item.latencyMs)),
    cache: { hits: all.reduce((total, item) => total + item.cache.hits, 0), misses: all.reduce((total, item) => total + item.cache.misses, 0) },
    cost: sum(all.map((item) => item.cost)),
    corrections: 0,
  };
}

function resultEvidence(result: ReasoningToolResult, contextHash: string, callId: string, tool: ReasoningToolName, knownEvidenceIds: Set<string>, retrieved: boolean = false): void {
  if (!record(result) || result.schemaVersion !== REASONING_POC_VERSION || result.contextHash !== contextHash || result.callId !== callId || result.tool !== tool
    || !record(result.data) || !Array.isArray(result.evidence) || !Array.isArray(result.limitations) || typeof result.durationMs !== "number") {
    throw new Error("Adaptive evidence executor returned malformed or cross-context result");
  }
  assertNoForbiddenPayload(result.data, "adaptive tool result data");
  for (const item of result.evidence) {
    if (!record(item) || item.contextHash !== contextHash || typeof item.id !== "string" || !item.id.trim() || (!retrieved && knownEvidenceIds.has(item.id))) {
      throw new Error("Adaptive evidence executor returned duplicate or cross-context evidence");
    }
    assertNoForbiddenPayload(item.data, `adaptive tool evidence ${item.id}`);
    knownEvidenceIds.add(item.id);
  }
  if (result.limitations.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Adaptive evidence tool result has malformed limitations");
}

function probeCount(rounds: readonly AdaptiveEvidenceToolRound[], failures: readonly AdaptiveEvidenceToolFailure[] = []): number {
  return [...rounds, ...failures].filter((round) => !FACT_TOOLS.has(round.tool)).length;
}

function unusedTools(descriptors: readonly ReasoningToolDescriptor[], rounds: readonly AdaptiveEvidenceToolRound[], failures: readonly AdaptiveEvidenceToolFailure[] = []): ReasoningToolName[] {
  const used = new Set([...rounds, ...failures].map((round) => round.tool));
  return descriptors.filter((descriptor) => !used.has(descriptor.name)).map((descriptor) => descriptor.name).sort();
}

function coverageFromRun(
  original: AblationEvidenceClosureCoverage,
  rounds: readonly AdaptiveEvidenceToolRound[],
  failures: readonly AdaptiveEvidenceToolFailure[],
  stoppingReason: "finish" | "tool-budget" | "probe-budget" | "model-budget",
): AblationEvidenceClosureCoverage {
  const covered = new Set(original.covered);
  const limitations = new Set(original.limitations);
  for (const round of rounds) {
    covered.add(round.tool);
    for (const item of round.result.limitations) limitations.add(item);
  }
  const unavailable = [...original.unavailable];
  for (const failure of failures) {
    if (!unavailable.some((item) => item.id === failure.tool)) unavailable.push({ id: failure.tool, reason: failure.failureCode });
  }
  return {
    // This adapter cannot convert bounded probing into exhaustive coverage.
    complete: false,
    covered: [...covered].sort(),
    omitted: [...original.omitted],
    unavailable: unavailable.sort((left, right) => left.id.localeCompare(right.id)),
    limitations: [...limitations, `Adaptive evidence collection stopped: ${stoppingReason}.`].sort(),
  };
}

/** Discovery metadata is not evidence; retrieval preserves the source records verbatim. */
export function retainedEvidenceCatalogue(bundle: Readonly<AblationEvidenceClosureBundle>) {
  return bundle.evidence.map((item) => ({
    id: item.id, kind: item.kind, source: item.source,
    preview: item.summary.slice(0, 240),
    previewTruncated: item.summary.length > 240,
    scope: record(item.data) ? item.data.phase || item.data.scope || "see-record-replay" : "see-record-replay",
    licenses: item.licenses,
    observations: bundle.observations.filter((observation) => observation.factEvidenceIds.includes(item.id)).map((observation) => ({
      type: observation.observationType, factKind: observation.attributes.factKind || null,
    })),
  }));
}

function promptForDecision(options: AdaptiveEvidenceLoopOptions, input: AdaptiveEvidenceLoopInput, descriptors: readonly ReasoningToolDescriptor[], rounds: readonly AdaptiveEvidenceToolRound[], failures: readonly AdaptiveEvidenceToolFailure[], modelCalls: number) {
  const view = projectAblationEvidenceForModel(input.bundle);
  const original = options.initialEvidenceView || view.bundle;
  return JSON.stringify({
    schemaVersion: ABLATION_ADAPTIVE_EVIDENCE_LOOP_VERSION,
    ...(!options.discoverRetainedEvidence ? { arm: input.arm } : {}),
    question: original.question,
    sourceBundleHash: view.sourceBundleHash,
    modelFacingEvidenceViewVersion: options.initialEvidenceView ? "lean-compact-initial/1" : view.schemaVersion,
    modelFacingEvidenceViewHash: options.initialEvidenceView?.bundleHash || view.viewHash,
    // The canonical context is frozen before this loop starts; no future game history is present.
    context: original.context,
    frozenInitialEvidence: options.discoverRetainedEvidence
      ? { observations: compactLeanEvidencePacket(original).observations, evidence: original.evidence, coverage: original.coverage }
      : { observations: original.observations, evidence: original.evidence, coverage: original.coverage },
    ...(options.discoverRetainedEvidence ? { retainedEvidenceCatalogue: retainedEvidenceCatalogue(input.bundle) } : {}),
    accumulatedToolResults: rounds.map((round) => ({ callId: round.callId, tool: round.tool, input: round.input,
      result: options.discoverRetainedEvidence
        ? { contextHash: round.result.contextHash, support: round.result.support, evidence: round.result.evidence, limitations: round.result.limitations }
        : round.result })),
    // Execution failures are not evidence, but they are part of the frozen
    // episode state. Showing their generic status prevents a later decision
    // from treating a requested tool as if it had never been attempted.
    failedToolExecutions: failures.map((failure) => ({ callId: failure.callId, tool: failure.tool, input: failure.input, status: failure.failureCode })),
    tools: descriptors,
    control: { name: "finish_evidence_collection", description: "Stop acquisition when the currently admitted evidence is sufficient. This is not a chess tool and has no input." },
    remainingBudget: {
      modelDecisions: Math.max(0, input.maxModelSteps - modelCalls),
      toolCalls: Math.max(0, input.maxToolCalls - rounds.length - failures.length),
      probes: Math.max(0, input.maxProbeCalls - probeCount(rounds, failures)),
    },
    instruction: "Return exactly one decision: either one advertised fact/probe tool with object input and short rationales, or finish_evidence_collection. Never return multiple tools.",
  });
}

function appendBudgetOmissions(
  coverage: AblationEvidenceClosureCoverage,
  descriptors: readonly ReasoningToolDescriptor[],
  rounds: readonly AdaptiveEvidenceToolRound[],
  failures: readonly AdaptiveEvidenceToolFailure[],
  reason: "not-requested" | "budget",
): AblationEvidenceClosureCoverage {
  const called = new Set([...rounds, ...failures].map((round) => round.tool));
  const omitted = [...coverage.omitted];
  for (const descriptor of descriptors) {
    if (!called.has(descriptor.name) && !omitted.some((item) => item.domain === "tool" && item.id === descriptor.name)) {
      omitted.push({ domain: "tool", id: descriptor.name, reason });
    }
  }
  return { ...coverage, omitted: omitted.sort((left, right) => `${left.domain}:${left.id}`.localeCompare(`${right.domain}:${right.id}`)) };
}

/** A browser/Node-neutral implementation of B/B′'s model-owned evidence loop. */
export class ModelOwnedAdaptiveEvidenceLoop implements AdaptiveEvidenceLoop {
  constructor(private readonly options: AdaptiveEvidenceLoopOptions) {}

  async run(input: AdaptiveEvidenceLoopInput): Promise<AdaptiveEvidenceLoopResult> {
    validateLimits(input, this.options);
    validateAblationEvidenceClosureBundle(input.bundle);
    if (input.bundle.lineage.kind !== "original") throw new Error("Adaptive evidence loop requires the frozen original evidence bundle");
    assertNoForbiddenPayload(input.bundle);
    const modelView = projectAblationEvidenceForModel(input.bundle);
    if (this.options.initialEvidenceView) {
      validateAblationEvidenceClosureBundle(this.options.initialEvidenceView);
      const view = this.options.initialEvidenceView;
      if (view.contextHash !== input.bundle.contextHash || view.question !== input.bundle.question
        || view.observations.some((item) => !input.bundle.observations.some((source) => source.id === item.id && JSON.stringify(source) === JSON.stringify(item)))
        || view.evidence.some((item) => !input.bundle.evidence.some((source) => source.id === item.id && JSON.stringify(source) === JSON.stringify(item)))) {
        throw new Error("Adaptive compact view must preserve source scope and exact evidence");
      }
    }
    const descriptors = normalizedDescriptors(input.tools).map((descriptor) => this.options.discoverRetainedEvidence && descriptor.name === "inspect_position" ? {
      ...descriptor,
      description: descriptor.description + " Alternatively retrieve 1–8 exact retained records from the catalogue by supplying only evidenceIds; this consumes one tool invocation and performs no new search.",
      inputSchema: { oneOf: [descriptor.inputSchema, { type: "object", required: ["evidenceIds"], additionalProperties: false,
        properties: { evidenceIds: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string" } } } }] },
    } : descriptor);
    const systemBody = baseSystem(input);
    const rounds: AdaptiveEvidenceToolRound[] = [];
    const failures: AdaptiveEvidenceToolFailure[] = [];
    const decisionUsage: AdaptiveCallUsage[] = [];
    const knownEvidenceIds = new Set(input.bundle.evidence.map((item) => item.id));
    const usedPrefixes = new Set<string>();
    let modelCalls = 0;
    let stopping: AdaptiveEvidenceLoopResult["stopping"] | null = null;
    let stoppingReason: "finish" | "tool-budget" | "probe-budget" | "model-budget" = "model-budget";

    while (!stopping) {
      if (input.signal?.aborted) throw input.signal.reason || new Error("Adaptive evidence collection cancelled");
      if (rounds.length + failures.length >= input.maxToolCalls) {
        stoppingReason = "tool-budget";
        stopping = { reason: "tool-budget-exhausted", rationale: "Stopped because the adaptive evidence tool-call budget was exhausted.", unusedRelevantTools: unusedTools(descriptors, rounds, failures) };
        break;
      }
      if (modelCalls >= input.maxModelSteps) {
        stoppingReason = "model-budget";
        stopping = { reason: "model-decision-budget-exhausted", rationale: "Stopped because the adaptive evidence model-decision budget was exhausted.", unusedRelevantTools: unusedTools(descriptors, rounds, failures) };
        break;
      }
      const allowed = descriptors.filter((descriptor) => FACT_TOOLS.has(descriptor.name) || probeCount(rounds, failures) < input.maxProbeCalls);
      if (!allowed.length) {
        stoppingReason = "probe-budget";
        stopping = { reason: "probe-budget-exhausted", rationale: "Stopped because the adaptive evidence probe budget was exhausted.", unusedRelevantTools: unusedTools(descriptors, rounds, failures) };
        break;
      }
      const prompt = promptForDecision(this.options, input, allowed, rounds, failures, modelCalls);
      const system = systemForDecision(input, systemBody, modelCalls, usedPrefixes);
      const started = now();
      emitObservableTrace(this.options.observableTraceSink, { model: typeof this.options.model === "string" ? this.options.model : this.options.model.modelId, providerRoute: "adaptive-provider", reasoningEffort: String(this.options.reasoning || "provider-default"), stage: "ablation-lean-acquisition", direction: "input", payload: {
        system, prompt, responseSchema: ADAPTIVE_EVIDENCE_DECISION_SCHEMA, maxOutputTokens: this.options.maxOutputTokens,
      } });
      const result = await generateText({
        model: this.options.model,
        system,
        prompt,
        output: Output.object({
          schema: jsonSchema<Record<string, unknown>>(ADAPTIVE_EVIDENCE_DECISION_SCHEMA as never),
          name: "knights_eye_adaptive_evidence_decision",
          description: "Exactly one bounded fact/probe decision or the finish_evidence_collection control.",
        }),
        onStepFinish: (step) => emitObservableTrace(this.options.observableTraceSink, { model: typeof this.options.model === "string" ? this.options.model : this.options.model.modelId, providerRoute: "adaptive-provider", reasoningEffort: String(this.options.reasoning || "provider-default"), stage: "ablation-lean-acquisition", direction: "output", payload: {
          text: step.text, finishReason: step.finishReason, usage: step.usage, model: step.model,
        } }),
        abortSignal: input.signal,
        maxOutputTokens: this.options.maxOutputTokens,
        maxRetries: 0,
        reasoning: this.options.reasoning || "provider-default",
        ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
      });
      if (input.signal?.aborted) throw input.signal.reason || new Error("Adaptive evidence collection cancelled");
      modelCalls += 1;
      const metadata = this.options.consumeProviderMetadata?.().at(-1);
      decisionUsage.push(usageFromResult(result, started, metadata));
      const decision = parseDecision(result.output, allowed);
      if (decision.type === "finish") {
        stoppingReason = "finish";
        stopping = { reason: "model-finished", rationale: decision.rationale, unusedRelevantTools: unusedTools(descriptors, rounds, failures) };
        break;
      }
      const attempt = rounds.length + failures.length + 1;
      const callId = `ablation-adaptive-evidence:${attempt}`;
      const requestId = `${input.bundle.context.nodeId}:adaptive-evidence:${attempt}`;
      const toolStarted = now();
      let toolResult: ReasoningToolResult;
      const retrieved = Boolean(this.options.discoverRetainedEvidence && decision.tool === "inspect_position" && "evidenceIds" in decision.input);
      emitObservableTrace(this.options.observableTraceSink, { model: typeof this.options.model === "string" ? this.options.model : this.options.model.modelId, providerRoute: "adaptive-provider", reasoningEffort: String(this.options.reasoning || "provider-default"), stage: "ablation-lean-tool", direction: "input", payload: {
        callId, tool: decision.tool, input: decision.input, selectionRationale: decision.selectionRationale,
      } });
      try {
        if (retrieved) {
          exactKeys(decision.input, ["evidenceIds"], "Retained evidence retrieval");
          const ids = decision.input.evidenceIds;
          if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error("Invalid retained evidence IDs");
          const evidence = ids.map((id) => input.bundle.evidence.find((item) => item.id === id));
          if (evidence.some((item) => !item)) throw new Error("Unknown retained evidence");
          toolResult = { schemaVersion: REASONING_POC_VERSION, callId, tool: decision.tool, contextHash: input.bundle.contextHash,
            support: "supported", data: { retrieval: true }, evidence: clone(evidence as ReasoningToolResult["evidence"]),
            limitations: ["Retrieved unchanged source records; no new chess search or authority."], durationMs: Math.round(now() - toolStarted) };
        } else toolResult = await this.options.toolExecutor.execute({
          callId, requestId, tool: decision.tool, input: clone(decision.input), context: clone(input.bundle.context), signal: input.signal,
        });
      } catch (error) {
        emitObservableTrace(this.options.observableTraceSink, { model: typeof this.options.model === "string" ? this.options.model : this.options.model.modelId, providerRoute: "adaptive-provider", reasoningEffort: String(this.options.reasoning || "provider-default"), stage: "ablation-lean-tool", direction: "error", payload: { callId, failureCode: "tool-execution-failed" } });
        if (input.signal?.aborted) throw input.signal.reason || error;
        failures.push(Object.freeze({
          attempt, callId, requestId, tool: decision.tool, input: clone(decision.input), selectionRationale: decision.selectionRationale,
          modelStatedRationale: decision.modelStatedRationale, failureCode: "tool-execution-failed",
          usage: { inputTokens: null, outputTokens: null, latencyMs: Math.max(0, Math.round(now() - toolStarted)), cache: { hits: 0, misses: 0 }, cost: null },
        }));
        continue;
      }
      // A host response that violates the frozen result contract is not an
      // ordinary execution failure. Fail closed rather than recording it as a
      // truthful failed call and allowing malformed evidence to influence a
      // later decision.
      if (input.signal?.aborted) throw input.signal.reason || new Error("Adaptive evidence collection cancelled");
      resultEvidence(toolResult, input.bundle.contextHash, callId, decision.tool, knownEvidenceIds, retrieved);
      emitObservableTrace(this.options.observableTraceSink, { model: typeof this.options.model === "string" ? this.options.model : this.options.model.modelId, providerRoute: "adaptive-provider", reasoningEffort: String(this.options.reasoning || "provider-default"), stage: "ablation-lean-tool", direction: "output", payload: { callId, result: toolResult, retrieved } });
      const toolUsage: AdaptiveCallUsage = { inputTokens: null, outputTokens: null, latencyMs: toolResult.durationMs, cache: { hits: 0, misses: 0 }, cost: null };
      rounds.push(Object.freeze({
        attempt, callId, requestId, tool: decision.tool, input: clone(decision.input), selectionRationale: decision.selectionRationale,
        modelStatedRationale: decision.modelStatedRationale, result: clone(toolResult), usage: toolUsage,
      }));
    }
    const hardBudget = stoppingReason !== "finish";
    const rawCoverage = coverageFromRun(input.bundle.coverage, rounds, failures, stoppingReason);
    const coverage = appendBudgetOmissions(rawCoverage, descriptors, rounds, failures, hardBudget ? "budget" : "not-requested");
    return Object.freeze({
      rounds: Object.freeze(rounds),
      failedToolCalls: Object.freeze(failures),
      availableTools: descriptors,
      // This is a model-facing set: it starts with the projected closure and
      // grows only with the evidence this episode itself acquired.
      saliencePresentedFactIds: Object.freeze([...new Set([
        ...(this.options.initialEvidenceView?.evidence.map((item) => item.id) || modelView.visibleEvidenceIds),
        ...rounds.flatMap((round) => round.result.evidence.map((record) => record.id)),
      ])].sort()),
      coverage: Object.freeze(coverage),
      stopping: Object.freeze(stopping!),
      modelCalls,
      usage: Object.freeze(aggregateUsage(rounds, failures, decisionUsage)),
    });
  }
}
