import test from 'node:test';
import assert from 'node:assert/strict';
import {compactPreparedSearchResult} from '../../src/chess-reasoning/compact-search-preparation.ts';
import {expandCompactEngineEvidence} from '../../src/chess-reasoning/simple-compact-evidence.ts';
import {compactSimpleEngineResult} from '../../src/chess-reasoning/simple-evidence-view.ts';

const fen='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const scope={fen,requestedDepth:18,minimumPvPlies:10,cacheProvenance:'widget-cache',
 sourceCacheProvenance:'widget-cache',requestedRootMoves:['e2e4','d2d4'],requestedMultiPv:null,
 history:'FEN-root search; prior repetition history not sent to engine'};
const scoreScope={fen,perspective:'white',positiveMeans:'advantage for perspective color',
 scoreCpUnit:'centipawns',matePlyUnit:'signed mate-in-moves (legacy field name, not plies)'};
const longPv=['e2e4','e7e5','g1f3','b8c6'];
const segment=(pv,startPly,scoreCp)=>({fen,startPly,depth:18,pv,scoreCp,matePly:null,
 scoreScope:{...scoreScope,fen},command:'go depth 18',engine:'Stockfish',engineBuild:'test-build',cacheProvenance:'widget-cache'});
const move=(uci,san)=>({uci,san,from:uci.slice(0,2),to:uci.slice(2,4),
 mover:{pieceId:`piece-${uci}`,color:'w',pieceType:'p',square:uci.slice(0,2)},capture:null,promotion:null,
 givesCheck:false,captureGeometry:{attackers:[{square:'e4'}]}});
const material={authority:'legal-replay-piece-counts',startFen:fen,plies:4,
 start:{balance:'Equal piece counts.'},end:{balance:'Equal piece counts.'},
 changes:[{ply:1,san:'e4',whiteMinusBlack:{pawn:0,knight:0,bishop:0,rook:0,queen:0},balance:'Equal piece counts.'}],
 endFen:fen,balanceChangeFromStart:{pawn:0,knight:0,bishop:0,rook:0,queen:0},scope:'Conditional variation.'};
const line=(rootMove,pv,scoreCp,matePly=null)=>({rootMove,pv,depth:18,nodes:100,
 scoreCp,matePly,scoreScope,rawPv:pv,pvCompletion:{requestedPlies:10,actualPlies:pv.length,
 status:'short-budget',conditional:true,segments:[segment(pv,0,scoreCp)]},material});
const record=()=>({schemaVersion:'conceptual-explanation-poc/57',id:'evidence:game:test-search',contextHash:'test-hash',
 kind:'probe',source:'Stockfish/compare_moves',proofStrength:'engine-bounded',summary:'Bounded two-root comparison',
 data:{recordedPosition:{recordHash:'game-hash',ply:0,startFen:fen,fen,historyUci:[],rootContextHash:'root-hash',
 nextRecordedMove:'e4',scope:'position after exactly ply recorded moves'},
 details:{phase:'after',rootMoves:['e2e4','d2d4'],rootSelection:{modelRequested:['e2e4','d2d4'],automaticallyAdded:[],scope:'restricted roots'},
 bestMove:'e2e4',engine:'Stockfish',engineBuild:'test-build',searchScope:scope,
 rootMoveFacts:[move('e2e4','e4')],continuationMoveFacts:[{rootMove:'e2e4',moves:longPv.map((v,i)=>move(v,['e4','e5','Nf3','Nc6'][i]))}],
 lines:[line('e2e4',longPv,32),line('d2d4',['d2d4','d7d5'],21)],minimumPvPlies:10,
 requestedPvCoverage:{requestedPlies:10,satisfied:[],short:['e2e4','d2d4']},authority:'bounded-engine'}},
 coverage:{complete:true,covered:['e2e4','d2d4'],unresolved:[]},
 replay:{fen,command:'go depth 18',linesUci:[longPv,['d2d4','d7d5']]},licenses:['engine.bounded-score']});
const search=()=>({schemaVersion:'conceptual-explanation-poc/57',callId:'initial-search-1',tool:'analyze_game_position',
 contextHash:'test-hash',support:'supported',data:{},evidence:[record()],limitations:[],durationMs:10});
const decode=(v)=>{
 if(v?.metadata&&v?.content){const expand=x=>Array.isArray(x)?x.map(expand):x&&typeof x==='object'
   ? x.$metadata?expand(v.metadata[x.$metadata]):Object.fromEntries(Object.entries(x).map(([k,a])=>[k,expand(a)])):x;
  return expandCompactEngineEvidence(expand(v.content));}
 return expandCompactEngineEvidence(v);
};

test('KE-REASON-016/021/024/026: initial search projection preserves both scoped comparisons and all PV moves',()=>{
 const original=search(),copy=structuredClone(original);
 const projected=decode(compactPreparedSearchResult(original,'d2d4'));
 assert.deepEqual(original,copy,'the authoritative record remains immutable for retrieval');
 const e=projected.evidence[0];
 assert.equal(e.id,original.evidence[0].id);
 assert.equal(e.data.recordedPosition.ply,0);
 assert.equal(e.data.recordedPosition.fen,fen);
 assert.deepEqual(e.data.details.searchScope,scope);
 assert.deepEqual(e.data.details.rootSelection,original.evidence[0].data.details.rootSelection);
 assert.deepEqual(e.data.details.lines.map(x=>x.pv),[longPv,['d2d4','d7d5']]);
 assert.deepEqual(e.data.details.lines[0].pvSan,['e4','e5','Nf3','Nc6']);
 assert.deepEqual(e.data.details.lines.map(x=>x.playedMove),[false,true]);
 assert.deepEqual(e.data.details.lines.map(x=>x.scoreCp),[32,21]);
 assert.deepEqual(e.data.details.lines.map(x=>x.scoreScope),[scoreScope,scoreScope]);
 assert.equal(e.data.details.lines[0].pvCompletion.status,'short-budget');
 assert.equal(e.data.details.lines[0].pvCompletion.conditional,true);
 assert.equal(e.data.details.lines[0].pvCompletion.segments[0].cacheProvenance,'widget-cache');
 assert.deepEqual(e.data.details.lines[0].pvCompletion.segments[0].pvFromLinePly,0);
 assert.equal(e.data.details.lines[0].pvCompletion.segments[0].pvLength,longPv.length);
 assert.equal(e.data.details.lines[0].materialSummary.endBalance,'Equal piece counts.');
 assert.equal(e.data.details.modelPresentation.retrieveFullEvidenceId,e.id);
 assert.equal(e.data.details.continuationMoveFacts,undefined);
 assert.equal(e.data.details.rootMoveFacts,undefined);
 assert.equal(e.replay,null);
 assert.equal(JSON.stringify(projected).includes('captureGeometry'),true,'retrieval instructions disclose the omitted detail');
 assert.ok(JSON.stringify(compactPreparedSearchResult(original,'d2d4')).length<JSON.stringify(original).length);
});

test('KE-REASON-016/021/024/026: distinct raw or segment PV and mate fields are not mistaken for duplicates',()=>{
 const original=search();const lines=original.evidence[0].data.details.lines;
 lines[0].rawPv=['d2d4','d7d5'];
 lines[0].matePly=3;lines[0].scoreCp=null;
 lines[0].pvCompletion.segments.push(segment(['d2d4'],1,null));
 const projected=decode(compactPreparedSearchResult(original,'e2e4'));
 const a=projected.evidence[0].data.details.lines[0];
 assert.deepEqual(a.rawPv,['d2d4','d7d5']);
 assert.equal(a.matePly,3);
 assert.equal(a.scoreCp,null);
 assert.deepEqual(a.pvCompletion.segments[1].pv,['d2d4']);
 assert.equal(a.playedMove,true);
});

test('KE-REASON-016/021/024/026: unfamiliar engine evidence stays complete',()=>{
 const original=search();original.evidence[0].data.details.lines[0].newEngineData={future:'keep'};
 const projected=decode(compactPreparedSearchResult(original,'e2e4'));
 const standard=decode(compactSimpleEngineResult({contextHash:original.contextHash,evidence:original.evidence,limitations:original.limitations}));
 assert.deepEqual(projected.evidence[0].data.details.lines[0].newEngineData,{future:'keep'});
 assert.deepEqual(projected.evidence[0].data.details.continuationMoveFacts,
  standard.evidence[0].data.details.continuationMoveFacts);
});

test('KE-REASON-016/026: unknown played move is not represented as a negative match',()=>{
 const projected=decode(compactPreparedSearchResult(search()));
 assert.ok(projected.evidence[0].data.details.lines.every(line=>!Object.hasOwn(line,'playedMove')));
});

test('KE-REASON-016/021/026: compact preparation retains line and continuation score origins',()=>{
 const original=search(),line=original.evidence[0].data.details.lines[0];
 line.scoreProvenance={kind:'legacy-unknown',originatingDepth:null,reportedDepth:18};
 line.pvCompletion.segments[0].scoreProvenance={kind:'root-search',fen,originatingDepth:22};
 const output=decode(compactPreparedSearchResult(original,'d2d4')).evidence[0].data.details;
 assert.ok(output.modelPresentation,'recognized provenance does not force full geometry presentation');
 assert.deepEqual(output.lines[0].scoreProvenance,line.scoreProvenance);
 assert.deepEqual(output.lines[0].pvCompletion.segments[0].scoreProvenance,line.pvCompletion.segments[0].scoreProvenance);
});
