import { compactSearchRecord } from './compact-search-preparation';
import type { ReasoningEvidenceRecord } from './poc-contracts';
import { matchedRootComparison } from './matched-comparison';
import type { PositionAnalysisResult } from './poc-tools';

export type PreparedPresentation = {
  callId:string; modelRun:Record<string,unknown>; records:ReasoningEvidenceRecord[];
  playedMove?:string; discoveryCallId?:string; limitations?:string[];
};
type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>!!v && typeof v==='object' && !Array.isArray(v);
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(x=>typeof x==='string');
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

function search(record:ReasoningEvidenceRecord) {
  const data=record.data;
  if(!object(data.recordedPosition)||!object(data.details))return;
  const root=data.recordedPosition,details=data.details;
  if(!object(details.searchScope)||!Array.isArray(details.lines)||!details.lines.length||!details.lines.every(object))return;
  const scope=details.searchScope,lines=details.lines as Obj[];
  const perspective=typeof root.fen==='string'&&root.fen.split(' ')[1]==='w'?'white':'black';
  if(typeof root.fen!=='string'||scope.fen!==root.fen||!Number.isInteger(root.ply)
    ||!strings(scope.requestedRootMoves)||new Set(lines.map(l=>l.rootMove)).size!==lines.length)return;
  for(const line of lines){
    if(typeof line.rootMove!=='string'||!strings(line.pv)||line.pv[0]!==line.rootMove||!finite(line.depth)
      ||!object(line.scoreScope)||line.scoreScope.fen!==root.fen||line.scoreScope.perspective!==perspective
      ||line.scoreScope.positiveMeans!=='advantage for perspective color')return;
    if(finite(line.matePly)){
      if(line.scoreScope.matePlyUnit!=='signed mate-in-moves (legacy field name, not plies)')return;
    }else if(line.matePly!=null||!finite(line.scoreCp)||Math.abs(line.scoreCp)>=100000||line.scoreScope.scoreCpUnit!=='centipawns')return;
  }
  return {root,details,scope,lines,requestedRootMoves:scope.requestedRootMoves as string[]};
}

/** Consolidates presentation only. Raw searches, evidence and numeric scores are never merged. */
export function consolidatePreparedSearches(entries:readonly PreparedPresentation[]) {
  const replacements=new Map<string,Record<string,unknown>>(),omitted=new Set<string>();
  const dependencies:Array<Record<string,unknown>>=[];
  for(const primary of entries){
    if(!primary.discoveryCallId)continue;
    const discovery=entries.find(e=>e.callId===primary.discoveryCallId);
    const dependency:Record<string,unknown>={relation:'candidate-selection',discoveryCallId:primary.discoveryCallId,
      comparisonCallId:primary.callId,discoveryEvidenceIds:discovery?.records.map(r=>r.id)??[],comparisonEvidenceIds:primary.records.map(r=>r.id),
      presentation:'separate',reason:'Comparison is not a complete compatible replacement.'};
    dependencies.push(dependency);
    if(!discovery||discovery.modelRun.status!=='completed'||primary.modelRun.status!=='completed'
      ||discovery.records.length!==1||primary.records.length!==1||omitted.has(discovery.callId))continue;
    const original=discovery.records[0],comparison=primary.records[0],a=search(original),b=search(comparison);
    if(!a||!b||!original.source.endsWith('/explore-continuations')||!comparison.source.endsWith('/compare_moves')
      ||original.contextHash!==comparison.contextHash||!equal(a.root,b.root)||a.requestedRootMoves.length
      ||comparison.coverage?.complete!==true||!primary.playedMove||!b.lines.some(l=>l.rootMove===primary.playedMove)
      ||new Set(b.lines.map(l=>l.depth)).size!==1)continue;
    // Only the primary comparison needs a verified common root-search depth.
    // A legacy discovery may remain a separately qualified historical summary.
    if(matchedRootComparison({...b.details,command:b.scope.command,cacheProvenance:b.scope.cacheProvenance,sourceCacheProvenance:b.scope.sourceCacheProvenance} as unknown as PositionAnalysisResult,String(b.root.fen),b.requestedRootMoves).status!=='matched')continue;
    const roots=a.lines.map(l=>String(l.rootMove)),compared=b.requestedRootMoves;
    if(![...roots,primary.playedMove,...compared].every(move=>compared.includes(move)&&comparison.coverage!.covered.includes(move)&&b.lines.some(l=>l.rootMove===move)))continue;
    // A compact projection marker confirms that the schema was recognized. Unknown
    // producer fields fall back to the original presentation rather than disappearing.
    if(!compactSearchRecord(original,primary.playedMove)||!compactSearchRecord(comparison,primary.playedMove))continue;
    const commonComparisonOrder=b.lines.map(l=>String(l.rootMove)).filter(move=>roots.includes(move));
    const differentContinuations=a.lines.filter(line=>{
      const other=b.lines.find(l=>l.rootMove===line.rootMove)!;
      return !equal(line.pv,other.pv)||!equal(line.pvCompletion,other.pvCompletion);
    }).map(l=>l.rootMove);
    const discoverySummary={callId:discovery.callId,evidenceId:original.id,source:original.source,
      engine:a.details.engine,engineBuild:a.details.engineBuild,searchScope:a.scope,
      coverage:original.coverage,summary:original.summary,limitations:discovery.limitations??[],
      scores:a.lines.map(l=>({rootMove:l.rootMove,depth:l.depth,scoreCp:l.scoreCp,matePly:l.matePly,scoreScope:l.scoreScope,
        ...(l.scoreProvenance?{scoreProvenance:l.scoreProvenance}:{}),
        ...(object(l.pvCompletion)?{continuation:{status:l.pvCompletion.status,conditional:l.pvCompletion.conditional,actualPlies:l.pvCompletion.actualPlies,requestedPlies:l.pvCompletion.requestedPlies}}:{})})),
      discoveryOrder:roots,comparisonOrderForDiscoveredMoves:commonComparisonOrder,
      reportedOrderChanged:!equal(roots,commonComparisonOrder),distinctContinuationRootMoves:differentContinuations,
      retrieveFullEvidenceId:original.id,
      interpretation:'Discovery supplied candidates for this comparison. Its scores and reported ordering belong to the discovery search, not the primary comparison. Reported order changes may include tied moves. Full discovery continuations and details remain retrievable; use retrieve_evidence before relying on an omitted discovery line. Score disagreements remain in scoreComparisonNotices. This dependency does not establish that the answering model used or cited either record.'};
    // Keep opening commentary delivered during discovery, including its original
    // associations. It may not be repeated by the subsequent comparison lookup.
    const result=discovery.modelRun.result;
    const discoveryOpeningSourceContext=object(result)?result.openingSourceContext:undefined;
    replacements.set(primary.callId,{...primary.modelRun,discovery:discoverySummary,
      ...(discoveryOpeningSourceContext?{discoveryOpeningSourceContext}:{})});
    omitted.add(discovery.callId);
    Object.assign(dependency,{presentation:'comparison-with-discovery-summary',reason:'Complete same-root comparison covers discovered alternatives and played move.',
      primaryEvidenceId:comparison.id,reportedOrderChanged:discoverySummary.reportedOrderChanged,distinctContinuationRootMoves:differentContinuations});
  }
  return {results:entries.filter(e=>!omitted.has(e.callId)).map(e=>replacements.get(e.callId)??e.modelRun),
    diagnostics:{version:'preparation-consolidation/1',searchCount:entries.length,primaryEntryCount:entries.length-omitted.size,
      summarizedDiscoveryCount:omitted.size,dependencies,
      interpretation:'Candidate-selection and presentation decisions are observable. They do not establish whether uncited records influenced the answer. All authoritative records remain available for retrieval.'}};
}
