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
test('KE-AI-PORT-001: existing preparation, genuine legal tools, resumable evidence and composition',async()=>{
 let turn=0;const searches=[];const events=[];
 const result=await runAnswerPipeline(setup(async request=>{
  turn++;assert.match(request.system,/Knight/);assert.ok(request.tools.every(t=>t.inputSchema&&typeof t.inputSchema==='object'));
  if(turn===1){assert.ok(searches.length>0);assert.match(JSON.stringify(request.messages),/initial-search/);return reply('',[{toolCallId:'inspect-1',toolName:'inspect_position',input:{phase:'before',squares:['e2']}}]);}
  if(turn===2){assert.match(JSON.stringify(request.messages),/tool-result/);assert.match(JSON.stringify(request.messages),/inspect-1/);return reply('',[{toolCallId:'line-1',toolName:'test_line',input:{phase:'before',movesUci:['e2e4','e7e5'],analyzeFinal:false}}]);}
  assert.match(JSON.stringify(request.messages),/line-1/);return reply('Both sides can develop their pieces.');
 },{analyzer:analyzer(searches),observableTraceSink:e=>events.push(e)}));
 assert.equal(result.status,'diagnostic');assert.equal(result.answer,'Both sides can develop their pieces.');assert.equal(turn,3);
 assert.ok(result.initialSearches.some(s=>s.status==='completed'));assert.equal(result.toolRuns.filter(s=>s.status==='completed').length,2);assert.ok(result.presentedEvidence.length>1);assert.ok(events.some(e=>e.stage==='simple-model'));
});
test('KE-AI-PORT-001: canonical six-turn reserve forces tool-free composition',async()=>{
 let turn=0;
 const result=await runAnswerPipeline(setup(async request=>{turn++;if(request.toolChoice==='none'){assert.equal(turn,6);assert.equal(request.tools.length,0);return reply('The acquired evidence is limited.');}return reply('',[{toolCallId:'inspect-'+turn,toolName:'inspect_position',input:{phase:'before',squares:['e2']}}]);}));
 assert.equal(turn,6);assert.equal(result.completionReason,'model-calls');assert.equal(result.toolCallsUsed,5);
});
test('KE-AI-PORT-001: search batch budget rejects nine requests before host execution',async()=>{
 let turn=0;
 const result=await runAnswerPipeline(setup(async request=>{turn++;if(turn===1)return reply('',[{toolCallId:'oversized',toolName:'search_batch',input:{requests:Array.from({length:9},(_,i)=>({queryId:'q'+i,tool:'test_line',input:{phase:'before',movesUci:['e2e4'],analyzeFinal:false}}))}}]);assert.match(JSON.stringify(request.messages),/invalid-tool-array/);return reply('The requested batch was too large.');}));
 assert.equal(result.toolRuns[0].status,'failed');assert.equal(result.searchesUsed,0);
});
test('KE-AI-PORT-001: cancellation after model response prevents tool execution',async()=>{
 const controller=new AbortController();
 const result=await runAnswerPipeline(setup(async()=>{controller.abort();return reply('',[{toolCallId:'cancelled',toolName:'inspect_position',input:{phase:'before',squares:['e2']}}]);},{signal:controller.signal}));
 assert.equal(result.status,'failure');assert.equal(result.toolRuns.length,0);assert.equal(result.answer,'');
});
test('KE-AI-PORT-001: unknown usage reserves output allowance without claiming measurement',async()=>{
 const result=await runAnswerPipeline(setup(async()=>({...reply('A bounded answer.'),usage:{}})));
 assert.equal(result.status,'diagnostic');assert.equal(result.usage.metering,'partly-unavailable');assert.equal(result.usage.reportedOutputTokens,null);assert.equal(result.usage.reportedInputTokens,null);assert.equal(result.usage.outputBudgetReservation,6000);assert.equal(result.usage.unmeteredCalls,1);
});
test('KE-AI-PORT-001: exact recorded history is frozen and retrieved through host port',async()=>{
 let reads=0,turn=0;
 const line={startFen:fen,moves:[{uci:'e2e4',san:'e4',edgeId:'e1'},{uci:'e7e5',san:'e5',edgeId:'e2'}],selectedIndex:-1,selectedAtStart:true,totalPlies:2,truncated:false};
 const result=await runAnswerPipeline(setup(async request=>{turn++;if(turn<3)return reply('',[{toolCallId:'history-'+turn,toolName:'get_main_line',input:{}}]);assert.match(JSON.stringify(request.messages),/e2e4/);assert.match(JSON.stringify(request.messages),/recordedMainLine/);return reply('The recorded game began with central pawn moves.');},{bridge:{getMainLine:async()=>{reads++;return line;}}}));
 assert.equal(reads,1);assert.equal(result.acquiredMainLines.length,2);assert.equal(result.acquiredMainLines[0].moves[1].san,'e5');
});
test('KE-AI-PORT-001: malformed connector batches fail closed before any valid prefix executes',async()=>{
 const valid={toolCallId:'first',toolName:'inspect_position',input:{phase:'before',squares:['e2']}};
 for(const invalid of [{...valid},{...valid,toolCallId:''},{...valid,toolCallId:'second',toolName:'unknown'},{...valid,toolCallId:'second',input:[]},{...valid,toolCallId:'second',input:null}]) {
  const result=await runAnswerPipeline(setup(async()=>reply('',[valid,invalid])));
  assert.equal(result.status,'failure');assert.equal(result.toolRuns.length,0);assert.equal(result.toolCallsUsed,0);
 }
 const result=await runAnswerPipeline(setup(async()=>reply('',Array.from({length:33},(_,i)=>({...valid,toolCallId:'call-'+i})))));
 assert.equal(result.status,'failure');assert.equal(result.toolRuns.length,0);
});

test('KE-REASON-034: signed-moves adapters preserve attributed legacy records and conditional segments',async()=>{
 const provenance={kind:'restored-fallback',engineBuild:'historical-build',originatingDepth:11};
 const scope={fen,perspective:'white',positiveMeans:'advantage for perspective color',scoreCpUnit:'centipawns',matePlyUnit:'signed mate-in-moves (legacy field name, not plies)'};
 const legacy={engine:'historical-engine',engineBuild:'historical-build',command:'historical',bestMove:'e2e4',cacheProvenance:'browser-completed-cache',sourceCacheProvenance:'widget-analysis-cache',
  lines:[{rootMove:'e2e4',pv:['e2e4'],rawPv:['e2e4'],depth:11,nodes:42,scoreCp:null,matePly:-3,scoreScope:scope,scoreProvenance:provenance,
   pvCompletion:{requestedPlies:10,actualPlies:1,status:'short-budget',conditional:true,segments:[{fen,startPly:1,depth:8,pv:['e7e5'],scoreCp:null,matePly:2,scoreScope:{...scope,perspective:'black'},scoreProvenance:provenance,command:'historical-endpoint',engine:'historical-engine',engineBuild:'historical-build',cacheProvenance:'restored-fallback'}]}}]};
 const frozen=JSON.stringify(legacy);
 const preferred=toPositionAnalysis(legacy);
 assert.equal(preferred.lines[0].mateInMoves,-3);assert.equal('matePly' in preferred.lines[0],false);
 assert.equal(preferred.lines[0].pvCompletion.segments[0].mateInMoves,2);
 assert.equal(preferred.lines[0].scoreScope.mateInMovesUnit,'signed mate-in-moves');
 assert.equal('matePlyUnit' in preferred.lines[0].scoreScope,false);
 assert.deepEqual(preferred.lines[0].scoreProvenance,provenance);
 assert.deepEqual(toLegacyPositionAnalysis(preferred),legacy);
 assert.equal(JSON.stringify(legacy),frozen);
 for(const mate of [null,0,3,-5]){
  const result={...legacy,lines:[{...legacy.lines[0],matePly:mate}]};
  assert.deepEqual(toLegacyPositionAnalysis(toPositionAnalysis(result)),result);
 }
});

test('KE-REASON-034: conflicting aliases, invalid distances and units fail closed including segments',async()=>{
 const result={engine:'test',engineBuild:'test',command:'test',bestMove:null,lines:[{rootMove:'e2e4',pv:['e2e4'],depth:1,nodes:null,scoreCp:null,mateInMoves:2}]};
 for(const convert of [toPositionAnalysis,toLegacyPositionAnalysis]){
  for(const value of [{matePly:3},{matePly:null},{mateInMoves:1.5},{mateInMoves:Infinity},{mateInMoves:undefined},{mateInMoves:'2'},{scoreScope:{mateInMovesUnit:'plies'}},{scoreScope:{matePlyUnit:'plies'}}]){
   assert.throws(()=>convert({...result,lines:[{...result.lines[0],...value}]}),TypeError);
  }
  assert.throws(()=>convert({...result,lines:[{...result.lines[0],pvCompletion:{segments:[{matePly:1,mateInMoves:2}]}}]}),/Conflicting/);
  const {mateInMoves:_,...missing}=result.lines[0];void _;
  assert.throws(()=>convert({...result,lines:[missing]}),/Missing/);
  assert.equal(convert({...result,lines:[{...result.lines[0],matePly:2}]}).lines.length,1);
 }
});

test('KE-REASON-034: preferred analyzer and explicit legacy analyzer produce identical answer evidence',async()=>{
 const oldSearches=[],newSearches=[];
 const old=await runAnswerPipeline(setup(async()=>reply('The evidence is bounded.'),{analyzer:analyzer(oldSearches)}));
 const modern=await runAnswerPipeline(setup(async()=>reply('The evidence is bounded.'),{analyzer:toPositionAnalysisProvider(analyzer(newSearches))}));
 assert.equal(modern.answer,old.answer);assert.equal(modern.status,old.status);
 assert.deepEqual(modern.presentedEvidence,old.presentedEvidence);
 assert.equal(newSearches.length,oldSearches.length);
 assert.ok(newSearches.length>0);
});

test('KE-REASON-034: analyzer adapters forward exact requests and reject pre/post completion cancellation',async()=>{
 for(const wrap of [toPositionAnalysisProvider,toLegacyPositionAnalysisProvider]){
  let calls=0;const controller=new AbortController();
  const request={fen,depth:18,multiPv:3,rootMoves:[],signal:controller.signal};
  const provider=wrap({async analyze(received){calls++;assert.equal(received,request);controller.abort(new Error('stop-adapter'));return {engine:'test',engineBuild:'test',command:'test',bestMove:null,lines:[]};}});
  await assert.rejects(provider.analyze(request),/stop-adapter/);assert.equal(calls,1);
  await assert.rejects(provider.analyze(request),/stop-adapter/);assert.equal(calls,1);
 }
});
