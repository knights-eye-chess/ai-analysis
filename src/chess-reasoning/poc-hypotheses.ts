import { DEFAULT_CONCEPT_REGISTRY, PARTICIPANT_ROLES, REFERENCE_DOMAINS, type ConceptRegistry } from "./concept-registry";
import {
  REASONING_POC_VERSION,
  type ReasoningEvidenceRecord,
  type ReasoningHypothesisDecision,
  type ReasoningHypothesisProposal,
  type ReasoningHypothesisRecord,
  type ReasoningHypothesisProvenance,
  type ReasoningHypothesisRelationRecord,
  type ReasoningPositionContext,
  type ReasoningRankedObservationSet,
  type ReasoningToolDescriptor,
} from "./poc-contracts";
import { collectReasoningMoveWitnesses, reasoningEvidenceReplayStartPhase } from "./poc-move-witnesses";
import { createPocIdentityTimeline, squareForPiece } from "./poc-piece-refs";
import { stableHash } from "./stable";
import { effectiveLicensesForRecord, licensesBoundedRouteRelevance, licensesSemanticChessGrounding, withEvidenceLicenses } from "./evidence-licenses";
import type { ProofStrength, SemanticAttributes, SemanticParticipant, SemanticValue } from "./types";

const PROOF_RANK: Record<ProofStrength, number> = {
  observed: 1,
  supported: 2,
  forced: 3,
};

function isRouteRelevanceEvidence(record: ReasoningEvidenceRecord | undefined): boolean {
  return Boolean(record
    && record.proofStrength !== null
    && licensesBoundedRouteRelevance(effectiveLicensesForRecord(record)));
}

function hasEvidenceForProofStrength(
  record: Pick<ReasoningHypothesisRecord, "evidenceIds" | "proofStrength">,
  evidence: Map<string, ReasoningEvidenceRecord>,
): boolean {
  return record.proofStrength === null || record.evidenceIds.some((id) => {
    const strength = evidence.get(id)?.proofStrength;
    return Boolean(strength && PROOF_RANK[strength] >= PROOF_RANK[record.proofStrength!]);
  });
}

export const RECORD_HYPOTHESES_DESCRIPTOR: ReasoningToolDescriptor = {
  name: "record_hypotheses",
  category: "graph",
  description: "Record model-originated semantic hypotheses and causal relations in the provisional Hypothesis Ledger. Hypotheses may cite observations or be novel with zero source observations; novel concrete claims still need evidence before acceptance. parentHypothesisIds means refinement lineage only, never causal order: normally use [] and express enables/supports/explains order in relations. A true refinement may name an earlier ledger ID or same-batch localId and must preserve parent owner/concepts/anchors or include explicit refinementReason and removedAnchorReasons attributes.",
  inputSchema: {
    type: "object",
    required: ["hypotheses", "relations"],
    properties: {
      hypotheses: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        items: {
          type: "object",
          required: ["localId", "entityType", "concepts", "owner", "participants", "attributes", "proofStrength", "evidenceIds", "sourceObservationIds", "parentHypothesisIds", "anchorRequirements"],
          properties: {
            localId: { type: "string", maxLength: 160 },
            entityType: { type: "string", maxLength: 160 },
            concepts: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", maxLength: 160 } },
            owner: { type: ["string", "null"], enum: ["w", "b", null] },
            participants: participantArraySchema(12),
            attributes: { type: "object", maxProperties: 24, propertyNames: { type: "string", minLength: 1, maxLength: 80 }, additionalProperties: true },
            proofStrength: { type: ["string", "null"], enum: ["observed", "supported", "forced", null] },
            evidenceIds: { type: "array", maxItems: 12, items: { type: "string", maxLength: 200 } },
            sourceObservationIds: { type: "array", maxItems: 12, items: { type: "string", maxLength: 200 } },
            parentHypothesisIds: { type: "array", maxItems: 8, description: "Refinement lineage only, not causal order. Usually []. True refinements may use existing hypothesis IDs or same-batch localIds and must satisfy refinement compatibility.", items: { type: "string", maxLength: 200 } },
            anchorRequirements: {
              type: "array",
              maxItems: 12,
              items: {
                type: "object",
                required: ["participant", "disposition"],
                properties: { participant: participantSchema(), disposition: { type: "string", enum: ["required"] } },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      relations: {
        type: "array",
        maxItems: 24,
        items: {
          type: "object",
          required: ["relationType", "from", "to", "attributes", "evidenceIds", "sourceObservationIds"],
          properties: {
            relationType: { type: "string", maxLength: 160 },
            from: { type: "string", maxLength: 200 },
            to: { type: "string", maxLength: 200 },
            attributes: { type: "object", maxProperties: 24, propertyNames: { type: "string", minLength: 1, maxLength: 80 }, additionalProperties: true },
            evidenceIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", maxLength: 200 } },
            sourceObservationIds: { type: "array", maxItems: 12, items: { type: "string", maxLength: 200 } },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

export const REVIEW_HYPOTHESES_DESCRIPTOR: ReasoningToolDescriptor = {
  name: "review_hypotheses",
  category: "graph",
  description: "Record terminal acceptance, rejection, or supersession for model-created hypotheses, or temporarily mark a hypothesis needs-probe. Resolve every independent critic finding explicitly; a later good hypothesis cannot make an objection to an earlier hypothesis disappear. A finding resolution must agree with the hypothesis decision and exact supersession targets. Evidence cited on rejected, superseded, or safe-to-omit resolutions is audit context only and never strengthens the discarded or optional hypothesis. Reject paraphrase duplicates covered by another source-linked record while keeping every used observation linked to at least one accepted hypothesis. Accepted means admissible, not required in the answer. A terminal batch that would orphan a used observation is rejected atomically and may be corrected once. Every recorded hypothesis and critic finding must be terminal before explain_plan.",
  inputSchema: {
    type: "object",
    required: ["decisions", "criticFindingResolutions"],
    properties: {
      decisions: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        items: {
          type: "object",
          required: ["hypothesisId", "disposition", "rationale", "supersededBy"],
          properties: {
            hypothesisId: { type: "string", maxLength: 200 },
            disposition: { type: "string", enum: ["accept", "reject", "needs-probe", "supersede"] },
            rationale: { type: "string", minLength: 1, maxLength: 500 },
            supersededBy: { type: "array", maxItems: 8, items: { type: "string", maxLength: 200 } },
          },
          additionalProperties: false,
        },
      },
      criticFindingResolutions: {
        type: "array",
        maxItems: 16,
        items: {
          type: "object",
          required: ["findingId", "hypothesisId", "disposition", "rationale", "evidenceIds", "supersededBy", "resolvedByHypothesisIds"],
          properties: {
            findingId: { type: "string", maxLength: 200 },
            hypothesisId: { type: "string", maxLength: 200 },
            disposition: { type: "string", enum: ["rejected", "superseded", "retained-with-new-evidence", "retained-safe-to-omit", "resolved-by-associated-hypotheses", "resolved-existing-evidence"] },
            rationale: { type: "string", minLength: 1, maxLength: 800 },
            evidenceIds: { type: "array", maxItems: 12, items: { type: "string", maxLength: 200 } },
            supersededBy: { type: "array", maxItems: 8, items: { type: "string", maxLength: 200 } },
            resolvedByHypothesisIds: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", maxLength: 200 } },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

export const EXPLAIN_PLAN_SELECTION_DESCRIPTOR: ReasoningToolDescriptor = {
  name: "explain_plan",
  category: "graph",
  description: "Materialize only accepted Hypothesis Ledger records and select a bounded explanation graph with one connected primary chain plus any required side components. Pass ledger IDs, not a second copy of semantic entities.",
  inputSchema: {
    type: "object",
    required: ["hypothesisIds", "relationIds", "startHypothesisId", "goalHypothesisId"],
    properties: {
      hypothesisIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", maxLength: 200 } },
      relationIds: { type: "array", maxItems: 20, items: { type: "string", maxLength: 200 } },
      startHypothesisId: { type: "string", maxLength: 200 },
      goalHypothesisId: { type: "string", maxLength: 200 },
      requiredHypothesisIds: { type: "array", maxItems: 10, items: { type: "string", maxLength: 200 } },
      maxEntities: { type: "integer", minimum: 1, maximum: 12 },
    },
    additionalProperties: false,
  },
};

function participantSchema() {
  return {
    type: "object",
    required: ["role", "ref"],
    properties: {
      role: { type: "string", maxLength: 160 },
      ref: {
        type: "object",
        required: ["domain", "id"],
        properties: { domain: { type: "string", maxLength: 160 }, id: { type: "string", maxLength: 200 } },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}

function participantArraySchema(maxItems: number) {
  return { type: "array", maxItems, items: participantSchema() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}

function strings(value: unknown, label: string, max: number, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > max) throw new Error(`${label} has an invalid number of values`);
  return [...new Set(value.map((item, index) => boundedString(item, `${label}[${index}]`)))];
}

const FORBIDDEN_KEYS = new Set(["isFork", "isSkewer", "isMainLine"]);

function semanticValue(value: unknown, label: string, depth = 0): SemanticValue {
  if (depth > 5) throw new Error(`${label} exceeds the semantic-value depth limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 24) throw new Error(`${label} exceeds the semantic-value item limit`);
    return value.map((item, index) => semanticValue(item, `${label}[${index}]`, depth + 1));
  }
  if (!isRecord(value)) throw new Error(`${label} is not a JSON semantic value`);
  if (Object.keys(value).length > 24) throw new Error(`${label} exceeds the semantic-value field limit`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${key} must be a registry value, not a semantic flag`);
    return [boundedString(key, `${label} key`, 80), semanticValue(item, `${label}.${key}`, depth + 1)];
  }));
}

function attributes(value: unknown, label: string): SemanticAttributes {
  if (value == null) return {};
  const parsed = semanticValue(value, label);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} must be an object`);
  return parsed;
}

function participantValue(value: unknown, label: string): SemanticParticipant {
  if (!isRecord(value) || !isRecord(value.ref)) throw new Error(`${label} is malformed`);
  return { role: boundedString(value.role, `${label}.role`, 160), ref: { domain: boundedString(value.ref.domain, `${label}.ref.domain`, 160), id: boundedString(value.ref.id, `${label}.ref.id`, 200) } };
}

function participantValues(value: unknown, label: string): SemanticParticipant[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${label} must contain at most 12 participants`);
  return value.map((item, index) => participantValue(item, `${label}[${index}]`));
}

function proof(value: unknown): ProofStrength | null {
  if (value == null) return null;
  if (value === "observed" || value === "supported" || value === "forced") return value;
  throw new Error("proofStrength must be observed, supported, forced, or null");
}

function participantKey(value: SemanticParticipant): string {
  return `${value.role}:${value.ref.domain}:${value.ref.id}`;
}

type ConceptAcceptanceValidator = (
  hypothesis: ReasoningHypothesisRecord,
  records: ReasoningEvidenceRecord[],
) => string[];

const CONCEPT_ACCEPTANCE_VALIDATORS: Readonly<Record<string, ConceptAcceptanceValidator>> = Object.freeze({
  "material-offer-liability/1": (hypothesis, records) => {
    const contradictedCapture = records.find((record) => {
      if (record.kind !== "fact" || record.data.kind !== "move.legal_recaptures_after") return false;
      const data = isRecord(record.data.data) ? record.data.data : null;
      return data?.targetPieceColor === hypothesis.owner
        && data.allCapturesLoseAfterImmediateSameSquareRecapture === true;
    });
    const contradictedData = contradictedCapture && isRecord(contradictedCapture.data.data)
      ? contradictedCapture.data.data
      : null;
    const captureMoves = Array.isArray(contradictedData?.moves)
      ? contradictedData.moves.flatMap((move) => isRecord(move) && typeof move.uci === "string" ? [move.uci] : [])
      : [];
    const strongerBoundedEvidence = captureMoves.length > 0 && records.some((record) => {
      if (record.kind !== "probe" || (record.proofStrength !== "supported" && record.proofStrength !== "forced")) return false;
      const roots = Array.isArray(record.data.rootMoves) ? record.data.rootMoves.filter((move): move is string => typeof move === "string") : [];
      return captureMoves.every((move) => roots.includes(move));
    });
    return contradictedCapture && !strongerBoundedEvidence
      ? [`Hypothesis ${hypothesis.id} calls the owner's moved piece a material offer even though cited exhaustive immediate-capture evidence shows every capture can be answered on the same square with a negative nominal balance delta for the capturing side (${contradictedCapture.id})`]
      : [];
  },
});

/**
 * Pure policy-only validation shared by every semantic admission boundary.
 * It does not alter Ledger status, review provenance, or hypothesis meaning.
 */
export function validateHypothesisAcceptancePolicies(
  hypothesis: ReasoningHypothesisRecord,
  evidence: Map<string, ReasoningEvidenceRecord>,
  registry: ConceptRegistry = DEFAULT_CONCEPT_REGISTRY,
): string[] {
  const records = hypothesis.evidenceIds.map((id) => evidence.get(id)).filter((record): record is ReasoningEvidenceRecord => Boolean(record));
  return hypothesis.concepts.flatMap((concept) => {
    const policy = registry[concept]?.acceptancePolicy;
    if (!policy) return [];
    const validator = CONCEPT_ACCEPTANCE_VALIDATORS[policy];
    return validator
      ? validator(hypothesis, records)
      : [`Hypothesis ${hypothesis.id} uses concept ${concept} with unavailable acceptance policy ${policy}`];
  });
}

export type ExplainPlanSelection = {
  hypothesisIds: string[];
  relationIds: string[];
  startHypothesisId: string;
  goalHypothesisId: string;
  requiredHypothesisIds: string[];
  maxEntities: number;
};

export type InternalExplainPlanRequest = {
  hypothesisLedgerRevision: string;
  hypotheses: {
    entities: Array<ReasoningHypothesisProposal & { hypothesisId: string }>;
    relations: Array<{
      relationType: string;
      from: string;
      to: string;
      attributes: SemanticAttributes;
      evidenceIds: string[];
      hypothesisRelationId: string;
    }>;
  };
  startEntityId: string;
  goalEntityId: string;
  requiredEntityIds: string[];
  maxEntities: number;
};

export class HypothesisLedger {
  private readonly records = new Map<string, ReasoningHypothesisRecord>();
  private readonly relations = new Map<string, ReasoningHypothesisRelationRecord>();
  private readonly observations: ReasoningRankedObservationSet;

  constructor(
    private readonly contextHash: string,
    observations: ReasoningRankedObservationSet,
    private readonly evidence: Map<string, ReasoningEvidenceRecord>,
    private readonly maxHypotheses: number,
    private readonly context?: ReasoningPositionContext,
    private readonly registry: ConceptRegistry = DEFAULT_CONCEPT_REGISTRY,
  ) {
    this.observations = observations;
  }

  allRecords(): ReasoningHypothesisRecord[] {
    return [...this.records.values()].map((record) => ({ ...record, participants: record.participants.map((item) => ({ ...item, ref: { ...item.ref } })) }));
  }

  allRelations(): ReasoningHypothesisRelationRecord[] {
    return [...this.relations.values()].map((record) => ({ ...record }));
  }

  proposalRevision(): string {
    const records = [...this.records.values()].map(({ status: _status, review: _review, evidenceIds: _evidenceIds, ...record }) => {
      void _status;
      void _review;
      // Terminal review may attach evidence that resolves a critic finding.
      // Observation dispositions describe which semantic proposals they map
      // to, so strengthening an otherwise unchanged proposal must not make
      // those dispositions stale. Membership/meaning changes still change
      // this revision because proposal IDs and every semantic field remain.
      void _evidenceIds;
      return record;
    });
    return stableHash({ records, relations: [...this.relations.values()] });
  }

  finalRevision(): string {
    return stableHash({ records: [...this.records.values()], relations: [...this.relations.values()] });
  }

  record(
    value: unknown,
    provenance: ReasoningHypothesisProvenance = {
      provider: "knights-eye/model-runtime",
      version: "unversioned",
      origin: "model",
    },
  ): { records: ReasoningHypothesisRecord[]; relations: ReasoningHypothesisRelationRecord[]; localToHypothesisIds: Record<string, string> } {
    if (!isRecord(value) || !Array.isArray(value.hypotheses) || !Array.isArray(value.relations)) throw new Error("record_hypotheses requires hypotheses and relations arrays");
    if (!value.hypotheses.length) throw new Error("record_hypotheses cannot record an empty hypothesis batch");
    if (value.hypotheses.length + this.records.size > this.maxHypotheses) throw new Error("Hypothesis Ledger budget exhausted");
    const observationById = new Map(this.observations.observations.map((item) => [item.id, item]));
    const proposals: ReasoningHypothesisProposal[] = value.hypotheses.map((item, index) => {
      if (!isRecord(item)) throw new Error(`hypotheses[${index}] is malformed`);
      const owner = item.owner == null ? null : item.owner;
      if (owner !== null && owner !== "w" && owner !== "b") throw new Error(`hypotheses[${index}].owner must be w, b, or null`);
      const concepts = strings(item.concepts, `hypotheses[${index}].concepts`, 4, false);
      for (const concept of concepts) if (!this.registry[concept]) throw new Error(`Unknown concept key: ${concept}`);
      const sourceObservationIds = strings(item.sourceObservationIds, `hypotheses[${index}].sourceObservationIds`, 12);
      for (const id of sourceObservationIds) {
        const observation = observationById.get(id);
        if (!observation) throw new Error(`Unknown source observation: ${id}`);
        if (!observation.presentedToModel) throw new Error(`Observation was not presented to the model: ${id}`);
      }
      const evidenceIds = strings(item.evidenceIds, `hypotheses[${index}].evidenceIds`, 12);
      for (const id of evidenceIds) if (!this.evidence.has(id)) throw new Error(`Hypothesis references missing or stale evidence: ${id}`);
      const parentHypothesisIds = strings(item.parentHypothesisIds, `hypotheses[${index}].parentHypothesisIds`, 8);
      const participants = participantValues(item.participants, `hypotheses[${index}].participants`);
      if (!Array.isArray(item.anchorRequirements) || item.anchorRequirements.length > 12) throw new Error(`hypotheses[${index}].anchorRequirements is invalid`);
      const anchorRequirements = item.anchorRequirements.map((anchor, anchorIndex) => {
        if (!isRecord(anchor) || anchor.disposition !== "required") throw new Error(`hypotheses[${index}].anchorRequirements[${anchorIndex}] is malformed`);
        const required = participantValue(anchor.participant, `hypotheses[${index}].anchorRequirements[${anchorIndex}].participant`);
        if (!participants.some((participant) => participantKey(participant) === participantKey(required))) throw new Error(`Required realization anchor is absent from hypothesis ${String(item.localId)}`);
        return { participant: required, disposition: "required" as const };
      });
      return {
        localId: boundedString(item.localId, `hypotheses[${index}].localId`, 160),
        entityType: boundedString(item.entityType, `hypotheses[${index}].entityType`, 160),
        concepts,
        owner,
        participants,
        attributes: attributes(item.attributes, `hypotheses[${index}].attributes`),
        proofStrength: proof(item.proofStrength),
        evidenceIds,
        sourceObservationIds,
        parentHypothesisIds,
        anchorRequirements,
      };
    });
    const localIds = new Set(proposals.map((item) => item.localId));
    if (localIds.size !== proposals.length) throw new Error("record_hypotheses localIds must be unique within the call");
    for (const proposal of proposals) {
      for (const id of proposal.parentHypothesisIds) {
        if (!this.records.has(id) && !localIds.has(id)) throw new Error(`Unknown parent hypothesis: ${id}`);
        if (id === proposal.localId) throw new Error(`Hypothesis ${proposal.localId} cannot be its own parent`);
      }
    }
    const visitState = new Map<string, "visiting" | "visited">();
    const proposalByLocalId = new Map(proposals.map((proposal) => [proposal.localId, proposal]));
    const visit = (localId: string) => {
      if (visitState.get(localId) === "visiting") throw new Error("Same-call hypothesis lineage must be acyclic");
      if (visitState.get(localId) === "visited") return;
      visitState.set(localId, "visiting");
      for (const parentId of proposalByLocalId.get(localId)?.parentHypothesisIds || []) if (localIds.has(parentId)) visit(parentId);
      visitState.set(localId, "visited");
    };
    for (const localId of localIds) visit(localId);
    const localToHypothesisIds: Record<string, string> = Object.fromEntries(proposals.map((proposal) => [
      proposal.localId,
      `hypothesis:${stableHash({ contextHash: this.contextHash, proposal })}`,
    ]));
    for (const id of Object.values(localToHypothesisIds)) if (this.records.has(id)) throw new Error(`Hypothesis revision repeats an existing proposal: ${id}`);
    const recorded = proposals.map((proposal) => {
      const id = localToHypothesisIds[proposal.localId];
      const parentHypothesisIds = proposal.parentHypothesisIds.map((parentId) => localToHypothesisIds[parentId] || parentId);
      const record: ReasoningHypothesisRecord = {
        ...proposal,
        parentHypothesisIds,
        schemaVersion: REASONING_POC_VERSION,
        id,
        contextHash: this.contextHash,
        origin: provenance.origin,
        provenance: { provider: provenance.provider, version: provenance.version },
        status: "proposed",
        review: null,
      };
      return record;
    });
    for (const record of recorded) assertDirectedDestinationAnchors(record, this.evidence, this.context);
    const proofIssues = recorded
      .filter((record) => !hasEvidenceForProofStrength(record, this.evidence))
      .map((record) => `Hypothesis ${record.localId} (${record.id}) overstates available proof as ${record.proofStrength}`);
    if (proofIssues.length) {
      throw new Error(`Hypothesis batch rejected ${proofIssues.length} proof overstatement(s): ${proofIssues.join(" | ")}`);
    }
    const pendingRecordIds = new Set(recorded.map((record) => record.id));
    const pendingRelationIds = new Set<string>();
    const relations = value.relations.map((item, index) => {
      if (!isRecord(item)) throw new Error(`relations[${index}] is malformed`);
      const fromInput = boundedString(item.from, `relations[${index}].from`);
      const toInput = boundedString(item.to, `relations[${index}].to`);
      const fromHypothesisId = localToHypothesisIds[fromInput] || (this.records.has(fromInput) || pendingRecordIds.has(fromInput) ? fromInput : "");
      const toHypothesisId = localToHypothesisIds[toInput] || (this.records.has(toInput) || pendingRecordIds.has(toInput) ? toInput : "");
      if (!fromHypothesisId || !toHypothesisId) throw new Error(`relations[${index}] references an unknown hypothesis`);
      const evidenceIds = strings(item.evidenceIds, `relations[${index}].evidenceIds`, 12);
      if (!evidenceIds.length) throw new Error(`Relation hypothesis ${index} requires compatible evidence`);
      for (const id of evidenceIds) if (!this.evidence.has(id)) throw new Error(`Relation references missing or stale evidence: ${id}`);
      if (!evidenceIds.some((id) => {
        const record = this.evidence.get(id);
        return Boolean(record && licensesSemanticChessGrounding(effectiveLicensesForRecord(record)));
      })) throw new Error(`Relation hypothesis ${index} lacks evidence licensed for semantic chess grounding`);
      const sourceObservationIds = strings(item.sourceObservationIds, `relations[${index}].sourceObservationIds`, 12);
      for (const id of sourceObservationIds) if (!observationById.has(id)) throw new Error(`Relation references unknown observation: ${id}`);
      const relationType = boundedString(item.relationType, `relations[${index}].relationType`, 160);
      const relation: ReasoningHypothesisRelationRecord = {
        schemaVersion: REASONING_POC_VERSION,
        id: `hypothesis-relation:${stableHash({ contextHash: this.contextHash, relationType, fromHypothesisId, toHypothesisId, attributes: item.attributes })}`,
        contextHash: this.contextHash,
        relationType,
        fromHypothesisId,
        toHypothesisId,
        attributes: attributes(item.attributes, `relations[${index}].attributes`),
        evidenceIds,
        sourceObservationIds,
      };
      if (this.relations.has(relation.id) || pendingRelationIds.has(relation.id)) throw new Error(`Hypothesis revision repeats an existing relation: ${relation.id}`);
      pendingRelationIds.add(relation.id);
      return relation;
    });
    for (const record of recorded) this.records.set(record.id, record);
    for (const relation of relations) this.relations.set(relation.id, relation);
    return { records: recorded, relations, localToHypothesisIds };
  }

  review(
    value: unknown,
    validateProspective?: (records: ReasoningHypothesisRecord[]) => void,
    supplementalEvidenceByHypothesisId: Map<string, string[]> = new Map(),
  ): { decisions: ReasoningHypothesisDecision[]; evidence: ReasoningEvidenceRecord } {
    if (!isRecord(value) || !Array.isArray(value.decisions) || !value.decisions.length || value.decisions.length > this.maxHypotheses) throw new Error("review_hypotheses requires decisions");
    const observationById = new Map(this.observations.observations.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const decisions = value.decisions.map((item, index): ReasoningHypothesisDecision => {
      if (!isRecord(item)) throw new Error(`decisions[${index}] is malformed`);
      const hypothesisId = boundedString(item.hypothesisId, `decisions[${index}].hypothesisId`);
      if (seen.has(hypothesisId)) throw new Error(`Duplicate hypothesis decision: ${hypothesisId}`);
      seen.add(hypothesisId);
      const record = this.records.get(hypothesisId);
      if (!record) throw new Error(`Unknown hypothesis: ${hypothesisId}`);
      const disposition = item.disposition;
      if (disposition !== "accept" && disposition !== "reject" && disposition !== "needs-probe" && disposition !== "supersede") throw new Error(`Invalid hypothesis disposition for ${hypothesisId}`);
      const supersededBy = strings(item.supersededBy, `decisions[${index}].supersededBy`, 8);
      if (disposition === "supersede") {
        if (!supersededBy.length) throw new Error(`Superseded hypothesis ${hypothesisId} requires supersededBy`);
        for (const childId of supersededBy) {
          const child = this.records.get(childId);
          if (!child || !child.parentHypothesisIds.includes(hypothesisId)) throw new Error(`Superseding hypothesis ${childId} must preserve lineage to ${hypothesisId}`);
        }
      } else if (supersededBy.length) {
        throw new Error(`Only supersede decisions may include supersededBy`);
      }
      const decision: ReasoningHypothesisDecision = { hypothesisId, disposition, rationale: boundedString(item.rationale, `decisions[${index}].rationale`, 500), supersededBy };
      return decision;
    });
    const acceptanceIssues: string[] = [];
    for (const decision of decisions.filter((item) => item.disposition === "accept")) {
      const storedRecord = this.records.get(decision.hypothesisId)!;
      const record = {
        ...storedRecord,
        evidenceIds: [...new Set([...storedRecord.evidenceIds, ...(supplementalEvidenceByHypothesisId.get(storedRecord.id) || [])])],
      };
      try {
        this.validateRealization(record);
      } catch (error) {
        acceptanceIssues.push(error instanceof Error ? error.message : `Hypothesis ${record.id} has invalid realization anchors`);
      }
      if (!record.evidenceIds.length) acceptanceIssues.push(`Accepted hypothesis ${record.id} requires compatible evidence`);
      for (const id of record.evidenceIds) {
        if (!this.evidence.has(id)) acceptanceIssues.push(`Accepted hypothesis ${record.id} references missing evidence ${id}`);
      }
      if (!record.evidenceIds.some((id) => {
        const evidence = this.evidence.get(id);
        return Boolean(evidence && licensesSemanticChessGrounding(effectiveLicensesForRecord(evidence)));
      })) acceptanceIssues.push(`Accepted hypothesis ${record.id} lacks evidence licensed for semantic chess grounding`);
      const usesGeneratedRouteAffordance = record.sourceObservationIds.some((id) =>
        observationById.get(id)?.observationType === "conditional-route-affordance");
      if (usesGeneratedRouteAffordance && !record.evidenceIds.some((id) => isRouteRelevanceEvidence(this.evidence.get(id)))) {
        acceptanceIssues.push(`Accepted hypothesis ${record.id} promotes a generated conditional route without separate bounded relevance evidence`);
      }
      acceptanceIssues.push(...validateHypothesisAcceptancePolicies(record, this.evidence, this.registry));
      if (!hasEvidenceForProofStrength(record, this.evidence)) acceptanceIssues.push(`Accepted hypothesis ${record.id} overstates available proof as ${record.proofStrength}`);
    }
    if (acceptanceIssues.length) throw new Error(`Hypothesis review rejected ${acceptanceIssues.length} acceptance issue(s): ${acceptanceIssues.join(" | ")}`);
    const decisionsById = new Map(decisions.map((decision) => [decision.hypothesisId, decision]));
    const prospectiveRecords = this.allRecords().map((record) => {
      const decision = decisionsById.get(record.id);
      const evidenceIds = [...new Set([...record.evidenceIds, ...(supplementalEvidenceByHypothesisId.get(record.id) || [])])];
      if (!decision) return { ...record, evidenceIds };
      return {
        ...record,
        evidenceIds,
        status: decision.disposition === "accept"
          ? "accepted" as const
          : decision.disposition === "reject"
            ? "rejected" as const
            : decision.disposition === "supersede"
              ? "superseded" as const
              : "needs-probe" as const,
        review: { rationale: decision.rationale, supersededBy: [...decision.supersededBy] },
      };
    });
    validateProspective?.(prospectiveRecords);
    for (const decision of decisions) {
      const record = this.records.get(decision.hypothesisId)!;
      record.evidenceIds = [...new Set([...record.evidenceIds, ...(supplementalEvidenceByHypothesisId.get(record.id) || [])])];
      const { disposition, supersededBy } = decision;
      record.status = disposition === "accept"
        ? "accepted"
        : disposition === "reject"
          ? "rejected"
          : disposition === "supersede"
            ? "superseded"
            : "needs-probe";
      record.review = { rationale: decision.rationale, supersededBy };
    }
    const evidence: ReasoningEvidenceRecord = withEvidenceLicenses({
      schemaVersion: REASONING_POC_VERSION,
      id: `evidence:hypothesis-review:${stableHash({ contextHash: this.contextHash, decisions })}`,
      contextHash: this.contextHash,
      kind: "hypothesis-review",
      source: "knights-eye/hypothesis-ledger-review",
      proofStrength: null,
      summary: `Recorded ${decisions.length} model hypothesis decision(s); review is semantic judgment, not chess proof.`,
      data: { decisions },
      coverage: {
        complete: this.allRecords().every((record) => ["accepted", "rejected", "superseded"].includes(record.status)),
        covered: this.allRecords().filter((record) => ["accepted", "rejected", "superseded"].includes(record.status)).map((record) => record.id),
        unresolved: this.allRecords().filter((record) => !["accepted", "rejected", "superseded"].includes(record.status)).map((record) => record.id),
      },
      replay: { ledger: "hypothesis", contextHash: this.contextHash },
    });
    this.evidence.set(evidence.id, evidence);
    return { decisions, evidence };
  }

  toInternalPlanRequest(value: unknown): InternalExplainPlanRequest {
    const selection = this.parseSelection(value);
    const unresolved = this.allRecords().filter((record) => record.status === "proposed" || record.status === "needs-probe");
    if (unresolved.length) throw new Error(`Every recorded hypothesis requires a terminal decision before explain_plan; unresolved: ${unresolved.map((item) => item.id).join(", ")}`);
    const selected = selection.hypothesisIds.map((id) => {
      const record = this.records.get(id);
      if (!record) throw new Error(`Unknown hypothesis selected for explain_plan: ${id}`);
      if (record.status !== "accepted") throw new Error(`Only accepted hypotheses can enter explain_plan: ${id}`);
      this.validateRealization(record);
      return record;
    });
    const selectedIds = new Set(selected.map((record) => record.id));
    const relations = selection.relationIds.map((id) => {
      const relation = this.relations.get(id);
      if (!relation) throw new Error(`Unknown hypothesis relation selected for explain_plan: ${id}`);
      if (!selectedIds.has(relation.fromHypothesisId) || !selectedIds.has(relation.toHypothesisId)) throw new Error(`Selected relation ${id} leaves the selected hypothesis set`);
      if (!relation.evidenceIds.some((evidenceId) => {
        const record = this.evidence.get(evidenceId);
        return Boolean(record && licensesSemanticChessGrounding(effectiveLicensesForRecord(record)));
      })) throw new Error(`Selected relation ${id} lacks evidence licensed for semantic chess grounding`);
      const routeEndpoint = [relation.fromHypothesisId, relation.toHypothesisId].some((hypothesisId) =>
        this.records.get(hypothesisId)?.sourceObservationIds.some((observationId) =>
          this.observations.observations.find((observation) => observation.id === observationId)?.observationType === "conditional-route-affordance"));
      const routeRelevanceEvidenceIds = [
        ...relation.evidenceIds,
        ...[relation.fromHypothesisId, relation.toHypothesisId].flatMap((hypothesisId) => this.records.get(hypothesisId)?.evidenceIds || []),
      ];
      if (routeEndpoint && !routeRelevanceEvidenceIds.some((evidenceId) => isRouteRelevanceEvidence(this.evidence.get(evidenceId)))) {
        throw new Error(`Selected relation ${id} promotes a generated conditional route without separate bounded relevance evidence`);
      }
      return relation;
    });
    for (const id of [selection.startHypothesisId, selection.goalHypothesisId, ...selection.requiredHypothesisIds]) if (!selectedIds.has(id)) throw new Error(`Selected endpoint ${id} is not in hypothesisIds`);
    return {
      hypothesisLedgerRevision: this.finalRevision(),
      hypotheses: {
        entities: selected.map((record) => ({
          localId: record.id,
          entityType: record.entityType,
          concepts: record.concepts,
          owner: record.owner,
          participants: record.participants,
          attributes: { ...record.attributes, sourceObservationIds: record.sourceObservationIds },
          proofStrength: record.proofStrength,
          evidenceIds: record.evidenceIds,
          sourceObservationIds: record.sourceObservationIds,
          parentHypothesisIds: record.parentHypothesisIds,
          anchorRequirements: record.anchorRequirements,
          hypothesisId: record.id,
        })),
        relations: relations.map((relation) => ({ relationType: relation.relationType, from: relation.fromHypothesisId, to: relation.toHypothesisId, attributes: relation.attributes, evidenceIds: relation.evidenceIds, hypothesisRelationId: relation.id })),
      },
      startEntityId: selection.startHypothesisId,
      goalEntityId: selection.goalHypothesisId,
      requiredEntityIds: selection.requiredHypothesisIds,
      maxEntities: selection.maxEntities,
    };
  }

  private parseSelection(value: unknown): ExplainPlanSelection {
    if (!isRecord(value)) throw new Error("explain_plan requires a selection object");
    const hypothesisIds = strings(value.hypothesisIds, "hypothesisIds", 12, false);
    if (hypothesisIds.length < 1) throw new Error("explain_plan requires at least one hypothesisId");
    const relationIds = strings(value.relationIds, "relationIds", 20);
    return {
      hypothesisIds,
      relationIds,
      startHypothesisId: boundedString(value.startHypothesisId, "startHypothesisId"),
      goalHypothesisId: boundedString(value.goalHypothesisId, "goalHypothesisId"),
      requiredHypothesisIds: strings(value.requiredHypothesisIds || [], "requiredHypothesisIds", 10),
      maxEntities: value.maxEntities == null ? 8 : Number(value.maxEntities),
    };
  }

  private validateRealization(record: ReasoningHypothesisRecord) {
    for (const anchor of record.anchorRequirements) {
      if (!record.participants.some((participant) => participantKey(participant) === participantKey(anchor.participant))) throw new Error(`Hypothesis ${record.id} lost required realization anchor ${participantKey(anchor.participant)}`);
    }
    for (const parentId of record.parentHypothesisIds) {
      const parent = this.records.get(parentId);
      if (!parent) throw new Error(`Hypothesis ${record.id} has missing parent ${parentId}`);
      if (parent.owner && record.owner && parent.owner !== record.owner) throw new Error(`Hypothesis ${record.id} contradicts parent owner`);
      const overlap = parent.concepts.some((concept) => record.concepts.includes(concept));
      if (!overlap && typeof record.attributes.refinementReason !== "string") throw new Error(`Hypothesis ${record.id} changes parent concepts without an explicit refinementReason`);
      const removedAnchorReasons = record.attributes.removedAnchorReasons;
      for (const anchor of parent.anchorRequirements) {
        const key = participantKey(anchor.participant);
        if (record.participants.some((participant) => participantKey(participant) === key)) continue;
        if (!isRecord(removedAnchorReasons) || typeof removedAnchorReasons[key] !== "string" || !removedAnchorReasons[key].trim()) {
          throw new Error(`Hypothesis ${record.id} drops parent realization anchor ${key} without an explicit removedAnchorReasons entry`);
        }
      }
    }
    this.validateDirectedDestinationAnchors(record);
  }

  private validateDirectedDestinationAnchors(record: ReasoningHypothesisRecord) {
    assertDirectedDestinationAnchors(record, this.evidence, this.context);
  }
}

/**
 * Actor/subject plus destination/goal is an exact typed movement assertion,
 * even when the surrounding hypothesis remains provisional semantic meaning.
 * Reject impossible bindings before they enter the Ledger so a later reviewer
 * cannot accidentally promote a supporting piece into the mover's role.
 */
export function assertDirectedDestinationAnchors(
  record: Pick<ReasoningHypothesisRecord, "id" | "localId" | "participants" | "evidenceIds">,
  evidenceById: Map<string, ReasoningEvidenceRecord>,
  context: ReasoningPositionContext | undefined,
) {
  if (!context) return;
  const actors = record.participants.filter((participant) =>
    participant.ref.domain === REFERENCE_DOMAINS.PIECE
    && (participant.role === PARTICIPANT_ROLES.ACTOR || participant.role === PARTICIPANT_ROLES.SUBJECT));
  const destinations = record.participants.filter((participant) =>
    participant.ref.domain === REFERENCE_DOMAINS.SQUARE
    && (participant.role === PARTICIPANT_ROLES.GOAL || participant.role === PARTICIPANT_ROLES.DESTINATION));
  if (!actors.length || !destinations.length) return;
  const records = record.evidenceIds.flatMap((id) => {
    const evidence = evidenceById.get(id);
    return evidence ? [evidence] : [];
  });
  const witnesses = collectReasoningMoveWitnesses(records, context);
  const timeline = createPocIdentityTimeline(context);
  const grounded = (pieceId: string, square: string) => records.some((evidence) => {
    const phase = reasoningEvidenceReplayStartPhase(evidence, context);
    const state = phase === "before" ? timeline.before : phase === "after" ? timeline.after : null;
    return state && squareForPiece(state, pieceId) === square;
  }) || witnesses.some((witness) => witness.pieceId === pieceId && witness.uci.slice(2, 4) === square);
  for (const actor of actors) {
    if (!destinations.some((destination) => grounded(actor.ref.id, destination.ref.id))) {
      const squares = destinations.map((destination) => destination.ref.id).join(", ");
      throw new Error(`Hypothesis localId ${record.localId} (${record.id}) has an actor/destination anchor not grounded by cited legal evidence: actor ${actor.ref.id} does not reach goal/destination ${squares}`);
    }
  }
  for (const destination of destinations) {
    if (!actors.some((actor) => grounded(actor.ref.id, destination.ref.id))) {
      const pieces = actors.map((actor) => actor.ref.id).join(", ");
      throw new Error(`Hypothesis localId ${record.localId} (${record.id}) has a destination anchor without a grounded actor in cited legal evidence: goal/destination ${destination.ref.id} is not reached by ${pieces}`);
    }
  }
}
