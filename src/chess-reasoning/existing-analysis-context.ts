import { Chess, type Square } from "chess.js";
import { PARTICIPANT_ROLES, REFERENCE_DOMAINS, participant } from "./concept-registry";
import { EVIDENCE_LICENSE, type EvidenceLicense, validateEvidenceLicenseClaims, withEvidenceLicenses } from "./evidence-licenses";
import { factProofStrength, isChessFactAuthority, type ChessFactAuthority } from "./fact-provider";
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
import { createPocIdentityTimeline, pieceIdAt } from "./poc-piece-refs";
import { stableHash } from "./stable";
import type { SemanticValue } from "./types";

export const EXISTING_ANALYSIS_CONTEXT_VERSION = "existing-analysis-context/2" as const;
export const LEGACY_EXISTING_ANALYSIS_CONTEXT_VERSION = "existing-analysis-context/1" as const;
export const CANONICAL_EDGE_ANALYSIS_SNAPSHOT_VERSION = "canonical-edge-analysis-snapshot/1" as const;
export const EXISTING_ANALYSIS_RECORD_VERSION = "existing-analysis-record/1" as const;
export const MATERIAL_OFFER_SET_VERSION = "classifier-material-offer-set/1" as const;
export const EXISTING_ANALYSIS_OBSERVATION_PROVIDER_ID = "knights-eye/existing-analysis-context" as const;

/**
 * Development/evaluation views over one identical canonical context snapshot.
 * These are ablation controls, not user-query kinds or alternative providers.
 */
export const EXISTING_ANALYSIS_CONTEXT_MODE = Object.freeze({
  HIDDEN: "hidden",
  LABEL_ONLY: "label-only",
  DIAGNOSTICS_ONLY: "diagnostics-only",
  FULL: "full",
} as const);

export type ExistingAnalysisContextMode = typeof EXISTING_ANALYSIS_CONTEXT_MODE[keyof typeof EXISTING_ANALYSIS_CONTEXT_MODE];

export const ANALYSIS_CONTEXT_PROVENANCE_TIER = Object.freeze({
  RAW_ANALYSIS: "raw-analysis",
  LEGACY_HEURISTIC: "legacy-heuristic-diagnostic",
  REVIEWED_SEMANTIC: "reviewed-semantic-state",
  POLICY_LABEL: "policy-derived-label",
} as const);

export type AnalysisContextProvenanceTier = typeof ANALYSIS_CONTEXT_PROVENANCE_TIER[keyof typeof ANALYSIS_CONTEXT_PROVENANCE_TIER];

export type MaterialOfferCandidateSummary = {
  captureUci: string;
  offeredSquare: string;
  offeredPiece: string;
  nominalOffer: number;
  voluntaryOfferCap: number;
  bestImmediateRecoveryNet: number;
  qualifying: boolean;
  acceptanceLine: string[];
  persistent: boolean | null;
  conversionGain: number | null;
};

export type MaterialOfferSet = {
  version: typeof MATERIAL_OFFER_SET_VERSION;
  status: "complete" | "unavailable";
  offers: MaterialOfferCandidateSummary[] | null;
  screenedCandidates: MaterialOfferCandidateSummary[];
  classifierVersion: number;
  detector: "classifier-sacrifice-offer-tracker";
  policy: string;
  horizon: {
    verificationDepth: number | null;
    materialWindowPlies: number | null;
    principalVariationPlies: number;
  };
  limitations: string[];
};

export type ExistingAnalysisRecord = {
  version: typeof EXISTING_ANALYSIS_RECORD_VERSION;
  id: string;
  kind: string;
  scope: "selected-edge" | "path-window";
  authority: ChessFactAuthority;
  licenses: EvidenceLicense[];
  summary: string;
  data: Record<string, SemanticValue>;
  coverage: { complete: boolean; covered: string[]; unresolved: string[] };
  provenance: {
    tier: AnalysisContextProvenanceTier;
    provider: string;
    version: string;
    derivedFromIds: string[];
  };
  replay: Record<string, SemanticValue> | null;
  limitations: string[];
};

export type ExistingAnalysisContext = {
  version: typeof EXISTING_ANALYSIS_CONTEXT_VERSION;
  materialOffers: MaterialOfferSet;
  records: ExistingAnalysisRecord[];
  coverage: {
    complete: boolean;
    includedKinds: string[];
    omitted: Array<{ kind: string; reason: "relevance" | "budget" | "unavailable" }>;
    unavailableKinds: string[];
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function boundedText(value: unknown, maximum = 240) {
  return String(value ?? "").slice(0, maximum);
}

function moveList(value: unknown, limit = 12) {
  return Array.isArray(value)
    ? value.map(String).filter((move) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)).slice(0, limit)
    : [];
}

function semanticValue(value: unknown, depth = 0): SemanticValue | null {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value == null ? null : typeof value === "string" ? value.slice(0, 500) : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 6) return null;
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => semanticValue(item, depth + 1));
  const item = record(value);
  if (!item) return null;
  return Object.fromEntries(Object.entries(item).slice(0, 32).map(([key, itemValue]) => [key.slice(0, 80), semanticValue(itemValue, depth + 1)]));
}

function semanticRecord(value: unknown): Record<string, SemanticValue> {
  return (semanticValue(value) || {}) as Record<string, SemanticValue>;
}

function candidateSummary(value: unknown): MaterialOfferCandidateSummary | null {
  const item = record(value);
  if (!item) return null;
  const captureUci = String(item.captureUci || "");
  const offeredSquare = String(item.offeredSquare || "");
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(captureUci) || !/^[a-h][1-8]$/.test(offeredSquare)) return null;
  return {
    captureUci,
    offeredSquare,
    offeredPiece: String(item.offeredPiece || "unknown").slice(0, 24),
    nominalOffer: finiteNumber(item.nominalOffer),
    voluntaryOfferCap: finiteNumber(item.voluntaryOfferCap),
    bestImmediateRecoveryNet: finiteNumber(item.bestImmediateRecoveryNet),
    qualifying: item.qualifying === true,
    acceptanceLine: moveList(item.acceptanceLine),
    persistent: typeof item.persistent === "boolean" ? item.persistent : null,
    conversionGain: item.conversionGain == null ? null : finiteNumber(item.conversionGain),
  };
}

function normalizeMaterialOfferSet(value: unknown): MaterialOfferSet | null {
  const material = record(value);
  if (!material || material.version !== MATERIAL_OFFER_SET_VERSION) return null;
  const status = material.status === "complete" ? "complete" : "unavailable";
  const screenedCandidates = Array.isArray(material.screenedCandidates)
    ? material.screenedCandidates.map(candidateSummary).filter((item): item is MaterialOfferCandidateSummary => Boolean(item))
    : [];
  const offers = status === "complete" && Array.isArray(material.offers)
    ? material.offers.map(candidateSummary).filter((item): item is MaterialOfferCandidateSummary => Boolean(item && item.qualifying))
    : null;
  if (status === "complete" && offers === null) return null;
  const horizon = record(material.horizon) || {};
  return {
    version: MATERIAL_OFFER_SET_VERSION,
    status,
    offers,
    screenedCandidates,
    classifierVersion: Math.max(0, Math.trunc(finiteNumber(material.classifierVersion))),
    detector: "classifier-sacrifice-offer-tracker",
    policy: String(material.policy || "unknown").slice(0, 120),
    horizon: {
      verificationDepth: horizon.verificationDepth == null ? null : Math.max(0, Math.trunc(finiteNumber(horizon.verificationDepth))),
      materialWindowPlies: horizon.materialWindowPlies == null ? null : Math.max(0, Math.trunc(finiteNumber(horizon.materialWindowPlies))),
      principalVariationPlies: Math.max(0, Math.trunc(finiteNumber(horizon.principalVariationPlies))),
    },
    limitations: Array.isArray(material.limitations) ? material.limitations.map(String).slice(0, 8).map((item) => item.slice(0, 300)) : [],
  };
}

function boundedCandidate(value: unknown, rootFen: string) {
  const item = record(value);
  if (!item) return null;
  const uci = boundedText(item.uci || moveList(item.pv, 1)[0], 8);
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const source = record(item.scoreProvenance);
  const reportedDepth = Math.max(0, Math.trunc(finiteNumber(item.depth)));
  const originKind = boundedText(source?.kind || 'legacy-unknown', 40);
  const originFen = typeof source?.fen === 'string' ? source.fen.slice(0, 120) : null;
  const originatingDepth = source?.originatingDepth == null ? null : nullableNumber(source.originatingDepth);
  const actualDepth = originKind === 'root-search' && originFen === rootFen && originatingDepth === reportedDepth && reportedDepth > 0
    ? originatingDepth : null;
  return {
    uci,
    san: boundedText(item.san, 20),
    scoreCp: nullableNumber(item.scoreCp),
    mate: nullableNumber(item.mate),
    reportedDepth,
    actualDepth,
    scoreOrigin: { kind: originKind, fen: originFen, originatingDepth },
    quality: boundedText(item.quality, 24),
    pv: moveList(item.pv, 10),
  };
}

/**
 * Canonical edge analysis stores bounded alternatives in the classifier's
 * compact `alternative_candidates` shape. Retain its scores and legal lines
 * with the reported depth and score origin, and expose mechanical root/line
 * pointers used by a live `compare_moves` response.  These are intentionally
 * just replayable UCI pointers: scores and lines remain bounded engine facts,
 * and neither pointer asserts why a root is preferable.
 */
function compactComparisonPointers(candidates: Array<NonNullable<ReturnType<typeof boundedCandidate>>>) {
  const rootMoves = [...new Set(candidates.map((candidate) => candidate.uci))];
  const continuationMoveFacts = candidates.flatMap((candidate) => {
    const moves = candidate.pv
      .filter((uci) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci))
      .map((uci) => ({ uci }));
    return moves.length && moves[0].uci === candidate.uci
      ? [{ rootMove: candidate.uci, moves }]
      : [];
  });
  return {
    rootMoves,
    continuationMoveFacts,
  };
}

function legalReplayLine(fen: string, line: string[]) {
  const board = new Chess(fen);
  for (const uci of line) {
    const move = board.moves({ verbose: true }).find((candidate) => `${candidate.from}${candidate.to}${candidate.promotion || ""}` === uci);
    if (!move) return false;
    board.move(move);
  }
  return true;
}

function analysisRecord(input: Omit<ExistingAnalysisRecord, "version" | "id" | "licenses"> & { idSeed: unknown; licenses?: EvidenceLicense[] }): ExistingAnalysisRecord {
  const licenseInput = {
    kind: "context",
    source: input.provenance.provider,
    authority: input.authority,
    proofStrength: factProofStrength(input.authority, { exhaustive: input.coverage.complete, unresolved: input.coverage.unresolved }),
    data: input.data,
    coverage: input.coverage,
    replay: input.replay,
  };
  return {
    version: EXISTING_ANALYSIS_RECORD_VERSION,
    id: `analysis-context:${stableHash(input.idSeed)}`,
    kind: input.kind,
    scope: input.scope,
    authority: input.authority,
    licenses: validateEvidenceLicenseClaims(licenseInput, input.licenses || []),
    summary: input.summary,
    data: input.data,
    coverage: input.coverage,
    provenance: input.provenance,
    replay: input.replay,
    limitations: input.limitations,
  };
}

function selectedEdgeRecords(value: unknown, context: ReasoningPositionContext): ExistingAnalysisRecord[] {
  const snapshot = record(value);
  const selected = record(snapshot?.selectedEdge);
  const analysis = record(selected?.analysis);
  if (!snapshot || snapshot.version !== CANONICAL_EDGE_ANALYSIS_SNAPSHOT_VERSION || !selected || !analysis) return [];
  if (String(selected.moveUci || "") !== context.moveUci || String(selected.moveSan || "") !== context.moveSan) return [];
  const classifierVersion = Math.max(0, Math.trunc(finiteNumber(analysis.classifier_version)));
  const engine = boundedText(analysis.engine || "unknown", 80);
  const result: ExistingAnalysisRecord[] = [];
  const classification = boundedText(analysis.classification, 40);
  if (classification) {
    result.push(analysisRecord({
      idSeed: { kind: "classification.label", context: context.nodeId, classifierVersion, classification },
      kind: "classification.label",
      scope: "selected-edge",
      authority: "heuristic-affordance",
      licenses: [EVIDENCE_LICENSE.ATTENTION_AFFORDANCE],
      summary: `Knight's Eye classified ${context.moveSan} as ${classification} under classifier policy ${classifierVersion}. The label reports the product decision; it does not prove why the move deserves it.`,
      data: { label: classification, classifierVersion, policy: `move-classification-policy/${classifierVersion}`, authoritativeScope: "reported-label-only" },
      coverage: { complete: true, covered: ["reported-label"], unresolved: ["semantic-explanation"] },
      provenance: { tier: ANALYSIS_CONTEXT_PROVENANCE_TIER.POLICY_LABEL, provider: "knights-eye/move-classifier", version: String(classifierVersion), derivedFromIds: [] },
      replay: { moveUci: context.moveUci },
      limitations: ["A user-facing classification label is not independent evidence for its chess explanation."],
    }));
  }

  const legalRoots = new Set(new Chess(context.fenBefore).moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion || ""}`));
  const alternatives = Array.isArray(analysis.alternative_candidates)
    ? analysis.alternative_candidates.map((candidate:unknown) => boundedCandidate(candidate,context.fenBefore)).filter((item): item is NonNullable<ReturnType<typeof boundedCandidate>> => Boolean(item)).slice(0, 5)
      .filter((item) => legalRoots.has(item.uci) && (!item.pv.length || item.pv[0] === item.uci) && legalReplayLine(context.fenBefore, item.pv))
    : [];
  const rawBestMove = boundedText(analysis.bestmove, 8);
  const bestMove = legalRoots.has(rawBestMove) ? rawBestMove : "";
  if (analysis.eval_before != null || analysis.eval_after != null || analysis.mate_before != null || analysis.mate_after != null || bestMove || alternatives.length) {
    const lines = alternatives.map((item) => item.pv).filter((line) => line.length);
    const comparisonPointers = compactComparisonPointers(alternatives);
    const engineData: Record<string, SemanticValue> = {
      engine,
      reportedDepth: Math.max(0, Math.trunc(finiteNumber(analysis.depth || analysis.processing_depth))),
      requestedDepth: Math.max(0, Math.trunc(finiteNumber(analysis.requested_depth))),
      scorePerspective: "selected-mover",
      evaluationBeforeCp: nullableNumber(analysis.eval_before),
      evaluationAfterCpForMover: nullableNumber(analysis.eval_after),
      centipawnLoss: nullableNumber(analysis.cp_loss),
      mateBefore: nullableNumber(analysis.mate_before),
      mateAfterForMover: nullableNumber(analysis.mate_after),
      bestMoveUci: bestMove,
      bestMoveSan: boundedText(analysis.bestmove_san, 20),
      alternatives: alternatives as unknown as SemanticValue,
      // Normalized mechanical pointers let semantic planning/criticism apply
      // the same bounded-comparison coverage rules to canonical analysis and
      // to a live compare_moves result. They deliberately carry no inferred
      // purpose, forcedness, or preference beyond the stored engine record.
      rootMoves: comparisonPointers.rootMoves as unknown as SemanticValue,
      continuationMoveFacts: comparisonPointers.continuationMoveFacts as unknown as SemanticValue,
    };
    result.push(analysisRecord({
      idSeed: { kind: "engine.bounded-assessment", context: context.nodeId, engineData },
      kind: "engine.bounded-assessment",
      scope: "selected-edge",
      authority: "bounded-engine",
      licenses: [EVIDENCE_LICENSE.ENGINE_BOUNDED_SCORE, ...(alternatives.length ? [EVIDENCE_LICENSE.ENGINE_BOUNDED_COMPARISON] : [])],
      summary: `Canonical ${engine} analysis records the bounded evaluation around ${context.moveSan}${bestMove ? ` and the best move ${boundedText(analysis.bestmove_san || bestMove, 20)}` : ""}.`,
      data: engineData,
      coverage: { complete: false, covered: alternatives.map((item) => item.uci), unresolved: ["bounded-search", "human-purpose"] },
      provenance: { tier: ANALYSIS_CONTEXT_PROVENANCE_TIER.RAW_ANALYSIS, provider: `knights-eye/${engine}/compare-moves`, version: boundedText(analysis.tree_analysis_version || "unknown", 40), derivedFromIds: [] },
      // Use the shared evidence replay key so every canonical bounded-engine
      // PV is eligible for a typed move reference only after replaying from
      // this exact request position.  This is identity/legality transport,
      // not an expansion of the engine record's semantic authority.
      replay: { fen: context.fenBefore, fenBefore: context.fenBefore, targetMoveUci: context.moveUci, linesUci: lines as unknown as SemanticValue, depth: Math.max(0, Math.trunc(finiteNumber(analysis.depth || analysis.processing_depth))), threads: 1 },
      limitations: ["A bounded engine comparison establishes only the recorded scores and continuations, not human intent, uniqueness beyond its coverage, or a semantic plan."],
    }));
  }

  const materialExchange = record(analysis.material_exchange);
  if (materialExchange) {
    result.push(analysisRecord({
      idSeed: { kind: "semantic.lifecycle.material-exchange", context: context.nodeId, materialExchange },
      kind: "semantic.lifecycle.material-exchange",
      scope: "selected-edge",
      authority: "heuristic-affordance",
      licenses: [EVIDENCE_LICENSE.ATTENTION_AFFORDANCE],
      summary: `The classifier's attributed material-exchange tracker recorded transition ${boundedText(materialExchange.transition || "unknown", 40)} at ${context.moveSan}.`,
      data: semanticRecord(materialExchange),
      coverage: { complete: false, covered: ["tracked-material-thread"], unresolved: ["semantic-purpose", "compensation"] },
      provenance: { tier: ANALYSIS_CONTEXT_PROVENANCE_TIER.LEGACY_HEURISTIC, provider: "knights-eye/material-exchange-tracker", version: String(classifierVersion), derivedFromIds: [] },
      replay: { moveUci: context.moveUci, fenBefore: context.fenBefore },
      limitations: ["Lifecycle names are attributed reusable context, not proof that the move has a particular purpose or compensation."],
    }));
  }

  const missed = record(analysis.missed_opportunity);
  if (missed) {
    result.push(analysisRecord({
      idSeed: { kind: "classifier.missed-opportunity", context: context.nodeId, missed },
      kind: "classifier.missed-opportunity",
      scope: "selected-edge",
      authority: "heuristic-affordance",
      licenses: [EVIDENCE_LICENSE.ATTENTION_AFFORDANCE],
      summary: `The classifier emitted an attributed missed-opportunity diagnostic for ${context.moveSan}; its underlying fields may guide inspection but do not prove the diagnosis.`,
      data: semanticRecord(missed),
      coverage: { complete: false, covered: ["classifier-diagnostic"], unresolved: ["semantic-explanation"] },
      provenance: { tier: ANALYSIS_CONTEXT_PROVENANCE_TIER.LEGACY_HEURISTIC, provider: "knights-eye/missed-opportunity-diagnostic", version: String(classifierVersion), derivedFromIds: [] },
      replay: { moveUci: context.moveUci, fenBefore: context.fenBefore },
      limitations: ["This diagnostic is an affordance. Its asserted chess meaning requires independent licensed evidence."],
    }));
  }
  return result;
}

function pathRecords(value: unknown, context: ReasoningPositionContext): ExistingAnalysisRecord[] {
  const snapshot = record(value);
  const items = Array.isArray(snapshot?.pathEdges) ? snapshot.pathEdges : [];
  return items.slice(-4).flatMap((raw) => {
    const edge = record(raw);
    const analysis = record(edge?.analysis);
    const lifecycle = record(analysis?.material_exchange);
    const moveUci = boundedText(edge?.moveUci, 8);
    if (!edge || !analysis || !lifecycle || !context.historyUci.includes(moveUci)) return [];
    const classifierVersion = Math.max(0, Math.trunc(finiteNumber(analysis.classifier_version)));
    return [analysisRecord({
      idSeed: { kind: "path.semantic.lifecycle.material-exchange", edgeId: edge.edgeId, lifecycle },
      kind: "path.semantic.lifecycle.material-exchange",
      scope: "path-window",
      authority: "heuristic-affordance",
      licenses: [EVIDENCE_LICENSE.ATTENTION_AFFORDANCE],
      summary: `A prior path edge ${boundedText(edge.moveSan || moveUci, 20)} carries an attributed material-exchange lifecycle record.`,
      data: { edgeId: boundedText(edge.edgeId, 120), moveUci, moveSan: boundedText(edge.moveSan, 20), lifecycle: semanticRecord(lifecycle) },
      coverage: { complete: false, covered: ["bounded-prior-path-record"], unresolved: ["path-relevance", "semantic-purpose"] },
      provenance: { tier: ANALYSIS_CONTEXT_PROVENANCE_TIER.LEGACY_HEURISTIC, provider: "knights-eye/material-exchange-tracker", version: String(classifierVersion), derivedFromIds: [] },
      replay: { historyStartFen: context.historyStartFen || "", historyUci: context.historyUci as unknown as SemanticValue, moveUci },
      limitations: ["Path-scoped lifecycle context is included only as an affordance; the model must establish its relevance independently."],
    })];
  });
}

function wantsPathContext(question: string) {
  return /\b(earlier|later|previous|prior|subsequent|persist(?:s|ed|ent)?|throughout|over the game|offer|sacrific|conversion|develop(?:s|ed|ment)?)\b/i.test(question);
}

export function normalizeExistingAnalysisContext(value: unknown, context: ReasoningPositionContext, options: { question?: string; maxRecords?: number } = {}): ExistingAnalysisContext | null {
  const input = record(value);
  if (!input || (input.version !== EXISTING_ANALYSIS_CONTEXT_VERSION && input.version !== LEGACY_EXISTING_ANALYSIS_CONTEXT_VERSION)) return null;
  const materialOffers = normalizeMaterialOfferSet(input.materialOffers);
  if (!materialOffers) return null;
  const after = new Chess(context.fenAfter);
  for (const candidate of [...materialOffers.screenedCandidates, ...(materialOffers.offers || [])]) {
    if (!after.moves({ verbose: true }).some((move) => `${move.from}${move.to}${move.promotion || ""}` === candidate.captureUci)) return null;
  }
  const allRecords = input.version === EXISTING_ANALYSIS_CONTEXT_VERSION ? [...selectedEdgeRecords(input.canonicalAnalysis, context), ...pathRecords(input.canonicalAnalysis, context)] : [];
  const relevant = allRecords.filter((item) => item.scope === "selected-edge" || wantsPathContext(options.question || ""));
  const omitted: ExistingAnalysisContext["coverage"]["omitted"] = allRecords
    .filter((item) => !relevant.includes(item))
    .map((item) => ({ kind: item.kind, reason: "relevance" }));
  const maximum = Math.max(1, Math.min(16, Math.trunc(options.maxRecords || 8)));
  const records = relevant.slice(0, maximum);
  omitted.push(...relevant.slice(maximum).map((item) => ({ kind: item.kind, reason: "budget" as const })));
  const unavailableKinds = ["classification.policy-definition", "classifier.uniqueness-and-criticality", "semantic.reviewed-idea-graph"];
  if (!record(input.canonicalAnalysis)) unavailableKinds.unshift("canonical.selected-edge-analysis");
  return {
    version: EXISTING_ANALYSIS_CONTEXT_VERSION,
    materialOffers,
    records,
    coverage: { complete: omitted.length === 0 && unavailableKinds.length === 0, includedKinds: [...new Set(records.map((item) => item.kind))], omitted, unavailableKinds },
  };
}

function materialOfferObservation(context: ReasoningPositionContext, material: MaterialOfferSet, contextHash: string, timeline: ReturnType<typeof createPocIdentityTimeline>) {
  const moveParticipant = participant(PARTICIPANT_ROLES.TARGET, REFERENCE_DOMAINS.MOVE, context.moveUci);
  const offerParticipants = material.screenedCandidates.flatMap((candidate) => {
    const pieceId = pieceIdAt(timeline.after, candidate.offeredSquare as Square);
    return pieceId ? [participant(PARTICIPANT_ROLES.SUBJECT, REFERENCE_DOMAINS.PIECE, pieceId)] : [];
  });
  const identity = { provider: EXISTING_ANALYSIS_OBSERVATION_PROVIDER_ID, version: EXISTING_ANALYSIS_CONTEXT_VERSION, classifierVersion: material.classifierVersion, detector: material.detector, policy: material.policy, moveUci: context.moveUci };
  const evidenceId = `evidence:analysis-context:${stableHash({ contextHash, identity, material })}`;
  const observationId = `observation:${stableHash({ contextHash, identity })}`;
  const offerCount = material.offers?.length || 0;
  const summary = offerCount ? `Knight's Eye classifier offer tracking found ${offerCount} qualifying material offer${offerCount === 1 ? "" : "s"} for ${context.moveSan} within its declared policy and horizon.` : `Knight's Eye classifier offer tracking completed for ${context.moveSan} and found no qualifying material offers within its declared policy and horizon.`;
  const coverage = { complete: true, covered: (material.offers || []).map((offer) => `${offer.captureUci}:${offer.offeredSquare}`), unresolved: [] as string[] };
  const data = { observationId, observationType: "analysis-context:material-offer-set", authority: "heuristic-affordance", offers: (material.offers || []) as unknown as SemanticValue, screenedCandidates: material.screenedCandidates as unknown as SemanticValue, classifierVersion: material.classifierVersion, detector: material.detector, policy: material.policy, horizon: material.horizon as unknown as SemanticValue };
  const evidence: ReasoningEvidenceRecord = withEvidenceLicenses({ schemaVersion: REASONING_POC_VERSION, id: evidenceId, contextHash, kind: "context", source: `${EXISTING_ANALYSIS_OBSERVATION_PROVIDER_ID}/${EXISTING_ANALYSIS_CONTEXT_VERSION}/classifier-${material.classifierVersion}`, proofStrength: null, summary: `${summary} This attributed classifier result is an observation, not independent proof of chess meaning.`, data, coverage, replay: { moveUci: context.moveUci, detector: material.detector, classifierVersion: material.classifierVersion, policy: material.policy }, licenses: [EVIDENCE_LICENSE.ATTENTION_AFFORDANCE] });
  const observation: ReasoningObservation = { schemaVersion: REASONING_POC_VERSION, id: observationId, contextHash, observationType: "analysis-context:material-offer-set", participants: [moveParticipant, ...offerParticipants], attributes: { authority: "heuristic-affordance", offers: (material.offers || []) as unknown as SemanticValue, screenedCandidates: material.screenedCandidates as unknown as SemanticValue, coverageComplete: true, detector: material.detector, policy: material.policy, classifierVersion: material.classifierVersion, horizon: material.horizon as unknown as SemanticValue }, exactness: "heuristic", provenance: { provider: EXISTING_ANALYSIS_OBSERVATION_PROVIDER_ID, version: EXISTING_ANALYSIS_CONTEXT_VERSION, trust: "deterministic", methods: [material.detector, material.policy] }, factEvidenceIds: [evidenceId], probeRecipes: [] };
  return { evidence, observation };
}

export class ExistingAnalysisObservationProvider implements ObservationProvider {
  readonly id = EXISTING_ANALYSIS_OBSERVATION_PROVIDER_ID;
  readonly version = EXISTING_ANALYSIS_CONTEXT_VERSION;

  constructor(
    private readonly existing: ExistingAnalysisContext | null,
    private readonly mode: ExistingAnalysisContextMode = EXISTING_ANALYSIS_CONTEXT_MODE.FULL,
  ) {}

  observe(context: ReasoningPositionContext, _controls: ReasoningRunControls, signal?: AbortSignal): ReasoningObservationSet {
    if (signal?.aborted) throw signal.reason || new Error("Existing-analysis observation extraction cancelled");
    const contextHash = reasoningContextHash(context);
    const existing = this.existing;
    if (!existing || this.mode === EXISTING_ANALYSIS_CONTEXT_MODE.HIDDEN) {
      return {
        schemaVersion: REASONING_POC_VERSION,
        contextHash,
        observations: [],
        evidence: [],
        providers: [{ provider: this.id, version: this.version }],
        limitations: [this.mode === EXISTING_ANALYSIS_CONTEXT_MODE.HIDDEN
          ? "Existing analysis context was deliberately hidden by the development ablation control."
          : "No valid existing analysis context was available for this selected edge."],
      };
    }
    const timeline = createPocIdentityTimeline(context);
    const includeLabels = this.mode === EXISTING_ANALYSIS_CONTEXT_MODE.LABEL_ONLY || this.mode === EXISTING_ANALYSIS_CONTEXT_MODE.FULL;
    const includeDiagnostics = this.mode === EXISTING_ANALYSIS_CONTEXT_MODE.DIAGNOSTICS_ONLY || this.mode === EXISTING_ANALYSIS_CONTEXT_MODE.FULL;
    const materialAvailable = includeDiagnostics && existing.materialOffers.status === "complete" && Array.isArray(existing.materialOffers.offers);
    const observations: ReasoningObservation[] = [];
    const evidence: ReasoningEvidenceRecord[] = [];
    if (materialAvailable) {
      const material = materialOfferObservation(context, existing.materialOffers, contextHash, timeline);
      observations.push(material.observation);
      evidence.push(material.evidence);
    }
    const selectedRecords = existing.records.filter((item) => item.kind === "classification.label" ? includeLabels : includeDiagnostics);
    const providers = [
      { provider: this.id, version: this.version },
      ...Array.from(new Map(selectedRecords.map((item) => [
        `${item.provenance.provider}\u0000${item.provenance.version}`,
        { provider: item.provenance.provider, version: item.provenance.version },
      ])).values()),
    ];
    for (const item of selectedRecords) {
      if (!isChessFactAuthority(item.authority)) continue;
      const observationId = `observation:${stableHash({ contextHash, analysisRecordId: item.id })}`;
      const evidenceId = `evidence:${stableHash({ contextHash, analysisRecordId: item.id })}`;
      const pathMoveUci = item.scope === "path-window" ? String(item.data.moveUci || "") : "";
      const participants = pathMoveUci && context.historyUci.includes(pathMoveUci)
        ? [
          participant(PARTICIPANT_ROLES.SUBJECT, REFERENCE_DOMAINS.MOVE, pathMoveUci),
          participant(PARTICIPANT_ROLES.TARGET, REFERENCE_DOMAINS.MOVE, context.moveUci),
        ]
        : [participant(PARTICIPANT_ROLES.TARGET, REFERENCE_DOMAINS.MOVE, context.moveUci)];
      evidence.push(withEvidenceLicenses({ schemaVersion: REASONING_POC_VERSION, id: evidenceId, contextHash, kind: "context", source: `${item.provenance.provider}/${item.provenance.version}`, proofStrength: factProofStrength(item.authority, { exhaustive: item.coverage.complete, unresolved: item.coverage.unresolved }), summary: item.summary, data: { observationId, observationType: `analysis-context:${item.kind}`, authority: item.authority, provenanceTier: item.provenance.tier, analysisRecordId: item.id, analysis: item.data }, coverage: item.coverage, replay: item.replay, licenses: item.licenses }));
      observations.push({ schemaVersion: REASONING_POC_VERSION, id: observationId, contextHash, observationType: `analysis-context:${item.kind}`, participants, attributes: { authority: item.authority, provenanceTier: item.provenance.tier, analysisRecordId: item.id, data: item.data, coverage: item.coverage as unknown as SemanticValue }, exactness: item.authority === "legal-exact" || item.authority === "deterministic-derived" ? "exact" : "heuristic", provenance: { provider: item.provenance.provider, version: item.provenance.version, trust: item.provenance.tier === ANALYSIS_CONTEXT_PROVENANCE_TIER.RAW_ANALYSIS ? "external" : "deterministic", methods: [item.kind, item.provenance.tier] }, factEvidenceIds: [evidenceId], probeRecipes: [] });
    }
    return {
      schemaVersion: REASONING_POC_VERSION,
      contextHash,
      observations,
      evidence,
      providers,
      limitations: [
        ...(materialAvailable ? existing.materialOffers.limitations : []),
        ...(materialAvailable ? ["An empty offers array means this named tracker completed its declared policy and horizon and found none; it is not proof that no conceivable sacrifice exists."] : []),
        `Existing analysis context ablation mode: ${this.mode}. Omitted context families were deliberately withheld from this development run.`,
        "Existing analysis context may affect attention, hypothesis formation, comparison, and tool choice. It does not become chess truth merely because Knight's Eye stored it.",
        "The final classification label is authoritative only about what Knight's Eye called the move; it is not proof of the explanation behind that label.",
        "Anti-circularity: a policy label derived from semantic state cannot be reused as independent evidence for reconstructing or validating that same state.",
        ...selectedRecords.flatMap((item) => item.limitations),
        ...existing.coverage.unavailableKinds.map((kind) => `Existing analysis context kind ${kind} is unavailable in this adapter version.`),
      ],
    };
  }
}
