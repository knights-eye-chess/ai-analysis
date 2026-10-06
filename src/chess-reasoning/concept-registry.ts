import type {
  ConceptKey,
  RegistryKey,
  SemanticCandidate,
  SemanticEntity,
  SemanticParticipant,
  SemanticValue,
} from "./types";

export const ENTITY_TYPES = {
  IDEA: "idea",
  PLAN: "plan",
  ROLE: "role-assignment",
  CONDITION: "condition",
  TRANSFORMATION: "transformation",
  OUTCOME: "outcome",
} as const;

export const REFERENCE_DOMAINS = {
  PIECE: "piece",
  SQUARE: "square",
  MOVE: "move",
  POSITION: "position",
  OUTCOME: "outcome",
  ENTITY: "entity",
} as const;

export const PARTICIPANT_ROLES = {
  ACTOR: "actor",
  SUBJECT: "subject",
  TARGET: "target",
  GOAL: "goal",
  RESOURCE: "resource",
  DEFENDER: "defender",
  DESTINATION: "destination",
} as const;

export const ATTRIBUTE_KEYS = {
  ACCEPTING_MOVES: "acceptingMoves",
  PROPOSAL_REASONS: "proposalReasons",
  DESCRIPTION: "description",
  CONFIDENCE_NOTE: "confidenceNote",
} as const;

export const RELATION_TYPES = {
  SUPPORTS: "supports",
  COMPETES: "competes",
  DERIVES: "derives",
  SPLITS: "splits",
  CONVERGES: "converges",
  ENABLES: "enables",
  REQUIRES: "requires",
  REFUTES: "refutes",
  EXPLAINS: "explains",
  TRANSFORMS: "transforms",
} as const;

/**
 * These are registry values, not members of the entity schema. New concepts
 * may be registered without changing `SemanticCandidate` or `SemanticEntity`.
 */
export const CONCEPT_KEYS = {
  OFFER: "material.offer",
  MATERIAL_CLAIM: "material.claim",
  FORK: "tactic.fork",
  TRAPPED_TARGET: "tactic.trapped-target",
  PROMOTION: "tactic.promotion",
  MATING_ATTACK: "attack.mating",
  PERPETUAL_CHECK: "attack.perpetual-check",
  POSITIONAL_CLAIM: "position.claim",
  KING_ATTACK_PLAN: "plan.king-attack",
  PIECE_ROLE: "role.piece-function",
  CHANGED_CONSTRAINT: "condition.changed-constraint",
  POSITIONAL_TRANSFORMATION: "position.transformation",
} as const;

export type CaptureActor = "owner" | "opponent" | "either";

export type ConceptLifecycle = {
  initialState: RegistryKey;
  retainedState: RegistryKey;
  terminalStates: RegistryKey[];
  trackedParticipantRole?: RegistryKey;
  expireWhenTrackedUnavailable?: boolean;
  onTrackedCapture?: {
    capturedBy: CaptureActor;
    matchingState: RegistryKey;
    matchingAnnotation: RegistryKey;
    otherState: RegistryKey;
    otherAnnotation: RegistryKey;
  };
};

export type ConceptDefinition = {
  key: ConceptKey;
  label: string;
  category: RegistryKey;
  description: string;
  defaultEntityType: RegistryKey;
  acceptancePolicy?: RegistryKey;
  lifecycle?: ConceptLifecycle;
};

export type ConceptRegistry = Readonly<Record<ConceptKey, Readonly<ConceptDefinition>>>;

const COMMON_TERMINAL_STATES = ["converted", "refuted", "abandoned", "expired"];

function claimLifecycle(capturedBy: CaptureActor): ConceptLifecycle {
  return {
    initialState: "created",
    retainedState: "retained",
    terminalStates: [...COMMON_TERMINAL_STATES],
    trackedParticipantRole: PARTICIPANT_ROLES.TARGET,
    expireWhenTrackedUnavailable: true,
    onTrackedCapture: {
      capturedBy,
      matchingState: "converted",
      matchingAnnotation: "converted",
      otherState: "refuted",
      otherAnnotation: "refuted",
    },
  };
}

export function createConceptRegistry(definitions: ConceptDefinition[]): ConceptRegistry {
  const registry: Record<string, Readonly<ConceptDefinition>> = {};
  for (const definition of definitions) {
    if (!definition.key.trim()) throw new Error("Concept keys must not be empty");
    if (registry[definition.key]) throw new Error(`Duplicate concept key: ${definition.key}`);
    registry[definition.key] = Object.freeze({
      ...definition,
      lifecycle: definition.lifecycle
        ? Object.freeze({
          ...definition.lifecycle,
          terminalStates: Object.freeze([...definition.lifecycle.terminalStates]) as unknown as RegistryKey[],
          onTrackedCapture: definition.lifecycle.onTrackedCapture
            ? Object.freeze({ ...definition.lifecycle.onTrackedCapture })
            : undefined,
        })
        : undefined,
    });
  }
  return Object.freeze(registry);
}

export function extendConceptRegistry(registry: ConceptRegistry, definitions: ConceptDefinition[]): ConceptRegistry {
  return createConceptRegistry([...Object.values(registry), ...definitions]);
}

export function conceptDefinition(registry: ConceptRegistry, key: ConceptKey): Readonly<ConceptDefinition> | null {
  return registry[key] || null;
}

export function conceptsOf(value: Pick<SemanticCandidate | SemanticEntity, "concepts">): ConceptKey[] {
  return [...value.concepts];
}

export function hasConcept(value: Pick<SemanticCandidate | SemanticEntity, "concepts">, concept: ConceptKey): boolean {
  return value.concepts.includes(concept);
}

export function primaryConcept(value: Pick<SemanticCandidate | SemanticEntity, "concepts">): ConceptKey | null {
  return value.concepts[0] || null;
}

export function participantIds(
  value: Pick<SemanticCandidate | SemanticEntity, "participants">,
  role: RegistryKey,
  domain?: RegistryKey,
): string[] {
  return value.participants
    .filter((participant) => participant.role === role && (!domain || participant.ref.domain === domain))
    .map((participant) => participant.ref.id);
}

export function participant(role: RegistryKey, domain: RegistryKey, id: string): SemanticParticipant {
  return { role, ref: { domain, id } };
}

export function stringListAttribute(value: { attributes: Record<string, SemanticValue> }, key: string): string[] {
  const attribute = value.attributes[key];
  return Array.isArray(attribute) ? attribute.filter((item): item is string => typeof item === "string") : [];
}

export const DEFAULT_CONCEPT_REGISTRY = createConceptRegistry([
  {
    key: CONCEPT_KEYS.OFFER,
    label: "Material offer",
    category: "tactical",
    description: "A material liability the opponent may choose to accept.",
    defaultEntityType: ENTITY_TYPES.IDEA,
    acceptancePolicy: "material-offer-liability/1",
    lifecycle: claimLifecycle("opponent"),
  },
  {
    key: CONCEPT_KEYS.MATERIAL_CLAIM,
    label: "Material claim",
    category: "tactical",
    description: "An evidence-backed entitlement to win material.",
    defaultEntityType: ENTITY_TYPES.IDEA,
    lifecycle: claimLifecycle("owner"),
  },
  {
    key: CONCEPT_KEYS.FORK,
    label: "Fork",
    category: "tactical",
    description: "One resource attacks multiple targets.",
    defaultEntityType: ENTITY_TYPES.IDEA,
    lifecycle: claimLifecycle("owner"),
  },
  {
    key: CONCEPT_KEYS.TRAPPED_TARGET,
    label: "Trapped target",
    category: "tactical",
    description: "A target lacks an adequate escape or defensive resource.",
    defaultEntityType: ENTITY_TYPES.IDEA,
    lifecycle: claimLifecycle("owner"),
  },
  {
    key: CONCEPT_KEYS.PROMOTION,
    label: "Promotion",
    category: "tactical",
    description: "A promotion event or promotion claim.",
    defaultEntityType: ENTITY_TYPES.IDEA,
  },
  {
    key: CONCEPT_KEYS.MATING_ATTACK,
    label: "Mating attack",
    category: "tactical",
    description: "A coordinated plan whose concrete target is mate.",
    defaultEntityType: ENTITY_TYPES.PLAN,
  },
  {
    key: CONCEPT_KEYS.PERPETUAL_CHECK,
    label: "Perpetual check",
    category: "tactical",
    description: "A claim to a repeatable checking sequence.",
    defaultEntityType: ENTITY_TYPES.IDEA,
  },
  {
    key: CONCEPT_KEYS.POSITIONAL_CLAIM,
    label: "Positional claim",
    category: "positional",
    description: "A measured, evidence-bounded positional interpretation.",
    defaultEntityType: ENTITY_TYPES.IDEA,
  },
  {
    key: CONCEPT_KEYS.KING_ATTACK_PLAN,
    label: "King attack plan",
    category: "plan",
    description: "A goal-directed sequence intended to attack the king.",
    defaultEntityType: ENTITY_TYPES.PLAN,
  },
  {
    key: CONCEPT_KEYS.PIECE_ROLE,
    label: "Piece role",
    category: "role",
    description: "A context-dependent function performed by a piece.",
    defaultEntityType: ENTITY_TYPES.ROLE,
  },
  {
    key: CONCEPT_KEYS.CHANGED_CONSTRAINT,
    label: "Changed constraint",
    category: "condition",
    description: "A condition whose importance changed after a move or sequence.",
    defaultEntityType: ENTITY_TYPES.CONDITION,
  },
  {
    key: CONCEPT_KEYS.POSITIONAL_TRANSFORMATION,
    label: "Positional transformation",
    category: "transformation",
    description: "A causal change in the meaning of a positional feature.",
    defaultEntityType: ENTITY_TYPES.TRANSFORMATION,
  },
]);
