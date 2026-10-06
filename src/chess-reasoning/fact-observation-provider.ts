import {
  CHESS_FACT_REQUEST_VERSION,
  chessFactRecordLicenses,
  factProofStrength,
  type ChessFactProvider,
  type ChessFactRequest,
} from "./fact-provider";
import {
  REASONING_POC_VERSION,
  reasoningContextHash,
  type ObservationProvider,
  type ReasoningEvidenceRecord,
  type ReasoningObservation,
  type ReasoningObservationSet,
  type ReasoningPositionContext,
  type ReasoningRunControls,
} from "./poc-contracts";
import { stableHash } from "./stable";
import type { SemanticValue } from "./types";

export const FACT_OBSERVATION_ADAPTER_VERSION = "chess-fact-observation-adapter/1" as const;

export type ChessFactObservationProviderOptions = {
  maxRecords?: number;
  maxBytes?: number;
};

function providerTrust(authority: import("./fact-provider").ChessFactAuthority): "deterministic" | "learned" | "external" {
  if (authority === "bounded-engine") return "external";
  return "deterministic";
}

export class ChessFactObservationProvider implements ObservationProvider {
  readonly id: string;
  readonly version: string;

  constructor(
    private readonly provider: ChessFactProvider,
    private readonly options: ChessFactObservationProviderOptions = {},
  ) {
    this.id = `knights-eye/fact-observation:${provider.id}`;
    this.version = stableHash({ adapter: FACT_OBSERVATION_ADAPTER_VERSION, provider: provider.id, version: provider.version });
  }

  async observe(context: ReasoningPositionContext, controls: ReasoningRunControls, signal?: AbortSignal): Promise<ReasoningObservationSet> {
    const contextHash = reasoningContextHash(context);
    const request: ChessFactRequest = {
      schemaVersion: CHESS_FACT_REQUEST_VERSION,
      requestId: `reasoning-facts:${stableHash({ contextHash, provider: this.provider.id, version: this.provider.version })}`,
      context,
      requestedKinds: [],
      budgets: {
        maxRecords: Math.max(1, Math.min(controls.maxObservationRecords, this.options.maxRecords ?? controls.maxObservationRecords)),
        maxBytes: Math.max(1_024, Math.min(controls.maxProviderOutputChars, this.options.maxBytes ?? controls.maxProviderOutputChars)),
        maxWallTimeMs: Math.max(1, Math.min(300_000, controls.maxWallTimeMs)),
      },
    };
    const result = await this.provider.collect(request, signal);
    if (result.contextHash !== contextHash) throw new Error("Chess fact provider returned stale context");
    const observations: ReasoningObservation[] = [];
    const evidence: ReasoningEvidenceRecord[] = [];
    for (const record of result.records) {
      const evidenceId = `evidence:${record.id}`;
      evidence.push({
        schemaVersion: REASONING_POC_VERSION,
        id: evidenceId,
        contextHash,
        kind: "fact",
        source: `${record.provenance.provider}@${record.provenance.version}`,
        proofStrength: factProofStrength(record.authority, record.coverage),
        licenses: chessFactRecordLicenses(record),
        summary: record.summary,
        data: {
          factId: record.id,
          kind: record.kind,
          phase: record.phase,
          authority: record.authority,
          participants: record.participants as unknown as SemanticValue,
          data: record.data,
          coverage: record.coverage as unknown as SemanticValue,
          provenance: record.provenance as unknown as SemanticValue,
        },
        coverage: {
          complete: record.coverage.exhaustive && record.coverage.unresolved.length === 0,
          covered: [...record.coverage.covered],
          unresolved: [...record.coverage.unresolved],
        },
        replay: record.replay,
      });
      observations.push({
        schemaVersion: REASONING_POC_VERSION,
        id: `observation:${record.id}`,
        contextHash,
        observationType: `chess-fact:${record.kind}`,
        participants: record.participants.map((participant) => ({ ...participant, ref: { ...participant.ref } })),
        attributes: {
          factId: record.id,
          factKind: record.kind,
          phase: record.phase,
          authority: record.authority,
          data: record.data,
          coverage: record.coverage as unknown as SemanticValue,
        },
        exactness: record.authority === "heuristic-affordance" ? "heuristic" : "exact",
        provenance: {
          provider: record.provenance.provider,
          version: record.provenance.version,
          trust: providerTrust(record.authority),
          methods: [record.provenance.method, FACT_OBSERVATION_ADAPTER_VERSION],
        },
        factEvidenceIds: [evidenceId],
        probeRecipes: [],
      });
    }
    const capabilities = result.capabilities.map((capability) => capability.kind).sort();
    return {
      schemaVersion: REASONING_POC_VERSION,
      contextHash,
      observations,
      evidence,
      providers: [
        { provider: this.id, version: this.version },
        { provider: this.provider.id, version: this.provider.version },
      ],
      limitations: [
        ...result.limitations,
        `Chess fact capabilities advertised for model-directed expansion: ${capabilities.join(", ") || "none"}.`,
        ...(result.omitted.length ? [`${result.omitted.length} fact record(s) were explicitly omitted by request or budget.`] : []),
        ...(result.unavailableKinds.length ? [`Unavailable fact kinds: ${result.unavailableKinds.map((item) => item.kind).join(", ")}.`] : []),
        "The adapter preserves fact authority and does not create semantic concepts, plans, roles, or classifications.",
      ],
    };
  }
}
