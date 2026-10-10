import assert from 'node:assert/strict';
import test from 'node:test';
import { Chess } from 'chess.js';
import { compactMechanism, expandMechanismPresentation } from '../../src/chess-reasoning/mechanism-presentation.ts';
import { moveMechanismFacts } from '../../src/chess-reasoning/move-mechanism-facts.ts';
import { shareEvidence } from '../../src/chess-reasoning/lossless-evidence-sharing.ts';

function measured(fen, uci) {
  const before = new Chess(fen);
  const after = new Chess(fen);
  after.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci.slice(4)||undefined});
  return moveMechanismFacts(before,after,uci.slice(0,2),uci.slice(2,4));
}

function oldProjection(value, targets) {
  const controlSquares = [...new Set(targets)].filter(s => /^[a-h][1-8]$/.test(s));
  return {...value,
    stationarySliderRays:value.stationarySliderRays.map(ray => {
      const copy = {...ray}; delete copy.beforeSquares; delete copy.afterSquares; return copy;
    }),
    controlDelta:value.controlDelta.filter(change => controlSquares.includes(change.square)),
    presentation:{controlSquares,
      omittedControlDeltaCount:value.controlDelta.length-value.controlDelta.filter(change => controlSquares.includes(change.square)).length,
      scope:'All changed stationary rays and mover/unmoved attack measurements retained. Control deltas shown only for controlSquares; an omitted square is not checked-negative in this view. Full ray extents and all control deltas are retrievable.'},
  };
}

test('KE-REASON-016/021: row encoding round trips every currently projected field and omission marker', () => {
  const examples = [
    [measured('1k1r3r/2p5/p2p1p2/2P2B2/b3PB1p/5P2/3R2PP/2KR4 w - - 1 25','d2b2'), ['d1','b2','d5']],
    [measured('r1bqkb1r/p1pp1pp1/1p3n1p/8/2BQP3/2N5/PPP2PPP/R1B1K2R w KQkq - 0 8','e4e5'), ['e5','g4','f4','e5']],
    [measured('8/4P3/1R2B3/6Bk/7P/8/8/2K5 w - - 3 50','e6f7'), ['g4','f7','e8']],
  ];
  for (const [full, targets] of examples) {
    const compact = compactMechanism(full,targets);
    assert.equal(compact.encoding,'move-mechanism/1');
    assert.deepEqual(expandMechanismPresentation(compact),oldProjection(full,targets));
    assert.deepEqual(compact.presentation.controlSquares,[...new Set(targets)]);
    assert.ok(compact.columns.rays.includes('gainedSquares'));
    assert.ok(compact.columns.control.includes('attackersAfter'));
    assert.equal(expandMechanismPresentation(full),full);
    assert.equal(compactMechanism(compact,targets),compact);
  }
});

test('KE-REASON-016/021: unknown canonical fields fail open without information loss', () => {
  const full = measured('r1bqkb1r/p1pp1pp1/1p3n1p/8/2BQP3/2N5/PPP2PPP/R1B1K2R w KQkq - 0 8','e4e5');
  for (const modified of [
    {...full, futureMeasurement:{value:42}},
    {...full, mover:{...full.mover,futureIdentity:'some-id'}},
    {...full, stationarySliderRays:full.stationarySliderRays.map((ray,index) => index ? ray : {...ray,futureRay:'retained'})},
  ]) {
    const projected = compactMechanism(modified,['g4']);
    assert.equal(projected.encoding,undefined);
    assert.deepEqual(projected,oldProjection(modified,['g4']));
  }
  const encoded = compactMechanism(full,['g4']);
  assert.equal(expandMechanismPresentation({...encoded,columns:{...encoded.columns,rays:['unknown']}}).encoding,'move-mechanism/1');
  assert.equal(expandMechanismPresentation({...encoded,rows:{...encoded.rows,futureRows:[42]}}).encoding,'move-mechanism/1');
});

test('KE-REASON-016/021: row tables reduce repeated geometry bytes across a mixed search packet', () => {
  const moves = ['e2e4','e7e5','g1f3','b8c6','f1c4','h7h6','d2d4','e5d4',
    'f3d4','c6d4','d1d4','g8f6','b1c3','b7b6','c3d5','f8c5'];
  const board = new Chess();
  const baseline = [], encoded = [];
  for (let index=0;index<moves.length;index++) {
    const uci = moves[index], before = new Chess(board.fen());
    board.move({from:uci.slice(0,2),to:uci.slice(2,4)});
    const fact = moveMechanismFacts(before,board,uci.slice(0,2),uci.slice(2,4));
    const targets = [uci.slice(2,4),moves[index+1]?.slice(2,4)].filter(Boolean);
    baseline.push({ply:index+1,mechanism:oldProjection(fact,targets)});
    encoded.push({ply:index+1,mechanism:compactMechanism(fact,targets)});
  }
  const originalBytes = JSON.stringify(shareEvidence(baseline)).length;
  const encodedBytes = JSON.stringify(shareEvidence(encoded)).length;
  assert.ok(encodedBytes < originalBytes * 0.75, `${originalBytes} -> ${encodedBytes}`);
});
