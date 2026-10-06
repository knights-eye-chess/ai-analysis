import type { Color, PieceSymbol, Square } from "chess.js";

export const CHESS_REASONING_SCHEMA_VERSION = "0.2.0" as const;
export const CHESS_REASONING_POLICY_VERSION = "shadow-2" as const;

export type BranchId = string;
export type PieceId = string;
export type EntityId = string;
export type EvidenceId = string;
export type CandidateId = string;
export type ConceptKey = string;
export type RegistryKey = string;
export type ProofStrength = "observed" | "supported" | "forced";
export type CandidateDisposition = "accepted" | "rejected" | "unsupported";
export type ConceptCoverage = "evaluated" | "partial" | "unsupported";

export type SemanticScalar = string | number | boolean | null;
export type SemanticValue = SemanticScalar | SemanticValue[] | { [key: string]: SemanticValue };
export type SemanticAttributes = Record<string, SemanticValue>;

export type SemanticReference = {
  domain: RegistryKey;
  id: string;
};

export type SemanticParticipant = {
  role: RegistryKey;
  ref: SemanticReference;
};

export type PieceIdentity = {
  id: PieceId;
  color: Color;
  type: PieceSymbol;
  originSquare: Square;
  createdPly: number;
  promotedFrom: PieceId | null;
  capturedAtPly: number | null;
  retiredAtPly: number | null;
};

export type IdentityState = {
  schemaVersion: typeof CHESS_REASONING_SCHEMA_VERSION;
  branchId: BranchId;
  fen: string;
  ply: number;
  pieces: Record<PieceId, PieceIdentity>;
  squares: Partial<Record<Square, PieceId>>;
  promotionSequence: number;
};

export type MoveIdentityDelta = {
  branchId: BranchId;
  ply: number;
  uci: string;
  san: string;
  mover: PieceId;
  captured: PieceId | null;
  promoted: PieceId | null;
  rookMoved: PieceId | null;
  beforeFen: string;
  afterFen: string;
};

export type ProposalReason = {
  code: RegistryKey;
  detail: string;
};

/**
 * Candidates and persisted entities deliberately share generic semantic
 * building blocks. Chess concepts are registry values in `concepts`; they do
 * not add flags, fields, or concept-specific entity subclasses.
 */
export type SemanticCandidate = {
  schemaVersion: typeof CHESS_REASONING_SCHEMA_VERSION;
  id: CandidateId;
  branchId: BranchId;
  ply: number;
  uci: string;
  san: string;
  entityType: RegistryKey;
  concepts: ConceptKey[];
  owner: Color | null;
  participants: SemanticParticipant[];
  attributes: SemanticAttributes;
  proposalReasons: ProposalReason[];
  verification: "not-requested";
};

export type CandidateGenerationReport = {
  schemaVersion: typeof CHESS_REASONING_SCHEMA_VERSION;
  branchId: BranchId;
  ply: number;
  move: MoveIdentityDelta;
  candidates: SemanticCandidate[];
  conceptCoverage: Record<ConceptKey, ConceptCoverage>;
  skipped: Array<{ concept: ConceptKey; reason: string }>;
};

export type ProbeBudget = {
  depth: number | null;
  nodes: number | null;
  timeMs: number | null;
};

export type EvidenceRecord = {
  schemaVersion: typeof CHESS_REASONING_SCHEMA_VERSION;
  id: EvidenceId;
  candidateId: CandidateId;
  disposition: CandidateDisposition;
  proofStrength: ProofStrength | null;
  summary: string;
  engine: string;
  engineBuild: string;
  budget: ProbeBudget;
  rootMovesCovered: string[];
  unresolvedMoves: string[];
  principalVariations: string[][];
  scoreCp: number | null;
  matePly: number | null;
  replay: {
    fen: string;
    command: string;
  } | null;
};

export type SemanticTransition = {
  ply: number;
  uci: string;
  state: RegistryKey;
  annotation: RegistryKey;
  evidence: EvidenceId[];
};

export type SemanticEntity = {
  schemaVersion: typeof CHESS_REASONING_SCHEMA_VERSION;
  id: EntityId;
  branchId: BranchId;
  entityType: RegistryKey;
  concepts: ConceptKey[];
  owner: Color | null;
  createdByPly: number;
  createdByUci: string;
  participants: SemanticParticipant[];
  attributes: SemanticAttributes;
  proofStrength: ProofStrength | null;
  state: RegistryKey;
  evidence: EvidenceId[];
  transitions: SemanticTransition[];
};

export type SemanticRelation = {
  id: string;
  branchId: BranchId;
  relationType: RegistryKey;
  from: EntityId;
  to: EntityId;
  createdAtPly: number;
  attributes: SemanticAttributes;
  evidence: EvidenceId[];
};

export type IdeaGraph = {
  schemaVersion: typeof CHESS_REASONING_SCHEMA_VERSION;
  policyVersion: typeof CHESS_REASONING_POLICY_VERSION;
  branchId: BranchId;
  ply: number;
  inputHash: string;
  entities: SemanticEntity[];
  relations: SemanticRelation[];
  candidateOutcomes: Array<{
    candidateId: CandidateId;
    disposition: CandidateDisposition;
    evidence: EvidenceId[];
  }>;
};

export type SemanticMoveRecord = {
  schemaVersion: typeof CHESS_REASONING_SCHEMA_VERSION;
  identity: IdentityState;
  generation: CandidateGenerationReport;
  evidence: EvidenceRecord[];
  graph: IdeaGraph;
};

export type ToolSupport = "supported" | "insufficient-evidence" | "unsupported-concept";

export type ReasoningToolResponse<T> = {
  schemaVersion: typeof CHESS_REASONING_SCHEMA_VERSION;
  support: ToolSupport;
  answer: T | null;
  evidence: EvidenceId[];
  limitations: string[];
};
