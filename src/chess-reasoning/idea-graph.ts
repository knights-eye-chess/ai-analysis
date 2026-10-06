import {
  DEFAULT_CONCEPT_REGISTRY,
  conceptDefinition,
  type ConceptRegistry,
} from "./concept-registry";
import { stableHash } from "./stable";
import {
  CHESS_REASONING_POLICY_VERSION,
  CHESS_REASONING_SCHEMA_VERSION,
  type IdeaGraph,
  type IdentityState,
  type ProofStrength,
  type SemanticAttributes,
  type SemanticEntity,
  type SemanticParticipant,
  type SemanticRelation,
  type SemanticValue,
} from "./types";

const FALLBACK_TERMINAL_STATES = new Set(["converted", "completed", "refuted", "abandoned", "expired"]);

function cloneValue(value: SemanticValue): SemanticValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function cloneAttributes(attributes: SemanticAttributes): SemanticAttributes {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, cloneValue(value)]));
}

function cloneParticipants(participants: SemanticParticipant[]): SemanticParticipant[] {
  return participants.map((item) => ({ role: item.role, ref: { ...item.ref } }));
}

export type CreateSemanticEntityInput = {
  id?: string;
  branchId: string;
  entityType: string;
  concepts: string[];
  owner?: SemanticEntity["owner"];
  createdByPly: number;
  createdByUci: string;
  participants?: SemanticParticipant[];
  attributes?: SemanticAttributes;
  proofStrength?: ProofStrength | null;
  state?: string;
  evidence?: string[];
};

export function createSemanticEntity(
  input: CreateSemanticEntityInput,
  registry: ConceptRegistry = DEFAULT_CONCEPT_REGISTRY,
): SemanticEntity {
  if (!input.concepts.length) throw new Error("A semantic entity must reference at least one registered concept");
  for (const concept of input.concepts) {
    if (!conceptDefinition(registry, concept)) throw new Error(`Unknown concept key: ${concept}`);
  }
  const concepts = [...new Set(input.concepts)].sort();
  const participants = cloneParticipants(input.participants || []).sort((left, right) =>
    `${left.role}:${left.ref.domain}:${left.ref.id}`.localeCompare(`${right.role}:${right.ref.domain}:${right.ref.id}`));
  const attributes = cloneAttributes(input.attributes || {});
  const evidence = [...new Set(input.evidence || [])].sort();
  const primary = conceptDefinition(registry, concepts[0]);
  const state = input.state || primary?.lifecycle?.initialState || "proposed";
  const identity = {
    branchId: input.branchId,
    entityType: input.entityType,
    concepts,
    owner: input.owner ?? null,
    createdByPly: input.createdByPly,
    createdByUci: input.createdByUci,
    participants,
    attributes,
  };
  const id = input.id || `entity:${input.branchId}:${input.createdByPly}:${stableHash(identity)}`;
  return {
    schemaVersion: CHESS_REASONING_SCHEMA_VERSION,
    id,
    ...identity,
    proofStrength: input.proofStrength ?? null,
    state,
    evidence,
    transitions: [{
      ply: input.createdByPly,
      uci: input.createdByUci,
      state,
      annotation: state,
      evidence,
    }],
  };
}

export type CreateSemanticRelationInput = {
  id?: string;
  branchId: string;
  relationType: string;
  from: string;
  to: string;
  createdAtPly: number;
  attributes?: SemanticAttributes;
  evidence?: string[];
};

export function createSemanticRelation(input: CreateSemanticRelationInput): SemanticRelation {
  const attributes = cloneAttributes(input.attributes || {});
  const evidence = [...new Set(input.evidence || [])].sort();
  const identity = {
    branchId: input.branchId,
    relationType: input.relationType,
    from: input.from,
    to: input.to,
    createdAtPly: input.createdAtPly,
    attributes,
  };
  return {
    id: input.id || `relation:${input.branchId}:${stableHash(identity)}`,
    ...identity,
    evidence,
  };
}

export function createIdeaGraph(branchId = "main", ply = 0): IdeaGraph {
  const seed = { branchId, ply, entities: [], relations: [], candidateOutcomes: [] };
  return {
    schemaVersion: CHESS_REASONING_SCHEMA_VERSION,
    policyVersion: CHESS_REASONING_POLICY_VERSION,
    branchId,
    ply,
    inputHash: stableHash(seed),
    entities: [],
    relations: [],
    candidateOutcomes: [],
  };
}

export function extendIdeaGraph(
  graph: IdeaGraph,
  entities: SemanticEntity[],
  relations: SemanticRelation[] = [],
  ply = graph.ply,
): IdeaGraph {
  const entityMap = new Map(graph.entities.map((entity) => [entity.id, entity]));
  for (const entity of entities) {
    if (entity.branchId !== graph.branchId) throw new Error(`Entity ${entity.id} belongs to another branch`);
    const existing = entityMap.get(entity.id);
    if (existing && stableHash(existing) !== stableHash(entity)) throw new Error(`Conflicting semantic entity ID: ${entity.id}`);
    entityMap.set(entity.id, entity);
  }
  const allEntities = [...entityMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set(allEntities.map((entity) => entity.id));
  const relationMap = new Map(graph.relations.map((relation) => [relation.id, relation]));
  for (const relation of relations) {
    if (relation.branchId !== graph.branchId) throw new Error(`Relation ${relation.id} belongs to another branch`);
    if (!ids.has(relation.from) || !ids.has(relation.to)) {
      throw new Error(`Relation ${relation.id} references an unknown semantic entity`);
    }
    const existing = relationMap.get(relation.id);
    if (existing && stableHash(existing) !== stableHash(relation)) throw new Error(`Conflicting semantic relation ID: ${relation.id}`);
    relationMap.set(relation.id, relation);
  }
  const allRelations = [...relationMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  const copy = {
    ...graph,
    ply,
    entities: allEntities,
    relations: allRelations,
    candidateOutcomes: graph.candidateOutcomes.map((outcome) => ({ ...outcome, evidence: [...outcome.evidence] })),
  };
  return { ...copy, inputHash: stableHash({ previous: graph.inputHash, ...copy, inputHash: undefined }) };
}

export function forkIdeaGraph(graph: IdeaGraph, branchId: string): IdeaGraph {
  const idMap = new Map(graph.entities.map((entity) => [
    entity.id,
    `entity:${branchId}:${entity.createdByPly}:${stableHash({ source: entity.id, branchId })}`,
  ]));
  const entities = graph.entities.map((entity) => ({
    ...entity,
    id: idMap.get(entity.id) as string,
    branchId,
    concepts: [...entity.concepts],
    participants: cloneParticipants(entity.participants),
    attributes: cloneAttributes(entity.attributes),
    evidence: [...entity.evidence],
    transitions: entity.transitions.map((transition) => ({ ...transition, evidence: [...transition.evidence] })),
  }));
  const relations = graph.relations.map((relation) => createSemanticRelation({
    branchId,
    relationType: relation.relationType,
    from: idMap.get(relation.from) as string,
    to: idMap.get(relation.to) as string,
    createdAtPly: relation.createdAtPly,
    attributes: relation.attributes,
    evidence: relation.evidence,
  }));
  const copy = {
    ...graph,
    branchId,
    entities,
    relations,
    candidateOutcomes: graph.candidateOutcomes.map((outcome) => ({ ...outcome, evidence: [...outcome.evidence] })),
  };
  return { ...copy, inputHash: stableHash({ source: graph.inputHash, branchId, entities, relations }) };
}

export function graphIdentityCompatible(identity: IdentityState, graph: IdeaGraph): boolean {
  return identity.branchId === graph.branchId && identity.ply === graph.ply;
}

export function isTerminalEntity(
  entity: SemanticEntity,
  registry: ConceptRegistry = DEFAULT_CONCEPT_REGISTRY,
): boolean {
  const registeredTerminal = entity.concepts.some((concept) =>
    conceptDefinition(registry, concept)?.lifecycle?.terminalStates.includes(entity.state));
  return registeredTerminal || FALLBACK_TERMINAL_STATES.has(entity.state);
}

export function openEntityCount(graph: IdeaGraph, registry: ConceptRegistry = DEFAULT_CONCEPT_REGISTRY): number {
  return graph.entities.filter((entity) => !isTerminalEntity(entity, registry)).length;
}
