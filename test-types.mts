import {runAnswerPipeline,createProductionObservationProvider,QUESTION_ROUTING_VERSION,type AnswerModelConnector,type AnswerSelection,type AnswerHistoryPort} from '@knights-eye-chess/ai-analysis';
const connector:AnswerModelConnector={kind:'model-turn',async invoke(request){return {text:request.toolChoice,toolCalls:[],finishReason:'stop',usage:{},response:{messages:[]}};}};
const selection:AnswerSelection={deliveryId:'x',selectionKey:'x',edgeId:'root',existingAnalysis:null,context:{kind:'position',nodeId:'root',fenBefore:'x',fenAfter:'x',historyUci:[],moveUci:'',moveSan:''}};
const history:AnswerHistoryPort={};
void runAnswerPipeline({connector,requestId:'x',question:'x',selected:selection,bridge:history,observationProvider:createProductionObservationProvider({context:selection.context}),prepareRouting:async()=>({question:'x',selectionKey:'x',deliveryId:'x',elapsedMs:0,omitSelectedContext:false,decision:{version:QUESTION_ROUTING_VERSION,status:'fallback',omitSelectedContext:false,includeGameRecord:false,reviewGame:false,reason:'explicit'}})});
// @ts-expect-error model turn cannot be replaced by an unrelated delegated agent executor
const wrong:AnswerModelConnector={kind:'agent',execute:async()=>''};
// @ts-expect-error exact history is required in a selected position context
const noHistory:AnswerSelection={...selection,context:{nodeId:'x',fenBefore:'x',fenAfter:'x',moveUci:'',moveSan:''}};
void wrong;void noHistory;

// The public analyzer distance is signed mate-in-moves; legacy reads are explicit.
import {toPositionAnalysis,toLegacyPositionAnalysis,type PositionAnalysisResult,type LegacyPositionAnalysisResult,type PositionAnalysisProvider} from '@knights-eye-chess/ai-analysis';
const modern:PositionAnalysisResult={engine:'synthetic',engineBuild:'test',command:'test',bestMove:'e2e4',lines:[{rootMove:'e2e4',pv:['e2e4'],depth:18,nodes:null,scoreCp:null,mateInMoves:-3}]};
const old:LegacyPositionAnalysisResult=toLegacyPositionAnalysis(modern);
const current:PositionAnalysisResult=toPositionAnalysis(old);
const analyzer:PositionAnalysisProvider={analyze:async()=>current};
// @ts-expect-error matePly alone is not the preferred public result contract
const oldAsCurrent:PositionAnalysisResult=old;
// @ts-expect-error mate distance is numeric, never a UCI or SAN string
const badMate:PositionAnalysisResult={...modern,lines:[{...modern.lines[0],mateInMoves:'3'}]};
void runAnswerPipeline({connector,requestId:'parallel',question:'x',selected:selection,bridge:history,analyzer,preparationAnalyzer:analyzer,parallelPreparation:true,observationProvider:createProductionObservationProvider({context:selection.context}),prepareRouting:async()=>({question:'x',selectionKey:'x',deliveryId:'x',elapsedMs:0,omitSelectedContext:false,decision:{version:QUESTION_ROUTING_VERSION,status:'fallback',omitSelectedContext:false,includeGameRecord:false,reviewGame:false,reason:'explicit'}})});
void analyzer;void oldAsCurrent;void badMate;

import {createEngineAnalysisProvider,type AnalysisEngineClient} from '@knights-eye-chess/ai-analysis/engine';
const engineClient:AnalysisEngineClient={async search(request){return{candidates:[{pv:['e2e4'],depth:request.limit.depth,scoreCp:20,mate:null,scoreProvenance:{engineBuild:'test'}}]};}};
const engineProvider:PositionAnalysisProvider=createEngineAnalysisProvider(engineClient);
void engineProvider;
