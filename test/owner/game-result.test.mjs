import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { recordedMainLineResult } from '../../src/chess-reasoning/recorded-main-line.ts';
function record(sans, result='*', fen) {
  const chess = new Chess(fen), startFen = chess.fen();
  const moves = sans.map((san,i) => { const m=chess.move(san); return {uci:m.from+m.to+(m.promotion||''),san:m.san,edgeId:String(i)}; });
  const line={startFen,moves,selectedIndex:-1,totalPlies:moves.length,truncated:false,selectedAtStart:true,reportedResult:{result,source:'PGN'}};
  const context={kind:'position',nodeId:'root',moveUci:'',moveSan:'',fenBefore:startFen,fenAfter:startFen,historyUci:[],historyStartFen:startFen};
  return {line,context};
}
function outcome(...args) {const {line,context}=record(...args);return recordedMainLineResult(line,context).recordedMainLine.outcome;}
test('source result stays explicit for decisive, drawn and unknown games',()=>{
  assert.equal(outcome(['e4'],'1-0').result,'1-0');
  assert.match(outcome(['e4'],'1-0').ending,/reason not recorded/);
  assert.equal(outcome(['e4'],'1/2-1/2').ending,'draw (agreed or unrecorded)');
  assert.equal(outcome(['e4']).result,'*');
});
test('verified mate overrides contradicting source with mismatch',()=>{
  const x=outcome(['f3','e5','g4','Qh4#'],'1-0');
  assert.equal(x.result,'0-1'); assert.equal(x.reportedResult,'1-0'); assert.equal(x.ending,'checkmate'); assert.equal(x.mismatch,true);
});
test('board proves stalemate and insufficient material',()=>{
  assert.equal(outcome([], '*','7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').ending,'stalemate');
  assert.equal(outcome([], '*','7k/8/6K1/8/8/8/8/8 w - - 0 1').ending,'insufficient material');
});
test('claimable repetition alone never invents draw outcome',()=>{
  const moves=['Nf3','Nf6','Ng1','Ng8','Nf3','Nf6','Ng1','Ng8'];
  assert.equal(outcome(moves).result,'*');
  assert.match(outcome(moves,'1/2-1/2').ending,/threefold/);
});
test('truncated record does not prove an ending or stamp result onto partial PGN',()=>{
  const {line,context}=record([], '0-1','7k/8/6K1/8/8/8/8/8 w - - 0 1');
  line.totalPlies=1;line.truncated=true;
  const data=recordedMainLineResult(line,context).recordedMainLine;
  assert.equal(data.outcome.authority,'source-reported');assert.doesNotMatch(data.pgn,/0-1/);
});
