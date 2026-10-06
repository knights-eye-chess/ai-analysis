import { Chess, SQUARES, type Color, type PieceSymbol, type Square } from "chess.js";
import { pieceIdAt } from "./poc-piece-refs";
import { applyIdentityMove } from "./piece-identities";
import type { IdentityState } from "./types";

export type OccupiedRayPiece = {
  pieceId: string;
  currentSquare: Square;
  pieceType: PieceSymbol;
  color: Color;
};

export type ExchangeRayAlignmentWitness = {
  movesUci: string[];
  finalFen: string;
  slider: OccupiedRayPiece;
  front: OccupiedRayPiece;
  rear: OccupiedRayPiece;
  ray: Square[];
};

type RayDirection = readonly [number, number];

const NOMINAL_VALUES: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const ORTHOGONAL_DIRECTIONS: readonly RayDirection[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL_DIRECTIONS: readonly RayDirection[] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

function moveUci(move: { from: string; to: string; promotion?: string }) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function squareAt(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${String.fromCharCode(97 + file)}${rank + 1}` as Square;
}

function occupiedOpponentRayAlignments(board: Chess, identities: IdentityState) {
  const result: Array<Omit<ExchangeRayAlignmentWitness, "movesUci" | "finalFen">> = [];
  for (const sliderSquare of SQUARES) {
    const slider = board.get(sliderSquare);
    if (!slider || !["b", "r", "q"].includes(slider.type)) continue;
    const directions = slider.type === "b"
      ? DIAGONAL_DIRECTIONS
      : slider.type === "r"
        ? ORTHOGONAL_DIRECTIONS
        : [...ORTHOGONAL_DIRECTIONS, ...DIAGONAL_DIRECTIONS];
    const originFile = sliderSquare.charCodeAt(0) - 97;
    const originRank = Number(sliderSquare[1]) - 1;
    for (const [fileStep, rankStep] of directions) {
      const ray: Square[] = [sliderSquare];
      const occupied: Array<{ square: Square; color: Color; type: PieceSymbol; pieceId: string | null }> = [];
      for (let distance = 1; distance < 8; distance += 1) {
        const square = squareAt(originFile + fileStep * distance, originRank + rankStep * distance);
        if (!square) break;
        ray.push(square);
        const piece = board.get(square);
        if (!piece) continue;
        occupied.push({ square, color: piece.color, type: piece.type, pieceId: pieceIdAt(identities, square) });
        if (occupied.length === 2) break;
      }
      const front = occupied[0];
      const rear = occupied[1];
      const sliderPieceId = pieceIdAt(identities, sliderSquare);
      if (!front || !rear || !sliderPieceId || !front.pieceId || !rear.pieceId) continue;
      if (front.color === slider.color || rear.color !== front.color) continue;
      if (rear.type !== "k" && NOMINAL_VALUES[rear.type] <= NOMINAL_VALUES[front.type]) continue;
      result.push({
        slider: { pieceId: sliderPieceId, currentSquare: sliderSquare, pieceType: slider.type, color: slider.color },
        front: { pieceId: front.pieceId, currentSquare: front.square, pieceType: front.type, color: front.color },
        rear: { pieceId: rear.pieceId, currentSquare: rear.square, pieceType: rear.type, color: rear.color },
        ray: ray.slice(0, ray.indexOf(rear.square) + 1),
      });
    }
  }
  return result;
}

function alignmentKey(alignment: Omit<ExchangeRayAlignmentWitness, "movesUci" | "finalFen">) {
  return [
    alignment.slider.pieceId,
    alignment.slider.currentSquare,
    alignment.front.pieceId,
    alignment.front.currentSquare,
    alignment.rear.pieceId,
    alignment.rear.currentSquare,
    alignment.ray.join("-"),
  ].join("|");
}

export function exchangeRayAlignmentWitnesses(
  fenAfter: string,
  identityAfter: IdentityState,
  exchangeLines: readonly (readonly { uci: string }[])[],
): ExchangeRayAlignmentWitness[] {
  const baseline = new Chess(fenAfter);
  const baselineKeys = new Set(occupiedOpponentRayAlignments(baseline, identityAfter).map(alignmentKey));
  const result = new Map<string, ExchangeRayAlignmentWitness>();
  for (const line of exchangeLines) {
    const board = new Chess(fenAfter);
    let identities = identityAfter;
    for (const item of line) {
      const move = board.moves({ verbose: true }).find((candidate) => moveUci(candidate) === item.uci);
      if (!move) throw new Error(`Same-square witness contains an illegal move: ${item.uci}`);
      board.move({ from: move.from, to: move.to, promotion: move.promotion });
      identities = applyIdentityMove(identities, { from: move.from, to: move.to, promotion: move.promotion }).state;
    }
    const movesUci = line.map((item) => item.uci);
    const finalFen = board.fen();
    for (const alignment of occupiedOpponentRayAlignments(board, identities)) {
      const key = alignmentKey(alignment);
      if (baselineKeys.has(key)) continue;
      const witness = { movesUci, finalFen, ...alignment };
      const existing = result.get(key);
      const witnessText = movesUci.join(" ");
      const existingText = existing?.movesUci.join(" ") || "";
      if (!existing || movesUci.length < existing.movesUci.length || (movesUci.length === existing.movesUci.length && witnessText < existingText)) {
        result.set(key, witness);
      }
    }
  }
  return [...result.values()].sort((left, right) => left.movesUci.join(" ").localeCompare(right.movesUci.join(" "))
    || alignmentKey(left).localeCompare(alignmentKey(right)));
}
