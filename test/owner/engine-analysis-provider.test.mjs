import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createEngineAnalysisProvider} from '../../src/chess-reasoning/engine-analysis-provider.ts';
const request={fen:'root',depth:18,multiPv:3,rootMoves:[],minimumPvPlies:10};
const line=(move,mate=null)=>({pv:[move],depth:18,nodes:42,scoreCp:mate===null?21:null,mate,
 scoreProvenance:{kind:'root-search',engineBuild:'Stockfish test',fen:'root',originatingDepth:18,reportedDepth:18}});
test('maps one completed search without padding fewer lines or short PVs',async()=>{
 let calls=0,received;
 const candidates=[line('g7g8',-3),line('g7f7')];
 const diagnostics={processReused:true};
 const provider=createEngineAnalysisProvider({async search(input){calls++;received=input;return{bestmove:'g7g8',candidates,diagnostics};}});
 const result=await provider.analyze(request);
 assert.equal(calls,1);assert.deepEqual(received,{fen:'root',limit:{depth:18},multiPv:3,rootMoves:[],signal:undefined});
 assert.equal(result.lines.length,2);assert.deepEqual(result.lines[0].pv,['g7g8']);
 assert.equal(result.lines[0].mateInMoves,-3);assert.equal(result.lines[0].scoreCp,null);
 assert.equal(result.lines[0].nodes,42);assert.deepEqual(result.lines[0].scoreProvenance,candidates[0].scoreProvenance);
 assert.equal(result.engineBuild,'Stockfish test');assert.equal(result.cacheProvenance,'engine');assert.equal(result.diagnostics,diagnostics);
});
test('preserves restricted roots and cancellation instead of changing search scope',async()=>{
 const controller=new AbortController();let received;
 const provider=createEngineAnalysisProvider({async search(input){received=input;return{bestmove:'g7g8',candidates:[line('g7g8')]};}});
 const result=await provider.analyze({...request,multiPv:1,rootMoves:['g7g8'],signal:controller.signal});
 assert.equal(received.signal,controller.signal);assert.deepEqual(received.rootMoves,['g7g8']);
 assert.equal(result.command,'go depth 18 searchmoves g7g8');
 controller.abort();await assert.rejects(provider.analyze({...request,signal:controller.signal}),{name:'AbortError'});
});
test('does not turn a cancelled or failed engine search into evidence',async()=>{
 const controller=new AbortController();
 const provider=createEngineAnalysisProvider({async search(){controller.abort();return{candidates:[line('g7g8')]};}});
 await assert.rejects(provider.analyze({...request,signal:controller.signal}),{name:'AbortError'});
 const failure=new Error('engine failed');
 await assert.rejects(createEngineAnalysisProvider({async search(){throw failure;}}).analyze(request),error=>error===failure);
});
test('requires an attributed single engine result',async()=>{
 for(const candidates of [[line('g7g8'),{...line('g7f7'),scoreProvenance:{...line('g7f7').scoreProvenance,weightsId:'different'}}],[{...line('g7g8'),scoreProvenance:undefined}],[line('g7g8'),{...line('g7f7'),scoreProvenance:{engineBuild:'other'}}]]){
  await assert.rejects(createEngineAnalysisProvider({async search(){return{bestmove:'g7g8',candidates};}}).analyze(request),/identity/);
 }
});
test('explicit no-move result carries engine identity without inventing a score',async()=>{
 const provider=createEngineAnalysisProvider({async search(){return{noMove:true,bestmove:null,candidates:[],engineBuild:'Stockfish test'};}});
 const result=await provider.analyze(request);
 assert.equal(result.bestMove,null);assert.deepEqual(result.lines,[]);
 assert.equal(result.engineBuild,'Stockfish test');
 for(const malformed of [{noMove:true,bestmove:null,candidates:[],engineBuild:''},
  {noMove:true,bestmove:'e2e4',candidates:[],engineBuild:'Stockfish test'},
  {noMove:true,bestmove:null,candidates:[line('e2e4')],engineBuild:'Stockfish test'}]) {
  await assert.rejects(createEngineAnalysisProvider({async search(){return malformed;}}).analyze(request),/no-move/);
 }
});
test('scored search requires an explicit completed best move',async()=>{
 for(const bestmove of [undefined,'d2d4']) {
  await assert.rejects(createEngineAnalysisProvider({async search(){return{bestmove,candidates:[line('e2e4')]};}}).analyze(request),/best move/);
 }
});
