import { NoOutputGeneratedError, RetryError } from "ai";
import { APICallError, EmptyResponseBodyError, NoContentGeneratedError } from "@ai-sdk/provider";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ReasoningRuntimeDiagnostic } from "./poc-contracts";

export type SanitizedHttpAttempt = {
  status: number | null;
  requestId: string | null;
  latencyMs: number;
  aborted: boolean;
  requestBytes?: number | null;
};

export type ObservableLlmTraceEvent = {
  stage: string;
  direction: "input" | "output" | "error";
  model: string;
  providerRoute: string;
  reasoningEffort: string;
  payload: Record<string, unknown>;
  excluded: string[];
};

export type ObservableLlmTraceSink = (event: ObservableLlmTraceEvent) => void;

export const AI_SDK_REASONING_RUNTIME = "ai-sdk-tool-loop-agent/99";
export const AI_SDK_HYPOTHESIS_RUNTIME = "ai-sdk-hypothesis-provider/31";
export const AI_SDK_PURPOSE_PROBE_RUNTIME = "ai-sdk-future-purpose-probe/1";
export const AI_SDK_CRITIC_RUNTIME = "ai-sdk-reasoning-critic/32";
export const AI_SDK_TERMINAL_REVIEW_RUNTIME = "ai-sdk-terminal-reasoning-review/7";
export const AI_SDK_RESOLUTION_AUDIT_RUNTIME = "ai-sdk-critic-resolution-audit/4";
export const AI_SDK_GRAPH_SELECTION_RUNTIME = "ai-sdk-graph-selector/8";
export const AI_SDK_ANSWER_OBLIGATION_RUNTIME = "ai-sdk-answer-obligation-audit/4";
export const AI_SDK_GRAPH_PLANNING_RUNTIME = "ai-sdk-answer-obligation-and-graph-selector/3";
export const AI_SDK_DISCOURSE_RUNTIME = "ai-sdk-discourse-planner/3";
export const DETERMINISTIC_DISCOURSE_RUNTIME = "harness-discourse-aggregator/3";
export const AI_SDK_RENDER_RUNTIME = "ai-sdk-checkpoint-render/24";
export const AI_SDK_REPAIR_RUNTIME = "ai-sdk-semantic-draft-repair/13";

const encoder = new TextEncoder();

export function bytes(value: unknown): number {
  if (typeof value === "string") return encoder.encode(value).byteLength;
  if (value == null) return 0;
  try {
    return encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

const OBSERVABLE_TRACE_EXCLUSIONS = Object.freeze([
  "provider credentials and authorization headers",
  "raw HTTP request and response bodies",
  "hidden chain-of-thought and provider reasoning details",
]);

function traceSafeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(traceSafeValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "reasoning") {
    return { type: "reasoning", omitted: true, byteCount: bytes(record.text) };
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "providerMetadata" || key === "providerOptions" || key === "reasoning_details" || key === "reasoningDetails") {
      result[`${key}Omitted`] = true;
      continue;
    }
    result[key] = traceSafeValue(item);
  }
  return result;
}

export function observableTraceMessages(messages: readonly ModelMessage[]): unknown[] {
  return messages.map((message) => traceSafeValue(message));
}

export function emitObservableTrace(
  sink: ObservableLlmTraceSink | undefined,
  event: Omit<ObservableLlmTraceEvent, "excluded">,
) {
  if (!sink) return;
  sink({
    ...event,
    payload: traceSafeValue(event.payload) as Record<string, unknown>,
    excluded: [...OBSERVABLE_TRACE_EXCLUSIONS],
  });
}

export function reasoningMetrics(content: readonly unknown[]) {
  let reasoningPartCount = 0;
  let reasoningBytes = 0;
  let reasoningDetailsPresent = false;
  for (const value of content) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const part = value as Record<string, unknown>;
    if (part.type === "reasoning") {
      reasoningPartCount += 1;
      reasoningBytes += bytes(part.text);
    }
    const metadata = (part.providerMetadata || part.providerOptions) as Record<string, unknown> | undefined;
    const openrouter = metadata?.openrouter as Record<string, unknown> | undefined;
    const details = openrouter?.reasoning_details;
    if (Array.isArray(details) && details.length) {
      reasoningDetailsPresent = true;
      reasoningBytes += bytes(details);
    }
  }
  return { reasoningPartCount, reasoningBytes, reasoningDetailsPresent };
}

export function numericUsage(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && typeof (value as { total?: unknown }).total === "number") {
    return (value as { total: number }).total;
  }
  return null;
}

export function requestId(headers?: Record<string, string>, fallback?: string): string | null {
  return headers?.["request-id"] || headers?.["x-request-id"] || headers?.["openai-request-id"] || fallback || null;
}

export class ReasoningWorkflowFailure extends Error {
  readonly code: "continuation-coverage-unavailable" | "response-coverage-unavailable";

  constructor(code: ReasoningWorkflowFailure["code"]) {
    super(code === "continuation-coverage-unavailable"
      ? "The required continuation coverage remained unavailable after the bounded forced probe."
      : "The required response coverage remained unavailable after the bounded forced probe.");
    this.name = "ReasoningWorkflowFailure";
    this.code = code;
  }
}

function classifyRuntimeError(error: unknown): string {
  if (error instanceof ReasoningWorkflowFailure) return error.code;
  if (RetryError.isInstance(error)) return `retry-${error.reason}`;
  if (APICallError.isInstance(error)) return "provider-api-call";
  if (EmptyResponseBodyError.isInstance(error)) return "empty-response-body";
  if (NoContentGeneratedError.isInstance(error)) return "no-provider-content";
  if (NoOutputGeneratedError.isInstance(error)) return "no-structured-output";
  const name = error instanceof Error ? error.name : "unknown";
  const message = error instanceof Error ? error.message : String(error || "");
  if (/timeout|timed out|wall-time budget/i.test(`${name} ${message}`)) return "timeout";
  if (/schema|validation/i.test(name)) return "structured-output-schema";
  if (/parse|json/i.test(name)) return "structured-output-parse";
  if (/abort/i.test(name)) return "aborted";
  return "runtime-unknown";
}

export function classifyRuntimeFailure(
  error: unknown,
  lastStep?: Pick<ReasoningRuntimeDiagnostic, "finishReason" | "structuredOutputBytes" | "toolCallCount">
    & Partial<Pick<ReasoningRuntimeDiagnostic, "lastHarnessPhase" | "sdkRuntime">>,
): string {
  if (lastStep?.structuredOutputBytes === 0 && lastStep.toolCallCount === 0 && lastStep.finishReason) {
    const rendering = lastStep.lastHarnessPhase === "draft-render"
      || lastStep.lastHarnessPhase === "draft-generated"
      || lastStep.lastHarnessPhase === "draft-repair";
    if (lastStep.finishReason === "length") {
      if (lastStep.lastHarnessPhase === "hypothesis-submission-required") return "hypothesis-submission-truncated";
      if (/reasoning-critic/.test(lastStep.sdkRuntime || "")) return "critic-output-truncated";
      if (/terminal-reasoning-review/.test(lastStep.sdkRuntime || "")) return "terminal-review-output-truncated";
      if (/critic-resolution-audit/.test(lastStep.sdkRuntime || "")) return "critic-resolution-audit-output-truncated";
      return rendering || !lastStep.lastHarnessPhase
        ? "structured-output-truncated"
        : "required-tool-call-truncated";
    }
    if (lastStep.lastHarnessPhase === "hypothesis-submission-required") return "hypothesis-submission-missing";
    if (/reasoning-critic/.test(lastStep.sdkRuntime || "")) return "critic-output-missing";
    if (/terminal-reasoning-review/.test(lastStep.sdkRuntime || "")) return "terminal-review-output-missing";
    if (/critic-resolution-audit/.test(lastStep.sdkRuntime || "")) return "critic-resolution-audit-output-missing";
    if (!rendering && lastStep.lastHarnessPhase) return "required-tool-call-missing";
  }
  if (lastStep?.lastHarnessPhase === "hypothesis-submission-required" && (lastStep.structuredOutputBytes || 0) > 0) {
    return "hypothesis-submission-invalid";
  }
  return classifyRuntimeError(error);
}

export function deepestError(error: unknown): unknown {
  if (RetryError.isInstance(error)) return error.lastError;
  if (error instanceof Error && "cause" in error && error.cause) return deepestError(error.cause);
  return error;
}

export function abortSource(
  signal: AbortSignal | undefined,
  error: unknown,
): ReasoningRuntimeDiagnostic["abortSource"] {
  const reason = signal?.aborted ? String(signal.reason instanceof Error ? signal.reason.message : signal.reason || "") : "";
  if (/wall-time budget/i.test(reason)) return "wall-time";
  if (signal?.aborted) return "external";
  if (RetryError.isInstance(error) && error.reason === "abort") return "provider";
  return null;
}

export type HypothesisRejection = {
  stage: NonNullable<ReasoningRuntimeDiagnostic["hypothesisRejectionStage"]>;
  code: NonNullable<ReasoningRuntimeDiagnostic["hypothesisRejectionCode"]>;
};

export class HypothesisProviderRuntimeFailure extends Error {
  readonly diagnostics: ReasoningRuntimeDiagnostic[];
  readonly usage: { inputTokens: number | null; outputTokens: number | null };

  constructor(diagnostics: ReasoningRuntimeDiagnostic[], usage: { inputTokens: number | null; outputTokens: number | null }) {
    super("The hypothesis provider failed before returning a valid batch");
    this.name = "HypothesisProviderRuntimeFailure";
    this.diagnostics = diagnostics.map((item) => ({ ...item }));
    this.usage = { ...usage };
  }
}

export class HypothesisHarnessRejection extends Error {
  readonly rejection: HypothesisRejection;

  constructor(rejection: HypothesisRejection) {
    super("The hypothesis batch failed Harness validation");
    this.name = "HypothesisHarnessRejection";
    this.rejection = rejection;
  }
}

export class ReasoningCriticHarnessRejection extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The independent critic decision failed Harness validation");
    this.name = "ReasoningCriticHarnessRejection";
    this.code = code;
  }
}

export class CriticResolutionAuditHarnessRejection extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The independent critic-resolution audit did not approve every finding resolution");
    this.name = "CriticResolutionAuditHarnessRejection";
    this.code = code;
  }
}

export class GraphSelectionHarnessRejection extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The dedicated graph selection failed Harness validation");
    this.name = "GraphSelectionHarnessRejection";
    this.code = code;
  }
}

export class HypothesisReviewHarnessRejection extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Terminal hypothesis review failed after its bounded correction path");
    this.name = "HypothesisReviewHarnessRejection";
    this.code = code;
  }
}

export class TerminalReviewHarnessRejection extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The dedicated terminal reasoning review failed Harness validation");
    this.name = "TerminalReviewHarnessRejection";
    this.code = code;
  }
}

export function classifyProviderHypothesisRejection(error: unknown): HypothesisRejection {
  const category = classifyRuntimeError(deepestError(error));
  if (category === "structured-output-schema") return { stage: "schema-validation", code: "schema" };
  if (category === "structured-output-parse") return { stage: "provider-structured-output", code: "parse" };
  return { stage: "provider-structured-output", code: "no-output" };
}

export function classifyHypothesisHarnessRejection(error: unknown): HypothesisRejection {
  const message = error instanceof Error ? error.message : String(error);
  if (/empty hypothesis batch/i.test(message)) return { stage: "harness-validation", code: "empty-batch" };
  if (/Unknown concept key/i.test(message)) return { stage: "harness-validation", code: "unsupported-concept" };
  if (/overstates available proof/i.test(message)) return { stage: "harness-validation", code: "proof-overstatement" };
  if (/requires an accepted hypothesis before explain_plan/i.test(message)) return { stage: "harness-validation", code: "used-observation-orphaned" };
  if (/Superseding hypothesis .* preserve lineage/i.test(message)) return { stage: "harness-validation", code: "supersession-lineage" };
  if (/Critic finding .* (?:cites missing, old, or non-grounding new evidence|is not resolved by compatible existing evidence)|criticFindingResolutions\[\d+\] cites unknown evidence/i.test(message)) {
    return { stage: "harness-validation", code: "critic-resolution-evidence" };
  }
  if (/Critic finding .* requires|criticFindingResolutions.*(?:does not match|incompatible|unknown or duplicate finding)|Every critic finding requires/i.test(message)) {
    return { stage: "harness-validation", code: "critic-resolution-incompatibility" };
  }
  if (/\banchor\b|\bowner\b|refinement|parent hypothesis|lineage/i.test(message)) return { stage: "harness-validation", code: "anchor-incompatibility" };
  if (/lacks evidence licensed|evidence licen[cs]e|license ceiling|unlicensed/i.test(message)) return { stage: "harness-validation", code: "evidence-license" };
  if (/observation|evidence|reference|missing or stale/i.test(message)) return { stage: "harness-validation", code: "unknown-reference-or-evidence" };
  if (/is malformed|attributes key|must be (?:a |an )?(?:non-empty|string|array|object)|invalid/i.test(message)) return { stage: "harness-validation", code: "malformed-structure" };
  if (/relation|budget|duplicate|repeats an existing/i.test(message)) return { stage: "harness-validation", code: "relation-or-budget" };
  return { stage: "harness-validation", code: "harness-validation" };
}

export function classifyReasoningCriticHarnessRejection(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/causal evidence audits must cover the exact bounded comparison set/i.test(message)) return "causal-evidence-incomplete";
  if (/root assessments must cover the exact compared roots/i.test(message)) return "causal-root-incomplete";
  if (/continuation activity audits must cover the exact indexed evidence set/i.test(message)) return "continuation-activity-evidence-incomplete";
  if (/continuation activity root assessments must cover the exact indexed roots/i.test(message)) return "continuation-activity-root-incomplete";
  if (/continuation activity assessments must cover every exact indexed piece route/i.test(message)) return "continuation-activity-incomplete";
  if (/continuation activity (?:contact assessments must cover every exact indexed contact|root requires every indexed contact assessment)/i.test(message)) return "continuation-activity-contact-incomplete";
  if (/(?:causal evidence audit|continuation activity (?:audit|root assessment|assessment)|continuation contact assessment) (?:is )?malformed/i.test(message)) return "malformed-audit-item";
  if (/(?:causal evidence audit|root assessment|continuation activity assessment|continuation contact assessment|hypothesisFindings\[\d+\]) references an unknown hypothesis/i.test(message)) return "unknown-hypothesis-or-reference";
  if (/priority omission audits must cover the exact high-salience exact observation set/i.test(message)) return "missing-link-contract";
  if (/material priority omission gap(?: without an existing hypothesis)? requires|material priority omission gap against an existing hypothesis requires/i.test(message)) return "missing-link-contract";
  if (/(?:material causal comparison|material continuation activity) gap requires a missing-link finding and one bounded revision/i.test(message)) return "missing-link-contract";
  if (/complete current set|complete audit|unknown or unpresented observation/i.test(message)) return "incomplete-audit";
  if (/must not contain duplicates/i.test(message)) return "duplicate-id";
  if (/contains duplicate or unknown hypotheses/i.test(message)) return "unknown-or-duplicate-representation";
  if (/Only a reopened non-used observation may name existing representing hypotheses/i.test(message)) return "nonused-retain-has-representation";
  if (/Reopened non-used observation .* may name only source-linked hypotheses/i.test(message)) return "nonused-representation-not-source-linked";
  if (/Retained used observation .* must retain its representing hypotheses/i.test(message)) return "retain-used-missing-representation";
  if (/requires a missingLink/i.test(message)) return "reopen-missing-link";
  if (/cannot claim a missingLink/i.test(message)) return "retain-has-missing-link";
  if (/must record that omission weakens/i.test(message)) return "retain-used-impact";
  if (/must preserve the conclusion/i.test(message)) return "retain-nonused-impact";
  if (/must weaken or leave uncertainty/i.test(message)) return "reopen-preserves-impact";
  if (/Uncertain omission impact must reopen/i.test(message)) return "retain-uncertain-impact";
  if (/representedHypothesisIds must be a string array/i.test(message)) return "invalid-representation-set";
  if (/\.omissionImpact is invalid/i.test(message)) return "invalid-omission-impact";
  if (/\.action is invalid/i.test(message)) return "invalid-action";
  if (/novelHypothesisNeeded must be boolean/i.test(message)) return "invalid-novelty-decision";
  if (/is malformed/i.test(message)) return "malformed-audit-item";
  if (/omission|preserve the conclusion|missingLink|reopen/i.test(message)) return "omission-contract";
  if (/terminal observation review|already been completed/i.test(message)) return "stale-phase";
  if (/requires at least one recorded hypothesis|must be a string array|must be a non-empty string/i.test(message)) return "malformed-audit";
  return "challenge-validation";
}

export function classifyGraphSelectionHarnessRejection(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/requires an accepted hypothesis before explain_plan/i.test(message)) return "used-observation-orphaned";
  if (/must include every hypothesis marked used/i.test(message)) return "missing-required";
  if (/Unknown hypothesis selected/i.test(message)) return "unknown-hypothesis";
  if (/Only accepted hypotheses/i.test(message)) return "unaccepted-hypothesis";
  if (/Unknown hypothesis relation/i.test(message)) return "unknown-relation";
  if (/relation .* leaves the selected hypothesis set/i.test(message)) return "relation-closure";
  if (/Selected endpoint .* is not in hypothesisIds|Selected entity .* does not exist/i.test(message)) return "endpoint-selection";
  if (/No connected (?:plan subgraph|primary explanation chain)|disconnected optional component/i.test(message)) return "disconnected";
  if (/lost required realization anchor/i.test(message)) return "entity-anchor-missing";
  if (/has missing parent/i.test(message)) return "parent-missing";
  if (/contradicts parent owner/i.test(message)) return "parent-owner-conflict";
  if (/changes parent concepts/i.test(message)) return "parent-concept-change";
  if (/drops parent realization anchor/i.test(message)) return "parent-anchor-dropped";
  if (/anchor|parent|refinement|owner/i.test(message)) return "realization";
  if (/hypotheses\.relations.*evidenceIds must contain|Relation hypothesis .* requires compatible evidence/i.test(message)) return "relation-evidence-missing";
  if (/overstates available proof/i.test(message)) return "proof-overstatement";
  if (/missing, stale, or incompatible evidence|cites missing evidence/i.test(message)) return "evidence-compatibility";
  if (/evidence|proof/i.test(message)) return "evidence";
  if (/budget|maxEntities|at least two|invalid number of values/i.test(message)) return "selection-budget";
  return "validation";
}

export function classifyGraphSelectionRuntimeFailure(
  error: unknown,
  lastStep?: Pick<ReasoningRuntimeDiagnostic, "finishReason" | "structuredOutputBytes" | "toolCallCount">,
): string {
  if (lastStep?.structuredOutputBytes === 0 && lastStep.toolCallCount === 0) {
    if (lastStep.finishReason === "length") return "graph-selection-output-truncated";
    if (lastStep.finishReason) return "graph-selection-output-missing";
  }
  const category = classifyRuntimeError(error);
  if (category === "no-structured-output" || category === "no-provider-content" || category === "empty-response-body") {
    return "graph-selection-output-missing";
  }
  if (category === "structured-output-schema") return "graph-selection-output-schema";
  if (category === "structured-output-parse") return "graph-selection-output-parse";
  return category;
}
