import { Chess, SQUARES } from "chess.js";
import {
  createAblationEvidenceClosureBundle,
  enrichAblationEvidenceClosureBundle,
  type AblationEvidenceClosureBundle,
  type AblationEvidenceClosureCoverage,
  type AblationEvidenceReferenceAllowlists,
} from "./ablation-evidence-bundle";
import { REFERENCE_DOMAINS } from "./concept-registry";
import { chessFactRecordLicenses, factProofStrength, type ChessFactRecord } from "./fact-provider";
import { deriveAdmittedCaptureResponseAvailabilityFact } from "./mechanical-fact-provider";
import { collectReasoningMoveWitnesses } from "./poc-move-witnesses";
import { createPocIdentityTimeline } from "./poc-piece-refs";
import {
  REASONING_POC_VERSION,
  reasoningContextHash,
  validateReasoningPositionContext,
  type ReasoningEvidenceRecord,
  type ReasoningObservation,
  type ReasoningObservationSet,
  type ReasoningPositionContext,
  type ReasoningRankedObservationSet,
  type ReasoningToolName,
  type ReasoningToolResult,
} from "./poc-contracts";
import { stableJson } from "./stable";
import type { SemanticValue } from "./types";

/**
 * The capture boundary is deliberately narrower than a full reasoning trace:
 * it accepts only the completed evidence-acquisition phase.  No model-created
 * hypothesis, review, graph, or answer state can cross this boundary.
 */
export const ABLATION_EVIDENCE_CAPTURE_VERSION = "architecture-ablation-evidence-capture/1" as const;
export const CAPTURE_RESPONSE_FACT_KIND = "move.capture_response_availability_after" as const;
export const COMPLETED_TOOL_REPLAY_ADMISSION_KEY = "ablationCompletedToolReplayAdmission" as const;
const COMPLETED_TOOL_REPLAY_ADMISSION_VERSION = "architecture-ablation-completed-tool-replay-admission/1" as const;

const PRESEMANTIC_TOOL_NAMES = new Set<ReasoningToolName>([
  "finish_evidence_collection",
  "inspect_position",
  "analyze_move",
  "explore_continuations",
  "compare_moves",
  "enumerate_defenses",
  "test_line",
]);
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export type AblationEvidenceCaptureInput = {
  context: ReasoningPositionContext;
  question: string;
  /** Provider output before salience; retained to make membership auditable. */
  observations: ReasoningObservationSet;
  /** The exact output of the production salience policy for `observations`. */
  rankedObservations: ReasoningRankedObservationSet;
  /** Already completed fact/probe calls from the evidence phase. */
  admittedToolResults?: readonly ReasoningToolResult[];
  /**
   * Retain exact fact records that the supplied salience result explicitly
   * presents. This is for consumers whose model packet is defined by that
   * production presentation decision; the original 2x2 baseline remains
   * response-fact-withheld by default.
   */
  retainPresentedExactFacts?: boolean;
  /** Generic acquisition keeps every admitted record discoverable; frozen 2x2 defaults stay unchanged. */
  retainAllExactFacts?: boolean;
};

type AdmittedReplayLine = {
  evidenceId: string;
  start: "before" | "after";
  movesUci: string[];
};

type CompletedToolReplayAdmission = {
  schemaVersion: typeof COMPLETED_TOOL_REPLAY_ADMISSION_VERSION;
  tool: ReasoningToolName;
  callId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasCallerSuppliedReplayAdmission(record: ReasoningEvidenceRecord): boolean {
  return isRecord(record.replay) && COMPLETED_TOOL_REPLAY_ADMISSION_KEY in record.replay;
}

function withCompletedToolReplayAdmission(
  record: ReasoningEvidenceRecord,
  result: Pick<ReasoningToolResult, "tool" | "callId">,
): ReasoningEvidenceRecord {
  if (!isRecord(record.replay)) return clone(record);
  if (hasCallerSuppliedReplayAdmission(record)) {
    throw new Error(`Ablation evidence ${record.id} cannot supply its own completed-tool replay admission`);
  }
  const admission: CompletedToolReplayAdmission = {
    schemaVersion: COMPLETED_TOOL_REPLAY_ADMISSION_VERSION,
    tool: result.tool,
    callId: result.callId,
  };
  return {
    ...clone(record),
    replay: {
      ...clone(record.replay),
      [COMPLETED_TOOL_REPLAY_ADMISSION_KEY]: admission,
    },
  };
}

function completedToolReplayAdmission(value: unknown): CompletedToolReplayAdmission | null {
  if (!isRecord(value)) return null;
  const admission = value[COMPLETED_TOOL_REPLAY_ADMISSION_KEY];
  if (!isRecord(admission)
    || Object.keys(admission).sort().join(",") !== "callId,schemaVersion,tool"
    || admission.schemaVersion !== COMPLETED_TOOL_REPLAY_ADMISSION_VERSION
    || typeof admission.callId !== "string" || !admission.callId.trim() || admission.callId.length > 500
    || typeof admission.tool !== "string" || !PRESEMANTIC_TOOL_NAMES.has(admission.tool as ReasoningToolName)) {
    return null;
  }
  return admission as CompletedToolReplayAdmission;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sortedUnique(values: readonly string[]): string[] {
  if (values.some((value) => typeof value !== "string" || !value.trim())) throw new Error("Expected non-empty deterministic identifiers");
  return [...new Set(values)].sort();
}

function responseEvidence(record: ReasoningEvidenceRecord): boolean {
  return isRecord(record.data) && record.data.kind === CAPTURE_RESPONSE_FACT_KIND;
}

function responseObservation(observation: ReasoningObservation): boolean {
  return observation.observationType === `chess-fact:${CAPTURE_RESPONSE_FACT_KIND}`
    || observation.attributes.factKind === CAPTURE_RESPONSE_FACT_KIND;
}

function assertNoSemanticState(value: unknown, path = "capture input"): void {
  if (Array.isArray(value)) return void value.forEach((item, index) => assertNoSemanticState(item, `${path}[${index}]`));
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (["hypotheses", "relations", "selectedEntities", "selectedRelations", "dispositions", "answer", "claims", "evaluatorAnchor", "idealProse"].includes(key)) {
      throw new Error(`Ablation evidence capture cannot admit semantic state at ${path}.${key}`);
    }
    assertNoSemanticState(child, `${path}.${key}`);
  }
}

function assertContextAndQuestion(context: ReasoningPositionContext, question: string): { context: ReasoningPositionContext; contextHash: string } {
  const checked = validateReasoningPositionContext(clone(context));
  if (typeof question !== "string" || !question.trim() || question.trim().length > 4_000) throw new Error("Ablation evidence capture requires a bounded verbatim question");
  return { context: checked, contextHash: reasoningContextHash(checked) };
}

function assertObservationSets(
  raw: ReasoningObservationSet,
  ranked: ReasoningRankedObservationSet,
  contextHash: string,
): ReasoningRankedObservationSet["observations"] {
  assertNoSemanticState(raw);
  assertNoSemanticState(ranked);
  if (raw.schemaVersion !== REASONING_POC_VERSION || ranked.schemaVersion !== REASONING_POC_VERSION
    || raw.contextHash !== contextHash || ranked.contextHash !== contextHash
    || !Array.isArray(raw.observations) || !Array.isArray(ranked.observations)
    || !Array.isArray(raw.evidence) || !Array.isArray(ranked.evidence)
    || !ranked.saliencePolicy?.trim()) {
    throw new Error("Ablation evidence capture received malformed raw or ranked observations");
  }
  const rawById = new Map(raw.observations.map((observation) => [observation.id, observation]));
  if (rawById.size !== raw.observations.length || ranked.observations.length !== raw.observations.length) {
    throw new Error("Ablation evidence capture requires a one-to-one raw/ranked observation set");
  }
  for (const observation of ranked.observations) {
    const unranked = rawById.get(observation.id);
    if (!unranked || observation.contextHash !== contextHash || unranked.contextHash !== contextHash
      || typeof observation.salience !== "number" || !Number.isFinite(observation.salience)
      || observation.salience < 0 || observation.salience > 1 || !Array.isArray(observation.salienceReasons)
      || typeof observation.presentedToModel !== "boolean") {
      throw new Error("Ablation evidence capture received a malformed ranked observation");
    }
    const { salience: _salience, salienceReasons: _reasons, presentedToModel: _presented, ...base } = observation;
    void _salience; void _reasons; void _presented;
    if (stableJson(base) !== stableJson(unranked)) {
      throw new Error(`Ablation salience altered observation meaning or membership: ${observation.id}`);
    }
  }
  return ranked.observations.map((observation) => clone(observation));
}

function admittedEvidence(
  raw: ReasoningObservationSet,
  results: readonly ReasoningToolResult[],
  contextHash: string,
): { evidence: ReasoningEvidenceRecord[]; toolNames: ReasoningToolName[]; limitations: string[] } {
  const evidence = new Map<string, ReasoningEvidenceRecord>();
  const append = (record: ReasoningEvidenceRecord) => {
    if (!record || record.schemaVersion !== REASONING_POC_VERSION || record.contextHash !== contextHash
      || !record.id?.trim() || !["context", "fact", "probe"].includes(record.kind)) {
      throw new Error("Ablation evidence capture received non-presemantic or cross-context evidence");
    }
    assertNoSemanticState(record, `evidence:${record.id}`);
    const previous = evidence.get(record.id);
    if (previous && stableJson(previous) !== stableJson(record)) throw new Error(`Ablation evidence capture has conflicting admitted evidence ${record.id}`);
    evidence.set(record.id, clone(record));
  };
  raw.evidence.forEach((record) => {
    if (hasCallerSuppliedReplayAdmission(record)) {
      throw new Error(`Provider evidence ${record.id} cannot self-authorize a completed-tool replay`);
    }
    append(record);
  });
  const toolNames = new Set<ReasoningToolName>();
  const limitations = new Set<string>(raw.limitations || []);
  for (const result of results) {
    assertNoSemanticState(result, `tool-result:${result.callId || "unknown"}`);
    if (result.schemaVersion !== REASONING_POC_VERSION || result.contextHash !== contextHash
      || !result.callId?.trim() || result.callId.length > 500 || !PRESEMANTIC_TOOL_NAMES.has(result.tool)
      || !["supported", "insufficient-evidence", "unsupported"].includes(result.support)
      || !Array.isArray(result.evidence) || !Array.isArray(result.limitations)
      || !Number.isFinite(result.durationMs) || result.durationMs < 0) {
      throw new Error("Ablation evidence capture can admit only completed presemantic fact/probe tool results");
    }
    toolNames.add(result.tool);
    result.evidence.forEach((record) => append(withCompletedToolReplayAdmission(record, result)));
    result.limitations.forEach((limitation) => {
      if (typeof limitation !== "string" || !limitation.trim()) throw new Error("Ablation evidence capture tool limitation must be a non-empty string");
      limitations.add(limitation);
    });
  }
  return { evidence: [...evidence.values()].sort((left, right) => left.id.localeCompare(right.id)), toolNames: [...toolNames].sort() as ReasoningToolName[], limitations: [...limitations].sort() };
}

function responseLinkedObservation(observation: ReasoningObservation, responseIds: Set<string>): boolean {
  return observation.factEvidenceIds.some((id) => responseIds.has(id))
    || (responseObservation(observation) && observation.factEvidenceIds.length === 0);
}

function referenceAllowlists(
  context: ReasoningPositionContext,
  observations: readonly ReasoningObservation[],
  evidence: readonly ReasoningEvidenceRecord[],
  toolNames: readonly ReasoningToolName[],
): AblationEvidenceReferenceAllowlists {
  const timeline = createPocIdentityTimeline(context);
  const knownPieces = new Set([...Object.keys(timeline.before.pieces), ...Object.keys(timeline.after.pieces)]);
  const witnesses = collectReasoningMoveWitnesses(evidence, context);
  const knownMoves = new Set([...context.historyUci, ...(context.kind === "position" ? [] : [context.moveUci]), ...witnesses.map((witness) => witness.uci)]);
  const references = new Map<string, { domain: "piece" | "square" | "move"; id: string }>();
  for (const observation of observations) {
    for (const participant of observation.participants) {
      const ref = participant.ref;
      if (ref.domain === REFERENCE_DOMAINS.PIECE) {
        if (!knownPieces.has(ref.id)) throw new Error(`Ablation capture references an unknown stable piece ${ref.id}`);
      } else if (ref.domain === REFERENCE_DOMAINS.SQUARE) {
        if (!SQUARES.includes(ref.id as typeof SQUARES[number])) throw new Error(`Ablation capture references an unknown square ${ref.id}`);
      } else if (ref.domain === REFERENCE_DOMAINS.MOVE) {
        if (!knownMoves.has(ref.id)) throw new Error(`Ablation capture references a move absent from context/evidence ${ref.id}`);
      } else {
        throw new Error(`Ablation capture references unsupported semantic domain ${String(ref.domain)}`);
      }
      references.set(`${ref.domain}:${ref.id}`, { domain: ref.domain, id: ref.id });
    }
  }
  if (context.kind !== "position") references.set(`move:${context.moveUci}`, { domain: "move", id: context.moveUci });
  return {
    evidenceIds: evidence.map((record) => record.id),
    observationIds: observations.map((observation) => observation.id),
    toolNames: [...toolNames].sort(),
    semanticReferences: [...references.values()].sort((left, right) => `${left.domain}:${left.id}`.localeCompare(`${right.domain}:${right.id}`)),
    moveWitnesses: witnesses,
  };
}

function originalCoverage(
  allObservations: readonly ReasoningObservation[],
  allEvidence: readonly ReasoningEvidenceRecord[],
  withheldObservations: readonly ReasoningObservation[],
  withheldEvidence: readonly ReasoningEvidenceRecord[],
  inheritedLimitations: readonly string[],
): AblationEvidenceClosureCoverage {
  return {
    complete: false,
    covered: sortedUnique([
      "pre-salience-observation-membership",
      "production-ranked-observation-membership",
      "admitted-presemantic-evidence",
      ...allObservations.map((observation) => `observation:${observation.id}`),
      ...allEvidence.map((record) => `evidence:${record.id}`),
    ]),
    omitted: [
      ...withheldObservations.map((observation) => ({ domain: "observation" as const, id: observation.id, reason: "withheld" as const })),
      ...withheldEvidence.map((record) => ({ domain: "evidence" as const, id: record.id, reason: "withheld" as const })),
    ].sort((left, right) => `${left.domain}:${left.id}`.localeCompare(`${right.domain}:${right.id}`)),
    unavailable: [],
    limitations: sortedUnique([
      "This immutable closure contains only supplied, already-admitted presemantic evidence; no evidence discovery occurred during capture.",
      ...(withheldEvidence.length ? ["Response-availability facts are deliberately withheld from the original 2x2 baseline."] : []),
      ...inheritedLimitations,
    ]),
  };
}

/** Freeze the evidence-acquisition state without allowing semantic artifacts across the boundary. */
export function captureAblationOriginalEvidenceBundle(input: AblationEvidenceCaptureInput): Readonly<AblationEvidenceClosureBundle> {
  const { context, contextHash } = assertContextAndQuestion(input.context, input.question);
  const ranked = assertObservationSets(input.observations, input.rankedObservations, contextHash);
  const admitted = admittedEvidence(input.observations, input.admittedToolResults || [], contextHash);
  const presentedExactFactEvidenceIds = new Set(input.retainPresentedExactFacts
    ? ranked.filter((observation) => observation.presentedToModel && observation.exactness === "exact")
      .flatMap((observation) => observation.factEvidenceIds)
    : []);
  const withheldEvidence = admitted.evidence.filter((record) => (
    responseEvidence(record) && !input.retainAllExactFacts && !presentedExactFactEvidenceIds.has(record.id)
  ));
  const withheldEvidenceIds = new Set(withheldEvidence.map((record) => record.id));
  const withheldObservations = ranked.filter((observation) => (
    responseLinkedObservation(observation, withheldEvidenceIds)
  ));
  const evidence = admitted.evidence.filter((record) => !withheldEvidenceIds.has(record.id));
  const observations = ranked.filter((observation) => !responseLinkedObservation(observation, withheldEvidenceIds));
  const allowedEvidenceIds = new Set(evidence.map((record) => record.id));
  if (observations.some((observation) => observation.factEvidenceIds.some((id) => !allowedEvidenceIds.has(id)))) {
    throw new Error("Ablation original closure cannot retain an observation whose response evidence was withheld");
  }
  return createAblationEvidenceClosureBundle({
    context,
    question: input.question,
    observations,
    evidence,
    referenceAllowlists: referenceAllowlists(context, observations, evidence, admitted.toolNames),
    coverage: originalCoverage(observations, evidence, withheldObservations, withheldEvidence, admitted.limitations),
  });
}

function phaseForReplayFen(context: ReasoningPositionContext, value: unknown): "before" | "after" | null {
  if (typeof value !== "string") return null;
  try {
    const fen = new Chess(value).fen();
    if (fen === new Chess(context.fenBefore).fen()) return "before";
    if (fen === new Chess(context.fenAfter).fen()) return "after";
  } catch {
    return null;
  }
  return null;
}

function explicitReplayLines(context: ReasoningPositionContext, evidence: readonly ReasoningEvidenceRecord[]): AdmittedReplayLine[] {
  const lines = new Map<string, AdmittedReplayLine>();
  for (const record of evidence) {
    // Only an admitted evidence-phase tool result may introduce a path beyond
    // the target. Provider fact replays are verification witnesses, not an
    // authorization to mine every provider record for a new continuation.
    const admission = completedToolReplayAdmission(record.replay);
    if ((record.kind !== "probe" && !admission) || !isRecord(record.replay)) continue;
    const start = phaseForReplayFen(context, record.replay.fen ?? record.replay.fenAfter);
    if (!start) continue;
    const supplied: unknown[] = [];
    if (Array.isArray(record.replay.movesUci)) supplied.push(record.replay.movesUci);
    // `test_line` calls its exact legal witness `moves`. It is admissible only
    // with the capture-owned completed-tool marker above; provider fact replay
    // fields never authorize continuation mining.
    if (admission && Array.isArray(record.replay.moves)) supplied.push(record.replay.moves);
    if (Array.isArray(record.replay.linesUci)) supplied.push(...record.replay.linesUci);
    for (const candidate of supplied) {
      if (!Array.isArray(candidate) || !candidate.length || candidate.some((move) => typeof move !== "string" || !UCI.test(move))) {
        throw new Error(`Admitted evidence ${record.id} has a malformed replay line`);
      }
      const movesUci = candidate as string[];
      const key = `${record.id}:${start}:${movesUci.join(",")}`;
      lines.set(key, { evidenceId: record.id, start, movesUci: [...movesUci] });
    }
  }
  return [...lines.values()].sort((left, right) => `${left.evidenceId}:${left.start}:${left.movesUci.join(",")}`.localeCompare(`${right.evidenceId}:${right.start}:${right.movesUci.join(",")}`));
}

function finalMoveIsCapture(context: ReasoningPositionContext, line: Pick<AdmittedReplayLine, "start" | "movesUci">): boolean {
  const board = new Chess(line.start === "before" ? context.fenBefore : context.fenAfter);
  for (const [index, uci] of line.movesUci.entries()) {
    const move = board.moves({ verbose: true }).find((candidate) => `${candidate.from}${candidate.to}${candidate.promotion || ""}` === uci);
    if (!move) throw new Error(`Admitted evidence replay is illegal at ply ${index}: ${uci}`);
    if (index === line.movesUci.length - 1) return Boolean(move.captured);
    board.move({ from: move.from, to: move.to, promotion: move.promotion });
  }
  return false;
}

function factAsEvidence(fact: ChessFactRecord, derivedFromEvidenceIds: readonly string[]): ReasoningEvidenceRecord {
  const evidenceId = `evidence:${fact.id}`;
  return {
    schemaVersion: REASONING_POC_VERSION,
    id: evidenceId,
    contextHash: fact.contextHash,
    kind: "fact",
    source: `${fact.provenance.provider}@${fact.provenance.version}`,
    proofStrength: factProofStrength(fact.authority, fact.coverage),
    licenses: chessFactRecordLicenses(fact),
    summary: fact.summary,
    data: {
      factId: fact.id,
      kind: fact.kind,
      phase: fact.phase,
      authority: fact.authority,
      participants: fact.participants as unknown as SemanticValue,
      data: fact.data,
      coverage: fact.coverage as unknown as SemanticValue,
      provenance: fact.provenance as unknown as SemanticValue,
      derivedFromEvidenceIds: [...derivedFromEvidenceIds].sort(),
      captureVersion: ABLATION_EVIDENCE_CAPTURE_VERSION,
    },
    coverage: {
      complete: fact.coverage.exhaustive && fact.coverage.unresolved.length === 0,
      covered: [...fact.coverage.covered],
      unresolved: [...fact.coverage.unresolved],
    },
    replay: fact.replay,
  };
}

function factAsObservation(fact: ChessFactRecord, evidenceId: string, derivedFromEvidenceIds: readonly string[]): ReasoningObservation {
  return {
    schemaVersion: REASONING_POC_VERSION,
    id: `observation:${fact.id}`,
    contextHash: fact.contextHash,
    observationType: `chess-fact:${fact.kind}`,
    participants: fact.participants.map((participant) => ({ ...participant, ref: { ...participant.ref } })),
    attributes: {
      factId: fact.id,
      factKind: fact.kind,
      phase: fact.phase,
      authority: fact.authority,
      data: fact.data,
      coverage: fact.coverage as unknown as SemanticValue,
      derivedFromEvidenceIds: [...derivedFromEvidenceIds].sort(),
      captureVersion: ABLATION_EVIDENCE_CAPTURE_VERSION,
    },
    exactness: fact.authority === "heuristic-affordance" ? "heuristic" : "exact",
    provenance: {
      provider: fact.provenance.provider,
      version: fact.provenance.version,
      trust: fact.authority === "bounded-engine" ? "external" : "deterministic",
      methods: [fact.provenance.method, ABLATION_EVIDENCE_CAPTURE_VERSION],
    },
    factEvidenceIds: [evidenceId],
    probeRecipes: [],
  };
}

/**
 * Derive the opt-in response-availability cell strictly from the immutable
 * original closure. `null` means that the target/its already-admitted lines
 * contain no capture, so the 2x2 experiment has no enriched cell to run.
 */
export function enrichAblationEvidenceBundleWithAdmittedCaptureResponses(
  original: Readonly<AblationEvidenceClosureBundle>,
): Readonly<AblationEvidenceClosureBundle> | null {
  if (original.lineage.kind !== "original") throw new Error("Capture-response enrichment requires an original evidence bundle");
  const candidates: AdmittedReplayLine[] = [];
  const targetLine: AdmittedReplayLine = { evidenceId: "context:target-move", start: "before", movesUci: [original.context.moveUci] };
  if (original.context.kind !== "position" && finalMoveIsCapture(original.context, targetLine)) candidates.push(targetLine);
  for (const line of explicitReplayLines(original.context, original.evidence)) {
    if (finalMoveIsCapture(original.context, line)) candidates.push(line);
  }
  const byFactId = new Map<string, { fact: ChessFactRecord; sources: Set<string> }>();
  for (const candidate of candidates) {
    const fact = deriveAdmittedCaptureResponseAvailabilityFact({
      context: original.context,
      contextHash: original.contextHash,
      start: candidate.start,
      movesUci: candidate.movesUci,
    });
    const existing = byFactId.get(fact.id);
    if (existing) existing.sources.add(candidate.evidenceId);
    else byFactId.set(fact.id, { fact, sources: new Set([candidate.evidenceId]) });
  }
  const additions = [...byFactId.values()].sort((left, right) => left.fact.id.localeCompare(right.fact.id));
  if (!additions.length) return null;
  const evidence = additions.map(({ fact, sources }) => factAsEvidence(fact, [...sources]));
  const observations = additions.map(({ fact, sources }) => factAsObservation(fact, `evidence:${fact.id}`, [...sources]));
  const combinedEvidence = [...original.evidence, ...evidence];
  const combinedObservations = [...original.observations, ...observations];
  return enrichAblationEvidenceClosureBundle(original, {
    evidence,
    observations,
    referenceAllowlists: referenceAllowlists(
      original.context,
      combinedObservations,
      combinedEvidence,
      original.referenceAllowlists.toolNames,
    ),
    coverage: {
      complete: false,
      covered: sortedUnique([
        ...original.coverage.covered,
        "response-availability-from-admitted-captures",
        ...evidence.map((record) => `evidence:${record.id}`),
      ]),
      omitted: original.coverage.omitted.filter((item) => (
        !evidence.some((record) => record.id === item.id)
        && !observations.some((observation) => observation.id === item.id)
      )),
      unavailable: [...original.coverage.unavailable],
      limitations: sortedUnique([
        ...original.coverage.limitations,
        "Response availability is exhaustive only for each already-admitted capture's immediate same-square recaptures; it does not discover a continuation or establish exchange quality.",
      ]),
    },
  });
}
