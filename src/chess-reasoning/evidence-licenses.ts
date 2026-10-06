import type { ProofStrength, SemanticValue } from "./types";

export const EVIDENCE_LICENSE = Object.freeze({
  CHESS_LEGALITY: "chess.legality",
  CHESS_IDENTITY: "chess.identity",
  CHESS_POSITION_FACT: "chess.position-fact",
  ENGINE_BOUNDED_CONTINUATION: "engine.bounded-continuation",
  ENGINE_BOUNDED_COMPARISON: "engine.bounded-comparison",
  ENGINE_BOUNDED_SCORE: "engine.bounded-score",
  ENGINE_BOUNDED_RESPONSE_COVERAGE: "engine.bounded-response-coverage",
  COVERAGE_EXHAUSTIVE: "coverage.exhaustive",
  ATTENTION_AFFORDANCE: "attention.affordance",
  SEMANTIC_REVIEWED_STATE: "semantic.reviewed-state",
  WORKFLOW_AUDIT: "workflow.audit",
} as const);

export type EvidenceLicense = typeof EVIDENCE_LICENSE[keyof typeof EVIDENCE_LICENSE];

const LICENSES = new Set<EvidenceLicense>(Object.values(EVIDENCE_LICENSE));

export type EvidenceLicenseInput = {
  kind: string;
  source: string;
  authority: string | null;
  proofStrength: ProofStrength | null;
  data: Record<string, SemanticValue>;
  coverage: { complete: boolean; covered: string[]; unresolved: string[] } | null;
  replay: Record<string, SemanticValue> | null;
};

export type LicensableEvidenceRecord = {
  kind: string;
  source: string;
  proofStrength: ProofStrength | null;
  licenses?: EvidenceLicense[];
  data: Record<string, SemanticValue>;
  coverage: { complete: boolean; covered: string[]; unresolved: string[] } | null;
  replay: Record<string, SemanticValue> | null;
};

export function evidenceLicenseInput(record: LicensableEvidenceRecord): EvidenceLicenseInput {
  const data = record.data || {};
  const authority = typeof data.authority === "string"
    ? data.authority
    : record.kind === "fact"
      ? "deterministic-derived"
      : record.kind === "probe"
        ? "bounded-engine"
        : null;
  return {
    kind: record.kind,
    source: record.source,
    authority,
    proofStrength: record.proofStrength,
    data,
    coverage: record.coverage || null,
    replay: record.replay || null,
  };
}

function exactSequenceOnly(input: EvidenceLicenseInput): boolean {
  return input.data.scope === "sequence-legality-and-identity";
}

function isWorkflowKind(kind: string): boolean {
  return kind === "observation-review"
    || kind === "reasoning-challenge"
    || kind === "hypothesis-review"
    || kind === "critic-resolution-audit";
}

/**
 * Central maximum-license policy. A producer may claim any subset of these
 * values, but no producer can broaden its source by adding a license.
 */
export function maximumEvidenceLicenses(input: EvidenceLicenseInput): EvidenceLicense[] {
  // Authority is the source ceiling. A heuristic producer cannot self-upgrade
  // by attaching a narrower-looking scope.
  if (input.authority === "heuristic-affordance") return [EVIDENCE_LICENSE.ATTENTION_AFFORDANCE];
  if (isWorkflowKind(input.kind)) return [EVIDENCE_LICENSE.WORKFLOW_AUDIT];
  if (input.kind === "graph") return [EVIDENCE_LICENSE.SEMANTIC_REVIEWED_STATE];
  // A replay witness explicitly scoped to legality and stable identity stays
  // in that narrow authority lane even when it was transported as a probe.
  // Record kind is transport metadata; it must not broaden the scope's
  // evidentiary meaning into a bounded-engine continuation or score.
  if (exactSequenceOnly(input)) {
    if (input.authority !== "legal-exact" && input.authority !== "bounded-engine") return [];
    const scoped = new Set<EvidenceLicense>([
      EVIDENCE_LICENSE.CHESS_LEGALITY,
      EVIDENCE_LICENSE.CHESS_IDENTITY,
    ]);
    if (input.coverage?.complete && input.coverage.unresolved.length === 0) {
      scoped.add(EVIDENCE_LICENSE.COVERAGE_EXHAUSTIVE);
    }
    return [...scoped].sort();
  }

  const result = new Set<EvidenceLicense>();
  if (input.authority === "legal-exact" || input.authority === "deterministic-derived") {
    result.add(EVIDENCE_LICENSE.CHESS_LEGALITY);
    result.add(EVIDENCE_LICENSE.CHESS_IDENTITY);
    result.add(EVIDENCE_LICENSE.CHESS_POSITION_FACT);
  }

  if (input.authority === "bounded-engine") {
    result.add(EVIDENCE_LICENSE.ENGINE_BOUNDED_SCORE);
    if (/compare[_-]moves|compare-moves/.test(input.source)) {
      result.add(EVIDENCE_LICENSE.ENGINE_BOUNDED_COMPARISON);
    } else {
      result.add(EVIDENCE_LICENSE.ENGINE_BOUNDED_CONTINUATION);
    }
    if (/enumerate[_-]defenses|enumerate-defenses/.test(input.source)) {
      result.add(EVIDENCE_LICENSE.ENGINE_BOUNDED_RESPONSE_COVERAGE);
    }
    if (input.replay) {
      result.add(EVIDENCE_LICENSE.CHESS_LEGALITY);
      result.add(EVIDENCE_LICENSE.CHESS_IDENTITY);
    }
  }

  if (input.coverage?.complete && input.coverage.unresolved.length === 0) {
    result.add(EVIDENCE_LICENSE.COVERAGE_EXHAUSTIVE);
  }
  return [...result].sort();
}

export function validateEvidenceLicenseClaims(input: EvidenceLicenseInput, claimed: readonly unknown[]): EvidenceLicense[] {
  if (!Array.isArray(claimed)) throw new Error("Evidence licenses must be an array");
  const normalized = [...new Set(claimed.map(String))];
  const unknown = normalized.filter((license) => !LICENSES.has(license as EvidenceLicense));
  if (unknown.length) throw new Error(`Unknown evidence license(s): ${unknown.join(", ")}`);
  const maximum = new Set(maximumEvidenceLicenses(input));
  const excessive = normalized.filter((license) => !maximum.has(license as EvidenceLicense));
  if (excessive.length) throw new Error(`Evidence claims license(s) beyond its source ceiling: ${excessive.join(", ")}`);
  return normalized.sort() as EvidenceLicense[];
}

export function effectiveEvidenceLicenses(input: EvidenceLicenseInput & { licenses?: readonly unknown[] }): EvidenceLicense[] {
  // Legacy development fixtures without an explicit field are normalized at
  // admission. Runtime and provider-owned records always serialize the result.
  return input.licenses === undefined
    ? maximumEvidenceLicenses(input)
    : validateEvidenceLicenseClaims(input, input.licenses);
}

export function effectiveLicensesForRecord(record: LicensableEvidenceRecord): EvidenceLicense[] {
  return effectiveEvidenceLicenses({ ...evidenceLicenseInput(record), licenses: record.licenses });
}

export function withEvidenceLicenses<T extends LicensableEvidenceRecord>(record: T): T & { licenses: EvidenceLicense[] } {
  return { ...record, licenses: effectiveLicensesForRecord(record) };
}

export function licensesSemanticChessGrounding(licenses: readonly EvidenceLicense[]): boolean {
  return licenses.some((license) => license === EVIDENCE_LICENSE.CHESS_POSITION_FACT
    || license === EVIDENCE_LICENSE.ENGINE_BOUNDED_CONTINUATION
    || license === EVIDENCE_LICENSE.ENGINE_BOUNDED_COMPARISON
    || license === EVIDENCE_LICENSE.ENGINE_BOUNDED_RESPONSE_COVERAGE
    || license === EVIDENCE_LICENSE.SEMANTIC_REVIEWED_STATE);
}

export function licensesBoundedRouteRelevance(licenses: readonly EvidenceLicense[]): boolean {
  return licenses.includes(EVIDENCE_LICENSE.ENGINE_BOUNDED_CONTINUATION)
    || licenses.includes(EVIDENCE_LICENSE.ENGINE_BOUNDED_COMPARISON)
    || licenses.includes(EVIDENCE_LICENSE.ENGINE_BOUNDED_RESPONSE_COVERAGE);
}
