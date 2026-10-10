import assert from 'node:assert/strict';
import test from 'node:test';
import { Chess } from 'chess.js';
import { moveMechanismFacts } from '../../src/chess-reasoning/move-mechanism-facts.ts';
import { applyIdentityMove, createIdentityState } from '../../src/chess-reasoning/piece-identities.ts';

function facts(fen, uci, suppliedIdentities = true) {
  const before = new Chess(fen);
  const beforeIds = createIdentityState(fen);
  const { state: afterIds } = applyIdentityMove(beforeIds, {
    from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined,
  });
  const after = new Chess(afterIds.fen);
  return moveMechanismFacts(before, after, uci.slice(0, 2), uci.slice(2, 4),
    ...(suppliedIdentities ? [beforeIds, afterIds] : []));
}

test('KE-REASON-016/021: Rb2+ mover is unattacked while the unmoved rook on d1 is attacked from a4', () => {
  const observed = facts('1k1r3r/2p5/p2p1p2/2P2B2/b3PB1p/5P2/3R2PP/2KR4 w - - 1 25', 'd2b2');
  assert.equal(observed.mover.pieceId, 'white-rook:d2:0');
  assert.deepEqual(observed.mover.attackersBefore, []);
  assert.deepEqual(observed.mover.attackersAfter, []);
  assert.deepEqual(observed.attackedUnmovedFriendlyPieces.find((piece) => piece.square === 'd1'), {
    pieceId: 'white-rook:d1:0', square: 'd1', pieceType: 'r',
    attackersBefore: ['a4'], attackersAfter: ['a4'],
  });
  assert.ok(observed.checksRun.includes('unmoved-friendly-piece-geometric-attackers-before-after'));
  assert.match(observed.scope, /geometric measurements/i);
});

test('KE-REASON-016/021: after 7...b6, e5 frees the queen d4 horizontal ray through f4-h4, not a8', () => {
  // Recorded main-line first 14 plies, exact position before White's eighth move.
  const observed = facts('r1bqkb1r/p1pp1pp1/1p3n1p/8/2BQP3/2N5/PPP2PPP/R1B1K2R w KQkq - 0 8', 'e4e5');
  const east = observed.stationarySliderRays.find((item) => item.fromSquare === 'd4' && item.direction === 'E');
  assert.deepEqual(east?.beforeSquares, ['e4']);
  assert.deepEqual(east?.afterSquares, ['e4', 'f4', 'g4', 'h4']);
  assert.deepEqual(east?.gainedSquares, ['f4', 'g4', 'h4']);
  assert.ok(!observed.stationarySliderRays.some((item) => item.fromSquare === 'd4' && item.gainedSquares.includes('a8')));
  assert.deepEqual(observed.controlDelta.find((item) => item.square === 'g4' && item.color === 'w')?.attackersAfter, ['d4']);
});

test('KE-REASON-016/021: control loss occurs at the actual knight move, not the prior pawn push', () => {
  const rootFen = 'r1bqkb1r/p1pp1pp1/1p3n1p/8/2BQP3/2N5/PPP2PPP/R1B1K2R w KQkq - 0 8';
  const pawnPush = facts(rootFen, 'e4e5');
  assert.equal(pawnPush.controlDelta.find((item) => item.square === 'd5' && item.color === 'b'), undefined);
  const afterPawnPush = new Chess(rootFen);
  afterPawnPush.move({ from: 'e4', to: 'e5' });
  const knightMove = facts(afterPawnPush.fen(), 'f6h7');
  assert.deepEqual(knightMove.controlDelta.find((item) => item.square === 'd5' && item.color === 'b'), {
    square: 'd5', color: 'b', attackersBefore: ['f6'], attackersAfter: [],
  });
  assert.deepEqual(knightMove.mover.attackersBefore, ['e5']);
});

test('KE-REASON-016/021: moving slider is not reported as stationary opening, even along same file', () => {
  const rootFen = 'k1B5/1R6/p2B1p2/8/4P2p/5P2/6PP/2K2b2 w - - 7 34';
  const observed = facts(rootFen, 'b7b2');
  assert.ok(!observed.stationarySliderRays.some((item) => item.pieceId === observed.mover.pieceId));
  assert.ok(!observed.stationarySliderRays.some((item) => item.fromSquare === 'b7' || item.fromSquare === 'b2'));
  const afterRook = new Chess(rootFen);
  afterRook.move({ from: 'b7', to: 'b2' });
  const response = facts(afterRook.fen(), 'f1b5');
  const blocked = response.stationarySliderRays.find((item) => item.fromSquare === 'b2' && item.direction === 'N');
  assert.deepEqual(blocked?.beforeSquares, ['b3', 'b4', 'b5', 'b6', 'b7', 'b8']);
  assert.deepEqual(blocked?.afterSquares, ['b3', 'b4', 'b5']);
  assert.deepEqual(blocked?.lostSquares, ['b6', 'b7', 'b8']);
});

test('KE-REASON-016/021: Bf7+, queen promotion and bishop underpromotion have exact mover identities and controls', () => {
  const bishop = facts('8/4P3/1R2B3/6Bk/7P/8/8/2K5 w - - 3 50', 'e6f7');
  assert.equal(bishop.mover.pieceId, bishop.mover.pieceIdAfter);
  assert.equal(bishop.mover.pieceTypeBefore, 'b');
  assert.deepEqual(bishop.controlDelta.find((item) => item.square === 'e8' && item.color === 'w')?.attackersAfter, ['f7']);
  assert.deepEqual(bishop.controlDelta.find((item) => item.square === 'g4' && item.color === 'w'), {
    square: 'g4', color: 'w', attackersBefore: ['e6'], attackersAfter: [],
  });
  const mateFen = '8/4P3/1R2B3/6Bk/7P/8/8/2K5 w - - 3 50';
  for (const uci of ['e7e8q', 'e7e8b']) {
    const promotionMate = new Chess(mateFen);
    promotionMate.move({ from: 'e7', to: 'e8', promotion: uci.slice(4) });
    assert.equal(promotionMate.isCheckmate(), true, `${uci} is a legal mate at the observed board`);
    assert.equal(facts(mateFen, uci).mover.pieceTypeAfter, uci.slice(4));
  }
  const promotionFen = '8/4P3/1R2B3/6B1/7P/5k2/8/2K5 w - - 7 52';
  const queen = facts(promotionFen, 'e7e8q');
  const underpromotion = facts(promotionFen, 'e7e8b', false);
  assert.equal(queen.mover.pieceTypeAfter, 'q');
  assert.equal(underpromotion.mover.pieceTypeAfter, 'b');
  assert.notEqual(queen.mover.pieceId, queen.mover.pieceIdAfter);
  assert.match(queen.mover.pieceIdAfter, /promotion:e8/);
  assert.ok(queen.controlDelta.some((entry) => entry.square === 'e7' && entry.color === 'w'));
  assert.ok(!underpromotion.controlDelta.some((entry) => entry.square === 'e7' && entry.color === 'w'));
});

test('KE-REASON-016/021: en passant removes the off-target blocker and castling excludes the moved rook', () => {
  const ep = facts('7k/8/8/3pP3/8/8/8/K2R4 w - d6 0 1', 'e5d6');
  assert.deepEqual(ep.controlDelta.find((item) => item.square === 'e4' && item.color === 'b'), {
    square: 'e4', color: 'b', attackersBefore: ['d5'], attackersAfter: [],
  });
  assert.deepEqual(ep.stationarySliderRays.find((item) => item.fromSquare === 'd1' && item.direction === 'N')?.afterSquares,
    ['d2', 'd3', 'd4', 'd5', 'd6']);
  const castle = facts('4k3/8/8/8/8/8/8/4K2R w K - 0 1', 'e1g1');
  assert.ok(!castle.stationarySliderRays.some((item) => item.pieceId === 'white-rook:h1:0'));
  assert.equal(castle.mover.toSquare, 'g1');
});
