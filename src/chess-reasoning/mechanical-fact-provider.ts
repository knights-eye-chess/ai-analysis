import { Chess, SQUARES, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import { PARTICIPANT_ROLES, REFERENCE_DOMAINS } from "./concept-registry";
import {
  CHESS_FACT_RESULT_VERSION,
  CHESS_FACT_SCHEMA_VERSION,
  CHESS_FACT_REQUEST_VERSION,
  validateChessFactRecord,
  validateChessFactRequest,
  type ChessFactAuthority,
  type ChessFactCapability,
  type ChessFactCoverage,
  type ChessFactPhase,
  type ChessFactProvider,
  type ChessFactRecord,
  type ChessFactRequest,
  type ChessFactResult,
} from "./fact-provider";
import { reasoningContextHash, validateReasoningPositionContext, type ReasoningPositionContext } from "./poc-contracts";
import { createPocIdentityTimeline, pieceIdAt } from "./poc-piece-refs";
import { applyIdentityMove } from "./piece-identities";
import { exchangeRayAlignmentWitnesses } from "./mechanical-ray-facts";
import { stableHash } from "./stable";
import type { IdentityState, RegistryKey, SemanticParticipant, SemanticValue } from "./types";

export const MECHANICAL_CHESS_FACT_PROVIDER_ID = "knights-eye/mechanical-chess-facts" as const;
export const MECHANICAL_CHESS_FACT_PROVIDER_VERSION = "mechanical-chess-facts/18" as const;

const MAX_FACT_SUMMARY_CHARACTERS = 1_000;

const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

const NOMINAL_VALUES: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const CAPABILITIES: readonly ChessFactCapability[] = Object.freeze([
  { kind: "castling.king_rook_transition", phases: ["transition"], authorities: ["legal-exact"], coverageDomains: ["target-move"], expandable: true, limitations: [] },
  { kind: "king.check_state", phases: ["before", "after"], authorities: ["legal-exact"], coverageDomains: ["side-to-move-check-state"], expandable: true, limitations: [] },
  { kind: "king.checkers_after", phases: ["after"], authorities: ["legal-exact"], coverageDomains: ["checking-pieces-after"], expandable: true, limitations: [] },
  { kind: "king.legal_moves", phases: ["after"], authorities: ["legal-exact"], coverageDomains: ["legal-king-moves-after"], expandable: true, limitations: ["This is exhaustive for king moves, not for every legal response."] },
  { kind: "king.geometry_after", phases: ["after"], authorities: ["legal-exact"], coverageDomains: ["king-square-geometry-after"], expandable: true, limitations: ["Distance and alignment are exact geometry, not an opposition or zugzwang label."] },
  { kind: "king_rook.castling_history", phases: ["path"], authorities: ["legal-exact"], coverageDomains: ["prior-castling-events"], expandable: true, limitations: ["A prior castling event does not by itself establish current king safety or the purpose of the target move."] },
  { kind: "line.occupied_ray_alignment_after_exchange", phases: ["path"], authorities: ["legal-exact"], coverageDomains: ["new-opposing-slider-ray-alignments-with-higher-value-rear-piece-after-one-legal-exchange-witness"], expandable: true, limitations: ["An exact newly created occupied ray does not by itself establish a pin, tactic, forced continuation, or favorable exchange."] },
  { kind: "material.inventory", phases: ["after"], authorities: ["legal-exact"], coverageDomains: ["after-position-piece-inventory"], expandable: true, limitations: [] },
  { kind: "material.nominal_delta", phases: ["transition"], authorities: ["deterministic-derived"], coverageDomains: ["target-move-material"], expandable: true, limitations: ["Nominal values are arithmetic, not an engine evaluation or exchange proof."] },
  { kind: "move.blocks_check_line", phases: ["transition"], authorities: ["legal-exact"], coverageDomains: ["target-move-check-resolution"], expandable: true, limitations: [] },
  { kind: "move.capture_check_delta", phases: ["transition"], authorities: ["legal-exact"], coverageDomains: ["target-move-capture-check"], expandable: true, limitations: [] },
  { kind: "move.capture_response_availability_after", phases: ["after"], authorities: ["deterministic-derived"], coverageDomains: ["target-capture-pre-capture-geometric-defenders-capturing-side-blocked-slider-rays-and-legal-same-square-recaptures-after"], expandable: true, limitations: ["This exhaustively records immediate legal same-square recaptures of an admitted target capture, pre-capture geometric defenders with none, and aligned sliders of the capturing side whose occupied ray prevents that capture. It is not SEE, a safety claim, or a conclusion about exchange quality, intent, or strategic relevance."] },
  { kind: "move.legal_transition", phases: ["transition"], authorities: ["legal-exact"], coverageDomains: ["target-move"], expandable: true, limitations: [] },
  { kind: "move.legal_recaptures_after", phases: ["after"], authorities: ["deterministic-derived"], coverageDomains: ["legal-captures-of-target-mover-after"], expandable: true, limitations: ["Immediate same-square replies and nominal material arithmetic are not SEE, engine evaluation, or proof of longer-term exchange soundness."] },
  { kind: "move.unblocks_line", phases: ["transition"], authorities: ["legal-exact"], coverageDomains: ["target-move-slider-lines"], expandable: true, limitations: [] },
  { kind: "piece.absolute_pin", phases: ["after"], authorities: ["legal-exact"], coverageDomains: ["side-to-move-absolute-pins-after"], expandable: true, limitations: ["Pins are emitted only when the side to move is not already in check."] },
  { kind: "piece.attack_delta", phases: ["transition"], authorities: ["deterministic-derived"], coverageDomains: ["moved-piece-geometric-attacks"], expandable: true, limitations: ["Attack geometry is not exchange safety or a claim that pressure is decisive."] },
  { kind: "piece.legal_moves", phases: ["after"], authorities: ["legal-exact"], coverageDomains: ["legal-moves-from-attacked-piece"], expandable: true, limitations: ["Emitted for occupied opponent pieces newly attacked by the target move."] },
  { kind: "pawn.advance_state", phases: ["transition"], authorities: ["deterministic-derived"], coverageDomains: ["target-pawn-advance"], expandable: true, limitations: ["Forward and diagonal square geometry does not prove that a future pawn move will remain legal after the opponent replies; passed-pawn geometry and distance do not prove promotion or a winning result."] },
  { kind: "position.legal_moves", phases: ["after"], authorities: ["legal-exact"], coverageDomains: ["all-legal-moves-after"], expandable: true, limitations: [] },
  { kind: "position.legal_move_count", phases: ["after"], authorities: ["legal-exact"], coverageDomains: ["all-legal-moves-after"], expandable: true, limitations: [] },
  { kind: "square.friendly_nonpawn_reachers_after", phases: ["after"], authorities: ["deterministic-derived"], coverageDomains: ["target-destination-friendly-nonpawn-reachers"], expandable: true, limitations: ["Movement geometry plus friendly occupancy does not establish that the occupied square is strategically desirable for the other piece."] },
  { kind: "square.target_destination_attackers_after", phases: ["after"], authorities: ["deterministic-derived"], coverageDomains: ["target-move-destination-attack-map-after"], expandable: true, limitations: ["Complete post-move destination attack map, including pawns and pinned pieces; not safety, SEE, or strategy."] },
  { kind: "square.same_square_exchange_witnesses", phases: ["path"], authorities: ["deterministic-derived"], coverageDomains: ["changed-square-exchange-witnesses"], expandable: true, limitations: ["These are legal same-square capture witnesses with nominal material arithmetic, not SEE, forced, best, or exhaustive over moves away from the square."] },
  { kind: "square.attacker_delta", phases: ["transition"], authorities: ["deterministic-derived"], coverageDomains: ["single-square-attacker-set-transition"], expandable: true, limitations: ["Geometric attackers include pinned pieces and do not establish exchange safety or strategic importance. Legal entry/capture witnesses establish only the recorded replay, not whether the entry is strategically desirable."] },
  { kind: "square.attackers_delta_inventory", phases: ["transition"], authorities: ["deterministic-derived"], coverageDomains: ["all-square-attacker-sets-transition"], expandable: true, limitations: ["Panoramic inventory; use the per-square records for concise model presentation."] },
]);

type CandidateRecord = ChessFactRecord & { priority: number; budgetProtected?: boolean };

/** A replayable immediate-capture response fact in the ordinary fact contract. */
export type AdmittedCaptureResponseAvailabilityFact = ChessFactRecord;

export type AdmittedCaptureResponseAvailabilityInput = {
  /** The target-move context that owns stable identities and the record hash. */
  context: ReasoningPositionContext;
  /** Must be the hash of `context`; callers cannot attach a path fact elsewhere. */
  contextHash: string;
  /** Which exact target-context phase the supplied line starts from. */
  start: "before" | "after";
  /** An admitted, fully declared line whose final move must be a legal capture. */
  movesUci: readonly string[];
};

function bytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function opposite(color: Color): Color {
  return color === "w" ? "b" : "w";
}

function colorName(color: Color): string {
  return color === "w" ? "White" : "Black";
}

function moveUci(move: { from: string; to: string; promotion?: string }) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function squareCoordinates(square: Square) {
  return { file: square.charCodeAt(0) - 97, rank: Number(square[1]) - 1 };
}

export function squaresBetween(from: Square, to: Square): Square[] {
  const left = squareCoordinates(from);
  const right = squareCoordinates(to);
  const fileDelta = right.file - left.file;
  const rankDelta = right.rank - left.rank;
  const aligned = fileDelta === 0 || rankDelta === 0 || Math.abs(fileDelta) === Math.abs(rankDelta);
  if (!aligned) return [];
  const fileStep = Math.sign(fileDelta);
  const rankStep = Math.sign(rankDelta);
  const squares: Square[] = [];
  let file = left.file + fileStep;
  let rank = left.rank + rankStep;
  while (file !== right.file || rank !== right.rank) {
    squares.push(`${String.fromCharCode(97 + file)}${rank + 1}` as Square);
    file += fileStep;
    rank += rankStep;
  }
  return squares;
}

function attackedSquares(board: Chess, origin: Square, color: Color): Square[] {
  return SQUARES.filter((square) => board.attackers(square, color).includes(origin));
}

function stableAttackers(board: Chess, state: IdentityState, square: Square, color: Color) {
  return board.attackers(square, color).map((origin) => ({
    pieceId: pieceIdAt(state, origin),
    currentSquare: origin,
    pieceType: board.get(origin)?.type || null,
  })).filter((item): item is { pieceId: string; currentSquare: Square; pieceType: PieceSymbol } => Boolean(item.pieceId && item.pieceType));
}

function sliderReachesSquare(pieceType: PieceSymbol, from: Square, to: Square) {
  const left = squareCoordinates(from);
  const right = squareCoordinates(to);
  const fileDistance = Math.abs(right.file - left.file);
  const rankDistance = Math.abs(right.rank - left.rank);
  if (fileDistance === 0 && rankDistance === 0) return false;
  const orthogonal = fileDistance === 0 || rankDistance === 0;
  const diagonal = fileDistance === rankDistance;
  return pieceType === "r" ? orthogonal : pieceType === "b" ? diagonal : pieceType === "q" ? orthogonal || diagonal : false;
}

function blockedSliderRecaptureRays(
  board: Chess,
  state: IdentityState,
  targetSquare: Square,
  color: Color,
) {
  return SQUARES.flatMap((sliderSquare) => {
    const slider = board.get(sliderSquare);
    if (!slider || slider.color !== color || !sliderReachesSquare(slider.type, sliderSquare, targetSquare)) return [];
    const between = squaresBetween(sliderSquare, targetSquare);
    const occupiedBlockingSquares = between.flatMap((square) => {
      const blocker = board.get(square);
      const pieceId = pieceIdAt(state, square);
      return blocker && pieceId ? [{
        pieceId,
        currentSquare: square,
        pieceType: blocker.type,
        color: blocker.color,
      }] : [];
    });
    const pieceId = pieceIdAt(state, sliderSquare);
    if (!pieceId || !occupiedBlockingSquares.length) return [];
    return [{
      pieceId,
      currentSquare: sliderSquare,
      pieceType: slider.type,
      ray: [sliderSquare, ...between, targetSquare],
      occupiedBlockingSquares,
    }];
  });
}

function attackerSetChanges(
  before: Chess,
  after: Chess,
  timeline: ReturnType<typeof createPocIdentityTimeline>,
) {
  return (["w", "b"] as Color[]).flatMap((color) => SQUARES.flatMap((square) => {
    const beforeAttackers = stableAttackers(before, timeline.before, square, color);
    const afterAttackers = stableAttackers(after, timeline.after, square, color);
    const beforeIds = new Set(beforeAttackers.map((item) => item.pieceId));
    const afterIds = new Set(afterAttackers.map((item) => item.pieceId));
    const lost = beforeAttackers.filter((item) => !afterIds.has(item.pieceId));
    const gained = afterAttackers.filter((item) => !beforeIds.has(item.pieceId));
    if (!lost.length && !gained.length) return [];
    return [{ square, color, beforeAttackers, afterAttackers, lost, gained }];
  }));
}

function inventory(board: Chess, state: IdentityState) {
  return board.board().flat().filter(Boolean).map((piece) => ({
    pieceId: pieceIdAt(state, piece!.square),
    color: piece!.color,
    type: piece!.type,
    square: piece!.square,
  }));
}

function nominalMaterial(board: Chess, color: Color) {
  return board.board().flat().filter((piece) => piece?.color === color).reduce((total, piece) => total + NOMINAL_VALUES[piece!.type], 0);
}

function nominalMaterialBalance(board: Chess, color: Color) {
  return nominalMaterial(board, color) - nominalMaterial(board, opposite(color));
}

function applyVerboseMove(board: Chess, move: Pick<Move, "from" | "to" | "promotion">) {
  return board.move({ from: move.from, to: move.to, promotion: move.promotion });
}

function immediateCaptureOutcomes(fenAfter: string, captures: Move[]) {
  const baseline = new Chess(fenAfter);
  return captures.map((capture) => {
    const afterCapture = new Chess(fenAfter);
    applyVerboseMove(afterCapture, capture);
    const baselineBalance = nominalMaterialBalance(baseline, capture.color);
    const immediateSameSquareRecaptures = afterCapture.moves({ verbose: true })
      .filter((reply) => reply.to === capture.to && Boolean(reply.captured))
      .map((reply) => {
        const afterReply = new Chess(afterCapture.fen());
        applyVerboseMove(afterReply, reply);
        return {
          uci: moveUci(reply),
          san: reply.san,
          nominalBalanceDeltaForCapturingSide: nominalMaterialBalance(afterReply, capture.color) - baselineBalance,
        };
      });
    return {
      capture: { uci: moveUci(capture), san: capture.san },
      capturingColor: capture.color,
      nominalBalanceDeltaAfterCapture: nominalMaterialBalance(afterCapture, capture.color) - baselineBalance,
      immediateSameSquareRecaptures,
      minimumNominalBalanceDeltaAfterImmediateSameSquareRecapture: immediateSameSquareRecaptures.length
        ? Math.min(...immediateSameSquareRecaptures.map((reply) => reply.nominalBalanceDeltaForCapturingSide))
        : null,
    };
  });
}

function pseudoCaptureKingExposure(
  board: Chess,
  from: Square,
  to: Square,
  color: Color,
) {
  const defender = board.get(from);
  if (!defender || defender.color !== color) return null;
  const replay = new Chess(board.fen());
  replay.remove(from);
  replay.remove(to);
  replay.put({ type: defender.type, color: defender.color }, to);
  const kingSquare = replay.findPiece({ type: "k", color })[0];
  if (!kingSquare) return null;
  const checkerSquares = replay.attackers(kingSquare, opposite(color));
  if (!checkerSquares.length) return null;
  return {
    kind: "own-king-exposure",
    kingSquare,
    checkerSquares,
    checkingLines: checkerSquares.map((checkerSquare) => ({
      checkerSquare,
      ray: [checkerSquare, ...squaresBetween(checkerSquare, kingSquare), kingSquare],
    })),
  };
}

function absolutePinRayConstraints(
  board: Chess,
  defenderSquare: Square,
  color: Color,
) {
  if (board.isCheck()) return [];
  const kingSquare = board.findPiece({ type: "k", color })[0];
  if (!kingSquare) return [];
  const removed = new Chess(board.fen());
  removed.remove(defenderSquare);
  return removed.attackers(kingSquare, opposite(color)).flatMap((pinnerSquare) => {
    const pinner = removed.get(pinnerSquare);
    if (!pinner || !new Set<PieceSymbol>(["b", "r", "q"]).has(pinner.type)
      || !squaresBetween(pinnerSquare, kingSquare).includes(defenderSquare)) return [];
    return [{
      kind: "absolute-pin-ray",
      pinnerSquare,
      pinnerType: pinner.type,
      kingSquare,
      ray: [pinnerSquare, ...squaresBetween(pinnerSquare, kingSquare), kingSquare],
    }];
  });
}

function sameSquareLineOutcomes(fenAfter: string, lines: ReturnType<typeof sameSquareExchangeWitnesses>) {
  return lines.map((line) => {
    const baseline = new Chess(fenAfter);
    const board = new Chess(fenAfter);
    let firstCapturingColor: Color | null = null;
    let baselineBalance = 0;
    const nominalBalanceDeltasAfterEachPly: number[] = [];
    for (const item of line) {
      const legal = board.moves({ verbose: true }).find((move) => moveUci(move) === item.uci);
      if (!legal) throw new Error(`Same-square witness contains an illegal move: ${item.uci}`);
      if (!firstCapturingColor && legal.captured) {
        firstCapturingColor = legal.color;
        baselineBalance = nominalMaterialBalance(baseline, legal.color);
      }
      applyVerboseMove(board, legal);
      nominalBalanceDeltasAfterEachPly.push(firstCapturingColor
        ? nominalMaterialBalance(board, firstCapturingColor) - baselineBalance
        : 0);
    }
    return {
      movesUci: line.map((item) => item.uci),
      firstCapturingColor,
      nominalBalanceDeltasAfterEachPly,
      finalNominalBalanceDeltaForFirstCapturingSide: firstCapturingColor
        ? nominalMaterialBalance(board, firstCapturingColor) - baselineBalance
        : null,
    };
  });
}

function kingDistance(left: Square, right: Square) {
  const a = squareCoordinates(left);
  const b = squareCoordinates(right);
  return {
    file: Math.abs(a.file - b.file),
    rank: Math.abs(a.rank - b.rank),
    chebyshev: Math.max(Math.abs(a.file - b.file), Math.abs(a.rank - b.rank)),
    manhattan: Math.abs(a.file - b.file) + Math.abs(a.rank - b.rank),
  };
}

function isPassedPawn(board: Chess, square: Square, color: Color) {
  const location = squareCoordinates(square);
  const opponent = opposite(color);
  const blockers = board.findPiece({ type: "p", color: opponent }).filter((candidate) => {
    const target = squareCoordinates(candidate);
    const ahead = color === "w" ? target.rank > location.rank : target.rank < location.rank;
    return ahead && Math.abs(target.file - location.file) <= 1;
  });
  return { passed: blockers.length === 0, opposingPawnBlockers: blockers };
}

function priorCastlingEvents(context: ReasoningPositionContext) {
  const board = context.historyStartFen ? new Chess(context.historyStartFen) : new Chess();
  return context.historyUci.flatMap((uci, plyIndex) => {
    const move = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    if (!move || (!move.isKingsideCastle() && !move.isQueensideCastle())) return [];
    const rank = move.color === "w" ? "1" : "8";
    return [{
      plyIndex,
      color: move.color,
      uci,
      san: move.san,
      king: { from: move.from, to: move.to },
      rook: {
        from: `${move.isKingsideCastle() ? "h" : "a"}${rank}`,
        to: `${move.isKingsideCastle() ? "f" : "d"}${rank}`,
      },
    }];
  });
}

function sameSquareExchangeWitnesses(fenAfter: string, square: Square) {
  const root = new Chess(fenAfter);
  const entries = root.moves({ verbose: true }).filter((move) => move.to === square);
  return entries.flatMap((entry) => {
    const afterEntry = new Chess(fenAfter);
    afterEntry.move({ from: entry.from, to: entry.to, promotion: entry.promotion });
    const captures = afterEntry.moves({ verbose: true }).filter((move) => move.to === square && Boolean(move.captured));
    return captures.flatMap((capture) => {
      const afterCapture = new Chess(afterEntry.fen());
      afterCapture.move({ from: capture.from, to: capture.to, promotion: capture.promotion });
      const recaptures = afterCapture.moves({ verbose: true }).filter((move) => move.to === square && Boolean(move.captured));
      const prefix = [
        { uci: moveUci(entry), san: entry.san },
        { uci: moveUci(capture), san: capture.san },
      ];
      return recaptures.length
        ? recaptures.map((recapture) => [...prefix, { uci: moveUci(recapture), san: recapture.san }])
        : [prefix];
    });
  });
}

function participantForSquare(
  state: IdentityState,
  square: Square,
  role: RegistryKey,
): { participant: SemanticParticipant; location: Record<string, SemanticValue> } | null {
  const pieceId = pieceIdAt(state, square);
  if (!pieceId) return null;
  return {
    participant: { role, ref: { domain: REFERENCE_DOMAINS.PIECE, id: pieceId } },
    location: { pieceId, currentSquare: square },
  };
}

function targetMoveParticipants(
  timeline: ReturnType<typeof createPocIdentityTimeline>,
  from: Square,
  to: Square,
  uci: string,
): { participants: SemanticParticipant[]; locations: Record<string, SemanticValue>[]; afterParticipants: SemanticParticipant[] } {
  const actorBefore = participantForSquare(timeline.before, from, PARTICIPANT_ROLES.ACTOR);
  const actorAfter = participantForSquare(timeline.after, to, PARTICIPANT_ROLES.ACTOR);
  const moveParticipant = { role: PARTICIPANT_ROLES.ACTOR, ref: { domain: REFERENCE_DOMAINS.MOVE, id: uci } };
  const originParticipant = { role: "origin", ref: { domain: REFERENCE_DOMAINS.SQUARE, id: from } };
  const destinationParticipant = { role: PARTICIPANT_ROLES.DESTINATION, ref: { domain: REFERENCE_DOMAINS.SQUARE, id: to } };
  // Promotion retires the pawn identity and creates a distinct piece identity.
  // Retain both ends of that transition instead of placing the retired pawn on
  // the promotion square, and let after-only facts select the resulting piece.
  const actorAfterAddsIdentity = actorAfter && actorAfter.participant.ref.id !== actorBefore?.participant.ref.id;
  return {
    participants: [
      moveParticipant,
      ...(actorBefore ? [actorBefore.participant] : []),
      ...(actorAfterAddsIdentity ? [actorAfter.participant] : []),
      originParticipant,
      destinationParticipant,
    ],
    locations: [
      ...(actorBefore ? [{ ...actorBefore.location, phase: "before" }] : []),
      ...(actorAfter ? [{ ...actorAfter.location, phase: "after" }] : []),
    ],
    afterParticipants: [moveParticipant, ...(actorAfter ? [actorAfter.participant] : []), destinationParticipant],
  };
}

function phaseState(
  timeline: ReturnType<typeof createPocIdentityTimeline>,
  phase: "before" | "after",
) {
  return phase === "before" ? timeline.before : timeline.after;
}

function createRecord(input: {
  contextHash: string;
  kind: string;
  phase: ChessFactPhase;
  authority: ChessFactAuthority;
  priority: number;
  /**
   * One direct target-move fact may be retained ahead of ordinary presentation
   * budgeting. This is deliberately limited to exact destination geometry;
   * it prevents a fact-cap from silently removing the board state needed to
   * inspect an immediate capture, without making any safety conclusion.
   */
  budgetProtected?: boolean;
  summary: string;
  participants: SemanticParticipant[];
  data: Record<string, SemanticValue>;
  pieceLocations: Record<string, SemanticValue>[];
  coverage: ChessFactCoverage;
  replay: Record<string, SemanticValue> | null;
  derivedFromIds?: string[];
}): CandidateRecord {
  const summaryTruncated = input.summary.length > MAX_FACT_SUMMARY_CHARACTERS;
  const summary = summaryTruncated
    ? `${input.summary.slice(0, MAX_FACT_SUMMARY_CHARACTERS - 1).trimEnd()}…`
    : input.summary;
  const data = {
    ...input.data,
    pieceLocations: input.pieceLocations,
    ...(summaryTruncated ? { summaryTruncated: true } : {}),
  };
  const identity = {
    provider: MECHANICAL_CHESS_FACT_PROVIDER_ID,
    version: MECHANICAL_CHESS_FACT_PROVIDER_VERSION,
    contextHash: input.contextHash,
    kind: input.kind,
    phase: input.phase,
    data,
  };
  const record: CandidateRecord = {
    schemaVersion: CHESS_FACT_SCHEMA_VERSION,
    id: `fact:${stableHash(identity)}`,
    contextHash: input.contextHash,
    kind: input.kind,
    phase: input.phase,
    authority: input.authority,
    summary,
    participants: input.participants,
    data,
    coverage: input.coverage,
    provenance: {
      provider: MECHANICAL_CHESS_FACT_PROVIDER_ID,
      version: MECHANICAL_CHESS_FACT_PROVIDER_VERSION,
      method: input.authority === "legal-exact" ? "chess.js-legal-state" : "chess.js-deterministic-delta",
      derivedFromIds: input.derivedFromIds || [],
    },
    replay: input.replay,
    priority: input.priority,
    ...(input.budgetProtected ? { budgetProtected: true } : {}),
  };
  const validated = { ...record };
  delete (validated as Partial<CandidateRecord>).priority;
  delete (validated as Partial<CandidateRecord>).budgetProtected;
  validateChessFactRecord(validated);
  return record;
}

/**
 * Derive the immediate legal recapture availability after a capture already
 * admitted by a replayable line.  This never discovers a continuation: the
 * caller supplies every UCI move, and the result is rooted at the declared
 * target-context phase.  Stable identities are replayed along that exact
 * prefix so a later capture can still name the original piece accurately.
 */
export function deriveAdmittedCaptureResponseAvailabilityFact(
  input: AdmittedCaptureResponseAvailabilityInput,
): AdmittedCaptureResponseAvailabilityFact {
  validateReasoningPositionContext(input.context);
  const rootContextHash = reasoningContextHash(input.context);
  if (input.contextHash !== rootContextHash) {
    throw new Error("Admitted capture response fact contextHash does not match its root context");
  }
  if (input.start !== "before" && input.start !== "after") {
    throw new Error("Admitted capture response fact start must be before or after");
  }
  if (!Array.isArray(input.movesUci) || input.movesUci.length === 0) {
    throw new Error("Admitted capture response fact requires a non-empty admitted UCI line");
  }
  if (input.movesUci.some((uci) => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci))) {
    throw new Error("Admitted capture response fact line contains invalid UCI");
  }

  const rootTimeline = createPocIdentityTimeline(input.context);
  const replayFen = input.start === "before" ? input.context.fenBefore : input.context.fenAfter;
  const board = new Chess(replayFen);
  let state = input.start === "before" ? rootTimeline.before : rootTimeline.after;
  if (state.fen !== board.fen()) throw new Error("Admitted capture response fact identity start does not match replay phase");

  let beforeCapture: Chess | null = null;
  let beforeCaptureState: IdentityState | null = null;
  let capture: Move | null = null;
  for (const [index, uci] of input.movesUci.entries()) {
    const legal = board.moves({ verbose: true }).find((move) => moveUci(move) === uci);
    if (!legal) throw new Error(`Admitted capture response fact line is illegal at ply ${index}: ${uci}`);
    if (index === input.movesUci.length - 1) {
      beforeCapture = new Chess(board.fen());
      beforeCaptureState = state;
      capture = legal;
    }
    let nextState: IdentityState;
    try {
      nextState = applyIdentityMove(state, {
        from: legal.from,
        to: legal.to,
        promotion: legal.promotion,
      }).state;
    } catch {
      throw new Error(`Admitted capture response fact stable-identity replay failed at ply ${index}: ${uci}`);
    }
    applyVerboseMove(board, legal);
    if (nextState.fen !== board.fen()) throw new Error(`Admitted capture response fact identity replay mismatch at ply ${index}: ${uci}`);
    state = nextState;
  }
  if (!capture || !beforeCapture || !beforeCaptureState) throw new Error("Admitted capture response fact failed to replay its final move");
  if (!capture.captured) throw new Error("Admitted capture response fact final move must be a capture");

  const afterCapture = board;
  const afterCaptureState = state;
  const from = capture.from as Square;
  const to = capture.to as Square;
  const moverColor = capture.color;
  const captureTimeline = { before: beforeCaptureState, after: afterCaptureState } as ReturnType<typeof createPocIdentityTimeline>;
  const target = targetMoveParticipants(captureTimeline, from, to, moveUci(capture));
  const captureSquare = (capture.isEnPassant() ? `${to[0]}${from[1]}` : to) as Square;
  const captured = participantForSquare(beforeCaptureState, captureSquare, PARTICIPANT_ROLES.TARGET);
  if (captured) {
    target.participants.push(captured.participant);
    target.locations.push({ ...captured.location, phase: "before" });
  }

  const movedPieceAfter = afterCapture.get(to);
  if (!movedPieceAfter) throw new Error("Admitted capture response fact final capture has no mover on its destination");
  const legalRecaptures = afterCapture.moves({ verbose: true }).filter((reply) => (
    reply.to === to && reply.captured === movedPieceAfter.type
  ));
  const defenderColor = opposite(moverColor);
  const preCaptureGeometricDefenders = stableAttackers(beforeCapture, beforeCaptureState, to, defenderColor);
  const preCaptureBlockedSliderCapturers = blockedSliderRecaptureRays(beforeCapture, beforeCaptureState, to, moverColor);
  const responseSquares = [
    ...preCaptureGeometricDefenders.map((defender) => defender.currentSquare),
    ...preCaptureBlockedSliderCapturers.flatMap((slider) => [
      slider.currentSquare,
      ...slider.occupiedBlockingSquares.map((blocker) => blocker.currentSquare),
    ]),
  ].filter((square, index, all) => all.indexOf(square) === index);
  const responseParticipants = responseSquares.flatMap((square) => {
    const participant = participantForSquare(beforeCaptureState, square, PARTICIPANT_ROLES.RESOURCE);
    return participant ? [{ square, participant }] : [];
  });
  const defenders = preCaptureGeometricDefenders.map((defender) => {
    const legalSameSquareRecaptures = legalRecaptures.filter((reply) => (
      pieceIdAt(afterCaptureState, reply.from as Square) === defender.pieceId
    ));
    const ownKingExposure = pseudoCaptureKingExposure(afterCapture, defender.currentSquare, to, defenderColor);
    const exclusionConstraints = legalSameSquareRecaptures.length
      ? []
      : [
        ...absolutePinRayConstraints(afterCapture, defender.currentSquare, defenderColor),
        ...(ownKingExposure ? [ownKingExposure] : []),
      ];
    return {
      ...defender,
      legalSameSquareRecaptures: legalSameSquareRecaptures.map((reply) => ({
        uci: moveUci(reply),
        san: reply.san,
        from: reply.from,
        to: reply.to,
      })),
      exclusionConstraints,
    };
  });
  const unavailableGeometricDefenders = defenders.filter((defender) => defender.legalSameSquareRecaptures.length === 0);
  const responsePieceLocations: Record<string, SemanticValue>[] = responseParticipants.flatMap(({ square, participant }) => [
    { pieceId: participant.participant.ref.id, currentSquare: square, phase: "before" },
    { pieceId: participant.participant.ref.id, currentSquare: square, phase: "after" },
  ]);
  const responseLocations = [...target.locations, ...responsePieceLocations]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.pieceId === item.pieceId && candidate.currentSquare === item.currentSquare && candidate.phase === item.phase) === index);
  const isDirectTargetCapture = input.start === "before"
    && input.movesUci.length === 1
    && input.movesUci[0] === input.context.moveUci;
  const record = createRecord({
    contextHash: input.contextHash,
    kind: "move.capture_response_availability_after",
    phase: "after",
    authority: "deterministic-derived",
    priority: unavailableGeometricDefenders.length || preCaptureBlockedSliderCapturers.length ? 95 : legalRecaptures.length ? 84 : 72,
    summary: `After the admitted capture ${capture.san} on ${to}, legal same-square recaptures are ${legalRecaptures.map((reply) => reply.san).join(", ") || "none"}. Pre-capture geometric defenders of ${to} with no legal same-square recapture are ${unavailableGeometricDefenders.map((defender) => defender.currentSquare).join(", ") || "none"}. Pre-capture aligned sliders of the capturing side blocked by occupied rays are ${preCaptureBlockedSliderCapturers.map((slider) => slider.currentSquare).join(", ") || "none"}. This records legal availability and exact ray geometry only; it does not establish safety, exchange quality, intent, or strategic relevance.`,
    participants: [...target.participants, ...responseParticipants.map((item) => item.participant.participant)]
      .filter((item, index, all) => all.findIndex((candidate) => candidate.role === item.role && candidate.ref.domain === item.ref.domain && candidate.ref.id === item.ref.id) === index),
    data: {
      capture: {
        uci: moveUci(capture),
        san: capture.san,
        from,
        to,
        capturedSquare: captureSquare,
        capturedType: capture.captured,
      },
      defenderColor,
      preCaptureGeometricDefenders: defenders,
      preCaptureBlockedSliderCapturers,
      legalSameSquareRecaptures: legalRecaptures.map((reply) => ({
        uci: moveUci(reply),
        san: reply.san,
        from: reply.from,
        to: reply.to,
        moverPieceId: pieceIdAt(afterCaptureState, reply.from as Square),
      })),
      unavailableGeometricDefenderPieceIds: unavailableGeometricDefenders.map((defender) => defender.pieceId),
      ...(isDirectTargetCapture ? {} : { admittedReplay: { start: input.start, movesUci: [...input.movesUci] } }),
    },
    pieceLocations: responseLocations,
    coverage: {
      domain: "target-capture-pre-capture-geometric-defenders-capturing-side-blocked-slider-rays-and-legal-same-square-recaptures-after",
      exhaustive: true,
      covered: [
        moveUci(capture),
        ...preCaptureGeometricDefenders.map((defender) => defender.pieceId),
        ...preCaptureBlockedSliderCapturers.flatMap((slider) => [slider.pieceId, ...slider.occupiedBlockingSquares.map((blocker) => blocker.pieceId)]),
        ...legalRecaptures.map(moveUci),
      ],
      unresolved: [],
    },
    replay: {
      fen: replayFen,
      movesUci: [...input.movesUci],
      linesUci: legalRecaptures.length
        ? legalRecaptures.map((reply) => [...input.movesUci, moveUci(reply)])
        : [[...input.movesUci]],
    },
  });
  const fact = { ...record };
  Reflect.deleteProperty(fact, "priority");
  Reflect.deleteProperty(fact, "budgetProtected");
  return fact;
}

function checkRecord(input: {
  board: Chess;
  phase: "before" | "after";
  timeline: ReturnType<typeof createPocIdentityTimeline>;
  contextHash: string;
  fen: string;
}): CandidateRecord {
  const color = input.board.turn();
  const kingSquare = input.board.findPiece({ type: "k", color })[0];
  if (!kingSquare) throw new Error("Mechanical fact provider requires both kings");
  const checkerSquares = input.board.attackers(kingSquare, opposite(color));
  const state = phaseState(input.timeline, input.phase);
  const king = participantForSquare(state, kingSquare, PARTICIPANT_ROLES.TARGET);
  const checkers = checkerSquares.flatMap((square) => {
    const participant = participantForSquare(state, square, PARTICIPANT_ROLES.ACTOR);
    return participant ? [participant] : [];
  });
  return createRecord({
    contextHash: input.contextHash,
    kind: "king.check_state",
    phase: input.phase,
    authority: "legal-exact",
    priority: input.phase === "before" && checkerSquares.length ? 99 : input.phase === "after" && checkerSquares.length ? 97 : 52,
    summary: checkerSquares.length
      ? `${color === "w" ? "White" : "Black"} is in check; the checking piece${checkerSquares.length === 1 ? " is" : "s are"} on ${checkerSquares.join(", ")}.`
      : `${color === "w" ? "White" : "Black"}, the side to move, is not in check.`,
    participants: [...(king ? [king.participant] : []), ...checkers.map((item) => item.participant)],
    data: {
      sideToMove: color,
      kingSquare,
      inCheck: checkerSquares.length > 0,
      checkerSquares,
      checkingLines: checkerSquares.map((square) => ({ checker: square, between: squaresBetween(square, kingSquare) })),
    },
    pieceLocations: [...(king ? [{ ...king.location, phase: input.phase }] : []), ...checkers.map((item) => ({ ...item.location, phase: input.phase }))],
    coverage: { domain: `${input.phase}-side-to-move-check-state`, exhaustive: true, covered: [kingSquare, ...checkerSquares], unresolved: [] },
    replay: { fen: input.fen },
  });
}

function pinRecord(input: {
  board: Chess;
  timeline: ReturnType<typeof createPocIdentityTimeline>;
  contextHash: string;
  fen: string;
}): CandidateRecord {
  const color = input.board.turn();
  const enemy = opposite(color);
  const kingSquare = input.board.findPiece({ type: "k", color })[0];
  if (!kingSquare) throw new Error("Mechanical fact provider requires both kings");
  const pins: Array<Record<string, SemanticValue>> = [];
  const participants: SemanticParticipant[] = [];
  const pieceLocations: Record<string, SemanticValue>[] = [];
  if (!input.board.isCheck()) {
    for (const square of input.board.findPiece({ color, type: "p" })
      .concat(input.board.findPiece({ color, type: "n" }), input.board.findPiece({ color, type: "b" }), input.board.findPiece({ color, type: "r" }), input.board.findPiece({ color, type: "q" }))) {
      const removed = new Chess(input.fen);
      removed.remove(square);
      const pinners = removed.attackers(kingSquare, enemy).filter((origin) => {
        const piece = removed.get(origin);
        return piece && new Set<PieceSymbol>(["b", "r", "q"]).has(piece.type) && squaresBetween(origin, kingSquare).includes(square);
      });
      for (const pinnerSquare of pinners) {
        const pinned = participantForSquare(input.timeline.after, square, PARTICIPANT_ROLES.TARGET);
        const pinner = participantForSquare(input.timeline.after, pinnerSquare, PARTICIPANT_ROLES.ACTOR);
        const king = participantForSquare(input.timeline.after, kingSquare, PARTICIPANT_ROLES.GOAL);
        const piece = input.board.get(square);
        if (!pinned || !pinner || !king || !piece) continue;
        const moves = input.board.moves({ square, verbose: true });
        pins.push({ pinnedSquare: square, pinnedType: piece.type, pinnerSquare, pinnerType: input.board.get(pinnerSquare)!.type, kingSquare, ray: [pinnerSquare, ...squaresBetween(pinnerSquare, kingSquare), kingSquare], legalMovesUci: moves.map((legalMove) => `${legalMove.from}${legalMove.to}${legalMove.promotion || ""}`) });
        participants.push(pinner.participant, pinned.participant, king.participant);
        pieceLocations.push({ ...pinner.location, phase: "after" }, { ...pinned.location, phase: "after" }, { ...king.location, phase: "after" });
      }
    }
  }
  const uniqueParticipants = participants.filter((item, index, all) => all.findIndex((candidate) => candidate.role === item.role && candidate.ref.domain === item.ref.domain && candidate.ref.id === item.ref.id) === index);
  const uniqueLocations = pieceLocations.filter((item, index, all) => all.findIndex((candidate) => candidate.pieceId === item.pieceId && candidate.currentSquare === item.currentSquare) === index);
  const exhaustive = !input.board.isCheck();
  return createRecord({
    contextHash: input.contextHash,
    kind: "piece.absolute_pin",
    phase: "after",
    authority: "legal-exact",
    priority: pins.length ? 89 : 45,
    summary: exhaustive
      ? pins.length
        ? `${pins.length} absolute pin${pins.length === 1 ? " is" : "s are"} present for the side to move after the target move; the recorded legal moves show whether a pinned piece can capture its pinner or remain on the ray.`
        : "No absolute pin is present for the side to move after the target move."
      : "Absolute pins are not enumerated while the side to move is already in check.",
    participants: uniqueParticipants,
    data: { sideToMove: color, kingSquare, pins },
    pieceLocations: uniqueLocations,
    coverage: { domain: "side-to-move-absolute-pins-after", exhaustive, covered: pins.map((pin) => String(pin.pinnedSquare)), unresolved: exhaustive ? [] : ["side-is-in-check"] },
    replay: { fen: input.fen },
  });
}

export class MechanicalChessFactProvider implements ChessFactProvider {
  readonly id = MECHANICAL_CHESS_FACT_PROVIDER_ID;
  readonly version = MECHANICAL_CHESS_FACT_PROVIDER_VERSION;

  capabilities(): readonly ChessFactCapability[] {
    return CAPABILITIES;
  }

  collect(requestInput: ChessFactRequest, signal?: AbortSignal): ChessFactResult {
    const request = validateChessFactRequest(requestInput);
    if (signal?.aborted) throw signal.reason || new Error("Chess fact request cancelled");
    validateReasoningPositionContext(request.context);
    const startedAt = Date.now();
    const contextHash = reasoningContextHash(request.context);
    const before = new Chess(request.context.fenBefore);
    const moverColor = before.turn();
    const move = before.move({
      from: request.context.moveUci.slice(0, 2),
      to: request.context.moveUci.slice(2, 4),
      promotion: request.context.moveUci.slice(4) || undefined,
    });
    if (!move || before.fen() !== new Chess(request.context.fenAfter).fen()) throw new Error("Mechanical fact provider context transition mismatch");
    const after = before;
    const beforeBoard = new Chess(request.context.fenBefore);
    const timeline = createPocIdentityTimeline(request.context);
    const from = move.from as Square;
    const to = move.to as Square;
    const target = targetMoveParticipants(timeline, from, to, request.context.moveUci);
    let capturedPiece: { pieceId: string; color: Color; pieceType: PieceSymbol; square: Square } | null = null;
    if (move.captured) {
      const captureSquare = (move.isEnPassant() ? `${to[0]}${from[1]}` : to) as Square;
      const captured = participantForSquare(timeline.before, captureSquare, PARTICIPANT_ROLES.TARGET);
      if (captured) {
        const identity = timeline.before.pieces[captured.participant.ref.id];
        if (identity) capturedPiece = { pieceId: identity.id, color: identity.color, pieceType: identity.type, square: captureSquare };
        target.participants.push(captured.participant);
        target.locations.push({ ...captured.location, phase: "before" });
      }
    }
    const candidates: CandidateRecord[] = [];
    const push = (record: CandidateRecord) => candidates.push(record);

    push(createRecord({
      contextHash,
      kind: "move.legal_transition",
      phase: "transition",
      authority: "legal-exact",
      priority: 100,
      summary: `${move.san} is legal and moves the ${PIECE_NAMES[move.piece]} from ${from} to ${to}${move.captured ? ` while capturing a ${PIECE_NAMES[move.captured]}` : ""}.`,
      participants: target.participants,
      data: { uci: request.context.moveUci, san: move.san, from, to, moverColor, pieceType: move.piece, capturedType: move.captured || null, capturedPiece, promotion: move.promotion || null },
      pieceLocations: target.locations,
      coverage: { domain: "target-move", exhaustive: true, covered: [request.context.moveUci], unresolved: [] },
      replay: { fen: request.context.fenBefore, movesUci: [request.context.moveUci] },
    }));

    const beforeCheck = checkRecord({ board: beforeBoard, phase: "before", timeline, contextHash, fen: request.context.fenBefore });
    const afterCheck = checkRecord({ board: after, phase: "after", timeline, contextHash, fen: request.context.fenAfter });
    push(beforeCheck);
    push(afterCheck);

    const beforeKingSquare = beforeBoard.findPiece({ type: "k", color: moverColor })[0];
    const beforeCheckers = beforeKingSquare ? beforeBoard.attackers(beforeKingSquare, opposite(moverColor)) : [];
    if (move.piece !== "k" && beforeKingSquare && beforeCheckers.length && !after.isAttacked(after.findPiece({ type: "k", color: moverColor })[0], opposite(moverColor))) {
      for (const checkerSquare of beforeCheckers.filter((square) => squaresBetween(square, beforeKingSquare).includes(to))) {
        // This transition is performed by the moved piece. The checker is the
        // piece whose checking line is affected by the block, so it is a
        // target rather than a second actor sharing the mover's destination.
        // Keeping that distinction here prevents consumers from inferring
        // that both pieces travel to the single destination square.
        const checker = participantForSquare(timeline.before, checkerSquare, PARTICIPANT_ROLES.TARGET);
        const king = participantForSquare(timeline.before, beforeKingSquare, PARTICIPANT_ROLES.TARGET);
        push(createRecord({
          contextHash,
          kind: "move.blocks_check_line",
          phase: "transition",
          authority: "legal-exact",
          priority: 100,
          summary: `${move.san} places the moved piece on ${to} between the checker on ${checkerSquare} and the king on ${beforeKingSquare}; the resulting position is not check.`,
          participants: [...target.participants, ...(checker ? [checker.participant] : []), ...(king ? [king.participant] : [])],
          data: { checkerSquare, kingSquare: beforeKingSquare, blockSquare: to, line: [checkerSquare, ...squaresBetween(checkerSquare, beforeKingSquare), beforeKingSquare], checkResolved: true },
          pieceLocations: [...target.locations, ...(checker ? [{ ...checker.location, phase: "before" }] : []), ...(king ? [{ ...king.location, phase: "before" }] : [])],
          coverage: { domain: "target-move-check-resolution", exhaustive: true, covered: [request.context.moveUci, checkerSquare, beforeKingSquare], unresolved: [] },
          replay: { fen: request.context.fenBefore, movesUci: [request.context.moveUci] },
          derivedFromIds: [beforeCheck.id, afterCheck.id],
        }));
      }
    }

    push(createRecord({
        contextHash,
        kind: "move.capture_check_delta",
        phase: "transition",
        authority: "legal-exact",
        priority: after.isCheck() ? 98 : 88,
        summary: `${move.san}${move.captured ? ` captures a ${PIECE_NAMES[move.captured]} on ${to}` : " does not capture"}${after.isCheck() ? " and gives check" : " and does not give check"}.`,
        participants: target.participants,
        data: { uci: request.context.moveUci, capture: Boolean(move.captured), capturedType: move.captured || null, capturedPiece, givesCheck: after.isCheck() },
        pieceLocations: target.locations,
        coverage: { domain: "target-move-capture-check", exhaustive: true, covered: [request.context.moveUci], unresolved: [] },
        replay: { fen: request.context.fenBefore, movesUci: [request.context.moveUci] },
      }));

    // A target move's destination is the one square where an immediate
    // capture/recapture question is intrinsically about the target move. Keep
    // its complete attack map as a compact, deterministic fact even when the
    // ordinary presentation budget is tight. This deliberately reports only
    // geometry: chess.js attack maps include pinned pieces, so neither set is
    // a conclusion about legal capture, SEE, or the safety of the mover.
    const destinationFriendlyDefenders = stableAttackers(after, timeline.after, to, moverColor);
    const destinationOpposingAttackers = stableAttackers(after, timeline.after, to, opposite(moverColor));
    const movedPieceId = pieceIdAt(timeline.after, to);
    push(createRecord({
      contextHash,
      kind: "square.target_destination_attackers_after",
      phase: "after",
      authority: "deterministic-derived",
      priority: 101,
      budgetProtected: true,
      summary: `After ${move.san}, the post-move attack map on ${to} has friendly ${destinationFriendlyDefenders.map((item) => item.currentSquare).join(", ") || "none"} and opposing ${destinationOpposingAttackers.map((item) => item.currentSquare).join(", ") || "none"}. Geometry only; not a safety, exchange, or strategic conclusion.`,
      participants: target.participants,
      data: {
        square: to,
        occupant: movedPieceId ? { pieceId: movedPieceId, currentSquare: to, color: moverColor, pieceType: move.piece } : null,
        friendlyDefenderSet: destinationFriendlyDefenders,
        opposingAttackerSet: destinationOpposingAttackers,
        attackMapScope: "geometry-only-including-pinned-pieces",
      },
      pieceLocations: target.locations,
      coverage: {
        domain: "target-move-destination-attack-map-after",
        exhaustive: true,
        covered: [to],
        unresolved: [],
      },
      replay: { fen: request.context.fenAfter },
    }));

    const afterLegalMoves = after.moves({ verbose: true });
    const movedPieceAfter = after.get(to);
    const legalRecaptures = movedPieceAfter
      ? afterLegalMoves.filter((reply) => reply.to === to && reply.captured === movedPieceAfter.type)
      : [];
    if (move.captured && movedPieceAfter) {
      const captureResponse = deriveAdmittedCaptureResponseAvailabilityFact({
        context: request.context,
        contextHash,
        start: "before",
        movesUci: [request.context.moveUci],
      });
      const unavailable = captureResponse.data.unavailableGeometricDefenderPieceIds;
      const blockedSliderCapturers = captureResponse.data.preCaptureBlockedSliderCapturers;
      const replies = captureResponse.data.legalSameSquareRecaptures;
      push({
        ...captureResponse,
        priority: Array.isArray(unavailable) && unavailable.length
          || Array.isArray(blockedSliderCapturers) && blockedSliderCapturers.length
          ? 95
          : Array.isArray(replies) && replies.length
            ? 84
            : 72,
      });
    }
    const captureOutcomes = immediateCaptureOutcomes(request.context.fenAfter, legalRecaptures);
    const allCapturesLoseAfterImmediateSameSquareRecapture = captureOutcomes.length > 0 && captureOutcomes.every((outcome) => (
      outcome.immediateSameSquareRecaptures.length > 0
      && outcome.minimumNominalBalanceDeltaAfterImmediateSameSquareRecapture !== null
      && outcome.minimumNominalBalanceDeltaAfterImmediateSameSquareRecapture < 0
    ));
    const recaptureParticipants = legalRecaptures.flatMap((reply) => {
      const participant = participantForSquare(timeline.after, reply.from as Square, PARTICIPANT_ROLES.ACTOR);
      return participant ? [participant] : [];
    });
    push(createRecord({
      contextHash,
      kind: "move.legal_recaptures_after",
      phase: "after",
      authority: "deterministic-derived",
      // A legal capture of the moved piece which is immediately answered on
      // the same square is direct target-move evidence. It stays near the
      // top of normal deterministic ordering, while still making no SEE or
      // longer-sequence safety claim.
      priority: legalRecaptures.length && captureOutcomes.some((outcome) => outcome.immediateSameSquareRecaptures.length)
        ? 100
        : legalRecaptures.length ? (allCapturesLoseAfterImmediateSameSquareRecapture ? 72 : 96) : 42,
      summary: legalRecaptures.length
        ? `The piece that moved to ${to} can be captured immediately by ${legalRecaptures.map((reply) => reply.san).join(", ")}.${captureOutcomes.map((outcome) => outcome.immediateSameSquareRecaptures.length
          ? ` After ${outcome.capture.san}, immediate same-square replies are ${outcome.immediateSameSquareRecaptures.map((reply) => `${reply.san} (capturing side nominal balance delta ${reply.nominalBalanceDeltaForCapturingSide})`).join(", ")}.`
          : ` No immediate same-square reply follows ${outcome.capture.san}.`).join("")} This is nominal arithmetic, not SEE or proof of longer-term exchange soundness.`
        : `The side to move has no immediate legal capture of the piece on ${to}. This does not establish that the piece is safe in a longer sequence.`,
      participants: [...target.afterParticipants, ...recaptureParticipants.map((item) => item.participant)],
      data: {
        targetSquare: to,
        targetPieceType: movedPieceAfter?.type || null,
        targetPieceColor: movedPieceAfter?.color || null,
        moves: legalRecaptures.map((reply) => ({
          uci: moveUci(reply),
          san: reply.san,
          moverPieceId: pieceIdAt(timeline.after, reply.from as Square),
          from: reply.from,
          to: reply.to,
          capturedType: reply.captured || null,
        })),
        captureOutcomes,
        allCapturesLoseAfterImmediateSameSquareRecapture,
      },
      pieceLocations: [...target.locations.filter((location) => location.phase === "after"), ...recaptureParticipants.map((item) => ({ ...item.location, phase: "after" }))],
      coverage: { domain: "legal-captures-of-target-mover-after", exhaustive: true, covered: legalRecaptures.map(moveUci), unresolved: [] },
      replay: {
        fen: request.context.fenAfter,
        linesUci: captureOutcomes.flatMap((outcome) => outcome.immediateSameSquareRecaptures.length
          ? outcome.immediateSameSquareRecaptures.map((reply) => [outcome.capture.uci, reply.uci])
          : [[outcome.capture.uci]]),
      },
    }));

    if (after.isCheck()) {
      const checkedColor = after.turn();
      const kingSquare = after.findPiece({ type: "k", color: checkedColor })[0];
      const checkerSquares = after.attackers(kingSquare, opposite(checkedColor));
      const participants = checkerSquares.flatMap((square) => {
        const item = participantForSquare(timeline.after, square, PARTICIPANT_ROLES.ACTOR);
        return item ? [item] : [];
      });
      const king = participantForSquare(timeline.after, kingSquare, PARTICIPANT_ROLES.TARGET);
      push(createRecord({
        contextHash,
        kind: "king.checkers_after",
        phase: "after",
        authority: "legal-exact",
        priority: 97,
        summary: `After ${move.san}, ${checkerSquares.length} piece${checkerSquares.length === 1 ? " checks" : "s check"} the king on ${kingSquare}: ${checkerSquares.join(", ")}.`,
        participants: [...participants.map((item) => item.participant), ...(king ? [king.participant] : [])],
        data: { kingSquare, checkerSquares, checkingLines: checkerSquares.map((square) => ({ checker: square, between: squaresBetween(square, kingSquare) })) },
        pieceLocations: [...participants.map((item) => ({ ...item.location, phase: "after" })), ...(king ? [{ ...king.location, phase: "after" }] : [])],
        coverage: { domain: "checking-pieces-after", exhaustive: true, covered: [kingSquare, ...checkerSquares], unresolved: [] },
        replay: { fen: request.context.fenAfter },
      }));
      const kingMoves = after.moves({ square: kingSquare, verbose: true });
      push(createRecord({
        contextHash,
        kind: "king.legal_moves",
        phase: "after",
        authority: "legal-exact",
        priority: 94,
        summary: `The checked king on ${kingSquare} has ${kingMoves.length} legal king move${kingMoves.length === 1 ? "" : "s"}: ${kingMoves.map((item) => item.san).join(", ") || "none"}.`,
        participants: king ? [king.participant] : [],
        data: { kingSquare, movesUci: kingMoves.map((item) => `${item.from}${item.to}${item.promotion || ""}`), movesSan: kingMoves.map((item) => item.san) },
        pieceLocations: king ? [{ ...king.location, phase: "after" }] : [],
        coverage: { domain: "legal-king-moves-after", exhaustive: true, covered: kingMoves.map((item) => `${item.from}${item.to}${item.promotion || ""}`), unresolved: [] },
        replay: { fen: request.context.fenAfter },
      }));
      for (const checkerSquare of checkerSquares.filter((square) => square !== to && squaresBetween(square, kingSquare).includes(from))) {
        const checker = participantForSquare(timeline.after, checkerSquare, PARTICIPANT_ROLES.ACTOR);
        push(createRecord({
          contextHash,
          kind: "move.unblocks_line",
          phase: "transition",
          authority: "legal-exact",
          priority: 95,
          summary: `Moving from ${from} clears the line from the ${PIECE_NAMES[after.get(checkerSquare)!.type]} on ${checkerSquare} to the king on ${kingSquare}.`,
          participants: [...target.participants, ...(checker ? [checker.participant] : []), ...(king ? [king.participant] : [])],
          data: { vacatedSquare: from, checkerSquare, kingSquare, line: [checkerSquare, ...squaresBetween(checkerSquare, kingSquare), kingSquare] },
          pieceLocations: [...target.locations, ...(checker ? [{ ...checker.location, phase: "after" }] : []), ...(king ? [{ ...king.location, phase: "after" }] : [])],
          coverage: { domain: "target-move-slider-lines", exhaustive: true, covered: [from, checkerSquare, kingSquare], unresolved: [] },
          replay: { fen: request.context.fenBefore, movesUci: [request.context.moveUci] },
        }));
      }
    }

    const whiteKingSquare = after.findPiece({ type: "k", color: "w" })[0];
    const blackKingSquare = after.findPiece({ type: "k", color: "b" })[0];
    if (!whiteKingSquare || !blackKingSquare) throw new Error("Mechanical fact provider requires both kings");
    const whiteKing = participantForSquare(timeline.after, whiteKingSquare, PARTICIPANT_ROLES.ACTOR);
    const blackKing = participantForSquare(timeline.after, blackKingSquare, PARTICIPANT_ROLES.TARGET);
    const distance = kingDistance(whiteKingSquare, blackKingSquare);
    const betweenKings = squaresBetween(whiteKingSquare, blackKingSquare);
    push(createRecord({
      contextHash,
      kind: "king.geometry_after",
      phase: "after",
      authority: "legal-exact",
      priority: distance.chebyshev <= 2 ? 90 : 24,
      summary: `After ${move.san}, the kings are on ${whiteKingSquare} and ${blackKingSquare}; their Chebyshev distance is ${distance.chebyshev}, it is ${colorName(after.turn())}'s turn, and aligned squares between them are ${betweenKings.join(", ") || "none"}.`,
      participants: [...(whiteKing ? [whiteKing.participant] : []), ...(blackKing ? [blackKing.participant] : [])],
      data: { whiteKingSquare, blackKingSquare, sideToMove: after.turn(), distance, alignedBetween: betweenKings },
      pieceLocations: [...(whiteKing ? [{ ...whiteKing.location, phase: "after" }] : []), ...(blackKing ? [{ ...blackKing.location, phase: "after" }] : [])],
      coverage: { domain: "king-square-geometry-after", exhaustive: true, covered: [whiteKingSquare, blackKingSquare], unresolved: [] },
      replay: { fen: request.context.fenAfter },
    }));

    const castlingEvents = priorCastlingEvents(request.context);
    const castlingColors = new Set(castlingEvents.map((event) => event.color));
    push(createRecord({
      contextHash,
      kind: "king_rook.castling_history",
      phase: "path",
      authority: "legal-exact",
      priority: castlingEvents.length ? 88 : 18,
      summary: castlingEvents.length
        ? `Before ${move.san}, the recorded path contains ${castlingEvents.length} castling event${castlingEvents.length === 1 ? "" : "s"}: ${castlingEvents.map((event) => `${colorName(event.color)} ${event.san} on ply ${event.plyIndex + 1}`).join("; ")}.`
        : `The recorded path before ${move.san} contains no castling event.`,
      participants: [
        ...(castlingColors.has("w") && whiteKing ? [whiteKing.participant] : []),
        ...(castlingColors.has("b") && blackKing ? [blackKing.participant] : []),
      ],
      data: { events: castlingEvents },
      pieceLocations: [
        ...(castlingColors.has("w") && whiteKing ? [{ ...whiteKing.location, phase: "after" }] : []),
        ...(castlingColors.has("b") && blackKing ? [{ ...blackKing.location, phase: "after" }] : []),
      ],
      coverage: { domain: "prior-castling-events", exhaustive: true, covered: castlingEvents.map((event) => String(event.plyIndex)), unresolved: [] },
      replay: { fen: request.context.historyStartFen || new Chess().fen(), movesUci: request.context.historyUci },
    }));

    const beforeAttacks = attackedSquares(beforeBoard, from, moverColor);
    const afterAttacks = attackedSquares(after, to, moverColor);
    const gained = afterAttacks.filter((square) => !beforeAttacks.includes(square));
    const lost = beforeAttacks.filter((square) => !afterAttacks.includes(square));
    const retained = afterAttacks.filter((square) => beforeAttacks.includes(square));
    const occupiedTargets = afterAttacks.filter((square) => after.get(square)?.color === opposite(moverColor));
    const targetPieces = occupiedTargets.flatMap((square) => {
      const item = participantForSquare(timeline.after, square, PARTICIPANT_ROLES.TARGET);
      return item ? [{ square, ...item }] : [];
    });
    push(createRecord({
      contextHash,
      kind: "piece.attack_delta",
      phase: "transition",
      authority: "deterministic-derived",
      priority: occupiedTargets.length ? 92 : 72,
      summary: `After ${move.san}, the moved ${PIECE_NAMES[move.piece]} attacks ${afterAttacks.join(", ") || "no squares"}; gained attacks are ${gained.join(", ") || "none"}, and occupied opponent targets are ${occupiedTargets.join(", ") || "none"}.`,
      participants: [...target.participants, ...targetPieces.map((item) => item.participant)],
      data: { from, to, beforeAttacks, afterAttacks, gained, lost, retained, occupiedOpponentTargets: occupiedTargets },
      pieceLocations: [...target.locations, ...targetPieces.map((item) => ({ ...item.location, phase: "after" }))],
      coverage: { domain: "moved-piece-geometric-attacks", exhaustive: true, covered: afterAttacks, unresolved: [] },
      replay: { fen: request.context.fenBefore, movesUci: [request.context.moveUci] },
    }));

    const friendlyOrigins = after.attackers(to, moverColor).filter((origin) => after.get(origin)?.type !== "p");
    const friendlyAttackers = friendlyOrigins.flatMap((origin) => {
      const item = participantForSquare(timeline.after, origin, PARTICIPANT_ROLES.RESOURCE);
      const piece = after.get(origin);
      return item && piece ? [{ origin, pieceType: piece.type, ...item }] : [];
    });
    push(createRecord({
      contextHash,
      kind: "square.friendly_nonpawn_reachers_after",
      phase: "after",
      authority: "deterministic-derived",
      priority: friendlyAttackers.some((item) => item.pieceType === "n") ? 91 : friendlyAttackers.length ? 64 : 20,
      summary: `${to} is occupied by the moved ${colorName(moverColor).toLowerCase()} ${PIECE_NAMES[move.piece]} after ${move.san}; friendly non-pawn pieces whose movement geometry reaches ${to} are ${friendlyAttackers.map((item) => `${PIECE_NAMES[item.pieceType]} on ${item.origin}`).join(" and ") || "none"}. Friendly occupancy makes entry onto ${to} illegal while it remains, but does not establish whether that square is strategically desirable for the other piece.`,
      participants: [...target.participants, ...friendlyAttackers.map((item) => item.participant)],
      data: { square: to, occupantPieceId: pieceIdAt(timeline.after, to), occupantType: move.piece, color: moverColor, friendlyNonPawnReachers: friendlyAttackers.map((item) => ({ pieceId: item.participant.ref.id, currentSquare: item.origin, pieceType: item.pieceType })), entryIllegalWhileFriendlyOccupied: true },
      pieceLocations: [...target.locations, ...friendlyAttackers.map((item) => ({ ...item.location, phase: "after" }))],
      coverage: { domain: "target-destination-friendly-nonpawn-reachers", exhaustive: true, covered: [to, ...friendlyOrigins], unresolved: [] },
      replay: { fen: request.context.fenAfter },
    }));

    const attackerChanges = attackerSetChanges(beforeBoard, after, timeline);
    const retainedAfterLoss = attackerChanges.filter((change) => change.lost.length && change.afterAttackers.length);
    const attackPieceLocations = attackerChanges
      .flatMap((change) => [...change.beforeAttackers.map((item) => ({ pieceId: item.pieceId, currentSquare: item.currentSquare, phase: "before" })), ...change.afterAttackers.map((item) => ({ pieceId: item.pieceId, currentSquare: item.currentSquare, phase: "after" }))])
      .filter((item, index, all) => all.findIndex((candidate) => candidate.pieceId === item.pieceId && candidate.currentSquare === item.currentSquare && candidate.phase === item.phase) === index);
    for (const change of attackerChanges) {
      const entries = afterLegalMoves.filter((reply) => reply.to === change.square);
      const entryResponseWitnesses = entries.map((entry) => {
        const afterEntry = new Chess(request.context.fenAfter);
        applyVerboseMove(afterEntry, entry);
        const captureMoves = afterEntry.moves({ verbose: true })
          .filter((reply) => reply.to === change.square && Boolean(reply.captured));
        const captureOutcomes = new Map(immediateCaptureOutcomes(afterEntry.fen(), captureMoves)
          .map((outcome) => [outcome.capture.uci, outcome]));
        const immediateSameSquareCaptures = captureMoves.map((reply) => {
          const outcome = captureOutcomes.get(moveUci(reply));
          return {
            uci: moveUci(reply),
            san: reply.san,
            from: reply.from,
            to: reply.to,
            moverPieceId: pieceIdAt(timeline.after, reply.from as Square),
            capturedPieceId: pieceIdAt(timeline.after, entry.from as Square),
            nominalBalanceDeltaAfterCapture: outcome?.nominalBalanceDeltaAfterCapture ?? null,
            immediateSameSquareRecaptures: outcome?.immediateSameSquareRecaptures || [],
            ...(outcome?.minimumNominalBalanceDeltaAfterImmediateSameSquareRecapture == null
              ? {}
              : { minimumNominalBalanceDeltaAfterImmediateSameSquareRecapture: outcome.minimumNominalBalanceDeltaAfterImmediateSameSquareRecapture }),
          };
        });
        return {
          entry: {
            uci: moveUci(entry),
            san: entry.san,
            from: entry.from,
            to: entry.to,
            moverPieceId: pieceIdAt(timeline.after, entry.from as Square),
          },
          immediateSameSquareCaptures,
        };
      });
      const entryResponseText = entryResponseWitnesses.flatMap((witness) => witness.immediateSameSquareCaptures
        .map((reply) => {
          const recaptures = reply.immediateSameSquareRecaptures.map((recapture) => `${recapture.san} (${recapture.nominalBalanceDeltaForCapturingSide})`);
          return `${witness.entry.san} ${reply.san}${recaptures.length ? ` ${recaptures.join(" or ")}` : ""} (first capturer nominal delta ${recaptures.length ? reply.minimumNominalBalanceDeltaAfterImmediateSameSquareRecapture : reply.nominalBalanceDeltaAfterCapture}; ${recaptures.length ? "after immediate recapture" : "no immediate recapture"})`;
        }));
      const entryResponseReplayLines: string[][] = entryResponseWitnesses.flatMap((witness) => witness.immediateSameSquareCaptures.length
        ? witness.immediateSameSquareCaptures.flatMap((reply) => reply.immediateSameSquareRecaptures.length
          ? reply.immediateSameSquareRecaptures.map((recapture) => [request.context.moveUci, witness.entry.uci, reply.uci, recapture.uci])
          : [[request.context.moveUci, witness.entry.uci, reply.uci]])
        : [[request.context.moveUci, witness.entry.uci]]);
      const beforeOccupant = beforeBoard.get(change.square);
      const afterOccupant = after.get(change.square);
      const beforeOccupantId = beforeOccupant ? pieceIdAt(timeline.before, change.square) : null;
      const afterOccupantId = afterOccupant ? pieceIdAt(timeline.after, change.square) : null;
      const occupiedOpponentLostAttack = change.lost.length > 0
        && beforeOccupant?.color === opposite(change.color)
        && afterOccupantId === beforeOccupantId;
      const newlyContestedLegalEntry = change.gained.length > 0 && entries.length > 0;
      const beforeText = change.beforeAttackers.map((item) => `${PIECE_NAMES[item.pieceType]} on ${item.currentSquare}`).join(" and ") || "none";
      const afterText = change.afterAttackers.map((item) => `${PIECE_NAMES[item.pieceType]} on ${item.currentSquare}`).join(" and ") || "none";
      const referenced: Array<{ participant: SemanticParticipant; location: Record<string, SemanticValue> }> = [
        ...change.beforeAttackers.flatMap((item) => {
          const participant = participantForSquare(timeline.before, item.currentSquare, PARTICIPANT_ROLES.RESOURCE);
          return participant ? [{ participant: participant.participant, location: { ...participant.location, phase: "before" } }] : [];
        }),
        ...change.afterAttackers.flatMap((item) => {
          const participant = participantForSquare(timeline.after, item.currentSquare, PARTICIPANT_ROLES.RESOURCE);
          return participant ? [{ participant: participant.participant, location: { ...participant.location, phase: "after" } }] : [];
        }),
      ];
      if (occupiedOpponentLostAttack) {
        const affectedBefore = participantForSquare(timeline.before, change.square, PARTICIPANT_ROLES.TARGET);
        const affectedAfter = participantForSquare(timeline.after, change.square, PARTICIPANT_ROLES.TARGET);
        if (affectedBefore) referenced.push({ participant: affectedBefore.participant, location: { ...affectedBefore.location, phase: "before" } });
        if (affectedAfter) referenced.push({ participant: affectedAfter.participant, location: { ...affectedAfter.location, phase: "after" } });
      }
      const participants = [...target.participants, ...referenced.map((item) => item.participant)]
        .filter((item, index, all) => all.findIndex((candidate) => candidate.role === item.role && candidate.ref.domain === item.ref.domain && candidate.ref.id === item.ref.id) === index);
      const locations = [...target.locations, ...referenced.map((item) => item.location)]
        .filter((item, index, all) => all.findIndex((candidate) => candidate.pieceId === item.pieceId && candidate.currentSquare === item.currentSquare && candidate.phase === item.phase) === index);
      const remainsAfterLoss = change.lost.length > 0 && change.afterAttackers.length > 0;
      push(createRecord({
        contextHash,
        kind: "square.attacker_delta",
        phase: "transition",
        authority: "deterministic-derived",
        priority: occupiedOpponentLostAttack
          ? 98
          : remainsAfterLoss && entries.length
            ? 94
            : newlyContestedLegalEntry
              // A newly available legal entry paired with an exact immediate
              // capture witness is direct, replayable board information. It
              // remains below occupied-piece protection, but ahead of broad
              // descriptive deltas so a tight budget can retain the concrete
              // entry/capture chain without inferring its strategic value.
              ? entryResponseWitnesses.some((witness) => witness.immediateSameSquareCaptures.length) ? 96 : 91
              : remainsAfterLoss
                ? 88
                : entries.length
                  ? 82
                  : 68,
        summary: `${colorName(change.color)} attackers of ${change.square} change from ${beforeText} to ${afterText}.${occupiedOpponentLostAttack && beforeOccupant ? ` The ${colorName(beforeOccupant.color).toLowerCase()} ${PIECE_NAMES[beforeOccupant.type]} remains on ${change.square} and is no longer attacked by the removed attacker set.` : ""}${entries.length ? ` ${colorName(after.turn())} has ${entries.length} legal move${entries.length === 1 ? "" : "s"} to ${change.square}: ${entries.map((reply) => reply.san).join(", ")}.` : ""}${entryResponseText.length ? ` Exact immediate captures back onto that entry square include ${entryResponseText.join(", ")}.` : ""}`,
        participants,
        data: {
          ...change,
          remainsAttackedAfterLoss: remainsAfterLoss,
          occupiedOpponentLostAttack,
          affectedOccupiedPiece: occupiedOpponentLostAttack && beforeOccupant ? {
            pieceId: beforeOccupantId,
            color: beforeOccupant.color,
            pieceType: beforeOccupant.type,
            square: change.square,
          } : null,
          newlyContestedLegalEntry,
          sideToMoveLegalEntries: entries.map((reply) => ({ uci: moveUci(reply), san: reply.san, from: reply.from, to: reply.to, moverPieceId: pieceIdAt(timeline.after, reply.from as Square) })),
          entryResponseWitnesses,
          entryResponseCoverage: {
            exhaustive: true,
            coveredEntryMoves: entries.map((reply) => moveUci(reply)),
            depth: "entry-capture-immediate-same-square-recapture",
            unresolved: ["later continuations", "off-square replies after the entry"],
          },
        },
        pieceLocations: locations,
        coverage: { domain: `attacker-set-${change.color}-${change.square}-transition`, exhaustive: true, covered: [change.square], unresolved: [] },
        replay: {
          fen: request.context.fenBefore,
          movesUci: [request.context.moveUci],
          ...(entryResponseReplayLines.length ? { linesUci: entryResponseReplayLines } : {}),
        },
      }));
      const exchangeWitnesses = sameSquareExchangeWitnesses(request.context.fenAfter, change.square);
      if (exchangeWitnesses.length) {
        const lineOutcomes = sameSquareLineOutcomes(request.context.fenAfter, exchangeWitnesses);
        push(createRecord({
          contextHash,
          kind: "square.same_square_exchange_witnesses",
          phase: "path",
          authority: "deterministic-derived",
          priority: lineOutcomes.every((outcome) => outcome.finalNominalBalanceDeltaForFirstCapturingSide !== null && outcome.finalNominalBalanceDeltaForFirstCapturingSide < 0)
            ? 70
            : exchangeWitnesses.some((line) => line.length >= 3) ? 93 : 78,
          summary: `Legal same-square exchange witnesses on ${change.square} after ${move.san} include ${exchangeWitnesses.map((line, index) => `${line.map((item) => item.san).join(" ")} (final nominal balance delta for the first capturing side ${lineOutcomes[index].finalNominalBalanceDeltaForFirstCapturingSide ?? "not applicable"})`).join("; ")}. These lines are not asserted to be forced or best, and nominal arithmetic is not SEE.`,
          participants: target.participants,
          data: {
            square: change.square,
            lines: exchangeWitnesses,
            lineOutcomes,
            attackerLossRetainedAndLegalEntry: remainsAfterLoss && entries.length > 0,
          },
          pieceLocations: target.locations,
          coverage: { domain: `same-square-exchange-witnesses-${change.square}`, exhaustive: true, covered: exchangeWitnesses.map((line) => line.map((item) => item.uci).join(" ")), unresolved: [] },
          replay: { fen: request.context.fenAfter, linesUci: exchangeWitnesses.map((line) => line.map((item) => item.uci)) },
        }));
        for (const witness of exchangeRayAlignmentWitnesses(request.context.fenAfter, timeline.after, exchangeWitnesses)) {
          push(createRecord({
            contextHash,
            kind: "line.occupied_ray_alignment_after_exchange",
            phase: "path",
            authority: "legal-exact",
            // Exact geometry in a hypothetical exchange line remains useful
            // on demand, but is less salient than the target move's direct
            // changes regardless of the rear piece's nominal value.
            priority: witness.rear.pieceType === "q" || witness.rear.pieceType === "k" ? 58 : 52,
            summary: `The legal witness ${witness.movesUci.join(" ")} newly creates an exact occupied ray from ${colorName(witness.slider.color)} ${PIECE_NAMES[witness.slider.pieceType]} on ${witness.slider.currentSquare} through ${colorName(witness.front.color)} ${PIECE_NAMES[witness.front.pieceType]} on ${witness.front.currentSquare} to ${colorName(witness.rear.color)} ${PIECE_NAMES[witness.rear.pieceType]} on ${witness.rear.currentSquare}. This geometry alone does not establish tactical meaning, force, or exchange quality.`,
            participants: [
              { role: PARTICIPANT_ROLES.ACTOR, ref: { domain: REFERENCE_DOMAINS.PIECE, id: witness.slider.pieceId } },
              { role: PARTICIPANT_ROLES.TARGET, ref: { domain: REFERENCE_DOMAINS.PIECE, id: witness.front.pieceId } },
              { role: PARTICIPANT_ROLES.TARGET, ref: { domain: REFERENCE_DOMAINS.PIECE, id: witness.rear.pieceId } },
            ],
            data: {
              movesUci: witness.movesUci,
              finalFen: witness.finalFen,
              sliderPieceId: witness.slider.pieceId,
              sliderSquare: witness.slider.currentSquare,
              sliderPieceType: witness.slider.pieceType,
              frontPieceId: witness.front.pieceId,
              frontSquare: witness.front.currentSquare,
              frontPieceType: witness.front.pieceType,
              rearPieceId: witness.rear.pieceId,
              rearSquare: witness.rear.currentSquare,
              rearPieceType: witness.rear.pieceType,
              ray: witness.ray,
            },
            pieceLocations: [
              { pieceId: witness.slider.pieceId, currentSquare: witness.slider.currentSquare, phase: "path-final" },
              { pieceId: witness.front.pieceId, currentSquare: witness.front.currentSquare, phase: "path-final" },
              { pieceId: witness.rear.pieceId, currentSquare: witness.rear.currentSquare, phase: "path-final" },
            ],
            coverage: {
              domain: `new-opposing-slider-ray-alignments-with-higher-value-rear-piece-after-${witness.movesUci.join("-")}`,
              exhaustive: true,
              covered: [`${witness.slider.currentSquare}:${witness.front.currentSquare}:${witness.rear.currentSquare}`],
              unresolved: [],
            },
            replay: { fen: request.context.fenAfter, movesUci: witness.movesUci },
          }));
        }
      }
    }
    push(createRecord({
      contextHash,
      kind: "square.attackers_delta_inventory",
      phase: "transition",
      authority: "deterministic-derived",
      priority: 22,
      summary: `Across all squares, ${attackerChanges.length} attacker set${attackerChanges.length === 1 ? " changes" : "s change"}; ${retainedAfterLoss.length} square${retainedAfterLoss.length === 1 ? " remains" : "s remain"} attacked after losing at least one attacker. This is geometry, not a claim of strategic importance.`,
      participants: target.participants,
      data: { moverColor, changes: attackerChanges, retainedAfterLoss: retainedAfterLoss.map((change) => change.square) },
      pieceLocations: [...target.locations, ...attackPieceLocations],
      coverage: { domain: "all-square-attacker-sets-transition", exhaustive: true, covered: [...SQUARES], unresolved: [] },
      replay: { fen: request.context.fenBefore, movesUci: [request.context.moveUci] },
    }));

    for (const attackedSquare of occupiedTargets) {
      const attackedPiece = after.get(attackedSquare);
      const participant = participantForSquare(timeline.after, attackedSquare, PARTICIPANT_ROLES.TARGET);
      if (!attackedPiece || !participant || attackedPiece.color !== after.turn()) continue;
      const legalMoves = after.moves({ square: attackedSquare, verbose: true });
      push(createRecord({
        contextHash,
        kind: "piece.legal_moves",
        phase: "after",
        authority: "legal-exact",
        priority: 84,
        summary: `The attacked ${PIECE_NAMES[attackedPiece.type]} on ${attackedSquare} has ${legalMoves.length} legal move${legalMoves.length === 1 ? "" : "s"}: ${legalMoves.map((item) => item.san).join(", ") || "none"}.`,
        participants: [participant.participant],
        data: { origin: attackedSquare, pieceType: attackedPiece.type, movesUci: legalMoves.map((item) => `${item.from}${item.to}${item.promotion || ""}`), movesSan: legalMoves.map((item) => item.san) },
        pieceLocations: [{ ...participant.location, phase: "after" }],
        coverage: { domain: `legal-moves-from-${attackedSquare}`, exhaustive: true, covered: legalMoves.map((item) => `${item.from}${item.to}${item.promotion || ""}`), unresolved: [] },
        replay: { fen: request.context.fenAfter },
      }));
    }

    if (move.isKingsideCastle() || move.isQueensideCastle()) {
      const rank = moverColor === "w" ? "1" : "8";
      const rookFrom = `${move.isKingsideCastle() ? "h" : "a"}${rank}` as Square;
      const rookTo = `${move.isKingsideCastle() ? "f" : "d"}${rank}` as Square;
      const rookBefore = participantForSquare(timeline.before, rookFrom, PARTICIPANT_ROLES.RESOURCE);
      const rookAfter = participantForSquare(timeline.after, rookTo, PARTICIPANT_ROLES.RESOURCE);
      push(createRecord({
        contextHash,
        kind: "castling.king_rook_transition",
        phase: "transition",
        authority: "legal-exact",
        priority: 98,
        summary: `${move.san} moves the king from ${from} to ${to} and the rook from ${rookFrom} to ${rookTo} in one legal move.`,
        participants: [...target.participants, ...(rookBefore ? [rookBefore.participant] : [])],
        data: { king: { from, to }, rook: { from: rookFrom, to: rookTo }, side: move.isKingsideCastle() ? "king" : "queen" },
        pieceLocations: [...target.locations, ...(rookBefore ? [{ pieceId: rookBefore.participant.ref.id, currentSquare: rookFrom, phase: "before" }, { pieceId: rookAfter?.participant.ref.id || rookBefore.participant.ref.id, currentSquare: rookTo, phase: "after" }] : [])],
        coverage: { domain: "target-move", exhaustive: true, covered: [request.context.moveUci, rookFrom, rookTo], unresolved: [] },
        replay: { fen: request.context.fenBefore, movesUci: [request.context.moveUci] },
      }));
    }

    push(pinRecord({ board: after, timeline, contextHash, fen: request.context.fenAfter }));

    if (move.piece === "p" && !move.isPromotion()) {
      const pawnState = isPassedPawn(after, to, moverColor);
      const toRank = Number(to[1]);
      const promotionSquare = `${to[0]}${moverColor === "w" ? "8" : "1"}` as Square;
      const ranksRemaining = moverColor === "w" ? 8 - toRank : toRank - 1;
      const forwardRank = toRank + (moverColor === "w" ? 1 : -1);
      const forwardSquare = forwardRank >= 1 && forwardRank <= 8 ? `${to[0]}${forwardRank}` as Square : null;
      const captureSquares = [-1, 1].flatMap((fileDelta) => {
        const file = to.charCodeAt(0) - 97 + fileDelta;
        return file >= 0 && file <= 7 && forwardRank >= 1 && forwardRank <= 8
          ? [`${String.fromCharCode(97 + file)}${forwardRank}` as Square]
          : [];
      });
      const squareOccupant = (square: Square | null) => {
        if (!square) return null;
        const piece = after.get(square);
        return piece ? { color: piece.color, pieceType: piece.type } : null;
      };
      const opponentKingSquare = moverColor === "w" ? blackKingSquare : whiteKingSquare;
      const opponentKingDistance = kingDistance(opponentKingSquare, promotionSquare).chebyshev;
      push(createRecord({
        contextHash,
        kind: "pawn.advance_state",
        phase: "transition",
        authority: "deterministic-derived",
        // A target pawn's immediate forward and capture geometry is direct
        // transition evidence. Keep it alongside other target-move facts in
        // constrained collections without treating the geometry as a future
        // plan or promotion result.
        priority: 97,
        summary: `After ${move.san}, the pawn is on ${to}. Its next forward square is ${forwardSquare || "none"} (${forwardSquare ? squareOccupant(forwardSquare) ? "occupied" : "empty" : "off board"}); its diagonal capture squares are ${captureSquares.map((square) => `${square} (${squareOccupant(square) ? "occupied" : "empty"})`).join(" and ") || "none"}. It has ${ranksRemaining} rank${ranksRemaining === 1 ? "" : "s"} remaining to ${promotionSquare}; ${pawnState.opposingPawnBlockers.length ? `opposing pawns ahead on its file or adjacent files are ${pawnState.opposingPawnBlockers.join(", ")}` : "no opposing pawn is ahead on its file or either adjacent file"}. This geometry does not assert that a future advance stays legal after the opponent replies.`,
        participants: target.participants,
        data: {
          from,
          to,
          color: moverColor,
          forwardSquare,
          forwardSquareOccupant: squareOccupant(forwardSquare),
          captureSquares,
          captureSquareOccupants: captureSquares.map((square) => ({ square, occupant: squareOccupant(square) })),
          promotionSquare,
          ranksRemaining,
          hasNoOpposingPawnAheadOnSameOrAdjacentFile: pawnState.passed,
          opposingPawnBlockers: pawnState.opposingPawnBlockers,
          opponentKingSquare,
          opponentKingDistanceToPromotionSquare: opponentKingDistance,
          sideToMove: after.turn(),
        },
        pieceLocations: target.locations,
        coverage: { domain: "target-pawn-advance", exhaustive: true, covered: [request.context.moveUci, to, promotionSquare], unresolved: [] },
        replay: { fen: request.context.fenBefore, movesUci: [request.context.moveUci] },
      }));
    }

    push(createRecord({
      contextHash,
      kind: "material.inventory",
      phase: "after",
      authority: "legal-exact",
      priority: 30,
      summary: "The complete after-position piece inventory is recorded without assigning strategic meaning.",
      participants: target.afterParticipants,
      data: { pieces: inventory(after, timeline.after) },
      pieceLocations: inventory(after, timeline.after).flatMap((piece) => piece.pieceId ? [{ pieceId: piece.pieceId, currentSquare: piece.square, phase: "after" }] : []),
      coverage: { domain: "after-position-piece-inventory", exhaustive: true, covered: ["all-occupied-squares"], unresolved: [] },
      replay: { fen: request.context.fenAfter },
    }));

    const beforeWhite = nominalMaterial(beforeBoard, "w");
    const beforeBlack = nominalMaterial(beforeBoard, "b");
    const afterWhite = nominalMaterial(after, "w");
    const afterBlack = nominalMaterial(after, "b");
    push(createRecord({
      contextHash,
      kind: "material.nominal_delta",
      phase: "transition",
      authority: "deterministic-derived",
      priority: move.captured || move.promotion ? 86 : 28,
      summary: `Nominal material changes from White ${beforeWhite}/Black ${beforeBlack} to White ${afterWhite}/Black ${afterBlack}; this arithmetic is not an engine evaluation.`,
      participants: target.participants,
      data: { values: NOMINAL_VALUES, before: { white: beforeWhite, black: beforeBlack }, after: { white: afterWhite, black: afterBlack }, delta: { white: afterWhite - beforeWhite, black: afterBlack - beforeBlack } },
      pieceLocations: target.locations,
      coverage: { domain: "target-move-material", exhaustive: true, covered: [request.context.moveUci], unresolved: [] },
      replay: { fen: request.context.fenBefore, movesUci: [request.context.moveUci] },
    }));

    push(createRecord({
      contextHash,
      kind: "position.legal_move_count",
      phase: "after",
      authority: "legal-exact",
      priority: 20,
      summary: `The side to move after ${move.san} has ${afterLegalMoves.length} legal moves.`,
      participants: [],
      data: { sideToMove: after.turn(), legalMoveCount: afterLegalMoves.length },
      pieceLocations: [],
      coverage: { domain: "all-legal-moves-after", exhaustive: true, covered: ["all-legal-moves"], unresolved: [] },
      replay: { fen: request.context.fenAfter },
    }));

    const replyPieceLocations = afterLegalMoves.map((reply) => ({
      pieceId: pieceIdAt(timeline.after, reply.from as Square),
      currentSquare: reply.from,
      phase: "after",
    })).filter((item): item is { pieceId: string; currentSquare: Square; phase: string } => Boolean(item.pieceId))
      .filter((item, index, all) => all.findIndex((candidate) => candidate.pieceId === item.pieceId && candidate.currentSquare === item.currentSquare) === index);
    push(createRecord({
      contextHash,
      kind: "position.legal_moves",
      phase: "after",
      authority: "legal-exact",
      priority: after.isCheck() || afterLegalMoves.length <= 4 ? 92 : 26,
      summary: `${colorName(after.turn())} has exactly ${afterLegalMoves.length} legal move${afterLegalMoves.length === 1 ? "" : "s"} after ${move.san}: ${afterLegalMoves.map((reply) => reply.san).join(", ") || "none"}.`,
      participants: [],
      data: { sideToMove: after.turn(), moves: afterLegalMoves.map((reply) => ({ uci: moveUci(reply), san: reply.san, moverPieceId: pieceIdAt(timeline.after, reply.from as Square), from: reply.from, to: reply.to, capture: reply.captured || null, promotion: reply.promotion || null })) },
      pieceLocations: replyPieceLocations,
      coverage: { domain: "all-legal-moves-after", exhaustive: true, covered: afterLegalMoves.map(moveUci), unresolved: [] },
      replay: { fen: request.context.fenAfter },
    }));

    if (signal?.aborted) throw signal.reason || new Error("Chess fact request cancelled");
    if (Date.now() - startedAt > request.budgets.maxWallTimeMs) throw new Error("Chess fact request exceeded its wall-time budget");
    const requested = new Set(request.requestedKinds);
    const ordered = [...candidates].sort((left, right) => right.priority - left.priority || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
    const selected = requested.size ? ordered.filter((record) => requested.has(record.kind)) : ordered;
    const omitted: ChessFactResult["omitted"] = requested.size
      ? ordered.filter((record) => !requested.has(record.kind)).map((record) => ({ kind: record.kind, reason: "not-requested", recordId: record.id }))
      : [];
    const records: ChessFactRecord[] = [];
    let resultBytes = bytes({ schemaVersion: CHESS_FACT_RESULT_VERSION, contextHash, records: [], capabilities: CAPABILITIES, omitted: [], unavailableKinds: [], limitations: [] });
    // A caller asking for a named subset owns that subset. For the default
    // complete target-move collection, reserve the first ordinary budget slot
    // for the one protected destination geometry record. The protection never
    // expands maxRecords or maxBytes: if the caller's byte cap cannot express
    // that required target-move fact, fail explicitly rather than returning a
    // silently incomplete geometry set.
    const budgetProtected = requested.size ? [] : selected.filter((record) => record.budgetProtected);
    const ordinary = selected.filter((record) => !record.budgetProtected);
    for (const candidate of budgetProtected) {
      const record = { ...candidate } as Partial<CandidateRecord>;
      delete record.priority;
      delete record.budgetProtected;
      const fact = record as ChessFactRecord;
      const recordBytes = bytes(fact);
      if (records.length >= request.budgets.maxRecords) {
        throw new Error("target-destination-geometry-budget-invariant: maxRecords cannot reserve the required destination attack-map record");
      }
      if (resultBytes + recordBytes > request.budgets.maxBytes) {
        throw new Error("target-destination-geometry-budget-invariant: maxBytes cannot contain the required destination attack-map record");
      }
      records.push(fact);
      resultBytes += recordBytes;
    }
    for (const candidate of ordinary) {
      const record = { ...candidate } as Partial<CandidateRecord>;
      delete record.priority;
      delete record.budgetProtected;
      const fact = record as ChessFactRecord;
      const recordBytes = bytes(fact);
      if (records.length >= request.budgets.maxRecords || resultBytes + recordBytes > request.budgets.maxBytes) {
        omitted.push({ kind: fact.kind, reason: "budget", recordId: fact.id });
      } else {
        records.push(fact);
        resultBytes += recordBytes;
      }
    }
    const availableKinds = new Set(CAPABILITIES.map((capability) => capability.kind));
    return {
      schemaVersion: CHESS_FACT_RESULT_VERSION,
      contextHash,
      records,
      capabilities: [...CAPABILITIES],
      omitted,
      unavailableKinds: [...requested].filter((kind) => !availableKinds.has(kind)).map((kind) => ({ kind, reason: "The mechanical provider does not implement this registry kind." })),
      limitations: [
        "Mechanical browser provider slice; no semantic plans, classifications, engine evaluation, SEE, or exchange-safety claims are emitted.",
        "Geometric attack deltas do not establish that a target is tactically loose, hanging, or safely capturable.",
      ],
    };
  }
}

export function createMechanicalFactRequest(
  context: ReasoningPositionContext,
  overrides: Partial<ChessFactRequest["budgets"]> = {},
): ChessFactRequest {
  return {
    schemaVersion: CHESS_FACT_REQUEST_VERSION,
    requestId: `mechanical-facts:${reasoningContextHash(context)}`,
    context,
    requestedKinds: [],
    // This helper is used by offline experiments and deterministic regression
    // fixtures. Live browser requests carry the run's explicit budget through
    // ChessFactObservationProvider instead of inheriting this default.
    budgets: { maxRecords: 64, maxBytes: 160_000, maxWallTimeMs: 5_000, ...overrides },
  };
}
