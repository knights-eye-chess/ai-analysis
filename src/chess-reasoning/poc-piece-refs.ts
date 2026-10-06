import { Chess, SQUARES, type PieceSymbol, type Square } from "chess.js";
import { applyIdentityMove, createIdentityState } from "./piece-identities";
import type { IdentityState, PieceId, PieceIdentity } from "./types";
import type { ReasoningPositionContext } from "./poc-contracts";

const PIECE_LABELS: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

function moveObject(uci: string) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.slice(4) || undefined,
  };
}

function replayFromStart(historyUci: string[], historyStartFen?: string): IdentityState | null {
  let state = createIdentityState(historyStartFen);
  try {
    for (const uci of historyUci) state = applyIdentityMove(state, moveObject(uci)).state;
    return state;
  } catch {
    return null;
  }
}

export type PocIdentityTimeline = {
  before: IdentityState;
  after: IdentityState;
};

export function createPocIdentityTimeline(context: ReasoningPositionContext): PocIdentityTimeline {
  const replayed = replayFromStart(context.historyUci, context.historyStartFen);
  const before = replayed?.fen === new Chess(context.fenBefore).fen()
    ? replayed
    : createIdentityState(context.fenBefore, `reasoning:${context.nodeId}`, context.historyUci.length);
  const after = context.kind === "position" ? before : applyIdentityMove(before, moveObject(context.moveUci)).state;
  if (after.fen !== new Chess(context.fenAfter).fen()) throw new Error("Stable piece-identity replay does not match fenAfter");
  return { before, after };
}

export function pieceIdAt(state: IdentityState, square: Square): PieceId | null {
  return state.squares[square] || null;
}

export function squareForPiece(state: IdentityState, pieceId: PieceId): Square | null {
  return (SQUARES.find((square) => state.squares[square] === pieceId) as Square | undefined) || null;
}

export function pieceIdentity(state: IdentityState, pieceId: PieceId): PieceIdentity | null {
  return state.pieces[pieceId] || null;
}

export function canonicalPieceLabel(piece: PieceIdentity): string {
  return `${piece.color === "w" ? "White" : "Black"} ${PIECE_LABELS[piece.type]}`;
}
