import { Chess, SQUARES, type Color, type PieceSymbol, type Square } from "chess.js";
import {
  CHESS_REASONING_SCHEMA_VERSION,
  type BranchId,
  type IdentityState,
  type MoveIdentityDelta,
  type PieceId,
  type PieceIdentity,
} from "./types";

const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

const COLOR_NAMES: Record<Color, string> = { w: "white", b: "black" };

function pieceId(color: Color, type: PieceSymbol, square: Square, ordinal = 0) {
  return `${COLOR_NAMES[color]}-${PIECE_NAMES[type]}:${square}:${ordinal}`;
}

function promotionId(color: Color, type: PieceSymbol, square: Square, ordinal: number) {
  return `${COLOR_NAMES[color]}-${PIECE_NAMES[type]}:promotion:${square}:${ordinal}`;
}

function clonePieces(pieces: Record<PieceId, PieceIdentity>) {
  return Object.fromEntries(Object.entries(pieces).map(([id, piece]) => [id, { ...piece }]));
}

export function createIdentityState(fen = new Chess().fen(), branchId: BranchId = "main", ply = 0): IdentityState {
  const chess = new Chess(fen);
  const pieces: Record<PieceId, PieceIdentity> = {};
  const squares: Partial<Record<Square, PieceId>> = {};
  const seen = new Map<string, number>();

  for (const square of SQUARES) {
    const piece = chess.get(square);
    if (!piece) continue;
    const key = `${piece.color}:${piece.type}:${square}`;
    const ordinal = seen.get(key) || 0;
    seen.set(key, ordinal + 1);
    const id = pieceId(piece.color, piece.type, square, ordinal);
    pieces[id] = {
      id,
      color: piece.color,
      type: piece.type,
      originSquare: square,
      createdPly: ply,
      promotedFrom: null,
      capturedAtPly: null,
      retiredAtPly: null,
    };
    squares[square] = id;
  }

  return {
    schemaVersion: CHESS_REASONING_SCHEMA_VERSION,
    branchId,
    fen: chess.fen(),
    ply,
    pieces,
    squares,
    promotionSequence: 0,
  };
}

export function forkIdentityState(state: IdentityState, branchId: BranchId): IdentityState {
  return {
    ...state,
    branchId,
    pieces: clonePieces(state.pieces),
    squares: { ...state.squares },
  };
}

export function applyIdentityMove(
  state: IdentityState,
  moveInput: string | { from: string; to: string; promotion?: string },
): { state: IdentityState; delta: MoveIdentityDelta } {
  const chess = new Chess(state.fen);
  const beforeFen = chess.fen();
  const move = chess.move(moveInput);
  const nextPly = state.ply + 1;
  const pieces = clonePieces(state.pieces);
  const squares = { ...state.squares };
  const mover = squares[move.from];
  if (!mover) throw new Error(`No stable piece identity at ${move.from}`);

  let captured: PieceId | null = null;
  const capturedSquare = move.isEnPassant() ? `${move.to[0]}${move.from[1]}` as Square : move.to;
  if (move.isCapture() || move.isEnPassant()) {
    captured = squares[capturedSquare] || null;
    if (!captured) throw new Error(`No captured piece identity at ${capturedSquare}`);
    pieces[captured] = { ...pieces[captured], capturedAtPly: nextPly };
    delete squares[capturedSquare];
  }

  delete squares[move.from];
  let rookMoved: PieceId | null = null;
  if (move.isKingsideCastle() || move.isQueensideCastle()) {
    const rank = move.from[1];
    const rookFrom = `${move.isKingsideCastle() ? "h" : "a"}${rank}` as Square;
    const rookTo = `${move.isKingsideCastle() ? "f" : "d"}${rank}` as Square;
    rookMoved = squares[rookFrom] || null;
    if (!rookMoved) throw new Error(`No stable rook identity at ${rookFrom}`);
    delete squares[rookFrom];
    squares[rookTo] = rookMoved;
  }

  let promoted: PieceId | null = null;
  let promotionSequence = state.promotionSequence;
  if (move.isPromotion()) {
    promotionSequence += 1;
    pieces[mover] = { ...pieces[mover], retiredAtPly: nextPly };
    promoted = promotionId(move.color, move.promotion as PieceSymbol, move.to, promotionSequence);
    pieces[promoted] = {
      id: promoted,
      color: move.color,
      type: move.promotion as PieceSymbol,
      originSquare: move.to,
      createdPly: nextPly,
      promotedFrom: mover,
      capturedAtPly: null,
      retiredAtPly: null,
    };
    squares[move.to] = promoted;
  } else {
    squares[move.to] = mover;
  }

  const nextState: IdentityState = {
    schemaVersion: CHESS_REASONING_SCHEMA_VERSION,
    branchId: state.branchId,
    fen: chess.fen(),
    ply: nextPly,
    pieces,
    squares,
    promotionSequence,
  };
  return {
    state: nextState,
    delta: {
      branchId: state.branchId,
      ply: nextPly,
      uci: `${move.from}${move.to}${move.promotion || ""}`,
      san: move.san,
      mover,
      captured,
      promoted,
      rookMoved,
      beforeFen,
      afterFen: chess.fen(),
    },
  };
}
