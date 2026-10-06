import type { ReasoningPositionContext } from "./poc-contracts";
import { effectiveEvidenceLicenses, validateEvidenceLicenseClaims, type EvidenceLicense } from "./evidence-licenses";
import type { ProofStrength, SemanticParticipant, SemanticValue } from "./types";

export const CHESS_FACT_SCHEMA_VERSION = "chess-facts/1" as const;
export const CHESS_FACT_REQUEST_VERSION = "chess-fact-request/1" as const;
export const CHESS_FACT_RESULT_VERSION = "chess-fact-result/1" as const;

export type ChessFactAuthority =
  | "legal-exact"
  | "deterministic-derived"
  | "heuristic-affordance"
  | "bounded-engine";

const PROOF_RANK: Readonly<Record<ProofStrength, number>> = Object.freeze({
  observed: 1,
  supported: 2,
  forced: 3,
});

export type ChessFactPhase = "before" | "after" | "transition" | "path";

export type ChessFactCoverage = {
  domain: string;
  exhaustive: boolean;
  covered: string[];
  unresolved: string[];
};

export type ChessFactEngineProvenance = {
  name: string;
  build: string;
  network: string | null;
  depth: number;
  threads: 1;
  multiPv: number;
  rootMoves: string[];
};

export type ChessFactRecord = {
  schemaVersion: typeof CHESS_FACT_SCHEMA_VERSION;
  id: string;
  contextHash: string;
  kind: string;
  phase: ChessFactPhase;
  authority: ChessFactAuthority;
  licenses?: EvidenceLicense[];
  summary: string;
  participants: SemanticParticipant[];
  data: Record<string, SemanticValue>;
  coverage: ChessFactCoverage;
  provenance: {
    provider: string;
    version: string;
    method: string;
    derivedFromIds: string[];
    engine?: ChessFactEngineProvenance;
  };
  replay: Record<string, SemanticValue> | null;
};

export type ChessFactCapability = {
  kind: string;
  phases: ChessFactPhase[];
  authorities: ChessFactAuthority[];
  coverageDomains: string[];
  expandable: boolean;
  limitations: string[];
};

export type ChessFactRequest = {
  schemaVersion: typeof CHESS_FACT_REQUEST_VERSION;
  requestId: string;
  context: ReasoningPositionContext;
  requestedKinds: string[];
  budgets: {
    maxRecords: number;
    maxBytes: number;
    maxWallTimeMs: number;
  };
  engineLimits?: {
    depth: number;
    threads: 1;
    multiPv: number;
    rootMoves: string[];
  };
};

export type ChessFactOmission = {
  kind: string;
  reason: "budget" | "not-requested";
  recordId: string | null;
};

export type ChessFactResult = {
  schemaVersion: typeof CHESS_FACT_RESULT_VERSION;
  contextHash: string;
  records: ChessFactRecord[];
  capabilities: ChessFactCapability[];
  omitted: ChessFactOmission[];
  unavailableKinds: Array<{ kind: string; reason: string }>;
  limitations: string[];
};

export interface ChessFactProvider {
  readonly id: string;
  readonly version: string;
  capabilities(): readonly ChessFactCapability[];
  collect(request: ChessFactRequest, signal?: AbortSignal): Promise<ChessFactResult> | ChessFactResult;
}

const MECHANICAL_KIND = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const INTERPRETIVE_KIND_TOKEN = /(?:^|[._-])(plan|idea|purpose|brilliant|great|interesting|best|good|okay|dubious|mistake|miss|blunder|decisive|interposition|readiness)(?:$|[._-])/;
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const SQUARE = /^[a-h][1-8]$/;

function validateMechanicalKind(kind: string): void {
  if (!MECHANICAL_KIND.test(kind)) throw new Error(`Chess fact kind is not mechanical: ${kind}`);
  if (INTERPRETIVE_KIND_TOKEN.test(kind)) throw new Error(`Chess fact kind leaks interpretation or policy: ${kind}`);
}

export function validateChessFactRequest(request: ChessFactRequest): ChessFactRequest {
  if (request.schemaVersion !== CHESS_FACT_REQUEST_VERSION) throw new Error("Unsupported chess fact request version");
  if (!request.requestId || request.requestId.length > 200) throw new Error("Chess fact requestId must contain 1..200 characters");
  if (!Number.isInteger(request.budgets.maxRecords) || request.budgets.maxRecords < 1 || request.budgets.maxRecords > 512) {
    throw new Error("Chess fact maxRecords must be an integer in 1..512");
  }
  if (!Number.isInteger(request.budgets.maxBytes) || request.budgets.maxBytes < 1_024 || request.budgets.maxBytes > 2_000_000) {
    throw new Error("Chess fact maxBytes must be an integer in 1024..2000000");
  }
  if (!Number.isInteger(request.budgets.maxWallTimeMs) || request.budgets.maxWallTimeMs < 1 || request.budgets.maxWallTimeMs > 300_000) {
    throw new Error("Chess fact maxWallTimeMs must be an integer in 1..300000");
  }
  for (const kind of request.requestedKinds) validateMechanicalKind(kind);
  if (new Set(request.requestedKinds).size !== request.requestedKinds.length) throw new Error("Chess fact requestedKinds must be unique");
  if (request.engineLimits) {
    if (request.engineLimits.threads !== 1) throw new Error("Reproducible chess fact engine requests require threads=1");
    if (!Number.isInteger(request.engineLimits.depth) || request.engineLimits.depth < 1 || request.engineLimits.depth > 64) throw new Error("Chess fact engine depth must be in 1..64");
    if (!Number.isInteger(request.engineLimits.multiPv) || request.engineLimits.multiPv < 1 || request.engineLimits.multiPv > 16) throw new Error("Chess fact engine multiPv must be in 1..16");
    if (request.engineLimits.rootMoves.some((move) => !UCI_MOVE.test(move))) throw new Error("Chess fact engine root moves must be UCI moves");
  }
  return request;
}

export function validateChessFactRecord(record: ChessFactRecord): ChessFactRecord {
  if (record.schemaVersion !== CHESS_FACT_SCHEMA_VERSION) throw new Error("Unsupported chess fact record version");
  if (!record.id || !record.contextHash) throw new Error("Chess fact record requires stable identity and context hash");
  validateMechanicalKind(record.kind);
  if (!new Set<ChessFactAuthority>(["legal-exact", "deterministic-derived", "heuristic-affordance", "bounded-engine"]).has(record.authority)) throw new Error("Unsupported chess fact authority");
  if (!new Set<ChessFactPhase>(["before", "after", "transition", "path"]).has(record.phase)) throw new Error("Unsupported chess fact phase");
  if (!record.summary.trim() || record.summary.length > 1_000) throw new Error("Chess fact summary must contain 1..1000 characters");
  if (!record.coverage.domain) throw new Error("Chess fact coverage domain is required");
  if (!record.coverage.exhaustive && record.coverage.unresolved.length === 0) throw new Error("Non-exhaustive chess fact coverage must state unresolved domain members");
  if (record.coverage.covered.some((item) => !item) || record.coverage.unresolved.some((item) => !item)) throw new Error("Chess fact coverage entries must be nonempty");
  if (!record.provenance.provider || !record.provenance.version || !record.provenance.method) throw new Error("Chess fact provenance is incomplete");
  if (new Set(record.provenance.derivedFromIds).size !== record.provenance.derivedFromIds.length) throw new Error("Chess fact derivedFromIds must be unique");
  if (Object.keys(record).some((key) => /^is[A-Z]/.test(key))) throw new Error("Chess fact records cannot add concept-specific boolean flags");
  const licenseInput = {
    kind: "fact",
    source: `${record.provenance.provider}/${record.provenance.method}`,
    authority: record.authority,
    proofStrength: factProofStrength(record.authority, record.coverage),
    data: { ...record.data, authority: record.authority, phase: record.phase, factKind: record.kind },
    coverage: { complete: record.coverage.exhaustive, covered: record.coverage.covered, unresolved: record.coverage.unresolved },
    replay: record.replay,
  };
  if (record.licenses !== undefined) validateEvidenceLicenseClaims(licenseInput, record.licenses);
  if (record.authority === "bounded-engine") {
    const engine = record.provenance.engine;
    if (!engine) throw new Error("Bounded-engine fact requires engine provenance");
    if (engine.threads !== 1) throw new Error("Bounded-engine fact provenance requires threads=1");
    if (!Number.isInteger(engine.depth) || engine.depth < 1 || engine.depth > 64) throw new Error("Bounded-engine fact provenance requires fixed depth");
    if (!Number.isInteger(engine.multiPv) || engine.multiPv < 1 || engine.multiPv > 16) throw new Error("Bounded-engine fact provenance requires bounded MultiPV");
    if (!engine.name || !engine.build) throw new Error("Bounded-engine fact provenance requires engine name and build");
    if (engine.rootMoves.some((move) => !UCI_MOVE.test(move))) throw new Error("Bounded-engine root moves must be UCI moves");
  } else if (record.provenance.engine) {
    throw new Error("Only bounded-engine facts may carry engine provenance");
  }
  const pieceIds = new Set(record.participants.filter((item) => item.ref.domain === "piece").map((item) => item.ref.id));
  if (pieceIds.size) {
    const locations = Array.isArray(record.data.pieceLocations) ? record.data.pieceLocations : [];
    const located = new Set(locations.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const pieceId = (value as Record<string, SemanticValue>).pieceId;
      const currentSquare = (value as Record<string, SemanticValue>).currentSquare;
      return typeof pieceId === "string" && typeof currentSquare === "string" && SQUARE.test(currentSquare) ? [pieceId] : [];
    }));
    for (const pieceId of pieceIds) if (!located.has(pieceId)) throw new Error(`Piece participant lacks currentSquare data: ${pieceId}`);
  }
  return record;
}

export function chessFactRecordLicenses(record: ChessFactRecord): EvidenceLicense[] {
  return effectiveEvidenceLicenses({
    kind: "fact",
    source: `${record.provenance.provider}/${record.provenance.method}`,
    authority: record.authority,
    proofStrength: factProofStrength(record.authority, record.coverage),
    data: { ...record.data, authority: record.authority, phase: record.phase, factKind: record.kind },
    coverage: { complete: record.coverage.exhaustive, covered: record.coverage.covered, unresolved: record.coverage.unresolved },
    replay: record.replay,
    licenses: record.licenses,
  });
}

/**
 * Central authority-to-proof policy for every fact-provider boundary.
 *
 * `forced` is intentionally absent: fact records cannot establish it. Forced
 * proof belongs to the rules-complete probe/coverage validators.
 */
export function maximumFactProofStrength(
  authority: ChessFactAuthority,
  coverage?: Pick<ChessFactCoverage, "exhaustive" | "unresolved"> | null,
): ProofStrength | null {
  if (authority === "heuristic-affordance") return null;
  if (authority === "legal-exact" || authority === "deterministic-derived") return "observed";
  return coverage?.exhaustive && coverage.unresolved.length === 0 ? "supported" : "observed";
}

export function factProofStrength(
  authority: ChessFactAuthority,
  coverage?: Pick<ChessFactCoverage, "exhaustive" | "unresolved"> | null,
): ProofStrength | null {
  return maximumFactProofStrength(authority, coverage);
}

export function assertFactProofWithinAuthority(input: {
  authority: ChessFactAuthority;
  proofStrength: ProofStrength | null;
  coverage?: Pick<ChessFactCoverage, "exhaustive" | "unresolved"> | null;
  label?: string;
}): void {
  const maximum = maximumFactProofStrength(input.authority, input.coverage);
  if (input.proofStrength === null) return;
  if (maximum === null || PROOF_RANK[input.proofStrength] > PROOF_RANK[maximum]) {
    throw new Error(`${input.label || "Fact evidence"} overstates ${input.authority} authority as ${input.proofStrength}`);
  }
}

export function isChessFactAuthority(value: unknown): value is ChessFactAuthority {
  return value === "legal-exact"
    || value === "deterministic-derived"
    || value === "heuristic-affordance"
    || value === "bounded-engine";
}

export function factCoverageSupportsAbsence(record: ChessFactRecord, domain: string): boolean {
  return record.coverage.domain === domain && record.coverage.exhaustive && record.coverage.unresolved.length === 0;
}
