import { Chess, SQUARES, type Color, type PieceSymbol, type Square } from "chess.js";
import { applyIdentityMove, createIdentityState } from "./piece-identities";
import type { IdentityState } from "./types";

type Direction = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
type RayStep = readonly [Direction, number, number];

const DIRECTIONS: readonly RayStep[] = [
  ["N", 0, 1], ["NE", 1, 1], ["E", 1, 0], ["SE", 1, -1],
  ["S", 0, -1], ["SW", -1, -1], ["W", -1, 0], ["NW", -1, 1],
];

export type MoveMechanismFacts = {
  mover: {
    pieceId: string;
    pieceIdAfter: string;
    fromSquare: Square;
    toSquare: Square;
    color: Color;
    pieceTypeBefore: PieceSymbol;
    pieceTypeAfter: PieceSymbol;
    attackersBefore: Square[];
    attackersAfter: Square[];
  };
  attackedUnmovedFriendlyPieces: Array<{
    pieceId: string;
    square: Square;
    pieceType: PieceSymbol;
    attackersBefore: Square[];
    attackersAfter: Square[];
  }>;
  stationarySliderRays: Array<{
    pieceId: string;
    fromSquare: Square;
    color: Color;
    pieceType: PieceSymbol;
    direction: Direction;
    beforeSquares: Square[];
    afterSquares: Square[];
    gainedSquares: Square[];
    lostSquares: Square[];
  }>;
  controlDelta: Array<{
    square: Square;
    color: Color;
    attackersBefore: Square[];
    attackersAfter: Square[];
  }>;
  checksRun: string[];
  scope: string;
};

function enemy(color: Color): Color {
  return color === "w" ? "b" : "w";
}

function attackers(board: Chess, square: Square, color: Color): Square[] {
  return board.attackers(square, color).sort((a, b) => SQUARES.indexOf(a) - SQUARES.indexOf(b));
}

function ray(board: Chess, origin: Square, fileStep: number, rankStep: number): Square[] {
  const squares: Square[] = [];
  const file = origin.charCodeAt(0) - 97;
  const rank = Number(origin[1]) - 1;
  for (let distance = 1; distance < 8; distance += 1) {
    const f = file + fileStep * distance;
    const r = rank + rankStep * distance;
    if (f < 0 || f > 7 || r < 0 || r > 7) break;
    const square = `${String.fromCharCode(97 + f)}${r + 1}` as Square;
    squares.push(square);
    // The first blocker is controlled, but nothing behind it is visible.
    if (board.get(square)) break;
  }
  return squares;
}

function sliderDirections(type: PieceSymbol): readonly RayStep[] {
  if (type === "q") return DIRECTIONS;
  return DIRECTIONS.filter(([, dx, dy]) => type === "r" ? !dx || !dy : !!dx && !!dy);
}

/** Complete board-local geometric measurements for one already-admitted legal move. */
export function moveMechanismFacts(
  before: Chess,
  after: Chess,
  from: Square,
  to: Square,
  beforeIds?: IdentityState,
  afterIds?: IdentityState,
): MoveMechanismFacts {
  const moverBefore = before.get(from);
  const moverAfter = after.get(to);
  if (!moverBefore || !moverAfter || moverBefore.color !== moverAfter.color) {
    throw new Error(`Move mechanism has no corresponding mover at ${from}-${to}`);
  }
  const beforeState = beforeIds || createIdentityState(before.fen());
  if (beforeState.fen !== before.fen() || (afterIds && afterIds.fen !== after.fen())) {
    throw new Error("Move mechanism identity position does not match the board");
  }
  // Resolve promotion by the resulting board, since from/to alone can name four
  // distinct legal moves. This also rejects an unrelated after-position.
  const actualMove = before.moves({ verbose: true }).find((move) => {
    if (move.from !== from || move.to !== to) return false;
    const replay = new Chess(before.fen());
    replay.move({ from, to, promotion: move.promotion });
    return replay.fen() === after.fen();
  });
  if (!actualMove) throw new Error(`Move mechanism after-position is not a legal ${from}-${to} result`);
  const afterState = afterIds || applyIdentityMove(beforeState, {
    from, to, promotion: actualMove.promotion,
  }).state;
  const pieceId = beforeState.squares[from];
  const pieceIdAfter = afterState.squares[to];
  if (!pieceId || !pieceIdAfter || (actualMove.promotion
    ? afterState.pieces[pieceIdAfter]?.promotedFrom !== pieceId
    : pieceIdAfter !== pieceId)) {
    throw new Error("Move mechanism mover identities do not match");
  }

  const attackedUnmovedFriendlyPieces: MoveMechanismFacts["attackedUnmovedFriendlyPieces"] = [];
  const stationarySliderRays: MoveMechanismFacts["stationarySliderRays"] = [];
  const color = moverBefore.color;
  for (const square of SQUARES) {
    const piece = before.get(square);
    const samePiece = after.get(square);
    const id = beforeState.squares[square];
    if (!piece || !samePiece || !id || afterState.squares[square] !== id
      || piece.color !== samePiece.color || piece.type !== samePiece.type) continue;
    if (piece.color === color) {
      const beforeAttackers = attackers(before, square, enemy(color));
      const afterAttackers = attackers(after, square, enemy(color));
      if (beforeAttackers.length || afterAttackers.length) {
        attackedUnmovedFriendlyPieces.push({
          pieceId: id, square, pieceType: piece.type,
          attackersBefore: beforeAttackers, attackersAfter: afterAttackers,
        });
      }
    }
    if (piece.type !== "r" && piece.type !== "b" && piece.type !== "q") continue;
    for (const [direction, dx, dy] of sliderDirections(piece.type)) {
      const beforeSquares = ray(before, square, dx, dy);
      const afterSquares = ray(after, square, dx, dy);
      const beforeSet = new Set(beforeSquares);
      const afterSet = new Set(afterSquares);
      const gainedSquares = afterSquares.filter((target) => !beforeSet.has(target));
      const lostSquares = beforeSquares.filter((target) => !afterSet.has(target));
      if (gainedSquares.length || lostSquares.length) {
        stationarySliderRays.push({
          pieceId: id, fromSquare: square, color: piece.color, pieceType: piece.type,
          direction, beforeSquares, afterSquares, gainedSquares, lostSquares,
        });
      }
    }
  }

  const controlDelta: MoveMechanismFacts["controlDelta"] = [];
  for (const square of SQUARES) {
    for (const attackingColor of ["w", "b"] as const) {
      const attackersBefore = attackers(before, square, attackingColor);
      const attackersAfter = attackers(after, square, attackingColor);
      if (attackersBefore.length !== attackersAfter.length
        || attackersBefore.some((origin, index) => origin !== attackersAfter[index])) {
        controlDelta.push({ square, color: attackingColor, attackersBefore, attackersAfter });
      }
    }
  }
  return {
    mover: {
      pieceId, pieceIdAfter, fromSquare: from, toSquare: to, color,
      pieceTypeBefore: moverBefore.type, pieceTypeAfter: moverAfter.type,
      attackersBefore: attackers(before, from, enemy(color)),
      attackersAfter: attackers(after, to, enemy(color)),
    },
    attackedUnmovedFriendlyPieces,
    stationarySliderRays,
    controlDelta,
    checksRun: [
      "mover-geometric-attackers-before-after",
      "unmoved-friendly-piece-geometric-attackers-before-after",
      "stationary-slider-visible-rays-before-after",
      "all-square-both-color-geometric-control-delta",
    ],
    scope: "Complete board-local geometric measurements at this move. Attackers include pinned pieces; visible slider rays include the first occupied square. Empty lists mean measured none or no change. No claim of legal captures, safe retreat, exchange profit, forced purpose, or strategic importance.",
  };
}
