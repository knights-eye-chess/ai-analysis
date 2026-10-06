import { MAX_INTERACTIVE_LINE_PLIES } from "./reference-limits";
import { Chess, type Square } from "chess.js";
import { applyIdentityMove } from "./piece-identities";
import type { ReasoningEvidenceRecord, ReasoningPositionContext } from "./poc-contracts";
import { createPocIdentityTimeline, pieceIdAt } from "./poc-piece-refs";
import type { IdentityState } from "./types";

const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const MAX_REPLAY_MOVES = MAX_INTERACTIVE_LINE_PLIES;

export type ReasoningMoveWitness = {
  evidenceId: string;
  uci: string;
  pieceId: string;
  san: string;
};

function canonicalFen(value: string): string | null {
  try {
    return new Chess(value).fen();
  } catch {
    return null;
  }
}

function replayStart(
  record: ReasoningEvidenceRecord,
  context: ReasoningPositionContext,
  before: IdentityState,
  after: IdentityState,
): IdentityState | null {
  const phase = reasoningEvidenceReplayStartPhase(record, context);
  return phase === "before" ? before : phase === "after" ? after : null;
}

export function reasoningEvidenceReplayStartPhase(
  record: ReasoningEvidenceRecord,
  context: ReasoningPositionContext,
): "before" | "after" | null {
  const value = record.replay?.fen ?? record.replay?.fenAfter;
  if (typeof value !== "string") return null;
  const fen = canonicalFen(value);
  if (!fen) return null;
  if (fen === canonicalFen(context.fenBefore)) return "before";
  if (fen === canonicalFen(context.fenAfter)) return "after";
  return null;
}

function replayMoves(record: ReasoningEvidenceRecord): string[] {
  const replay = record.replay;
  if (!replay) return [];
  const sequence = Array.isArray(replay.movesUci)
    ? replay.movesUci
    : Array.isArray(replay.moves)
      ? replay.moves
      : Array.isArray(replay.line)
        ? replay.line
        : typeof replay.move === "string"
          ? [replay.move]
          : [];
  if (!sequence.length || sequence.length > MAX_REPLAY_MOVES) return [];
  return sequence.every((value) => typeof value === "string" && UCI_PATTERN.test(value))
    ? sequence as string[]
    : [];
}

function replayLines(record: ReasoningEvidenceRecord): string[][] {
  const lines = record.replay?.linesUci;
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_REPLAY_MOVES) return [];
  return lines.flatMap((line) => {
    if (!Array.isArray(line) || !line.length || line.length > MAX_REPLAY_MOVES) return [];
    return line.every((value) => typeof value === "string" && UCI_PATTERN.test(value))
      ? [line as string[]]
      : [];
  });
}

function replaySequence(
  evidenceId: string,
  start: IdentityState,
  moves: string[],
): ReasoningMoveWitness[] | null {
  let identities = start;
  const witnesses: ReasoningMoveWitness[] = [];
  for (const uci of moves) {
    const from = uci.slice(0, 2) as Square;
    const pieceId = pieceIdAt(identities, from);
    if (!pieceId) return null;
    try {
      const applied = applyIdentityMove(identities, {
        from,
        to: uci.slice(2, 4),
        promotion: uci.slice(4) || undefined,
      });
      witnesses.push({ evidenceId, uci, pieceId, san: applied.delta.san });
      identities = applied.state;
    } catch {
      return null;
    }
  }
  return witnesses;
}

function independentRootMoves(record: ReasoningEvidenceRecord): string[] {
  const roots = record.data?.rootMoves;
  if (!Array.isArray(roots) || !roots.length || roots.length > MAX_REPLAY_MOVES) return [];
  return roots.every((value) => typeof value === "string" && UCI_PATTERN.test(value))
    ? roots as string[]
    : [];
}

/**
 * Replays only admitted evidence whose starting position is one of the exact
 * request positions. A malformed or partial replay contributes no witnesses.
 */
export function collectReasoningMoveWitnesses(
  records: Iterable<ReasoningEvidenceRecord>,
  context: ReasoningPositionContext,
): ReasoningMoveWitness[] {
  const timeline = createPocIdentityTimeline(context);
  const collected: ReasoningMoveWitness[] = [];

  for (const record of records) {
    const start = replayStart(record, context, timeline.before, timeline.after);
    const moves = replayMoves(record);
    if (start && moves.length) {
      const recordWitnesses = replaySequence(record.id, start, moves);
      if (recordWitnesses) collected.push(...recordWitnesses);
    }
    if (start) {
      for (const line of replayLines(record)) {
        const lineWitnesses = replaySequence(record.id, start, line);
        if (lineWitnesses) collected.push(...lineWitnesses);
      }
    }

    // compare_moves records describe mutually exclusive legal alternatives.
    // Replay each root from the same exact request position rather than
    // pretending the alternatives form one sequential line.
    const roots = independentRootMoves(record);
    if (!start || !roots.length) continue;
    const rootWitnesses: ReasoningMoveWitness[] = [];
    let validRoots = true;
    for (const uci of roots) {
      const from = uci.slice(0, 2) as Square;
      const pieceId = pieceIdAt(start, from);
      if (!pieceId) {
        validRoots = false;
        break;
      }
      try {
        const applied = applyIdentityMove(start, {
          from,
          to: uci.slice(2, 4),
          promotion: uci.slice(4) || undefined,
        });
        rootWitnesses.push({ evidenceId: record.id, uci, pieceId, san: applied.delta.san });
      } catch {
        validRoots = false;
        break;
      }
    }
    if (validRoots) collected.push(...rootWitnesses);
  }

  return [...new Map(collected.map((witness) => [
    `${witness.evidenceId}:${witness.uci}:${witness.pieceId}:${witness.san}`,
    witness,
  ])).values()];
}
