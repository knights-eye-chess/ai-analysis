import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreComparisonNotices } from '../../src/chess-reasoning/score-comparison-notices.ts';
const fen='7k/8/8/8/8/8/8/KR6 w - - 0 1';
function evidence(id,cp,comparison=false){
 const roots=comparison?['b1b7','b1b2']:[];
 const line=(rootMove,scoreCp)=>({rootMove,scoreCp,matePly:null,depth:18,scoreScope:{fen,perspective:'white',positiveMeans:'advantage for perspective color',scoreCpUnit:'centipawns',matePlyUnit:'signed mate-in-moves (legacy field name, not plies)'}});
 return {id,source:`Stockfish/${comparison?'compare_moves':'explore-continuations'}`,coverage:{complete:comparison,covered:comparison?roots:['b1b7'],unresolved:comparison?[]:['non-enumerated alternatives']},data:{engine:'Stockfish',engineBuild:'18',searchScope:{fen,requestedDepth:18,requestedMultiPv:comparison?2:3,requestedRootMoves:roots,cacheProvenance:comparison?'engine':'browser-completed-cache',sourceCacheProvenance:comparison?'engine':'widget-analysis-cache'},lines:[line('b1b7',cp),...(comparison?[line('b1b2',1000)]:[])]}};
}
test('KE-REASON-016/021: qualify cached unrestricted versus matched comparison scores without changing evidence',()=>{
 const a=evidence('a',1391),b=evidence('b',1256,true),records=[a,b],saved=structuredClone(records);
 const [notice]=scoreComparisonNotices(records);
 assert.deepEqual(records,saved);
 assert.equal(notice.rootMove,'b1b7');assert.equal(notice.perspective,'white');
 assert.deepEqual(notice.observations.map(o=>o.score),[{unit:'centipawns',value:1391},{unit:'centipawns',value:1256}]);
 assert.deepEqual(notice.observations.map(o=>o.rootScope),['unrestricted','restricted']);
 assert.deepEqual(notice.observations.map(o=>[o.reportedDepth,o.actualDepth]),[[18,null],[18,18]]);
 assert.equal(notice.disagreementKind,'centipawn-variation');
 assert.deepEqual(notice.preferredWithinSearchComparisonEvidenceIds,['b']);
 assert.match(notice.interpretation,/does not require another search/);
});
test('KE-REASON-021: scope separates root positions and perspectives and excludes unscoped scores',()=>{
 const a=evidence('a',1391),b=evidence('b',1256,true);
 b.data.searchScope.fen=fen.replace('0 1','1 1');
 assert.deepEqual(scoreComparisonNotices([a,b]),[]);
 b.data.searchScope.fen=fen;b.data.lines[0].scoreScope.perspective='black';
 assert.deepEqual(scoreComparisonNotices([a,b]),[]);
 delete b.data.lines[0].scoreScope;
 assert.deepEqual(scoreComparisonNotices([a,b]),[]);
});
test('KE-REASON-021: historical nested results retain scope; duplicates and equal scores create no notice',()=>{
 const a=evidence('a',1391),b=evidence('b',1256,true);
 b.data={recordedPosition:{ply:66},details:b.data};
 assert.equal(scoreComparisonNotices([a,b,a]).length,1);
 assert.equal(scoreComparisonNotices([a,b,a])[0].observations.length,2);
 assert.deepEqual(scoreComparisonNotices([a,evidence('equal',1391)]),[]);
});
test('KE-REASON-021: mates remain typed distances and missing mate metadata cannot leak sentinel CP',()=>{
 const a=evidence('a',1391),b=evidence('b',100000,true);
 b.data.lines[0].matePly=3;
 const [notice]=scoreComparisonNotices([a,b]);
 assert.deepEqual(notice.observations[1].score,{unit:'mate-in-moves',value:3});
 assert.equal(notice.disagreementKind,'mate-status-disagreement');
 assert.match(notice.interpretation,/centipawn score in another search does not refute its mating continuation/);
 assert.match(notice.interpretation,/within that search, not independent confirmation or rejection/);
 assert.deepEqual(notice.preferredWithinSearchComparisonEvidenceIds,['b']);
 b.data.lines[0].matePly=null;
 assert.deepEqual(scoreComparisonNotices([a,b]),[]);
});
test('KE-REASON-016/021/026: distinguish opposing mate signs from distances while retaining reported scope and provenance',()=>{
 const a=evidence('a',100000),b=evidence('b',100000,true);
 a.data.lines[0].matePly=3;b.data.lines[0].matePly=-5;
 const reported={kind:'root-search',fen,originatingDepth:17,engineBuild:'18'};
 b.data.lines[0].scoreProvenance=reported;
 const saved=structuredClone([a,b]);
 const [opposite]=scoreComparisonNotices([a,b]);
 assert.equal(opposite.disagreementKind,'opposite-mate-sign');
 assert.match(opposite.interpretation,/mate signs oppose/);
 assert.deepEqual(opposite.observations[1].scoreProvenance,reported);
 assert.equal('scoreProvenance' in opposite.observations[0],false);
 assert.deepEqual(opposite.observations.map(o=>[o.reportedDepth,o.actualDepth,o.requestedDepth,o.rootScope,o.sourceCacheProvenance]),[[18,null,18,'unrestricted','widget-analysis-cache'],[18,null,18,'restricted','engine']]);
 assert.deepEqual([a,b],saved);
 b.data.lines[0].matePly=5;
 const [distance]=scoreComparisonNotices([a,b]);
 assert.equal(distance.disagreementKind,'mate-distance-variation');
 assert.match(distance.interpretation,/different mate distances/);
 assert.match(distance.interpretation,/does not require another search/);
});
test('KE-REASON-021: incomplete or mixed-depth comparisons do not receive comparison preference',()=>{
 const a=evidence('a',1391),b=evidence('b',1256,true);
 b.data.lines[1].depth=17;
 assert.deepEqual(scoreComparisonNotices([a,b])[0].preferredWithinSearchComparisonEvidenceIds,[]);
 b.data.lines[1].depth=18;b.coverage.complete=false;
 assert.deepEqual(scoreComparisonNotices([a,b])[0].preferredWithinSearchComparisonEvidenceIds,[]);
});

test('KE-REASON-026: malformed candidates and inconsistent original commands cannot certify comparison preference',()=>{
 const a=evidence('a',1391),b=evidence('b',1256,true);
 b.data.searchScope.command='go depth 18';
 b.data.lines.forEach(line=>line.scoreProvenance={kind:'root-search',fen,originatingDepth:18,command:'go depth 26'});
 assert.deepEqual(scoreComparisonNotices([a,b])[0].preferredWithinSearchComparisonEvidenceIds,[]);
 b.data.lines.push(null);
 assert.deepEqual(scoreComparisonNotices([a,b])[0].preferredWithinSearchComparisonEvidenceIds,[]);
});
test('KE-REASON-016/021/026: cached reported depths and subsequent-position scores cannot certify a matched root comparison',()=>{
 const a=evidence('a',1391),b=evidence('b',1256,true);
 b.data.searchScope.cacheProvenance='browser-completed-cache';
 b.data.searchScope.sourceCacheProvenance='widget-analysis-cache';
 assert.deepEqual(scoreComparisonNotices([a,b])[0].preferredWithinSearchComparisonEvidenceIds,[]);
 assert.deepEqual(scoreComparisonNotices([a,b])[0].observations[1].actualDepth,null);
 const kinds=[
  {kind:'restored-fallback',originatingDepth:null,reportedDepth:18,fallbackDepth:18},
  {kind:'legacy-unknown',originatingDepth:null,reportedDepth:18},
  {kind:'subsequent-position',fen:fen.replace('0 1','1 1'),originatingDepth:18,reportedDepth:18},
  {kind:'root-search',fen:fen.replace('0 1','1 1'),originatingDepth:18,engineBuild:'18'},
  {kind:'root-search',fen,originatingDepth:0,engineBuild:'18'},
 ];
 for(const provenance of kinds){
  b.data.lines[0].scoreProvenance=provenance;b.data.lines[1].scoreProvenance=provenance;
  const [notice]=scoreComparisonNotices([a,b]);
  assert.equal(notice.observations[1].reportedDepth,18);
  assert.equal(notice.observations[1].actualDepth,null);
  assert.deepEqual(notice.preferredWithinSearchComparisonEvidenceIds,[]);
 }
 b.data.lines[0].scoreProvenance={kind:'root-search',fen,originatingDepth:17,engineBuild:'18'};
 b.data.lines[1].scoreProvenance={kind:'root-search',fen,originatingDepth:18,engineBuild:'18'};
 assert.deepEqual(scoreComparisonNotices([a,b])[0].preferredWithinSearchComparisonEvidenceIds,[]);
 b.data.lines[1].scoreProvenance={kind:'root-search',fen,originatingDepth:17,engineBuild:'18'};
 assert.deepEqual(scoreComparisonNotices([a,b])[0].preferredWithinSearchComparisonEvidenceIds,[], 'candidate provenance does not establish shared search identity');
 b.data.searchScope.sourceCacheProvenance='engine';
 b.data.lines.forEach(line=>line.depth=17);
 const [verified]=scoreComparisonNotices([a,b]);
 assert.deepEqual(verified.preferredWithinSearchComparisonEvidenceIds,['b']);
 assert.deepEqual(verified.observations[1].scoreProvenance,b.data.lines[0].scoreProvenance);
 assert.equal(verified.observations[1].actualDepth,17);
});
