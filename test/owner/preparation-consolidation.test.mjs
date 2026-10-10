import test from 'node:test';
import assert from 'node:assert/strict';
import {consolidatePreparedSearches} from '../../src/chess-reasoning/preparation-consolidation.ts';
import {compactPreparedSearchResult} from '../../src/chess-reasoning/compact-search-preparation.ts';
import {scoreComparisonNotices} from '../../src/chess-reasoning/score-comparison-notices.ts';
const fen='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const scoreScope={fen,perspective:'white',positiveMeans:'advantage for perspective color',scoreCpUnit:'centipawns',matePlyUnit:'signed mate-in-moves (legacy field name, not plies)'};
function record(id,restricted=false){
 const roots=restricted?['d2d4','e2e4','b1c3']:['e2e4','d2d4'];
 return {id,contextHash:'game',source:'Stockfish/'+(restricted?'compare_moves':'explore-continuations'),
 data:{recordedPosition:{recordHash:'record',ply:0,startFen:fen,fen,historyUci:[],rootContextHash:'root'},details:{phase:'after',engine:'Stockfish',engineBuild:'test',searchScope:{fen,requestedDepth:18,requestedMultiPv:restricted?null:2,requestedRootMoves:restricted?roots:[],cacheProvenance:'engine'},rootMoveFacts:[],continuationMoveFacts:[],lines:roots.map((rootMove,i)=>({rootMove,pv:[rootMove],depth:18,scoreCp:50-i*10,matePly:null,scoreScope,pvCompletion:{requestedPlies:1,actualPlies:1,status:'complete',conditional:false,segments:[]}}))}},
 coverage:{complete:restricted,covered:roots,unresolved:[]},licenses:['engine.bounded-comparison'],replay:{fen,linesUci:roots.map(x=>[x])}};
}
function entry(callId,record,discoveryCallId){
 const result=compactPreparedSearchResult({contextHash:'game',evidence:[record],limitations:[]},'b1c3');
 return {callId,records:[record],playedMove:'b1c3',discoveryCallId,modelRun:{callId,status:'completed',result}};
}
const pair=()=>[entry('discovery',record('evidence:discovery')),entry('comparison',record('evidence:comparison',true),'discovery')];
test('KE-REASON-016/021/026: one primary comparison keeps original scores, order changes, dependency and retrieval identity',()=>{
 const input=pair(),copy=structuredClone(input),notices=scoreComparisonNotices(input.flatMap(x=>x.records));
 const out=consolidatePreparedSearches(input);
 assert.equal(out.results.length,1);assert.deepEqual(out.results[0].result,input[1].modelRun.result);
 assert.equal(out.results[0].discovery.evidenceId,'evidence:discovery');
 assert.equal(out.results[0].discovery.retrieveFullEvidenceId,'evidence:discovery');
 assert.deepEqual(out.results[0].discovery.scores.map(x=>[x.rootMove,x.scoreCp]),[['e2e4',50],['d2d4',40]]);
 assert.deepEqual(out.results[0].discovery.comparisonOrderForDiscoveredMoves,['d2d4','e2e4']);
 assert.equal(out.results[0].discovery.reportedOrderChanged,true);
 assert.equal(out.diagnostics.dependencies[0].relation,'candidate-selection');
 assert.equal(out.diagnostics.dependencies[0].primaryEvidenceId,'evidence:comparison');
 assert.deepEqual(scoreComparisonNotices(input.flatMap(x=>x.records)),notices);assert.equal(notices.length,2);
 assert.deepEqual(input,copy);
});
test('KE-REASON-016/021/026: distinct PVs and conditional segments remain explicitly discoverable by original ID',()=>{
 const input=pair();const line=input[0].records[0].data.details.lines[0];line.pv.push('e7e5');line.pvCompletion.conditional=true;
 input[0].modelRun.result=compactPreparedSearchResult({contextHash:'game',evidence:input[0].records,limitations:[]},'b1c3');
 const out=consolidatePreparedSearches(input);assert.deepEqual(out.results[0].discovery.distinctContinuationRootMoves,['e2e4']);
 assert.deepEqual(input[0].records[0].data.details.lines[0].pv,['e2e4','e7e5']);
});
test('KE-REASON-023/026: discovery-only delivered opening commentary survives consolidation',()=>{
 const input=pair(),source={pages:[{title:'source',prose:'opening',matchedTargets:['original']}]};
 input[0].modelRun.result={chessResult:input[0].modelRun.result,openingSourceContext:source};
 assert.deepEqual(consolidatePreparedSearches(input).results[0].discoveryOpeningSourceContext,source);
});
test('KE-REASON-016/026: no omission for incomplete, failed, foreign, unrecognized, mixed-depth or unrelated results',()=>{
 const changes=[
 a=>a[1].modelRun.status='failed',a=>a[1].records[0].coverage.complete=false,
 a=>a[1].records[0].coverage.covered.pop(),a=>a[1].records[0].data.details.lines.pop(),
 a=>a[1].records[0].data.recordedPosition.ply=1,a=>a[1].records[0].contextHash='foreign',
 a=>a[1].records[0].data.details.lines[0].depth=19,a=>a[1].records[0].data.details.lines[0].scoreScope={...scoreScope,perspective:'black'},
 a=>a[0].records[0].data.details.newProducerField='retain',a=>a[1].discoveryCallId=undefined,
 a=>a[1].playedMove=undefined,a=>a[0].records[0].data.details.lines[0].pv.push('a1a8'),
 ];
 for(const change of changes){const input=pair();change(input);const out=consolidatePreparedSearches(input);assert.deepEqual(out.results,input.map(e=>e.modelRun));assert.equal(out.diagnostics.summarizedDiscoveryCount,0);}
 const only=[pair()[0]];assert.deepEqual(consolidatePreparedSearches(only).results,only.map(e=>e.modelRun));
});

test('KE-REASON-016/021/026: unverified cached comparison depth cannot authorize consolidation',()=>{
 const input=pair();input[1].records[0].data.details.searchScope.sourceCacheProvenance='widget-analysis-cache';
 assert.equal(consolidatePreparedSearches(input).results.length,2);
 for(const line of input[1].records[0].data.details.lines)line.scoreProvenance={kind:'root-search',fen,originatingDepth:18};
 input[0].records[0].data.details.lines[0].scoreProvenance={kind:'legacy-unknown',originatingDepth:null,reportedDepth:18};
 assert.equal(consolidatePreparedSearches(input).results.length,2, 'known origins alone do not establish one search');
 input[1].records[0].data.details.searchScope.sourceCacheProvenance='engine';
 const out=consolidatePreparedSearches(input);
 assert.equal(out.results.length,1);
 assert.equal(out.results[0].discovery.scores[0].scoreProvenance.kind,'legacy-unknown');
});

test('KE-REASON-026: the original command remains authoritative when origins share a different command',()=>{
 const input=pair(),details=input[1].records[0].data.details;
 details.searchScope.command='go depth 18 searchmoves d2d4 e2e4 b1c3';
 for(const line of details.lines)line.scoreProvenance={kind:'root-search',fen,originatingDepth:18,command:'go depth 26'};
 assert.equal(consolidatePreparedSearches(input).results.length,2);
});
