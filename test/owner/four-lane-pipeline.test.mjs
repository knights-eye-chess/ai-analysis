import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess} from 'chess.js';
import {runAnswerPipeline,createProductionObservationProvider,QUESTION_ROUTING_VERSION,simpleSystemPolicy,simpleToolDescription,toPositionAnalysis,toLegacyPositionAnalysis,toPositionAnalysisProvider,toLegacyPositionAnalysisProvider} from '../../src/chess-reasoning/answer-pipeline-exports.ts';
const fen=new Chess().fen();
const context={kind:'position',nodeId:'root',historyStartFen:fen,historyUci:[],moveUci:'',moveSan:'',fenBefore:fen,fenAfter:fen};
function setup(invoke,options={}) {
 const selected={deliveryId:'answer-test',selectionKey:'root',edgeId:'root',context,existingAnalysis:null};
 const question='Assess the current position';
 return {requestId:'portable-test',question,selected,modelName:'deterministic-test',connector:{kind:'model-turn',invoke},
  policy:{system:simpleSystemPolicy,description:simpleToolDescription},observationProvider:createProductionObservationProvider({context,question}),
  prepareRouting:async()=>({question,selectionKey:'root',deliveryId:'answer-test',elapsedMs:0,omitSelectedContext:false,
   decision:{version:QUESTION_ROUTING_VERSION,status:'fallback',omitSelectedContext:false,includeGameRecord:false,reviewGame:false,reason:'explicit-consumer-position',answers:{answer_scope:{choice:'position_analysis',confidence:1}}}}),...options};
}
function reply(text='',toolCalls=[]) {return {text,toolCalls,finishReason:toolCalls.length?'tool-calls':'stop',usage:{inputTokens:20,outputTokens:10},response:{messages:[{role:'assistant',content:toolCalls.length?toolCalls.map(c=>({type:'tool-call',...c})):text}]}};}
function analyzer(log) {return {async analyze(request){log.push(request);const board=new Chess(request.fen);const legal=board.moves({verbose:true});const roots=request.rootMoves.length?request.rootMoves:legal.slice(0,request.multiPv).map(m=>m.from+m.to+(m.promotion??''));return {engine:'deterministic-legal-test',engineBuild:'test-only',command:'test',bestMove:roots[0]??null,lines:roots.map(root=>{const b=new Chess(request.fen);b.move({from:root.slice(0,2),to:root.slice(2,4),promotion:root.slice(4)||undefined});const pv=[root];while(pv.length<(request.minimumPvPlies??1)&&!b.isGameOver()){const m=b.moves({verbose:true})[0];pv.push(m.from+m.to+(m.promotion??''));b.move(m);}return {rootMove:root,pv,depth:request.depth,nodes:1,scoreCp:0,matePly:null};})};}};}

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
function gameSetup(invoke,options={}) {
 const board=new Chess(),moves=[];
 for(const san of ['e4','e5','Nf3','Nc6']) {
  const before=board.fen(),move=board.move(san),uci=move.from+move.to;
  moves.push({uci,san,edgeId:'edge-'+moves.length,analysis:{version:'recorded-move-analysis/1',fenBefore:before,fenAfter:board.fen(),moveUci:uci,
   engine:'fixture',actualDepth:18,requestedDepth:18,classifierVersion:47,classification:'mistake',beforeCp:0,afterCp:-100,lossCp:100,mateBefore:null,mateAfter:null}});
 }
 const mainLine={startFen:fen,selectedAtStart:true,selectedIndex:-1,totalPlies:moves.length,truncated:false,moves};
 return setup(invoke,{question:'Review the whole game',prepareRouting:async()=>({question:'Review the whole game',selectionKey:'root',deliveryId:'answer-test',elapsedMs:0,omitSelectedContext:true,mainLine,
  decision:{version:QUESTION_ROUTING_VERSION,status:'fallback',omitSelectedContext:true,includeGameRecord:true,reviewGame:true,reason:'fixture',answers:{answer_scope:{choice:'game_review',confidence:1}}}}),...options});
}
test('four-lane pipeline uses dedicated provider, deterministic IDs and unchanged request quality',async()=>{
 const gate=deferred(),searches=[],ordinary=[],starts=[];let invoked=false;
 const legal=analyzer(searches);
 const running=runAnswerPipeline(gameSetup(async()=>{invoked=true;return reply('The game contains useful lessons.');},{initialSearchConcurrency:4,
  analyzer:analyzer(ordinary),initialPreparationAnalyzer:{async analyze(request){starts.push(request);await gate.promise;return legal.analyze(request);}}}));
 for(let i=0;i<20&&starts.length<4;i++)await tick();
 assert.equal(starts.length,4);assert.equal(invoked,false);gate.resolve();const result=await running;
 assert.equal(ordinary.length,0);assert.ok(result.initialSearches.every(row=>row.status==='completed'));
 assert.ok(searches.every(request=>request.depth===18&&request.minimumPvPlies===10));
 assert.ok(searches.some(request=>request.rootMoves.length>0),'dynamic matched comparison uses discovered roots');
 const ids=result.initialSearches.map(row=>row.callId);assert.equal(ids[0],'initial-chain-1-discovery');
 assert.deepEqual(ids,[...ids].sort((a,b)=>Number(a.split('-')[2])-Number(b.split('-')[2])||Number(a.endsWith('comparison'))-Number(b.endsWith('comparison'))));
});
test('serial pipeline keeps historical IDs and ordinary provider without opt-in',async()=>{
 const searches=[];const result=await runAnswerPipeline(gameSetup(async()=>reply('The game contains useful lessons.'),{analyzer:analyzer(searches)}));
 assert.ok(searches.length>=4);assert.deepEqual(result.initialSearches.map(row=>row.callId),result.initialSearches.map((_,i)=>`initial-search-${i+1}`));
});
test('parallel full-game provider is required and unsupported concurrency is rejected',async()=>{
 await assert.rejects(runAnswerPipeline(gameSetup(async()=>reply('unused'),{initialSearchConcurrency:4})),/independent provider/);
 await assert.rejects(runAnswerPipeline(gameSetup(async()=>reply('unused'),{initialSearchConcurrency:3})),/Unsupported/);
});
test('two simultaneous model-stub reviews keep providers and evidence in their answer scope',async()=>{
 const logs=[[],[]],gates=[deferred(),deferred()],starts=[0,0],turns=[0,0];
 const runs=logs.map((log,job)=>runAnswerPipeline(gameSetup(async()=>{turns[job]++;return reply('The game contains useful lessons.');},{requestId:`job-${job}`,initialSearchConcurrency:4,
  initialPreparationAnalyzer:{async analyze(request){starts[job]++;await gates[job].promise;return analyzer(log).analyze(request);}}})));
 for(let i=0;i<20&&starts.some(n=>n<4);i++)await tick();assert.deepEqual(starts,[4,4]);
 gates[1].resolve();const second=await runs[1];assert.equal(turns[0],0);assert.equal(logs[0].length,0);
 gates[0].resolve();const first=await runs[0];assert.ok(turns.every(n=>n>0));
 assert.notEqual(first.initialSearches,second.initialSearches);assert.ok(logs.every(log=>log.length>=4));
});
test('pipeline abort drains all four acquisitions before rejection and never dispatches model',async()=>{
 const controller=new AbortController(),cleanup=deferred();let active=0,drained=0,turns=0,settled=false;
 const running=runAnswerPipeline(gameSetup(async()=>{turns++;return reply('unused');},{initialSearchConcurrency:4,signal:controller.signal,
  initialPreparationAnalyzer:{async analyze(request){active++;await new Promise(resolve=>request.signal.addEventListener('abort',resolve,{once:true}));await cleanup.promise;drained++;throw request.signal.reason;}}})).finally(()=>{settled=true;});
 const rejected=assert.rejects(running);for(let i=0;i<20&&active<4;i++)await tick();assert.equal(active,4);
 controller.abort(Error('owner cancelled'));await tick();assert.equal(settled,false);cleanup.resolve();await rejected;assert.equal(drained,4);assert.equal(turns,0);
});
test('serial and four-lane acquisition preserve canonical requests including dynamically derived roots',async()=>{
 const serial=[],parallel=[];
 const one=await runAnswerPipeline(gameSetup(async()=>reply('The game contains useful lessons.'),{analyzer:analyzer(serial)}));
 const two=await runAnswerPipeline(gameSetup(async()=>reply('The game contains useful lessons.'),{initialSearchConcurrency:4,initialPreparationAnalyzer:analyzer(parallel)}));
 const shape=request=>JSON.stringify({fen:request.fen,rootMoves:request.rootMoves,depth:request.depth,multiPv:request.multiPv,minimumPvPlies:request.minimumPvPlies});
 assert.deepEqual(parallel.map(shape).sort(),serial.map(shape).sort());
 assert.deepEqual(two.initialSearches.map(({tool,input,status})=>({tool,input,status})),one.initialSearches.map(({tool,input,status})=>({tool,input,status})));
});

test('full-game opt-in with no eligible review rows requires no independent provider',async()=>{
 const input=gameSetup(async()=>reply('The game contains useful lessons.'),{initialSearchConcurrency:4});
 const routing=await input.prepareRouting();
 for(const move of routing.mainLine.moves) move.analysis.classification='good';
 input.prepareRouting=async()=>routing;
 const result=await runAnswerPipeline(input);
 assert.deepEqual(result.initialSearches,[]);
 assert.equal(result.answer,'The game contains useful lessons.');
});
