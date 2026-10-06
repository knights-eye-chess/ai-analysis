import type { ReasoningToolResult, ReasoningToolSet } from "./poc-contracts";

export const SIMPLE_EVIDENCE_PREPARATION_VERSION = "simple-evidence-preparation/1";
export type SimpleEvidencePreparation = {
  version: typeof SIMPLE_EVIDENCE_PREPARATION_VERSION;
  searchCount: 0 | 1 | 2 | 3;
  investigationLeads?: Record<string, unknown>;
  rawRecords?: unknown[];
  elapsedMs: number;
  result?: ReasoningToolResult;
  failure?: "unavailable";
};

/** A normal engine probe, not a model stage or a purpose inference. */
export async function prepareSimpleEvidence(host: ReasoningToolSet, contextHash: string, signal?: AbortSignal): Promise<SimpleEvidencePreparation> {
  const started = performance.now();
  signal?.throwIfAborted();
  try {
    const result = await host.execute("explore_continuations", {
      contextHash, phase: "before", multiPv: 3, depth: 18, callId: "initial-continuations",
    }, signal);
    signal?.throwIfAborted();
    return { version: SIMPLE_EVIDENCE_PREPARATION_VERSION, searchCount: 1, elapsedMs: performance.now() - started, result };
  } catch {
    signal?.throwIfAborted();
    return { version: SIMPLE_EVIDENCE_PREPARATION_VERSION, searchCount: 1, elapsedMs: performance.now() - started, failure: "unavailable" };
  }
}
