import {
  DEFAULT_CONCEPT_REGISTRY,
  type ConceptRegistry,
} from "./concept-registry";
import {
  createIdeaGraph,
  createSemanticEntity,
  createSemanticRelation,
  extendIdeaGraph,
} from "./idea-graph";
import { stableHash } from "./stable";
import { effectiveLicensesForRecord, licensesSemanticChessGrounding } from "./evidence-licenses";
import type {
  ReasoningEvidenceRecord,
  ReasoningPositionContext,
} from "./poc-contracts";
import type {
  IdeaGraph,
  ProofStrength,
  SemanticAttributes,
  SemanticParticipant,
  SemanticRelation,
  SemanticValue,
} from "./types";

export type PlanEntityHypothesis = {
  hypothesisId: string;
  localId: string;
  entityType: string;
  concepts: string[];
  owner: "w" | "b" | null;
  participants: SemanticParticipant[];
  attributes: SemanticAttributes;
  proofStrength: ProofStrength | null;
  evidenceIds: string[];
  sourceObservationIds: string[];
};

export type PlanRelationHypothesis = {
  hypothesisRelationId: string;
  relationType: string;
  from: string;
  to: string;
  attributes: SemanticAttributes;
  evidenceIds: string[];
};

export type PlanHypothesisSet = {
  entities: PlanEntityHypothesis[];
  relations: PlanRelationHypothesis[];
};

export type ExplainPlanRequest = {
  hypothesisLedgerRevision: string;
  hypotheses: PlanHypothesisSet;
  startEntityId: string;
  goalEntityId: string;
  requiredEntityIds: string[];
  maxEntities: number;
};

export type ResolvedPlanExplanation = {
  hypothesisLedgerRevision: string;
  graph: IdeaGraph;
  localToGraphIds: Record<string, string>;
  selectedEntityIds: string[];
  selectedRelationIds: string[];
  evidenceIds: string[];
};

const PROOF_RANK: Record<ProofStrength, number> = {
  observed: 1,
  supported: 2,
  forced: 3,
};

const FORBIDDEN_SEMANTIC_KEYS = new Set(["isFork", "isSkewer", "isMainLine"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function semanticValue(value: unknown, label: string, depth = 0): SemanticValue {
  if (depth > 5) throw new Error(`${label} exceeds the semantic-value depth limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 24) throw new Error(`${label} exceeds the semantic-value item limit`);
    return value.map((item, index) => semanticValue(item, `${label}[${index}]`, depth + 1));
  }
  if (!isRecord(value)) throw new Error(`${label} is not a JSON semantic value`);
  const entries = Object.entries(value);
  if (entries.length > 24) throw new Error(`${label} exceeds the semantic-value field limit`);
  return Object.fromEntries(entries.map(([key, item]) => {
    if (FORBIDDEN_SEMANTIC_KEYS.has(key)) throw new Error(`${key} must be a registry value, not a semantic flag`);
    return [boundedString(key, `${label} key`, 80), semanticValue(item, `${label}.${key}`, depth + 1)];
  }));
}

function stringArray(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new Error(`${label} must contain 1..${max} values`);
  }
  return [...new Set(value.map((item, index) => boundedString(item, `${label}[${index}]`)))];
}

function optionalStringArray(value: unknown, label: string, max: number): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must contain at most ${max} values`);
  return [...new Set(value.map((item, index) => boundedString(item, `${label}[${index}]`)))];
}

function attributes(value: unknown, label: string): SemanticAttributes {
  if (value == null) return {};
  const parsed = semanticValue(value, label);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} must be an object`);
  return parsed;
}

function participants(value: unknown, label: string): SemanticParticipant[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${label} must contain at most 12 participants`);
  return value.map((item, index) => {
    if (!isRecord(item) || !isRecord(item.ref)) throw new Error(`${label}[${index}] is malformed`);
    return {
      role: boundedString(item.role, `${label}[${index}].role`),
      ref: {
        domain: boundedString(item.ref.domain, `${label}[${index}].ref.domain`),
        id: boundedString(item.ref.id, `${label}[${index}].ref.id`),
      },
    };
  });
}

function parseProofStrength(value: unknown): ProofStrength | null {
  if (value == null) return null;
  if (value === "observed" || value === "supported" || value === "forced") return value;
  throw new Error("proofStrength must be observed, supported, forced, or null");
}

export function parseExplainPlanRequest(value: unknown): ExplainPlanRequest {
  if (!isRecord(value) || !isRecord(value.hypotheses)) throw new Error("explain_plan requires hypotheses");
  const hypothesisLedgerRevision = boundedString(value.hypothesisLedgerRevision, "hypothesisLedgerRevision", 200);
  const rawEntities = value.hypotheses.entities;
  const rawRelations = value.hypotheses.relations;
  if (!Array.isArray(rawEntities) || rawEntities.length < 1 || rawEntities.length > 12) {
    throw new Error("explain_plan requires 1..12 entity hypotheses");
  }
  if (!Array.isArray(rawRelations) || rawRelations.length > 20) {
    throw new Error("explain_plan requires 0..20 relation hypotheses");
  }
  const entities = rawEntities.map((item, index): PlanEntityHypothesis => {
    if (!isRecord(item)) throw new Error(`hypotheses.entities[${index}] is malformed`);
    const owner = item.owner == null ? null : item.owner;
    if (owner !== null && owner !== "w" && owner !== "b") throw new Error("entity owner must be w, b, or null");
    return {
      localId: boundedString(item.localId, `hypotheses.entities[${index}].localId`),
      entityType: boundedString(item.entityType, `hypotheses.entities[${index}].entityType`),
      concepts: stringArray(item.concepts, `hypotheses.entities[${index}].concepts`, 4),
      owner,
      participants: participants(item.participants, `hypotheses.entities[${index}].participants`),
      attributes: attributes(item.attributes, `hypotheses.entities[${index}].attributes`),
      proofStrength: parseProofStrength(item.proofStrength),
      evidenceIds: stringArray(item.evidenceIds, `hypotheses.entities[${index}].evidenceIds`, 12),
      hypothesisId: boundedString(item.hypothesisId, `hypotheses.entities[${index}].hypothesisId`, 200),
      sourceObservationIds: optionalStringArray(item.sourceObservationIds, `hypotheses.entities[${index}].sourceObservationIds`, 12),
    };
  });
  const relations = rawRelations.map((item, index): PlanRelationHypothesis => {
    if (!isRecord(item)) throw new Error(`hypotheses.relations[${index}] is malformed`);
    return {
      hypothesisRelationId: boundedString(item.hypothesisRelationId, `hypotheses.relations[${index}].hypothesisRelationId`, 200),
      relationType: boundedString(item.relationType, `hypotheses.relations[${index}].relationType`),
      from: boundedString(item.from, `hypotheses.relations[${index}].from`),
      to: boundedString(item.to, `hypotheses.relations[${index}].to`),
      attributes: attributes(item.attributes, `hypotheses.relations[${index}].attributes`),
      evidenceIds: stringArray(item.evidenceIds, `hypotheses.relations[${index}].evidenceIds`, 12),
    };
  });
  const localIds = new Set(entities.map((entity) => entity.localId));
  if (localIds.size !== entities.length) throw new Error("Entity hypothesis localIds must be unique");
  for (const relation of relations) {
    if (!localIds.has(relation.from) || !localIds.has(relation.to)) throw new Error("Relation hypothesis references an unknown localId");
  }
  const startEntityId = boundedString(value.startEntityId, "startEntityId");
  const goalEntityId = boundedString(value.goalEntityId, "goalEntityId");
  const requiredEntityIds = optionalStringArray(value.requiredEntityIds, "requiredEntityIds", 10);
  for (const localId of [startEntityId, goalEntityId, ...requiredEntityIds]) {
    if (!localIds.has(localId)) throw new Error(`Selected entity ${localId} does not exist in the hypotheses`);
  }
  const maxEntities = value.maxEntities == null ? 8 : Number(value.maxEntities);
  if (!Number.isInteger(maxEntities) || maxEntities < 1 || maxEntities > 12) throw new Error("maxEntities must be an integer from 1 through 12");
  return { hypothesisLedgerRevision, hypotheses: { entities, relations }, startEntityId, goalEntityId, requiredEntityIds, maxEntities };
}

function compatibleEvidence(
  ids: string[],
  evidence: Map<string, ReasoningEvidenceRecord>,
  contextHash: string,
): ReasoningEvidenceRecord[] {
  const records = ids.map((id) => evidence.get(id));
  if (records.some((record) => !record || record.contextHash !== contextHash)) {
    throw new Error("Plan hypothesis references missing, stale, or incompatible evidence");
  }
  return records as ReasoningEvidenceRecord[];
}

function validateProof(localId: string, proof: ProofStrength | null, records: ReasoningEvidenceRecord[]) {
  if (!proof) return;
  const supported = records.some((record) => record.proofStrength && PROOF_RANK[record.proofStrength] >= PROOF_RANK[proof]);
  if (!supported) throw new Error(`Plan hypothesis ${localId} overstates available proof as ${proof}`);
}

function validateSemanticLicense(localId: string, records: ReasoningEvidenceRecord[]) {
  if (!records.some((record) => licensesSemanticChessGrounding(effectiveLicensesForRecord(record)))) {
    throw new Error(`Plan hypothesis or relation ${localId} lacks evidence licensed for semantic chess grounding`);
  }
}

function selectExplanationGraph(
  graph: IdeaGraph,
  start: string,
  goal: string,
  required: string[],
  maxEntities: number,
): { entityIds: string[]; relations: SemanticRelation[] } {
  const terminals = new Set([start, goal, ...required]);
  const entityIds = graph.entities.map((entity) => entity.id).sort();
  if (entityIds.length > maxEntities) throw new Error("Selected explanation graph exceeds maxEntities");
  if ([...terminals].some((terminal) => !entityIds.includes(terminal))) {
    throw new Error("Selected explanation graph omits a required endpoint");
  }
  const relations = [...graph.relations].sort((left, right) => left.id.localeCompare(right.id));
  const adjacency = new Map(entityIds.map((id) => [id, [] as string[]]));
  for (const relation of relations) {
    adjacency.get(relation.from)?.push(relation.to);
    adjacency.get(relation.to)?.push(relation.from);
  }
  const componentFor = new Map<string, number>();
  let component = 0;
  for (const entityId of entityIds) {
    if (componentFor.has(entityId)) continue;
    const queue = [entityId];
    componentFor.set(entityId, component);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      for (const neighbor of adjacency.get(queue[cursor]) || []) {
        if (componentFor.has(neighbor)) continue;
        componentFor.set(neighbor, component);
        queue.push(neighbor);
      }
    }
    component += 1;
  }
  if (componentFor.get(start) !== componentFor.get(goal)) {
    throw new Error("No connected primary explanation chain covers start and goal");
  }
  const terminalComponents = new Set([...terminals].map((terminal) => componentFor.get(terminal)));
  if ([...new Set(componentFor.values())].some((id) => !terminalComponents.has(id))) {
    throw new Error("Selected explanation graph contains a disconnected optional component");
  }
  return { entityIds, relations };
}

export function resolveAndSelectPlan(
  rawRequest: unknown,
  context: ReasoningPositionContext,
  contextHash: string,
  availableEvidence: Iterable<ReasoningEvidenceRecord>,
  registry: ConceptRegistry = DEFAULT_CONCEPT_REGISTRY,
): ResolvedPlanExplanation {
  const request = parseExplainPlanRequest(rawRequest);
  const evidence = new Map([...availableEvidence].map((record) => [record.id, record]));
  const branchId = `reasoning:${context.nodeId}`;
  const ply = context.historyUci.length + 1;
  const localToGraphIds: Record<string, string> = {};
  const entities = request.hypotheses.entities.map((hypothesis) => {
    for (const concept of hypothesis.concepts) {
      if (!registry[concept]) throw new Error(`Unknown concept key: ${concept}`);
    }
    const records = compatibleEvidence(hypothesis.evidenceIds, evidence, contextHash);
    validateSemanticLicense(hypothesis.localId, records);
    validateProof(hypothesis.localId, hypothesis.proofStrength, records);
    const id = `entity:${branchId}:${ply}:${stableHash({ contextHash, hypothesis })}`;
    localToGraphIds[hypothesis.localId] = id;
    return createSemanticEntity({
      id,
      branchId,
      entityType: hypothesis.entityType,
      concepts: hypothesis.concepts,
      owner: hypothesis.owner,
      createdByPly: ply,
      createdByUci: context.moveUci,
      participants: hypothesis.participants,
      attributes: {
        ...hypothesis.attributes,
        sourceHypothesisIds: [hypothesis.hypothesisId],
        sourceObservationIds: hypothesis.sourceObservationIds,
      },
      proofStrength: hypothesis.proofStrength,
      state: hypothesis.proofStrength ? "supported" : "proposed",
      evidence: hypothesis.evidenceIds,
    }, registry);
  });
  const relations = request.hypotheses.relations.map((hypothesis) => {
    const records = compatibleEvidence(hypothesis.evidenceIds, evidence, contextHash);
    validateSemanticLicense(hypothesis.hypothesisRelationId, records);
    return createSemanticRelation({
      branchId,
      relationType: hypothesis.relationType,
      from: localToGraphIds[hypothesis.from],
      to: localToGraphIds[hypothesis.to],
      createdAtPly: ply,
      attributes: { ...hypothesis.attributes, sourceHypothesisRelationIds: [hypothesis.hypothesisRelationId] },
      evidence: hypothesis.evidenceIds,
    });
  });
  const graph = extendIdeaGraph(createIdeaGraph(branchId, ply), entities, relations, ply);
  const selected = selectExplanationGraph(
    graph,
    localToGraphIds[request.startEntityId],
    localToGraphIds[request.goalEntityId],
    request.requiredEntityIds.map((id) => localToGraphIds[id]),
    request.maxEntities,
  );
  const selectedEntities = new Set(selected.entityIds);
  const evidenceIds = [...new Set([
    ...graph.entities.filter((entity) => selectedEntities.has(entity.id)).flatMap((entity) => entity.evidence),
    ...selected.relations.flatMap((relation) => relation.evidence),
  ])].sort();
  return {
    hypothesisLedgerRevision: request.hypothesisLedgerRevision,
    graph,
    localToGraphIds,
    selectedEntityIds: selected.entityIds,
    selectedRelationIds: selected.relations.map((relation) => relation.id),
    evidenceIds,
  };
}
