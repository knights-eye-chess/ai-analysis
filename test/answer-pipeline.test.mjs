import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess} from 'chess.js';
import {runAnswerPipeline,createProductionObservationProvider,QUESTION_ROUTING_VERSION,simpleSystemPolicy,simpleToolDescription,toPositionAnalysis,toLegacyPositionAnalysis,toPositionAnalysisProvider,toLegacyPositionAnalysisProvider} from '@knights-eye-chess/ai-analysis';
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
function moveSetup(invoke,options={}) {
 const board=new Chess();board.move('e4');
 const moveContext={...context,kind:undefined,nodeId:'e1',moveUci:'e2e4',moveSan:'e4',fenAfter:board.fen()};
 const question='What is the idea behind this move?';
 return setup(invoke,{question,selected:{deliveryId:'answer-test',selectionKey:'e1',edgeId:'e1',context:moveContext,existingAnalysis:null},
  observationProvider:createProductionObservationProvider({context:moveContext,question}),
  prepareRouting:async()=>({question,selectionKey:'e1',deliveryId:'answer-test',elapsedMs:0,omitSelectedContext:false,
   decision:{version:QUESTION_ROUTING_VERSION,status:'fallback',omitSelectedContext:false,includeGameRecord:false,reviewGame:false,reason:'test-selected-move',answers:{answer_scope:{choice:'move_explanation',confidence:1}}}}),...options});
}
test('KE-AI-PORT-003: preparation, classification and observations have separate measured intervals',async t=>{
 let clock=100,turns=0;const events=[],searches=[];
 t.mock.method(performance,'now',()=>clock);
 const successful=analyzer(searches);
 const input=moveSetup(async()=>{turns++;return reply('The pawn occupies the centre.');});
 const route=input.prepareRouting,provider=input.observationProvider;
 input.prepareRouting=async()=>{clock+=7;return route();};
 input.analyzer={async analyze(request){clock+=searches.length?17:11;return successful.analyze(request);}};
 input.bridge={async refreshContext(){clock+=42;return {existingAnalysis:null};}};
 input.observationProvider={async observe(...args){clock+=13;return provider.observe(...args);}};
 input.observableTraceSink=event=>events.push(event);
 const result=await runAnswerPipeline(input);
 assert.equal(result.answer,'The pawn occupies the centre.');assert.equal(turns,1);assert.equal(searches.length,2);
 const phases=events.filter(event=>event.stage.startsWith('answer-pipeline-'));
 assert.deepEqual(phases.filter(e=>e.direction==='output').map(e=>[e.stage,e.payload.durationMs]),[
  ['answer-pipeline-routing',7],['answer-pipeline-preparation',28],
  ['answer-pipeline-classification-refresh',42],['answer-pipeline-observations',13],
  ['answer-pipeline-evidence-collection',0],
 ]);
 const ids=new Set();
 for(let i=0;i<phases.length;i+=2){
  const [start,end]=phases.slice(i,i+2);
  for(const event of [start,end]){
   assert.equal(event.model,'deterministic');assert.equal(event.providerRoute,'local-harness');assert.equal(event.reasoningEffort,'none');
  }
  assert.equal(start.direction,'input');assert.equal(end.direction,'output');assert.equal(end.payload.status,'completed');
  assert.equal(start.payload.invocationId,end.payload.invocationId);assert.equal(start.stage,end.stage);
  assert.equal(end.payload.elapsedMs-start.payload.elapsedMs,end.payload.durationMs);
  assert.equal(ids.has(start.payload.invocationId),false);ids.add(start.payload.invocationId);
 }
 assert.equal(events.find(e=>e.stage==='simple-preparation').payload.elapsedMs,28);
});
test('KE-AI-PORT-003: classification failure and cancellation retain their original error and a terminal duration',async t=>{
 let clock=0;t.mock.method(performance,'now',()=>clock);
 for(const cancelled of [false,true]){
  const controller=new AbortController(),events=[];let turns=0;
  const failure=new Error('host-private-error-message');
  const input=moveSetup(async()=>{turns++;return reply('Must not run.');},{analyzer:analyzer([]),signal:controller.signal,
   bridge:{async refreshContext(){clock+=23;if(cancelled)controller.abort(failure);throw failure;}},
   observableTraceSink:event=>events.push(event)});
  await assert.rejects(runAnswerPipeline(input),error=>error===failure);assert.equal(turns,0);
  const phase=events.filter(event=>event.stage==='answer-pipeline-classification-refresh');
  assert.equal(phase.length,2);assert.equal(phase[0].direction,'input');assert.equal(phase[1].direction,'error');
  assert.equal(phase[1].payload.status,cancelled?'cancelled':'failed');assert.equal(phase[1].payload.durationMs,23);
  assert.equal(phase[0].payload.invocationId,phase[1].payload.invocationId);
  assert.doesNotMatch(JSON.stringify(phase),/host-private-error-message/);
 }
});
test('KE-AI-PORT-003: initial-search refresh failure remains recoverable and supplied routing is not remeasured',async()=>{
 const events=[],input=setup(async()=>reply('The position permits development.'),{analyzer:analyzer([]),
  bridge:{async refreshContext(){throw Error('refresh unavailable');}},observableTraceSink:event=>events.push(event)});
 input.routingPreparation=await input.prepareRouting();input.prepareRouting=()=>{throw Error('supplied routing must be reused');};
 const result=await runAnswerPipeline(input);
 assert.equal(result.answer,'The position permits development.');
 assert.equal(events.some(event=>event.stage==='answer-pipeline-routing'),false);
 const phase=events.find(event=>event.stage==='answer-pipeline-classification-refresh'&&event.direction==='error');
 assert.equal(phase.payload.origin,'initial-search-preparation');assert.equal(phase.payload.status,'failed');
 assert.ok(Number.isFinite(phase.payload.durationMs));assert.ok(phase.payload.durationMs>=0);
});
test('KE-AI-PORT-003: overlapping opening lookup measures only its remaining wait',async t=>{
 let clock=0,finishOpening;const events=[];t.mock.method(performance,'now',()=>clock);
 const pendingOpening=new Promise(resolve=>{finishOpening=resolve;});
 const source={status:'unavailable',contextHash:'no-source',pages:[],requestCount:0,networkRequestCount:0,
  networkRequestedTitles:[],localIndexCandidateCount:0,localIndexPositionCheckCount:0,
  localIndexSelectedTitleCount:0,cacheHitTitleCount:0,timingMs:41,limitations:[]};
 const input=moveSetup(async()=>reply('The pawn occupies the centre.'),{
  analyzer:analyzer([]),openingSession:{initial:()=>pendingOpening},
  bridge:{async refreshContext(){clock+=8;return {existingAnalysis:null};}},
  observableTraceSink:event=>{events.push(event);if(event.stage==='answer-pipeline-opening-wait'&&event.direction==='input'){clock+=33;finishOpening(source);}},
 });
 const result=await runAnswerPipeline(input);
 assert.equal(result.answer,'The pawn occupies the centre.');
 const phase=events.filter(event=>event.stage==='answer-pipeline-opening-wait');
 assert.equal(phase.length,2);assert.equal(phase[0].payload.elapsedMs,8);
 assert.equal(phase[1].payload.durationMs,33);assert.equal(phase[1].payload.elapsedMs,41);
});
test('KE-AI-PORT-002: all failed preparation and tool searches retain causes and disclose degraded answers',async()=>{
 let turn=0,calls=0;const events=[];
 const result=await runAnswerPipeline(moveSetup(async request=>{
  turn++;
  if(turn===1)return reply('',[{toolCallId:'compare-before',toolName:'compare_moves',input:{phase:'before',movesUci:['e2e4','d2d4']}}]);
  if(turn===2){assert.match(JSON.stringify(request.messages),/engine-503/);return reply('',[{toolCallId:'compare-after',toolName:'compare_moves',input:{phase:'after',movesUci:['e7e5','c7c5']}}]);}
  return reply('The pawn occupies the centre.');
 },{analyzer:{async analyze(){calls++;throw Object.assign(new Error('engine-503: unavailable'),{code:'engine-unavailable',status:503,cause:new Error('upstream unreachable'),stack:'private stack',headers:{Authorization:'private header'}});}},observableTraceSink:e=>events.push(e)}));
 assert.equal(result.status,'diagnostic');assert.equal(calls,4);assert.equal(result.searchesUsed,4);
 assert.equal(result.searchesSucceeded,0);assert.equal(result.searchesFailed,4);assert.equal(result.engineEvidenceStatus,'unavailable');
 assert.match(result.answer,/^Engine analysis was unavailable.*not been verified with Stockfish\.\n\nThe pawn occupies/);
 assert.equal(result.preparation.searchesFailed,2);assert.deepEqual(result.preparation.rawRecords,[]);
 for(const entry of result.preparation.investigationLeads.unavailable){assert.equal(entry.error,'engine-503: unavailable');assert.equal(entry.code,'engine-unavailable');assert.equal(entry.status,503);assert.equal(entry.cause,'upstream unreachable');assert.equal('stack' in entry,false);assert.equal('headers' in entry,false);}
 assert.ok(events.some(e=>e.stage==='simple-engine-evidence'&&e.payload.status==='degraded'&&e.payload.searchesFailed===4));
 assert.doesNotMatch(JSON.stringify(result.preparation),/private stack|private header/);
});
test('KE-AI-PORT-002: final causal claim ranges include outage disclosure and UTF-16 paragraph offsets',async()=>{
 const prose='A quiet plan ♞ 🧩.\n\n[1. e4](game:0:e2e4) opens the bishop on f1 toward a6.\n\nA second view ♟: [1. e4](game:0:e2e4) clears the bishop on f1 toward a6.';
 for(const outage of [true,false]) {
  const events=[];
  const result=await runAnswerPipeline(moveSetup(async()=>reply(prose),{
   analyzer:outage?{async analyze(){throw Error('deterministic engine outage');}}:analyzer([]),
   observableTraceSink:event=>events.push(event),
  }));
  assert.equal(result.engineEvidenceStatus,outage?'unavailable':'available');
  assert.equal(result.referenceValidation.causalClaimCheckStatus,'completed');
  const checks=result.referenceValidation.causalClaimChecks;
  assert.equal(checks.length,2);
  assert.ok(prose.length>[...prose].length,'fixture includes a UTF-16 surrogate pair');
  for(const check of checks) {
   assert.equal(result.answer.slice(check.claimRange.start,check.claimRange.end),check.claim);
   assert.equal(result.answer.slice(check.sentenceContext.start,check.sentenceContext.end),check.sentenceContext.text);
   assert.match(check.claim,/bishop on f1 toward a6/);
  }
  assert.deepEqual(events.find(event=>event.stage==='simple-reference-validation').payload.causalClaimChecks,checks);
  if(outage)assert.match(result.answer,/^Engine analysis was unavailable/);
  else assert.equal(result.answer,prose);
 }
});
test('KE-AI-PORT-002: endpoint comparison descriptions explicitly require final analysis',()=>{
 for(const name of ['test_line','test_game_line'])assert.match(simpleToolDescription(name),/compareFinalMovesUci requires analyzeFinal=true/);
});
test('KE-AI-PORT-002: recovery after failed preparation counts real successes and clears all-failed disclosure',async()=>{
 let turn=0,calls=0;const successful=analyzer([]);
 const result=await runAnswerPipeline(moveSetup(async()=>++turn===1?reply('',[{toolCallId:'recovered',toolName:'compare_moves',input:{phase:'before',movesUci:['e2e4','d2d4']}}]):reply('Both central pawn moves are available.'),
  {analyzer:{async analyze(request){calls++;if(calls<=2)throw Error('offline');return successful.analyze(request);}}}));
 assert.equal(result.status,'diagnostic');assert.equal(result.searchesUsed,3);assert.equal(result.searchesSucceeded,1);assert.equal(result.searchesFailed,2);
 assert.equal(result.engineEvidenceStatus,'available');assert.equal(result.answer,'Both central pawn moves are available.');
});
test('KE-AI-PORT-002: initial search failures and later successes count analyzer dispatches, not tools',async()=>{
 let turn=0,calls=0;const successful=analyzer([]);
 const result=await runAnswerPipeline(setup(async()=>++turn===1?reply('',[{toolCallId:'recover',toolName:'compare_moves',input:{phase:'before',movesUci:['e2e4','d2d4']}}]):reply('A bounded assessment.'),
  {analyzer:{async analyze(request){calls++;if(calls===1)throw Error('initial engine unavailable');return successful.analyze(request);}}}));
 assert.equal(result.initialSearches[0].status,'failed');assert.equal(result.searchesUsed,2);assert.equal(result.searchesSucceeded,1);assert.equal(result.searchesFailed,1);assert.equal(result.engineEvidenceStatus,'available');
});
test('KE-AI-PORT-002: endpoint failures within one successful tool remain failed searches',async()=>{
 let calls=0;const successful=analyzer([]);
 const result=await runAnswerPipeline(setup(async()=>reply('Only the initial engine lines are available.'),
  {analyzer:{async analyze(request){calls++;if(calls>1)throw Error('endpoint unavailable');const value=await successful.analyze(request);return {...value,lines:value.lines.map(line=>({...line,pv:[line.rootMove]}))};}}}));
 assert.equal(result.initialSearches[0].status,'completed');assert.equal(calls,4);assert.equal(result.searchesUsed,4);
 assert.equal(result.searchesSucceeded,1);assert.equal(result.searchesFailed,3);assert.equal(result.engineEvidenceStatus,'available');
 assert.equal(result.answer,'Only the initial engine lines are available.');
});
test('KE-AI-PORT-002: a partial search batch counts failed dispatches separately from successful queries',async()=>{
 let turn=0,calls=0;const successful=analyzer([]);
 const result=await runAnswerPipeline(setup(async request=>{
  if(++turn===1)return reply('',[{toolCallId:'partial-batch',toolName:'search_batch',input:{requests:[
   {queryId:'central',tool:'compare_moves',input:{phase:'before',movesUci:['e2e4','d2d4']}},
   {queryId:'knights',tool:'compare_moves',input:{phase:'before',movesUci:['g1f3','b1c3']}}]}}]);
  assert.match(JSON.stringify(request.messages),/batch search unavailable/);return reply('The central pawn comparison is available.');
 },{analyzer:{async analyze(request){calls++;if(calls===2)return successful.analyze(request);throw Error('batch search unavailable');}}}));
 assert.equal(result.toolRuns[0].status,'completed');assert.deepEqual(result.toolRuns[0].result.searches.map(s=>s.status),['completed','failed']);
 assert.equal(calls,3);assert.equal(result.searchesUsed,3);assert.equal(result.searchesSucceeded,1);assert.equal(result.searchesFailed,2);assert.equal(result.engineEvidenceStatus,'available');
 assert.equal(result.answer,'The central pawn comparison is available.');
});
test('KE-AI-PORT-002: no engine requested and cancelled searches do not become outage disclosures',async()=>{
 const noEngine=await runAnswerPipeline(setup(async()=>reply('A positional explanation.')));
 assert.equal(noEngine.engineEvidenceStatus,'not-requested');assert.equal(noEngine.searchesFailed,0);assert.equal(noEngine.answer,'A positional explanation.');
 const controller=new AbortController();let calls=0,turn=0;const successful=analyzer([]);
 const cancelled=await runAnswerPipeline(moveSetup(async()=>++turn===1?reply('',[{toolCallId:'cancel-search',toolName:'compare_moves',input:{phase:'before',movesUci:['e2e4','d2d4']}}]):reply('This must not run.'),
  {signal:controller.signal,analyzer:{async analyze(request){calls++;if(calls<=2)return successful.analyze(request);controller.abort(new Error('explicit cancellation'));throw Error('stopped');}}}));
 assert.equal(cancelled.status,'failure');assert.equal(cancelled.answer,'');assert.equal(cancelled.searchesUsed,3);assert.equal(cancelled.searchesFailed,0);
});
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
