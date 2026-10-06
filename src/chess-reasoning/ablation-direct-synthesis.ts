import { SQUARES } from "chess.js";
import { REFERENCE_DOMAINS } from "./concept-registry";
import { EVIDENCE_LICENSE, effectiveLicensesForRecord, licensesBoundedRouteRelevance, licensesSemanticChessGrounding } from "./evidence-licenses";
import {
  validateAblationEvidenceClosureBundle,
  type AblationEvidenceClosureBundle,
} from "./ablation-evidence-bundle";
import { projectAblationEvidenceForModel } from "./ablation-model-facing-evidence";
import { HypothesisLedger, validateHypothesisAcceptancePolicies } from "./poc-hypotheses";
import { collectReasoningMoveWitnesses } from "./poc-move-witnesses";
import { createPocIdentityTimeline, pieceIdentity } from "./poc-piece-refs";
import { RAW_CHESS_TEXT } from "./poc-semantic-text";
import { stableHash } from "./stable";
import type {
  ReasoningClaimKind,
  ReasoningHypothesisProposal,
  ReasoningHypothesisProvenance,
  ReasoningHypothesisRecord,
  ReasoningHypothesisRelationProposal,
  ReasoningHypothesisRelationRecord,
  ReasoningNarrativeSegment,
} from "./poc-contracts";
import type { ProofStrength } from "./types";

/**
 * Contract used by the direct ablation arms only.  It deliberately ends before
 * C's observation review, criticism, terminal review, graph selection,
 * checkpoint, discourse, rendering, or repair stages.
 */
export const ABLATION_DIRECT_SYNTHESIS_VERSION = "architecture-ablation-direct-synthesis/2" as const;

/**
 * Provider-facing schema. Strict structured-output providers require every
 * object field to be required and every object to be closed. The parser below
 * maps explicit nulls and entry-encoded attribute values back to the existing
 * optional/object-valued semantic contract before materialization.
 */
export const DIRECT_SYNTHESIS_PROPOSAL_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "hypotheses", "relations", "claims", "demonstrations", "coverage", "limitations", "riskProfile"],
  properties: {
    schemaVersion: { const: ABLATION_DIRECT_SYNTHESIS_VERSION },
    hypotheses: { type: "array", minItems: 1, maxItems: 16, items: { $ref: "#/$defs/hypothesis" } },
    relations: { type: "array", maxItems: 24, items: { $ref: "#/$defs/relation" } },
    claims: { type: "array", minItems: 1, maxItems: 16, items: { $ref: "#/$defs/claim" } },
    demonstrations: { type: ["array", "null"], maxItems: 8, items: { $ref: "#/$defs/demonstration" } },
    coverage: { $ref: "#/$defs/coverage" },
    limitations: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 1000 } },
    riskProfile: { $ref: "#/$defs/riskProfile" },
  },
  $defs: {
    reference: { type: "object", additionalProperties: false, required: ["domain", "id"], properties: { domain: { type: "string", minLength: 1, maxLength: 160 }, id: { type: "string", minLength: 1, maxLength: 200 } } },
    participant: { type: "object", additionalProperties: false, required: ["role", "ref"], properties: { role: { type: "string", minLength: 1, maxLength: 160 }, ref: { $ref: "#/$defs/reference" } } },
    anchor: { type: "object", additionalProperties: false, required: ["participant", "disposition"], properties: { participant: { $ref: "#/$defs/participant" }, disposition: { const: "required" } } },
    attributeEntry: { type: "object", additionalProperties: false, required: ["key", "value"], properties: { key: { type: "string", minLength: 1, maxLength: 160 }, value: { $ref: "#/$defs/attributeValue" } } },
    attributeObject: { type: "object", additionalProperties: false, required: ["entries"], properties: { entries: { type: "array", maxItems: 32, items: { $ref: "#/$defs/attributeEntry" } } } },
    attributeValue: { anyOf: [
      { type: "object", additionalProperties: false, required: ["type", "value"], properties: { type: { const: "string" }, value: { type: "string", maxLength: 1000 } } },
      { type: "object", additionalProperties: false, required: ["type", "value"], properties: { type: { const: "number" }, value: { type: "number" } } },
      { type: "object", additionalProperties: false, required: ["type", "value"], properties: { type: { const: "boolean" }, value: { type: "boolean" } } },
      { type: "object", additionalProperties: false, required: ["type", "value"], properties: { type: { const: "null" }, value: { type: "null" } } },
      { type: "object", additionalProperties: false, required: ["type", "items"], properties: { type: { const: "array" }, items: { type: "array", maxItems: 32, items: { $ref: "#/$defs/attributeValue" } } } },
      { type: "object", additionalProperties: false, required: ["type", "entries"], properties: { type: { const: "object" }, entries: { type: "array", maxItems: 32, items: { $ref: "#/$defs/attributeEntry" } } } },
    ] },
    hypothesis: {
      type: "object", additionalProperties: false,
      required: ["localId", "entityType", "concepts", "owner", "participants", "attributes", "proofStrength", "evidenceIds", "sourceObservationIds", "parentHypothesisIds", "anchorRequirements"],
      properties: {
        localId: { type: "string", minLength: 1, maxLength: 160 }, entityType: { type: "string", minLength: 1, maxLength: 160 },
        concepts: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 160 } }, owner: { enum: ["w", "b", null] },
        participants: { type: "array", maxItems: 12, items: { $ref: "#/$defs/participant" } }, attributes: { $ref: "#/$defs/attributeObject" },
        proofStrength: { enum: ["observed", "supported", "forced", null] }, evidenceIds: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } },
        sourceObservationIds: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } }, parentHypothesisIds: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 200 } }, anchorRequirements: { type: "array", maxItems: 12, items: { $ref: "#/$defs/anchor" } },
      },
    },
    relation: { type: "object", additionalProperties: false, required: ["localId", "relationType", "from", "to", "attributes", "evidenceIds", "sourceObservationIds"], properties: { localId: { type: "string", minLength: 1, maxLength: 160 }, relationType: { type: "string", minLength: 1, maxLength: 160 }, from: { type: "string", minLength: 1, maxLength: 160 }, to: { type: "string", minLength: 1, maxLength: 160 }, attributes: { $ref: "#/$defs/attributeObject" }, evidenceIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } }, sourceObservationIds: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } } } },
    segment: { anyOf: [
      { type: "object", additionalProperties: false, required: ["type", "text"], properties: { type: { const: "text" }, text: { type: "string", minLength: 1, maxLength: 600 } } },
      { type: "object", additionalProperties: false, required: ["type", "pieceId", "form", "capitalize", "label"], properties: { type: { const: "piece" }, pieceId: { type: "string", minLength: 1, maxLength: 200 }, form: { enum: ["definite", "color-qualified", "square-qualified", "canonical", "bare", "bare-square-qualified", null] }, capitalize: { type: ["boolean", "null"] }, label: { type: ["string", "null"], minLength: 1, maxLength: 120 } } },
      { type: "object", additionalProperties: false, required: ["type", "pieceKind", "color", "label"], properties: { type: { const: "piece-kind" }, pieceKind: { enum: ["bishop", "king", "knight", "pawn", "queen", "rook"] }, color: { enum: ["w", "b", null] }, label: { type: ["string", "null"], minLength: 1, maxLength: 120 } } },
      { type: "object", additionalProperties: false, required: ["type", "square", "label"], properties: { type: { const: "square" }, square: { type: "string", minLength: 1, maxLength: 2 }, label: { type: ["string", "null"], minLength: 1, maxLength: 120 } } },
      { type: "object", additionalProperties: false, required: ["type", "uci", "pieceId", "san", "label"], properties: { type: { const: "move" }, uci: { type: "string", minLength: 1, maxLength: 5 }, pieceId: { type: "string", minLength: 1, maxLength: 200 }, san: { type: "string", minLength: 1, maxLength: 40 }, label: { type: ["string", "null"], minLength: 1, maxLength: 120 } } },
      { type: "object", additionalProperties: false, required: ["type", "entityLocalId", "label"], properties: { type: { const: "entity" }, entityLocalId: { type: "string", minLength: 1, maxLength: 160 }, label: { type: ["string", "null"], minLength: 1, maxLength: 120 } } },
      { type: "object", additionalProperties: false, required: ["type", "relationLocalId", "fromEntityLocalId", "toEntityLocalId", "label"], properties: { type: { const: "relation" }, relationLocalId: { type: "string", minLength: 1, maxLength: 160 }, fromEntityLocalId: { type: "string", minLength: 1, maxLength: 160 }, toEntityLocalId: { type: "string", minLength: 1, maxLength: 160 }, label: { type: ["string", "null"], minLength: 1, maxLength: 120 } } },
    ] },
    claim: { type: "object", additionalProperties: false, required: ["localId", "kind", "content", "proofStrength", "evidenceIds", "qualifications"], properties: { localId: { type: "string", minLength: 1, maxLength: 160 }, kind: { enum: ["fact", "interpretation", "consequence", "defense", "uncertainty"] }, content: { type: "array", minItems: 1, maxItems: 32, items: { $ref: "#/$defs/segment" } }, proofStrength: { enum: ["observed", "supported", "forced", null] }, evidenceIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } }, qualifications: { type: "array", maxItems: 8, items: { type: "array", minItems: 1, maxItems: 16, items: { $ref: "#/$defs/segment" } } } } },
    demonstration: { anyOf: [
      { type: "object", additionalProperties: false, required: ["localId", "type", "start", "moves", "label", "evidenceIds"], properties: { localId: { type: "string", minLength: 1, maxLength: 160 }, type: { const: "legal-variation" }, start: { enum: ["before", "after"] }, moves: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", additionalProperties: false, required: ["uci", "pieceId", "san"], properties: { uci: { type: "string", minLength: 1, maxLength: 5 }, pieceId: { type: "string", minLength: 1, maxLength: 200 }, san: { type: "string", minLength: 1, maxLength: 40 } } } }, label: { type: "string", minLength: 1, maxLength: 160 }, evidenceIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } } } },
      { type: "object", additionalProperties: false, required: ["localId", "type", "pieceId", "waypoints", "prerequisiteRefs", "label", "evidenceIds"], properties: { localId: { type: "string", minLength: 1, maxLength: 160 }, type: { const: "conditional-route" }, pieceId: { type: "string", minLength: 1, maxLength: 200 }, waypoints: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 1000 } }, prerequisiteRefs: { type: "array", minItems: 1, maxItems: 16, items: { $ref: "#/$defs/segment" } }, label: { type: "string", minLength: 1, maxLength: 160 }, evidenceIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } } } },
      { type: "object", additionalProperties: false, required: ["localId", "type", "relationLocalId", "fromEntityLocalId", "toEntityLocalId", "label", "evidenceIds"], properties: { localId: { type: "string", minLength: 1, maxLength: 160 }, type: { const: "static-relationship" }, relationLocalId: { type: "string", minLength: 1, maxLength: 160 }, fromEntityLocalId: { type: "string", minLength: 1, maxLength: 160 }, toEntityLocalId: { type: "string", minLength: 1, maxLength: 160 }, label: { type: "string", minLength: 1, maxLength: 160 }, evidenceIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } } } },
    ] },
    coverageLane: { type: "object", additionalProperties: false, required: ["status", "evidenceIds", "unresolved"], properties: { status: { enum: ["complete", "partial", "unavailable"] }, evidenceIds: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } }, unresolved: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 1000 } } } },
    omission: { type: "object", additionalProperties: false, required: ["localId", "reason"], properties: { localId: { type: "string", minLength: 1, maxLength: 160 }, reason: { type: "string", minLength: 1, maxLength: 500 } } },
    coverage: { type: "object", additionalProperties: false, required: ["responseCoverage", "continuationCoverage", "unresolvedEvidenceObligations", "omittedHypotheses", "omittedRelations"], properties: { responseCoverage: { $ref: "#/$defs/coverageLane" }, continuationCoverage: { $ref: "#/$defs/coverageLane" }, unresolvedEvidenceObligations: { type: "array", maxItems: 24, items: { type: "object", additionalProperties: false, required: ["id", "reason"], properties: { id: { type: "string", minLength: 1, maxLength: 160 }, reason: { type: "string", minLength: 1, maxLength: 500 } } } }, omittedHypotheses: { type: "array", maxItems: 24, items: { $ref: "#/$defs/omission" } }, omittedRelations: { type: "array", maxItems: 24, items: { $ref: "#/$defs/omission" } } } },
    riskProfile: { type: "object", additionalProperties: false, required: ["level", "reasons"], properties: { level: { enum: ["low", "medium", "high"] }, reasons: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 1000 } } } },
  },
} as const;

export type DirectSynthesisArm = "A1" | "B" | "B-prime";

export type DirectSynthesisSegment = Exclude<ReasoningNarrativeSegment, { type: "move" | "entity" | "relation" }>
  | { type: "move"; uci: string; pieceId: string; san: string; label?: string }
  | { type: "entity"; entityLocalId: string; label?: string }
  | { type: "relation"; relationLocalId: string; fromEntityLocalId: string; toEntityLocalId: string; label?: string };

export type DirectSynthesisClaim = {
  localId: string;
  kind: ReasoningClaimKind;
  content: DirectSynthesisSegment[];
  proofStrength: ProofStrength | null;
  evidenceIds: string[];
  qualifications: DirectSynthesisSegment[][];
};

export type DirectSynthesisDemonstration =
  | {
    localId: string;
    type: "legal-variation";
    start: "before" | "after";
    moves: Array<{ uci: string; pieceId: string; san: string }>;
    label: string;
    evidenceIds: string[];
  }
  | {
    localId: string;
    type: "conditional-route";
    pieceId: string;
    waypoints: string[];
    prerequisiteRefs: DirectSynthesisSegment[];
    label: string;
    evidenceIds: string[];
  }
  | {
    localId: string;
    type: "static-relationship";
    relationLocalId: string;
    fromEntityLocalId: string;
    toEntityLocalId: string;
    label: string;
    evidenceIds: string[];
  };

export type DirectSynthesisRiskProfile = {
  level: "low" | "medium" | "high";
  reasons: string[];
};

export type DirectSynthesisCoverageStatus = "complete" | "partial" | "unavailable";

export type DirectSynthesisCoverage = {
  responseCoverage: { status: DirectSynthesisCoverageStatus; evidenceIds: string[]; unresolved: string[] };
  continuationCoverage: { status: DirectSynthesisCoverageStatus; evidenceIds: string[]; unresolved: string[] };
  unresolvedEvidenceObligations: Array<{ id: string; reason: string }>;
  omittedHypotheses: Array<{ localId: string; reason: string }>;
  omittedRelations: Array<{ localId: string; reason: string }>;
};

/** A local relation handle is transport-only and is discarded after remapping. */
export type DirectSynthesisRelationProposal = ReasoningHypothesisRelationProposal & { localId: string };

/** Model-local handles are permitted only in this inbound proposal. */
export type DirectSynthesisProposal = {
  schemaVersion: typeof ABLATION_DIRECT_SYNTHESIS_VERSION;
  hypotheses: ReasoningHypothesisProposal[];
  relations: DirectSynthesisRelationProposal[];
  claims: DirectSynthesisClaim[];
  demonstrations?: DirectSynthesisDemonstration[];
  coverage: DirectSynthesisCoverage;
  limitations: string[];
  riskProfile: DirectSynthesisRiskProfile;
};

export type CanonicalDirectSynthesisClaim = Omit<DirectSynthesisClaim, "localId" | "content" | "qualifications"> & {
  id: string;
  content: ReasoningNarrativeSegment[];
  qualifications: ReasoningNarrativeSegment[][];
};

export type CanonicalDirectSynthesisDemonstration =
  | {
    id: string;
    type: "legal-variation";
    start: "before" | "after";
    moves: Array<{ uci: string; pieceId: string; san: string }>;
    label: string;
    evidenceIds: string[];
  }
  | {
    id: string;
    type: "conditional-route";
    pieceId: string;
    waypoints: string[];
    prerequisiteRefs: ReasoningNarrativeSegment[];
    label: string;
    evidenceIds: string[];
  }
  | {
    id: string;
    type: "static-relationship";
    relationId: string;
    fromEntityId: string;
    toEntityId: string;
    relationType: string;
    label: string;
    evidenceIds: string[];
  };

/** The Ledger's localId is an input-only helper and is never persisted here. */
export type CanonicalDirectSynthesisHypothesis = Omit<ReasoningHypothesisRecord, "localId">;

/**
 * This artifact is intentionally pre-checkpoint.  It contains only canonical
 * Ledger records plus directly validated narrative material; it does not
 * manufacture acceptance, graph selection, or a C-stage checkpoint.
 */
export type DirectSynthesisArtifact = {
  schemaVersion: typeof ABLATION_DIRECT_SYNTHESIS_VERSION;
  contextHash: string;
  bundleHash: string;
  hypotheses: CanonicalDirectSynthesisHypothesis[];
  relations: ReasoningHypothesisRelationRecord[];
  claims: CanonicalDirectSynthesisClaim[];
  demonstrations: CanonicalDirectSynthesisDemonstration[];
  coverage: Omit<DirectSynthesisCoverage, "omittedHypotheses" | "omittedRelations"> & {
    omittedHypothesisIds: Array<{ hypothesisId: string; reason: string }>;
    omittedRelationIds: Array<{ relationId: string; reason: string }>;
  };
  admission: "pre-checkpoint-proposed";
  productSupport: "not-a-validated-graph-checkpoint-or-product-result";
  limitations: string[];
  riskProfile: DirectSynthesisRiskProfile;
};

export type DirectSynthesisIssue = {
  path: string;
  code: string;
  message: string;
  permittedReferences: string[];
};

export type DirectSynthesisMaterializationResult =
  | { ok: true; metadata: { arm: DirectSynthesisArm }; artifact: DirectSynthesisArtifact }
  | { ok: false; metadata: { arm: DirectSynthesisArm }; code: "direct-synthesis-rejected"; issues: DirectSynthesisIssue[] };

export type MaterializeDirectSynthesisInput = {
  arm: DirectSynthesisArm;
  bundle: Readonly<AblationEvidenceClosureBundle>;
  proposal: unknown;
  provenance?: ReasoningHypothesisProvenance;
};

class AdmissionFailure extends Error {
  constructor(readonly issue: DirectSynthesisIssue) {
    super(issue.message);
  }
}

function fail(path: string, code: string, message: string, permittedReferences: string[] = []): never {
  throw new AdmissionFailure({ path, code, message, permittedReferences });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(path, "unsupported_field", "Direct synthesis contains an unsupported field");
}

function nonEmptyString(value: unknown, path: string, max = 1_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(path, "invalid_string", "Expected a bounded non-empty string");
  return value.trim();
}

function stringArray(value: unknown, path: string, max: number, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && !value.length)) fail(path, "invalid_string_array", "Expected a bounded string array");
  const result = value.map((item, index) => nonEmptyString(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) fail(path, "duplicate_reference", "References must not be duplicated");
  return result;
}

function proof(value: unknown, path: string): ProofStrength | null {
  if (value === null) return null;
  if (value === "observed" || value === "supported" || value === "forced") return value;
  return fail(path, "invalid_proof_strength", "Proof strength must be observed, supported, forced, or null");
}

function parseProviderAttributeEntries(value: unknown, path: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length > 32) fail(path, "invalid_attribute_entries", "Attribute entries must be a bounded array");
  const attributes: Record<string, unknown> = {};
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) fail(`${path}[${index}]`, "invalid_attribute_entry", "Attribute entry must be structured");
    exactKeys(entry, ["key", "value"], `${path}[${index}]`);
    const key = nonEmptyString(entry.key, `${path}[${index}].key`, 160);
    if (Object.hasOwn(attributes, key)) fail(`${path}[${index}].key`, "duplicate_attribute_key", "Attribute keys must be unique");
    attributes[key] = parseProviderAttributeValue(entry.value, `${path}[${index}].value`);
  }
  return attributes;
}

function parseProviderAttributeValue(value: unknown, path: string): unknown {
  if (!isRecord(value)) fail(path, "invalid_attribute_value", "Attribute values must use the typed provider transport");
  const type = value.type;
  if (type === "string") {
    exactKeys(value, ["type", "value"], path);
    return nonEmptyString(value.value, `${path}.value`, 1_000);
  }
  if (type === "number") {
    exactKeys(value, ["type", "value"], path);
    if (typeof value.value !== "number" || !Number.isFinite(value.value)) fail(`${path}.value`, "invalid_attribute_number", "Attribute number must be finite");
    return value.value;
  }
  if (type === "boolean") {
    exactKeys(value, ["type", "value"], path);
    if (typeof value.value !== "boolean") fail(`${path}.value`, "invalid_attribute_boolean", "Attribute boolean must be boolean");
    return value.value;
  }
  if (type === "null") {
    exactKeys(value, ["type", "value"], path);
    if (value.value !== null) fail(`${path}.value`, "invalid_attribute_null", "Null attribute must carry null");
    return null;
  }
  if (type === "array") {
    exactKeys(value, ["type", "items"], path);
    if (!Array.isArray(value.items) || value.items.length > 32) fail(`${path}.items`, "invalid_attribute_array", "Attribute array must be bounded");
    return value.items.map((item, index) => parseProviderAttributeValue(item, `${path}.items[${index}]`));
  }
  if (type === "object") {
    exactKeys(value, ["type", "entries"], path);
    return parseProviderAttributeEntries(value.entries, `${path}.entries`);
  }
  return fail(`${path}.type`, "invalid_attribute_type", "Attribute value type is invalid");
}

function parseAttributes(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "invalid_attributes", "Attributes must be an object");
  // Strict-provider requests use the closed, recursively typed entry transport.
  // Retain the legacy object form for stored fixtures and direct parser callers;
  // provider output is constrained by DIRECT_SYNTHESIS_PROPOSAL_JSON_SCHEMA.
  if (Array.isArray(value.entries)) {
    exactKeys(value, ["entries"], path);
    return parseProviderAttributeEntries(value.entries, `${path}.entries`);
  }
  return value;
}

function assertNoCArtifacts(value: unknown, path = "proposal", topLevel = true): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCArtifacts(item, `${path}[${index}]`, false));
    return;
  }
  if (!isRecord(value)) return;
  const forbiddenTopLevel = new Set([
    "review", "reviews", "critic", "critics", "challenge", "challenges", "terminalReview",
    "answerObligation", "answerObligations", "selectedGraph", "selectedEntities", "selectedRelations",
    "graphRefs", "hypothesisLedgerRevision", "discourse", "discoursePlan", "render", "repair",
  ]);
  if (topLevel) {
    for (const key of Object.keys(value)) if (forbiddenTopLevel.has(key)) {
      fail(`${path}.${key}`, "semantic_c_artifact", "Direct synthesis must not transport staged-C semantic artifacts");
    }
  }
  // Attribute dictionaries remain model-owned semantic meaning.  Reject only
  // recognizable C envelopes, never an ordinary attribute merely called
  // "review", "critic", or similar.
  if (Array.isArray(value.selectedEntities) || Array.isArray(value.selectedRelations)
    || typeof value.hypothesisLedgerRevision === "string"
    || (isRecord(value.discoursePlan) && typeof value.discoursePlan.checkpointId === "string")
    || (isRecord(value.reasoningCheckpoint) && typeof value.reasoningCheckpoint.checkpointVersion === "string")) {
    fail(path, "semantic_c_artifact", "Direct synthesis must not transport a staged-C envelope");
  }
  for (const [key, child] of Object.entries(value)) assertNoCArtifacts(child, `${path}.${key}`, false);
}

function parseSegment(value: unknown, path: string): DirectSynthesisSegment {
  if (!isRecord(value)) return fail(path, "invalid_segment", "Narrative segments must be typed objects");
  const type = nonEmptyString(value.type, `${path}.type`, 64);
  if (type === "text") {
    exactKeys(value, ["type", "text"], path);
    const text = nonEmptyString(value.text, `${path}.text`, 600);
    if (RAW_CHESS_TEXT.test(text)) fail(`${path}.text`, "raw_chess_reference", "Concrete chess references must use typed segments");
    return { type: "text", text };
  }
  if (type === "piece") {
    exactKeys(value, ["type", "pieceId", "form", "capitalize", "label"], path);
    const form = value.form;
    if (form !== undefined && form !== null && form !== "definite" && form !== "color-qualified" && form !== "square-qualified" && form !== "canonical" && form !== "bare" && form !== "bare-square-qualified") {
      fail(`${path}.form`, "invalid_piece_form", "Piece reference form is invalid");
    }
    if (value.capitalize !== undefined && value.capitalize !== null && typeof value.capitalize !== "boolean") fail(`${path}.capitalize`, "invalid_piece_capitalization", "Piece capitalization must be boolean");
    if (value.label !== undefined && value.label !== null) nonEmptyString(value.label, `${path}.label`, 120);
    return { type: "piece", pieceId: nonEmptyString(value.pieceId, `${path}.pieceId`, 200), ...(form === undefined || form === null ? {} : { form }), ...(value.capitalize === undefined || value.capitalize === null ? {} : { capitalize: value.capitalize }), ...(value.label === undefined || value.label === null ? {} : { label: value.label as string }) };
  }
  if (type === "piece-kind") {
    exactKeys(value, ["type", "pieceKind", "color", "label"], path);
    const pieceKind = nonEmptyString(value.pieceKind, `${path}.pieceKind`, 20);
    if (!(["bishop", "king", "knight", "pawn", "queen", "rook"] as string[]).includes(pieceKind)) fail(`${path}.pieceKind`, "invalid_piece_kind", "Piece kind is invalid");
    if (value.color !== "w" && value.color !== "b" && value.color !== null) fail(`${path}.color`, "invalid_piece_color", "Piece-kind color is invalid");
    if (value.label !== undefined && value.label !== null) nonEmptyString(value.label, `${path}.label`, 120);
    return { type: "piece-kind", pieceKind: pieceKind as "bishop" | "king" | "knight" | "pawn" | "queen" | "rook", color: value.color, ...(value.label === undefined || value.label === null ? {} : { label: value.label as string }) };
  }
  if (type === "square") {
    exactKeys(value, ["type", "square", "label"], path);
    if (value.label !== undefined && value.label !== null) nonEmptyString(value.label, `${path}.label`, 120);
    return { type: "square", square: nonEmptyString(value.square, `${path}.square`, 2), ...(value.label === undefined || value.label === null ? {} : { label: value.label as string }) };
  }
  if (type === "move") {
    exactKeys(value, ["type", "uci", "pieceId", "san", "label"], path);
    if (value.label !== undefined && value.label !== null) nonEmptyString(value.label, `${path}.label`, 120);
    return { type: "move", uci: nonEmptyString(value.uci, `${path}.uci`, 5), pieceId: nonEmptyString(value.pieceId, `${path}.pieceId`, 200), san: nonEmptyString(value.san, `${path}.san`, 40), ...(value.label === undefined || value.label === null ? {} : { label: value.label as string }) };
  }
  if (type === "entity") {
    exactKeys(value, ["type", "entityLocalId", "label"], path);
    if (value.label !== undefined && value.label !== null) nonEmptyString(value.label, `${path}.label`, 120);
    return { type: "entity", entityLocalId: nonEmptyString(value.entityLocalId, `${path}.entityLocalId`, 160), ...(value.label === undefined || value.label === null ? {} : { label: value.label as string }) };
  }
  if (type === "relation") {
    exactKeys(value, ["type", "relationLocalId", "fromEntityLocalId", "toEntityLocalId", "label"], path);
    if (value.label !== undefined && value.label !== null) nonEmptyString(value.label, `${path}.label`, 120);
    return {
      type: "relation",
      relationLocalId: nonEmptyString(value.relationLocalId, `${path}.relationLocalId`, 160),
      fromEntityLocalId: nonEmptyString(value.fromEntityLocalId, `${path}.fromEntityLocalId`, 160),
      toEntityLocalId: nonEmptyString(value.toEntityLocalId, `${path}.toEntityLocalId`, 160),
      ...(value.label === undefined || value.label === null ? {} : { label: value.label as string }),
    };
  }
  return fail(`${path}.type`, "unknown_segment_type", "Narrative segment type is not supported");
}

function parseClaim(value: unknown, path: string): DirectSynthesisClaim {
  if (!isRecord(value)) return fail(path, "invalid_claim", "Claim must be an object");
  exactKeys(value, ["localId", "kind", "content", "proofStrength", "evidenceIds", "qualifications"], path);
  const kind = value.kind;
  if (kind !== "fact" && kind !== "interpretation" && kind !== "consequence" && kind !== "defense" && kind !== "uncertainty") fail(`${path}.kind`, "invalid_claim_kind", "Claim kind is invalid");
  if (!Array.isArray(value.content) || !value.content.length || value.content.length > 32) fail(`${path}.content`, "invalid_claim_content", "Claim requires bounded typed content");
  if (!Array.isArray(value.qualifications) || value.qualifications.length > 8) fail(`${path}.qualifications`, "invalid_qualifications", "Claim qualifications must be bounded typed segment arrays");
  return {
    localId: nonEmptyString(value.localId, `${path}.localId`, 160),
    kind,
    content: value.content.map((segment, index) => parseSegment(segment, `${path}.content[${index}]`)),
    proofStrength: proof(value.proofStrength, `${path}.proofStrength`),
    evidenceIds: stringArray(value.evidenceIds, `${path}.evidenceIds`, 12, false),
    qualifications: value.qualifications.map((qualification, index) => {
      if (!Array.isArray(qualification) || !qualification.length || qualification.length > 16) fail(`${path}.qualifications[${index}]`, "invalid_qualification", "Each qualification requires typed content");
      return qualification.map((segment, segmentIndex) => parseSegment(segment, `${path}.qualifications[${index}][${segmentIndex}]`));
    }),
  };
}

function parseHypothesis(value: unknown, path: string): ReasoningHypothesisProposal {
  if (!isRecord(value)) return fail(path, "invalid_hypothesis", "Hypothesis must be an object");
  exactKeys(value, ["localId", "entityType", "concepts", "owner", "participants", "attributes", "proofStrength", "evidenceIds", "sourceObservationIds", "parentHypothesisIds", "anchorRequirements"], path);
  if (value.owner !== "w" && value.owner !== "b" && value.owner !== null) fail(`${path}.owner`, "invalid_owner", "Hypothesis owner is invalid");
  if (!Array.isArray(value.participants) || value.participants.length > 12) fail(`${path}.participants`, "invalid_participants", "Hypothesis participants must be bounded");
  const participants = value.participants.map((participant, index) => {
    if (!isRecord(participant) || !isRecord(participant.ref)) fail(`${path}.participants[${index}]`, "invalid_participant", "Participant must have a typed reference");
    exactKeys(participant, ["role", "ref"], `${path}.participants[${index}]`);
    exactKeys(participant.ref, ["domain", "id"], `${path}.participants[${index}].ref`);
    return {
      role: nonEmptyString(participant.role, `${path}.participants[${index}].role`, 160),
      ref: {
        domain: nonEmptyString(participant.ref.domain, `${path}.participants[${index}].ref.domain`, 160),
        id: nonEmptyString(participant.ref.id, `${path}.participants[${index}].ref.id`, 200),
      },
    };
  });
  if (!Array.isArray(value.anchorRequirements) || value.anchorRequirements.length > 12) fail(`${path}.anchorRequirements`, "invalid_anchor_requirements", "Hypothesis anchors must be bounded");
  const anchorRequirements = value.anchorRequirements.map((anchor, index) => {
    if (!isRecord(anchor) || !isRecord(anchor.participant) || !isRecord(anchor.participant.ref)) fail(`${path}.anchorRequirements[${index}]`, "invalid_anchor_requirement", "Anchor requirement is malformed");
    exactKeys(anchor, ["participant", "disposition"], `${path}.anchorRequirements[${index}]`);
    exactKeys(anchor.participant, ["role", "ref"], `${path}.anchorRequirements[${index}].participant`);
    exactKeys(anchor.participant.ref, ["domain", "id"], `${path}.anchorRequirements[${index}].participant.ref`);
    if (anchor.disposition !== "required") fail(`${path}.anchorRequirements[${index}].disposition`, "invalid_anchor_disposition", "Anchor disposition must be required");
    return {
      disposition: "required" as const,
      participant: {
        role: nonEmptyString(anchor.participant.role, `${path}.anchorRequirements[${index}].participant.role`, 160),
        ref: {
          domain: nonEmptyString(anchor.participant.ref.domain, `${path}.anchorRequirements[${index}].participant.ref.domain`, 160),
          id: nonEmptyString(anchor.participant.ref.id, `${path}.anchorRequirements[${index}].participant.ref.id`, 200),
        },
      },
    };
  });
  return {
    localId: nonEmptyString(value.localId, `${path}.localId`, 160),
    entityType: nonEmptyString(value.entityType, `${path}.entityType`, 160),
    concepts: stringArray(value.concepts, `${path}.concepts`, 4, false),
    owner: value.owner,
    participants,
    attributes: parseAttributes(value.attributes, `${path}.attributes`) as ReasoningHypothesisProposal["attributes"],
    proofStrength: proof(value.proofStrength, `${path}.proofStrength`),
    evidenceIds: stringArray(value.evidenceIds, `${path}.evidenceIds`, 12),
    sourceObservationIds: stringArray(value.sourceObservationIds, `${path}.sourceObservationIds`, 12),
    parentHypothesisIds: stringArray(value.parentHypothesisIds, `${path}.parentHypothesisIds`, 8),
    anchorRequirements,
  };
}

function parseRelation(value: unknown, path: string): DirectSynthesisRelationProposal {
  if (!isRecord(value)) return fail(path, "invalid_relation", "Relation must be an object");
  exactKeys(value, ["localId", "relationType", "from", "to", "attributes", "evidenceIds", "sourceObservationIds"], path);
  return {
    localId: nonEmptyString(value.localId, `${path}.localId`, 160),
    relationType: nonEmptyString(value.relationType, `${path}.relationType`, 160),
    from: nonEmptyString(value.from, `${path}.from`, 160),
    to: nonEmptyString(value.to, `${path}.to`, 160),
    attributes: parseAttributes(value.attributes, `${path}.attributes`) as ReasoningHypothesisRelationProposal["attributes"],
    evidenceIds: stringArray(value.evidenceIds, `${path}.evidenceIds`, 12, false),
    sourceObservationIds: stringArray(value.sourceObservationIds, `${path}.sourceObservationIds`, 12),
  };
}

function parseCoverageLane(value: unknown, path: string): DirectSynthesisCoverage["responseCoverage"] {
  if (!isRecord(value)) return fail(path, "invalid_coverage_lane", "Coverage lane must be structured");
  exactKeys(value, ["status", "evidenceIds", "unresolved"], path);
  if (value.status !== "complete" && value.status !== "partial" && value.status !== "unavailable") fail(`${path}.status`, "invalid_coverage_status", "Coverage status is invalid");
  const evidenceIds = stringArray(value.evidenceIds, `${path}.evidenceIds`, 12);
  const unresolved = stringArray(value.unresolved, `${path}.unresolved`, 24);
  if (value.status === "complete" && unresolved.length) fail(`${path}.unresolved`, "complete_coverage_has_unresolved", "Complete coverage cannot retain unresolved obligations");
  return { status: value.status, evidenceIds, unresolved };
}

function parseOmissions(value: unknown, path: string): Array<{ localId: string; reason: string }> {
  if (!Array.isArray(value) || value.length > 24) fail(path, "invalid_omissions", "Omissions must be a bounded array");
  const omissions = value.map((item, index) => {
    if (!isRecord(item)) return fail(`${path}[${index}]`, "invalid_omission", "Omission must be structured");
    exactKeys(item, ["localId", "reason"], `${path}[${index}]`);
    return { localId: nonEmptyString(item.localId, `${path}[${index}].localId`, 160), reason: nonEmptyString(item.reason, `${path}[${index}].reason`, 500) };
  });
  if (new Set(omissions.map((item) => item.localId)).size !== omissions.length) fail(path, "duplicate_omission", "Omitted local IDs must be unique");
  return omissions;
}

function parseCoverage(value: unknown, path: string): DirectSynthesisCoverage {
  if (!isRecord(value)) return fail(path, "invalid_coverage", "Direct synthesis requires structured coverage");
  exactKeys(value, ["responseCoverage", "continuationCoverage", "unresolvedEvidenceObligations", "omittedHypotheses", "omittedRelations"], path);
  if (!Array.isArray(value.unresolvedEvidenceObligations) || value.unresolvedEvidenceObligations.length > 24) fail(`${path}.unresolvedEvidenceObligations`, "invalid_unresolved_obligations", "Unresolved evidence obligations must be bounded");
  const unresolvedEvidenceObligations = value.unresolvedEvidenceObligations.map((item, index) => {
    if (!isRecord(item)) return fail(`${path}.unresolvedEvidenceObligations[${index}]`, "invalid_unresolved_obligation", "Unresolved evidence obligation must be structured");
    exactKeys(item, ["id", "reason"], `${path}.unresolvedEvidenceObligations[${index}]`);
    return { id: nonEmptyString(item.id, `${path}.unresolvedEvidenceObligations[${index}].id`, 160), reason: nonEmptyString(item.reason, `${path}.unresolvedEvidenceObligations[${index}].reason`, 500) };
  });
  if (new Set(unresolvedEvidenceObligations.map((item) => item.id)).size !== unresolvedEvidenceObligations.length) fail(`${path}.unresolvedEvidenceObligations`, "duplicate_unresolved_obligation", "Unresolved evidence obligations must be unique");
  return {
    responseCoverage: parseCoverageLane(value.responseCoverage, `${path}.responseCoverage`),
    continuationCoverage: parseCoverageLane(value.continuationCoverage, `${path}.continuationCoverage`),
    unresolvedEvidenceObligations,
    omittedHypotheses: parseOmissions(value.omittedHypotheses, `${path}.omittedHypotheses`),
    omittedRelations: parseOmissions(value.omittedRelations, `${path}.omittedRelations`),
  };
}

function parseDemonstration(value: unknown, path: string): DirectSynthesisDemonstration {
  if (!isRecord(value)) return fail(path, "invalid_demonstration", "Demonstration must be an object");
  const type = value.type;
  if (type === "legal-variation") {
    exactKeys(value, ["localId", "type", "start", "moves", "label", "evidenceIds"], path);
    if (value.start !== "before" && value.start !== "after") fail(`${path}.start`, "invalid_variation_start", "Variation start must be before or after");
    if (!Array.isArray(value.moves) || !value.moves.length || value.moves.length > 16) fail(`${path}.moves`, "invalid_variation_moves", "Variation requires bounded moves");
    return {
      localId: nonEmptyString(value.localId, `${path}.localId`, 160), type, start: value.start,
      moves: value.moves.map((move, index) => {
        if (!isRecord(move)) return fail(`${path}.moves[${index}]`, "invalid_variation_move", "Variation move must be typed");
        exactKeys(move, ["uci", "pieceId", "san"], `${path}.moves[${index}]`);
        return { uci: nonEmptyString(move.uci, `${path}.moves[${index}].uci`, 5), pieceId: nonEmptyString(move.pieceId, `${path}.moves[${index}].pieceId`, 200), san: nonEmptyString(move.san, `${path}.moves[${index}].san`, 40) };
      }),
      label: nonEmptyString(value.label, `${path}.label`, 160), evidenceIds: stringArray(value.evidenceIds, `${path}.evidenceIds`, 12, false),
    };
  }
  if (type === "conditional-route") {
    exactKeys(value, ["localId", "type", "pieceId", "waypoints", "prerequisiteRefs", "label", "evidenceIds"], path);
    if (!Array.isArray(value.prerequisiteRefs) || !value.prerequisiteRefs.length || value.prerequisiteRefs.length > 16) fail(`${path}.prerequisiteRefs`, "invalid_route_prerequisites", "Route prerequisites require typed references");
    return {
      localId: nonEmptyString(value.localId, `${path}.localId`, 160), type,
      pieceId: nonEmptyString(value.pieceId, `${path}.pieceId`, 200), waypoints: stringArray(value.waypoints, `${path}.waypoints`, 16, false),
      prerequisiteRefs: value.prerequisiteRefs.map((segment, index) => parseSegment(segment, `${path}.prerequisiteRefs[${index}]`)),
      label: nonEmptyString(value.label, `${path}.label`, 160), evidenceIds: stringArray(value.evidenceIds, `${path}.evidenceIds`, 12, false),
    };
  }
  if (type === "static-relationship") {
    exactKeys(value, ["localId", "type", "relationLocalId", "fromEntityLocalId", "toEntityLocalId", "label", "evidenceIds"], path);
    return {
      localId: nonEmptyString(value.localId, `${path}.localId`, 160), type,
      relationLocalId: nonEmptyString(value.relationLocalId, `${path}.relationLocalId`, 160),
      fromEntityLocalId: nonEmptyString(value.fromEntityLocalId, `${path}.fromEntityLocalId`, 160),
      toEntityLocalId: nonEmptyString(value.toEntityLocalId, `${path}.toEntityLocalId`, 160),
      label: nonEmptyString(value.label, `${path}.label`, 160), evidenceIds: stringArray(value.evidenceIds, `${path}.evidenceIds`, 12, false),
    };
  }
  return fail(`${path}.type`, "invalid_demonstration_type", "Demonstration type is invalid");
}

/** Strict parser intended for a later model-runtime adapter. */
export function parseDirectSynthesisProposal(value: unknown): DirectSynthesisProposal {
  assertNoCArtifacts(value);
  if (!isRecord(value)) return fail("proposal", "invalid_proposal", "Direct synthesis proposal must be an object");
  exactKeys(value, ["schemaVersion", "hypotheses", "relations", "claims", "demonstrations", "coverage", "limitations", "riskProfile"], "proposal");
  if (value.schemaVersion !== ABLATION_DIRECT_SYNTHESIS_VERSION) fail("proposal.schemaVersion", "unsupported_version", "Unsupported direct synthesis schema version");
  if (!Array.isArray(value.hypotheses) || !value.hypotheses.length || value.hypotheses.length > 16) fail("proposal.hypotheses", "invalid_hypotheses", "Direct synthesis requires one bounded hypothesis batch");
  if (!Array.isArray(value.relations) || value.relations.length > 24) fail("proposal.relations", "invalid_relations", "Relations must be a bounded array");
  if (!Array.isArray(value.claims) || !value.claims.length || value.claims.length > 16) fail("proposal.claims", "invalid_claims", "Direct synthesis requires bounded typed claims");
  if (value.demonstrations !== undefined && value.demonstrations !== null && (!Array.isArray(value.demonstrations) || value.demonstrations.length > 8)) fail("proposal.demonstrations", "invalid_demonstrations", "Demonstrations must be a bounded array or null");
  if (!isRecord(value.riskProfile)) fail("proposal.riskProfile", "invalid_risk_profile", "Risk profile must be structured");
  exactKeys(value.riskProfile, ["level", "reasons"], "proposal.riskProfile");
  if (value.riskProfile.level !== "low" && value.riskProfile.level !== "medium" && value.riskProfile.level !== "high") fail("proposal.riskProfile.level", "invalid_risk_level", "Risk level is invalid");
  return {
    schemaVersion: ABLATION_DIRECT_SYNTHESIS_VERSION,
    hypotheses: value.hypotheses.map((hypothesis, index) => parseHypothesis(hypothesis, `proposal.hypotheses[${index}]`)),
    relations: value.relations.map((relation, index) => parseRelation(relation, `proposal.relations[${index}]`)),
    claims: value.claims.map((claim, index) => parseClaim(claim, `proposal.claims[${index}]`)),
    ...(value.demonstrations === undefined || value.demonstrations === null ? {} : { demonstrations: value.demonstrations.map((demonstration, index) => parseDemonstration(demonstration, `proposal.demonstrations[${index}]`)) }),
    coverage: parseCoverage(value.coverage, "proposal.coverage"),
    limitations: stringArray(value.limitations, "proposal.limitations", 24),
    riskProfile: { level: value.riskProfile.level, reasons: stringArray(value.riskProfile.reasons, "proposal.riskProfile.reasons", 12) },
  };
}

function proofRank(value: ProofStrength): number {
  return value === "observed" ? 1 : value === "supported" ? 2 : 3;
}

function assertDistinctLocalIds(proposal: DirectSynthesisProposal): void {
  const localIds = [
    ...proposal.hypotheses.map((item) => item.localId),
    ...proposal.relations.map((item) => item.localId),
    ...proposal.claims.map((item) => item.localId),
    ...(proposal.demonstrations || []).map((item) => item.localId),
  ];
  if (new Set(localIds).size !== localIds.length) fail("proposal", "duplicate_local_id", "Model-local IDs must be unique within one direct synthesis result");
}

function admittedEvidenceIds(bundle: Readonly<AblationEvidenceClosureBundle>, ids: readonly string[], path: string) {
  const allowed = new Set(bundle.referenceAllowlists.evidenceIds);
  const records = new Map(bundle.evidence.map((record) => [record.id, record]));
  for (const id of ids) if (!allowed.has(id) || !records.has(id)) fail(path, "unknown_evidence", "Evidence is outside the frozen closure", [...allowed]);
  return ids.map((id) => records.get(id)!);
}

function assertEvidenceProof(bundle: Readonly<AblationEvidenceClosureBundle>, ids: readonly string[], path: string, requestedProof: ProofStrength | null) {
  const records = admittedEvidenceIds(bundle, ids, path);
  if (requestedProof && !records.some((record) => record.proofStrength && proofRank(record.proofStrength) >= proofRank(requestedProof))) {
    fail(path, "unsupported_proof_strength", "Claimed proof strength exceeds cited evidence");
  }
  return records;
}

function hasMeaningLicense(record: ReturnType<typeof admittedEvidenceIds>): boolean {
  return record.some((item) => licensesSemanticChessGrounding(effectiveLicensesForRecord(item)));
}

function assertEvidenceSupportsMeaning(bundle: Readonly<AblationEvidenceClosureBundle>, ids: readonly string[], path: string, requestedProof: ProofStrength | null): void {
  const records = assertEvidenceProof(bundle, ids, path, requestedProof);
  if (!hasMeaningLicense(records)) fail(path, "underlicensed_semantic_meaning", "Semantic meaning requires centrally licensed position, bounded-engine, or reviewed-semantic evidence; legality and identity alone are insufficient");
}

function assertEvidenceSupportsRouteMeaning(bundle: Readonly<AblationEvidenceClosureBundle>, ids: readonly string[], path: string): void {
  const records = admittedEvidenceIds(bundle, ids, path);
  if (!records.some((record) => licensesBoundedRouteRelevance(effectiveLicensesForRecord(record)))) {
    fail(path, "underlicensed_route_meaning", "Conditional routes and plans require bounded continuation, comparison, or response-coverage evidence");
  }
}

function assertEvidenceSupportsClaim(bundle: Readonly<AblationEvidenceClosureBundle>, ids: readonly string[], path: string, kind: ReasoningClaimKind, requestedProof: ProofStrength | null): void {
  const records = assertEvidenceProof(bundle, ids, path, requestedProof);
  const licenses = records.flatMap((record) => effectiveLicensesForRecord(record));
  if (kind === "fact" || kind === "uncertainty") {
    if (!licenses.some((license) => license === EVIDENCE_LICENSE.CHESS_LEGALITY || license === EVIDENCE_LICENSE.CHESS_IDENTITY || license === EVIDENCE_LICENSE.CHESS_POSITION_FACT || license.startsWith("engine."))) {
      fail(path, "underlicensed_fact_claim", "Fact claim lacks exact or bounded-engine evidence");
    }
    return;
  }
  if (kind === "interpretation" || kind === "consequence") {
    if (!hasMeaningLicense(records)) fail(path, "underlicensed_semantic_meaning", "Interpretation/consequence claims cannot be grounded only by legality, identity, or bounded comparison score evidence");
    return;
  }
  if (!licenses.includes(EVIDENCE_LICENSE.ENGINE_BOUNDED_RESPONSE_COVERAGE) && !licenses.includes(EVIDENCE_LICENSE.ENGINE_BOUNDED_CONTINUATION)) {
    fail(path, "underlicensed_defense_claim", "Defense claims require bounded response or continuation evidence");
  }
}

type ReferenceAuthority = {
  pieces: Set<string>;
  squares: Set<string>;
  moveIds: Set<string>;
  moves: Map<string, Set<string>>;
};

function referenceAuthority(bundle: Readonly<AblationEvidenceClosureBundle>): ReferenceAuthority {
  const pieces = new Set(bundle.referenceAllowlists.semanticReferences.filter((item) => item.domain === REFERENCE_DOMAINS.PIECE).map((item) => item.id));
  const squares = new Set(bundle.referenceAllowlists.semanticReferences.filter((item) => item.domain === REFERENCE_DOMAINS.SQUARE).map((item) => item.id));
  const moveIds = new Set(bundle.referenceAllowlists.semanticReferences.filter((item) => item.domain === REFERENCE_DOMAINS.MOVE).map((item) => item.id));
  const moves = new Map<string, Set<string>>();
  for (const witness of bundle.referenceAllowlists.moveWitnesses) {
    const key = `${witness.uci}:${witness.pieceId}:${witness.san}`;
    const evidence = moves.get(key) || new Set<string>();
    evidence.add(witness.evidenceId);
    moves.set(key, evidence);
  }
  return { pieces, squares, moveIds, moves };
}

function addClosureReferences(value: unknown, global: ReferenceAuthority, scoped: { pieces: Set<string>; squares: Set<string> }): void {
  if (typeof value === "string") {
    if (global.pieces.has(value)) scoped.pieces.add(value);
    if (global.squares.has(value)) scoped.squares.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => addClosureReferences(item, global, scoped));
    return;
  }
  if (isRecord(value)) Object.values(value).forEach((item) => addClosureReferences(item, global, scoped));
}

function scopedReferenceAuthority(
  bundle: Readonly<AblationEvidenceClosureBundle>,
  evidenceIds: readonly string[],
  semanticParticipants: Array<{ ref: { domain: string; id: string } }> = [],
): ReferenceAuthority {
  const global = referenceAuthority(bundle);
  const pieces = new Set<string>();
  const squares = new Set<string>();
  const moves = new Map<string, Set<string>>();
  const addWitness = (witness: { evidenceId: string; uci: string; pieceId: string; san: string }) => {
    if (!global.moveIds.has(witness.uci)) return;
    const key = `${witness.uci}:${witness.pieceId}:${witness.san}`;
    const sources = moves.get(key) || new Set<string>();
    sources.add(witness.evidenceId);
    moves.set(key, sources);
    if (global.pieces.has(witness.pieceId)) pieces.add(witness.pieceId);
    if (global.squares.has(witness.uci.slice(0, 2))) squares.add(witness.uci.slice(0, 2));
    if (global.squares.has(witness.uci.slice(2, 4))) squares.add(witness.uci.slice(2, 4));
  };
  bundle.referenceAllowlists.moveWitnesses.filter((witness) => witness.uci === bundle.context.moveUci).forEach(addWitness);
  const requested = new Set(evidenceIds);
  for (const record of bundle.evidence) {
    if (!requested.has(record.id)) continue;
    addClosureReferences(record.data, global, { pieces, squares });
    collectReasoningMoveWitnesses([record], bundle.context).forEach(addWitness);
  }
  for (const participant of semanticParticipants) {
    if (participant.ref.domain === REFERENCE_DOMAINS.PIECE && global.pieces.has(participant.ref.id)) pieces.add(participant.ref.id);
    if (participant.ref.domain === REFERENCE_DOMAINS.SQUARE && global.squares.has(participant.ref.id)) squares.add(participant.ref.id);
  }
  return { pieces, squares, moveIds: global.moveIds, moves };
}

function assertTypedParticipantReference(
  reference: { domain: string; id: string },
  evidenceIds: readonly string[],
  authority: ReferenceAuthority,
  path: string,
): void {
  if (reference.domain === REFERENCE_DOMAINS.PIECE) {
    if (!authority.pieces.has(reference.id)) fail(path, "participant_outside_closure", "Piece participant is outside the frozen semantic-reference allowlist", [...authority.pieces]);
    return;
  }
  if (reference.domain === REFERENCE_DOMAINS.SQUARE) {
    if (!authority.squares.has(reference.id)) fail(path, "participant_outside_closure", "Square participant is outside the frozen semantic-reference allowlist", [...authority.squares]);
    return;
  }
  if (reference.domain === REFERENCE_DOMAINS.MOVE) {
    const witnessed = [...authority.moves.entries()].some(([key, evidence]) => key.startsWith(`${reference.id}:`) && [...evidence].some((id) => evidenceIds.includes(id)));
    if (!authority.moveIds.has(reference.id) || !witnessed) fail(path, "participant_move_unwitnessed", "Move participant lacks a typed allowlist entry or cited exact witness in the frozen closure", [...authority.moves.keys()]);
    return;
  }
  fail(path, "participant_outside_closure", "Participant domain is outside the frozen semantic-reference allowlist", [REFERENCE_DOMAINS.PIECE, REFERENCE_DOMAINS.SQUARE, REFERENCE_DOMAINS.MOVE]);
}

function assertHypothesisReferenceAuthority(
  hypothesis: ReasoningHypothesisProposal,
  evidenceIds: readonly string[],
  authority: ReferenceAuthority,
  path: string,
): void {
  hypothesis.participants.forEach((participant, index) => assertTypedParticipantReference(participant.ref, evidenceIds, authority, `${path}.participants[${index}].ref`));
  hypothesis.anchorRequirements.forEach((anchor, index) => assertTypedParticipantReference(anchor.participant.ref, evidenceIds, authority, `${path}.anchorRequirements[${index}].participant.ref`));
}

function hasEvidenceAssociation(itemEvidenceIds: readonly string[], semanticEvidenceIds: readonly string[]): boolean {
  return itemEvidenceIds.some((id) => semanticEvidenceIds.includes(id));
}

function semanticParticipantsForSegments(
  segments: readonly DirectSynthesisSegment[],
  hypothesesByLocalId: ReadonlyMap<string, ReasoningHypothesisProposal>,
  relationsByLocalId: ReadonlyMap<string, DirectSynthesisRelationProposal>,
): Array<{ ref: { domain: string; id: string } }> {
  const participants: Array<{ ref: { domain: string; id: string } }> = [];
  const addHypothesis = (localId: string) => {
    const hypothesis = hypothesesByLocalId.get(localId);
    if (hypothesis) participants.push(...hypothesis.participants);
  };
  for (const segment of segments) {
    if (segment.type === "entity") addHypothesis(segment.entityLocalId);
    if (segment.type === "relation") {
      const relation = relationsByLocalId.get(segment.relationLocalId);
      if (relation) {
        addHypothesis(relation.from);
        addHypothesis(relation.to);
      }
    }
  }
  return participants;
}

function remapSegments(
  segments: readonly DirectSynthesisSegment[],
  path: string,
  evidenceIds: readonly string[],
  authority: ReferenceAuthority,
  localToCanonical: Readonly<Record<string, string>>,
  relationByLocalId: ReadonlyMap<string, ReasoningHypothesisRelationRecord>,
  hypothesisByCanonicalId: ReadonlyMap<string, ReasoningHypothesisRecord>,
  semanticParticipants: Array<{ ref: { domain: string; id: string } }>,
  bundle: Readonly<AblationEvidenceClosureBundle>,
): ReasoningNarrativeSegment[] {
  const itemAuthority = scopedReferenceAuthority(bundle, evidenceIds, semanticParticipants);
  const evidenceSet = new Set(evidenceIds);
  const timeline = createPocIdentityTimeline(bundle.context);
  return segments.map((segment, index): ReasoningNarrativeSegment => {
    const segmentPath = `${path}[${index}]`;
    if (segment.type === "text") return segment;
    if (segment.type === "piece") {
      if (!authority.pieces.has(segment.pieceId) || (!pieceIdentity(timeline.before, segment.pieceId) && !pieceIdentity(timeline.after, segment.pieceId))) {
        fail(segmentPath, "untyped_piece_reference", "Piece reference is not admitted by the frozen closure", [...authority.pieces]);
      }
      if (!itemAuthority.pieces.has(segment.pieceId)) {
        fail(segmentPath, "item_unscoped_piece_reference", "Piece reference is not grounded by this item's target, cited evidence, or typed semantic binding", [...itemAuthority.pieces]);
      }
      return segment;
    }
    if (segment.type === "piece-kind") {
      const type = ({ bishop: "b", king: "k", knight: "n", pawn: "p", queen: "q", rook: "r" } as const)[segment.pieceKind];
      const authorized = [...itemAuthority.pieces].some((pieceId) => {
        const identity = pieceIdentity(timeline.before, pieceId) || pieceIdentity(timeline.after, pieceId);
        return identity?.type === type && (segment.color === null || identity.color === segment.color);
      });
      if (!authorized) fail(segmentPath, "item_unscoped_piece_kind_reference", "Generic piece reference is not grounded by this item's authority", [...itemAuthority.pieces]);
      return segment;
    }
    if (segment.type === "square") {
      if (!SQUARES.includes(segment.square as typeof SQUARES[number]) || !authority.squares.has(segment.square)) {
        fail(segmentPath, "untyped_square_reference", "Square reference is not admitted by the frozen closure", [...authority.squares]);
      }
      if (!itemAuthority.squares.has(segment.square)) {
        fail(segmentPath, "item_unscoped_square_reference", "Square reference is not grounded by this item's target, cited evidence, or typed semantic binding", [...itemAuthority.squares]);
      }
      return segment;
    }
    if (segment.type === "move") {
      const witnesses = itemAuthority.moves.get(`${segment.uci}:${segment.pieceId}:${segment.san}`);
      if (!itemAuthority.moveIds.has(segment.uci) || !witnesses || ![...witnesses].some((id) => evidenceSet.has(id))) {
        fail(segmentPath, "untyped_move_reference", "Move reference lacks an exact cited evidence witness", [...itemAuthority.moves.keys()]);
      }
      return { type: "move", uci: segment.uci, pieceId: segment.pieceId, san: segment.san, ...(segment.label === undefined ? {} : { label: segment.label }) };
    }
    if (segment.type === "entity") {
      const entityId = localToCanonical[segment.entityLocalId];
      if (!entityId) fail(segmentPath, "unknown_local_entity", "Entity local reference is not declared by this proposal");
      const hypothesis = hypothesisByCanonicalId.get(entityId);
      if (!hypothesis || !hasEvidenceAssociation(evidenceIds, hypothesis.evidenceIds)) {
        fail(segmentPath, "unrelated_semantic_evidence", "Entity segment must cite evidence associated with its canonical hypothesis");
      }
      return { type: "entity", entityId, ...(segment.label === undefined ? {} : { label: segment.label }) };
    }
    const relation = relationByLocalId.get(segment.relationLocalId);
    const fromEntityId = localToCanonical[segment.fromEntityLocalId];
    const toEntityId = localToCanonical[segment.toEntityLocalId];
    if (!relation || !fromEntityId || !toEntityId) fail(segmentPath, "dangling_local_relation", "Relation local reference is not declared by this proposal");
    if (relation.fromHypothesisId !== fromEntityId || relation.toHypothesisId !== toEntityId) {
      fail(segmentPath, "relation_endpoint_mismatch", "Relation segment endpoints do not match the canonical relation");
    }
    if (!hasEvidenceAssociation(evidenceIds, relation.evidenceIds)) {
      fail(segmentPath, "unrelated_semantic_evidence", "Relation segment must cite evidence associated with its canonical relation");
    }
    return { type: "relation", relationId: relation.id, fromEntityId, toEntityId, ...(segment.label === undefined ? {} : { label: segment.label }) };
  });
}

function validateVariation(
  demonstration: Extract<DirectSynthesisDemonstration, { type: "legal-variation" }>,
  bundle: Readonly<AblationEvidenceClosureBundle>,
  path: string,
): void {
  const citedEvidence = new Set(demonstration.evidenceIds);
  const witnesses = collectReasoningMoveWitnesses(
    bundle.evidence.filter((record) => citedEvidence.has(record.id)),
    bundle.context,
  );
  const submitted = demonstration.moves.map((move) => `${move.uci}:${move.pieceId}:${move.san}`);
  for (const key of submitted) if (!witnesses.some((witness) => `${witness.uci}:${witness.pieceId}:${witness.san}` === key)) {
    fail(path, "variation_witness_missing", "Variation move lacks an exact cited evidence witness");
  }
  const starts = bundle.evidence.filter((record) => citedEvidence.has(record.id)).flatMap((record) => {
    const replay = record.replay;
    if (!replay) return [];
    const start = replay.fen === bundle.context.fenBefore ? "before" : replay.fen === bundle.context.fenAfter ? "after" : null;
    const moves = Array.isArray(replay.movesUci) ? replay.movesUci : Array.isArray(replay.moves) ? replay.moves : Array.isArray(replay.line) ? replay.line : typeof replay.move === "string" ? [replay.move] : [];
    return start && moves.every((move) => typeof move === "string") ? [{ start, moves }] : [];
  });
  const submittedUci = demonstration.moves.map((move) => move.uci);
  if (!starts.some((candidate) => candidate.start === demonstration.start && submittedUci.every((move, index) => candidate.moves[index] === move))) {
    fail(path, "variation_sequence_not_grounded", "Variation must be an exact prefix of one cited replayable evidence line");
  }
}

function assertCoverageEvidence(bundle: Readonly<AblationEvidenceClosureBundle>, coverage: DirectSynthesisCoverage): void {
  for (const [path, lane] of [["responseCoverage", coverage.responseCoverage], ["continuationCoverage", coverage.continuationCoverage]] as const) {
    admittedEvidenceIds(bundle, lane.evidenceIds, `proposal.coverage.${path}.evidenceIds`);
  }
}

function validateAndMaterializeCoverage(
  coverage: DirectSynthesisCoverage,
  records: readonly ReasoningHypothesisRecord[],
  relations: readonly ReasoningHypothesisRelationRecord[],
  localToCanonical: Readonly<Record<string, string>>,
  relationByLocalId: ReadonlyMap<string, ReasoningHypothesisRelationRecord>,
  claims: readonly CanonicalDirectSynthesisClaim[],
  demonstrations: readonly CanonicalDirectSynthesisDemonstration[],
): DirectSynthesisArtifact["coverage"] {
  const omittedHypotheses = coverage.omittedHypotheses.map((item) => {
    const hypothesisId = localToCanonical[item.localId];
    if (!hypothesisId) fail("proposal.coverage.omittedHypotheses", "unknown_omitted_hypothesis", "Omitted hypothesis does not name a local hypothesis");
    return { hypothesisId, reason: item.reason };
  });
  const omittedRelations = coverage.omittedRelations.map((item) => {
    const relation = relationByLocalId.get(item.localId);
    if (!relation) fail("proposal.coverage.omittedRelations", "unknown_omitted_relation", "Omitted relation does not name a local relation");
    return { relationId: relation.id, reason: item.reason };
  });
  const presentedHypothesisIds = new Set<string>();
  const presentedRelationIds = new Set<string>();
  const visitSegments = (segments: readonly ReasoningNarrativeSegment[]) => {
    for (const segment of segments) {
      if (segment.type === "entity") presentedHypothesisIds.add(segment.entityId);
      if (segment.type === "relation") {
        presentedRelationIds.add(segment.relationId);
        presentedHypothesisIds.add(segment.fromEntityId);
        presentedHypothesisIds.add(segment.toEntityId);
      }
    }
  };
  claims.forEach((claim) => { visitSegments(claim.content); claim.qualifications.forEach(visitSegments); });
  demonstrations.forEach((demonstration) => {
    if (demonstration.type === "conditional-route") visitSegments(demonstration.prerequisiteRefs);
    if (demonstration.type === "static-relationship") {
      presentedRelationIds.add(demonstration.relationId);
      presentedHypothesisIds.add(demonstration.fromEntityId);
      presentedHypothesisIds.add(demonstration.toEntityId);
    }
  });
  const omittedHypothesisIds = new Set(omittedHypotheses.map((item) => item.hypothesisId));
  const omittedRelationIds = new Set(omittedRelations.map((item) => item.relationId));
  for (const record of records) {
    if (!presentedHypothesisIds.has(record.id) && !omittedHypothesisIds.has(record.id)) {
      fail("proposal.coverage.omittedHypotheses", "uncommunicated_hypothesis", "Every emitted hypothesis must be typed-presented or explicitly omitted");
    }
    if (presentedHypothesisIds.has(record.id) && omittedHypothesisIds.has(record.id)) {
      fail("proposal.coverage.omittedHypotheses", "presented_and_omitted_hypothesis", "A hypothesis cannot be both presented and omitted");
    }
  }
  for (const relation of relations) {
    if (!presentedRelationIds.has(relation.id) && !omittedRelationIds.has(relation.id)) {
      fail("proposal.coverage.omittedRelations", "uncommunicated_relation", "Every emitted relation must be typed-presented or explicitly omitted");
    }
    if (presentedRelationIds.has(relation.id) && omittedRelationIds.has(relation.id)) {
      fail("proposal.coverage.omittedRelations", "presented_and_omitted_relation", "A relation cannot be both presented and omitted");
    }
  }
  return {
    responseCoverage: { ...coverage.responseCoverage, evidenceIds: [...coverage.responseCoverage.evidenceIds], unresolved: [...coverage.responseCoverage.unresolved] },
    continuationCoverage: { ...coverage.continuationCoverage, evidenceIds: [...coverage.continuationCoverage.evidenceIds], unresolved: [...coverage.continuationCoverage.unresolved] },
    unresolvedEvidenceObligations: coverage.unresolvedEvidenceObligations.map((item) => ({ ...item })),
    omittedHypothesisIds: omittedHypotheses,
    omittedRelationIds: omittedRelations,
  };
}

/**
 * Deterministically validates and materializes a direct A1/B/B-prime result.
 * It returns a typed failure instead of narrowing, repairing, or inventing
 * chess meaning.
 */
export function materializeDirectSynthesis(input: MaterializeDirectSynthesisInput): DirectSynthesisMaterializationResult {
  const metadata = { arm: input.arm };
  try {
    if (input.arm !== "A1" && input.arm !== "B" && input.arm !== "B-prime") fail("arm", "invalid_arm", "Direct synthesis arm is invalid");
    validateAblationEvidenceClosureBundle(input.bundle);
    // The supplied bundle remains the immutable audit closure. Every direct
    // proposal is admitted against its model-facing projection, so a hidden
    // fact/observation cannot be cited just because it exists for evaluation.
    const sourceBundleHash = input.bundle.bundleHash;
    input = { ...input, bundle: projectAblationEvidenceForModel(input.bundle).bundle };
    const proposal = parseDirectSynthesisProposal(input.proposal);
    assertDistinctLocalIds(proposal);
    const authority = referenceAuthority(input.bundle);
    assertCoverageEvidence(input.bundle, proposal.coverage);
    const hypothesisIds = new Set(proposal.hypotheses.map((item) => item.localId));
    for (const [index, relation] of proposal.relations.entries()) {
      if (!hypothesisIds.has(relation.from) || !hypothesisIds.has(relation.to)) fail(`proposal.relations[${index}]`, "dangling_local_relation", "Relation endpoint does not name a local hypothesis");
      assertEvidenceSupportsMeaning(input.bundle, relation.evidenceIds, `proposal.relations[${index}].evidenceIds`, null);
    }
    for (const [index, hypothesis] of proposal.hypotheses.entries()) {
      assertEvidenceSupportsMeaning(input.bundle, hypothesis.evidenceIds, `proposal.hypotheses[${index}].evidenceIds`, hypothesis.proofStrength);
      if (hypothesis.entityType === "plan") assertEvidenceSupportsRouteMeaning(input.bundle, hypothesis.evidenceIds, `proposal.hypotheses[${index}].evidenceIds`);
      assertHypothesisReferenceAuthority(
        hypothesis,
        hypothesis.evidenceIds,
        scopedReferenceAuthority(input.bundle, hypothesis.evidenceIds),
        `proposal.hypotheses[${index}]`,
      );
      for (const observationId of hypothesis.sourceObservationIds) {
        if (!input.bundle.referenceAllowlists.observationIds.includes(observationId)) fail(`proposal.hypotheses[${index}].sourceObservationIds`, "unknown_observation", "Source observation is outside the frozen closure");
      }
    }
    const observations = {
      schemaVersion: input.bundle.observations[0]?.schemaVersion || "conceptual-explanation-poc/57",
      contextHash: input.bundle.contextHash,
      observations: input.bundle.observations.map((observation) => ({ ...observation, salience: 1, salienceReasons: ["frozen-ablation-closure"], presentedToModel: true })),
      evidence: input.bundle.evidence,
      providers: [], limitations: [...input.bundle.coverage.limitations], saliencePolicy: "ablation-direct-frozen-closure/1",
    };
    const ledger = new HypothesisLedger(
      input.bundle.contextHash,
      observations,
      new Map(input.bundle.evidence.map((record) => [record.id, record])),
      proposal.hypotheses.length,
      input.bundle.context,
    );
    const recorded = ledger.record(
      {
        hypotheses: proposal.hypotheses,
        relations: proposal.relations.map((relation) => {
          const withoutLocalId = { ...relation };
          Reflect.deleteProperty(withoutLocalId, "localId");
          return withoutLocalId;
        }),
      },
      input.provenance || { provider: "knights-eye/ablation-direct", version: ABLATION_DIRECT_SYNTHESIS_VERSION, origin: "model" },
    );
    const evidenceById = new Map(input.bundle.evidence.map((record) => [record.id, record]));
    const observationById = new Map(input.bundle.observations.map((observation) => [observation.id, observation]));
    for (const [index, record] of recorded.records.entries()) {
      const policyIssues = validateHypothesisAcceptancePolicies(record, evidenceById);
      if (policyIssues.length) fail(`proposal.hypotheses[${index}]`, "acceptance_policy_rejected", "Direct hypothesis fails a registered production acceptance policy");
      const usesConditionalRouteAffordance = record.sourceObservationIds.some((id) => observationById.get(id)?.observationType === "conditional-route-affordance");
      if (usesConditionalRouteAffordance && !record.evidenceIds.some((id) => {
        const evidence = evidenceById.get(id);
        return Boolean(evidence && licensesBoundedRouteRelevance(effectiveLicensesForRecord(evidence)));
      })) {
        fail(`proposal.hypotheses[${index}].evidenceIds`, "underlicensed_route_meaning", "Hypotheses sourced from conditional-route affordances require separate bounded route-relevance evidence");
      }
    }
    const relationByLocalId = new Map(proposal.relations.map((relation, index) => [relation.localId, recorded.relations[index]] as const));
    const hypothesisByCanonicalId = new Map(recorded.records.map((record) => [record.id, record]));
    const hypothesesByLocalId = new Map(proposal.hypotheses.map((hypothesis) => [hypothesis.localId, hypothesis]));
    const relationsByLocalId = new Map(proposal.relations.map((relation) => [relation.localId, relation]));
    const claimIds = new Set<string>();
    const claims = proposal.claims.map((claim, index): CanonicalDirectSynthesisClaim => {
      if (claimIds.has(claim.localId)) fail(`proposal.claims[${index}].localId`, "duplicate_local_id", "Claim local ID is duplicated");
      claimIds.add(claim.localId);
      assertEvidenceSupportsClaim(input.bundle, claim.evidenceIds, `proposal.claims[${index}].evidenceIds`, claim.kind, claim.proofStrength);
      const semanticParticipants = semanticParticipantsForSegments([...claim.content, ...claim.qualifications.flat()], hypothesesByLocalId, relationsByLocalId);
      const content = remapSegments(claim.content, `proposal.claims[${index}].content`, claim.evidenceIds, authority, recorded.localToHypothesisIds, relationByLocalId, hypothesisByCanonicalId, semanticParticipants, input.bundle);
      const qualifications = claim.qualifications.map((segments, qualificationIndex) => remapSegments(segments, `proposal.claims[${index}].qualifications[${qualificationIndex}]`, claim.evidenceIds, authority, recorded.localToHypothesisIds, relationByLocalId, hypothesisByCanonicalId, semanticParticipants, input.bundle));
      return { id: `direct-claim:${stableHash({ contextHash: input.bundle.contextHash, kind: claim.kind, content, evidenceIds: claim.evidenceIds, qualifications })}`, kind: claim.kind, content, proofStrength: claim.proofStrength, evidenceIds: [...claim.evidenceIds], qualifications };
    });
    const demonstrationIds = new Set<string>();
    const demonstrations = (proposal.demonstrations || []).map((demonstration, index): CanonicalDirectSynthesisDemonstration => {
      if (demonstrationIds.has(demonstration.localId)) fail(`proposal.demonstrations[${index}].localId`, "duplicate_local_id", "Demonstration local ID is duplicated");
      demonstrationIds.add(demonstration.localId);
      if (demonstration.type === "legal-variation") {
        admittedEvidenceIds(input.bundle, demonstration.evidenceIds, `proposal.demonstrations[${index}].evidenceIds`);
        validateVariation(demonstration, input.bundle, `proposal.demonstrations[${index}].moves`);
        return { id: `direct-demonstration:${stableHash({ contextHash: input.bundle.contextHash, type: demonstration.type, start: demonstration.start, moves: demonstration.moves, evidenceIds: demonstration.evidenceIds })}`, type: demonstration.type, start: demonstration.start, moves: demonstration.moves.map((move) => ({ ...move })), label: demonstration.label, evidenceIds: [...demonstration.evidenceIds] };
      }
      if (demonstration.type === "static-relationship") {
        assertEvidenceSupportsMeaning(input.bundle, demonstration.evidenceIds, `proposal.demonstrations[${index}].evidenceIds`, null);
        const relation = relationByLocalId.get(demonstration.relationLocalId);
        const fromEntityId = recorded.localToHypothesisIds[demonstration.fromEntityLocalId];
        const toEntityId = recorded.localToHypothesisIds[demonstration.toEntityLocalId];
        if (!relation || !fromEntityId || !toEntityId) fail(`proposal.demonstrations[${index}]`, "dangling_local_relation", "Static relationship does not name direct local records");
        if (relation.fromHypothesisId !== fromEntityId || relation.toHypothesisId !== toEntityId) fail(`proposal.demonstrations[${index}]`, "relation_endpoint_mismatch", "Static relationship endpoints do not match the canonical relation");
        if (!hasEvidenceAssociation(demonstration.evidenceIds, relation.evidenceIds)) fail(`proposal.demonstrations[${index}].evidenceIds`, "unrelated_semantic_evidence", "Static relationship must cite evidence associated with its canonical relation");
        return { id: `direct-demonstration:${stableHash({ contextHash: input.bundle.contextHash, type: demonstration.type, relationId: relation.id, fromEntityId, toEntityId, evidenceIds: demonstration.evidenceIds })}`, type: demonstration.type, relationId: relation.id, fromEntityId, toEntityId, relationType: relation.relationType, label: demonstration.label, evidenceIds: [...demonstration.evidenceIds] };
      }
      assertEvidenceSupportsRouteMeaning(input.bundle, demonstration.evidenceIds, `proposal.demonstrations[${index}].evidenceIds`);
      const routeAuthority = scopedReferenceAuthority(input.bundle, demonstration.evidenceIds, semanticParticipantsForSegments(demonstration.prerequisiteRefs, hypothesesByLocalId, relationsByLocalId));
      if (!routeAuthority.pieces.has(demonstration.pieceId) || demonstration.waypoints.some((square) => !routeAuthority.squares.has(square))) {
        fail(`proposal.demonstrations[${index}]`, "untyped_route_reference", "Route references are outside the frozen closure");
      }
      const prerequisiteRefs = remapSegments(demonstration.prerequisiteRefs, `proposal.demonstrations[${index}].prerequisiteRefs`, demonstration.evidenceIds, authority, recorded.localToHypothesisIds, relationByLocalId, hypothesisByCanonicalId, semanticParticipantsForSegments(demonstration.prerequisiteRefs, hypothesesByLocalId, relationsByLocalId), input.bundle);
      return { id: `direct-demonstration:${stableHash({ contextHash: input.bundle.contextHash, type: demonstration.type, pieceId: demonstration.pieceId, waypoints: demonstration.waypoints, prerequisiteRefs, evidenceIds: demonstration.evidenceIds })}`, type: demonstration.type, pieceId: demonstration.pieceId, waypoints: [...demonstration.waypoints], prerequisiteRefs, label: demonstration.label, evidenceIds: [...demonstration.evidenceIds] };
    });
    const coverage = validateAndMaterializeCoverage(proposal.coverage, recorded.records, recorded.relations, recorded.localToHypothesisIds, relationByLocalId, claims, demonstrations);
    return {
      ok: true,
      metadata,
      artifact: {
        schemaVersion: ABLATION_DIRECT_SYNTHESIS_VERSION,
        contextHash: input.bundle.contextHash,
        bundleHash: sourceBundleHash,
        hypotheses: recorded.records.map((record) => {
          const withoutLocalId = { ...record };
          Reflect.deleteProperty(withoutLocalId, "localId");
          return withoutLocalId;
        }),
        relations: recorded.relations,
        claims,
        demonstrations,
        coverage,
        admission: "pre-checkpoint-proposed",
        productSupport: "not-a-validated-graph-checkpoint-or-product-result",
        limitations: [...proposal.limitations],
        riskProfile: { level: proposal.riskProfile.level, reasons: [...proposal.riskProfile.reasons] },
      },
    };
  } catch (error) {
    const issue = error instanceof AdmissionFailure
      ? error.issue
      : { path: "proposal", code: "production_admission_failure", message: "Direct synthesis failed production admission", permittedReferences: [] };
    return { ok: false, metadata, code: "direct-synthesis-rejected", issues: [issue] };
  }
}
