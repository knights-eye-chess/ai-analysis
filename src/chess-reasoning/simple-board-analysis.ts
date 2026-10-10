import { scopedClassifierDecision } from '@knights-eye-chess/move-classifier/contracts';
import { savedScorePresentation } from './saved-score-presentation';
import { Chess } from 'chess.js';
import { reasoningContextHash, REASONING_POC_VERSION, validateReasoningPositionContext, type ReasoningPositionContext, type ReasoningEvidenceRecord } from './poc-contracts';
import { withEvidenceLicenses, EVIDENCE_LICENSE } from './evidence-licenses';
import { stableHash } from './stable';
import type { SemanticValue } from './types';

/** Request-local canonical snapshot, never a replacement for acquired chess proof. */
export function simpleBoardAnalysis(context: ReasoningPositionContext, raw: unknown, edgeId?: string) {
  validateReasoningPositionContext(context);
  if (context.kind === 'position' || !raw || typeof raw !== 'object') return undefined;
  raw = structuredClone(raw); // Freeze the delivered snapshot against later canonical updates.
  const source = raw as { canonicalAnalysis?: {version?:string; selectedEdge?: {edgeId?:string;moveUci?:string;moveSan?:string;analysis?:Record<string,unknown>};nextMoves?:{fen?:string;perspective?:string;candidates?:unknown[]};classificationPending?:boolean} };
  const edge = source.canonicalAnalysis?.selectedEdge, a = edge?.analysis ?? {};
  if (source.canonicalAnalysis?.version !== 'canonical-edge-analysis-snapshot/1' || edge?.moveUci !== context.moveUci || edge.moveSan !== context.moveSan || (edgeId && edge.edgeId !== edgeId)) return undefined;
  const legal = new Map(new Chess(context.fenBefore).moves({verbose:true}).map(m=>[`${m.from}${m.to}${m.promotion||''}`,m.san]));
  const best = typeof a.bestmove === 'string' && legal.has(a.bestmove) ? a.bestmove : null;
  const num = (v:unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const text = (v:unknown) => typeof v === 'string' ? v.slice(0,100) : null;
  const candidateDepth = (candidate:Record<string,unknown>,rootFen:string) => {
    const reportedDepth=num(candidate.depth),raw=candidate.scoreProvenance;
    const provenance=raw && typeof raw==='object' && !Array.isArray(raw) ? raw as Record<string,unknown> : null;
    const originKind=text(provenance?.kind),originFen=text(provenance?.fen),originatingDepth=num(provenance?.originatingDepth);
    const actualDepth=originKind==='root-search' && originFen===rootFen && originatingDepth!==null && originatingDepth>0
      && Number.isInteger(originatingDepth) && originatingDepth===reportedDepth ? originatingDepth : null;
    return {reportedDepth,actualDepth,scoreOrigin:{kind:originKind??'legacy-unknown',fen:originFen,originatingDepth}};
  };
  const id = `evidence:board-analysis:${stableHash({context:reasoningContextHash(context),raw})}`;
  const record:ReasoningEvidenceRecord = withEvidenceLicenses({schemaVersion:REASONING_POC_VERSION,id,contextHash:reasoningContextHash(context),kind:'context',source:'knights-eye/canonical-board-analysis/1',proofStrength:null,summary:'Complete existing board analysis. Product labels and saved searches are attributed context, not independent proof of the explanation.',data:{authority:'heuristic-affordance',snapshot:raw as SemanticValue},coverage:{complete:false,covered:['reported-board-analysis'],unresolved:['fresh-comparison','causal-explanation']},replay:{fen:context.fenBefore,moveUci:context.moveUci},licenses:[EVIDENCE_LICENSE.ATTENTION_AFFORDANCE]});
  const classifierDecision = scopedClassifierDecision(a.classifier_decision, context, a.classification, a.classifier_version);
  const alternatives = (Array.isArray(a.alternative_candidates)?a.alternative_candidates:[]).slice(0,6).flatMap((value:unknown)=>{
    if(!value || typeof value!=='object')return [];
    const c=value as Record<string,unknown>;if(typeof c.uci!=='string'||!legal.has(c.uci))return [];
    // Only expose fully legal stored lines; complete original record remains retrievable.
    const board=new Chess(context.fenBefore),uci:string[]=[],san:string[]=[];
    try { for(const move of (Array.isArray(c.pv)?c.pv:[])){if(typeof move!=='string')throw Error();const m=board.move({from:move.slice(0,2),to:move.slice(2,4),promotion:move.slice(4)||undefined});uci.push(move);san.push(m.san);} }catch {uci.length=0;san.length=0;}
    if(uci.length && uci[0]!==c.uci){uci.length=0;san.length=0;}
    return [{uci:c.uci,san:legal.get(c.uci),scoreCp:num(c.mate)!==null||Math.abs(num(c.scoreCp)??0)>=100000?null:num(c.scoreCp),mate:num(c.mate),...candidateDepth(c,context.fenBefore),lineUci:uci,lineSan:san.join(' ')}];
  });
  const next = source.canonicalAnalysis?.nextMoves;
  const responses = next?.fen === context.fenAfter && Array.isArray(next.candidates) ? next.candidates.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const c = value as Record<string, unknown>, board = new Chess(context.fenAfter);
    if (typeof c.uci !== 'string') return [];
    try {
      const root = board.move({from:c.uci.slice(0,2),to:c.uci.slice(2,4),promotion:c.uci.slice(4)||undefined});
      board.load(context.fenAfter);
      const moves = Array.isArray(c.pv) ? c.pv : [], san:string[] = [];
      for (const u of moves) { if(typeof u !== 'string') return []; san.push(board.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u.slice(4)||undefined}).san); }
      if (moves.length && moves[0] !== c.uci) return [];
      return [{uci:c.uci,san:root.san,classification:text(c.quality),scoreCp:num(c.mate)!==null||Math.abs(num(c.scoreCp)??0)>=100000?null:num(c.scoreCp),mate:num(c.mate),...candidateDepth(c,context.fenAfter),lineUci:moves,lineSan:san.join(' ')}];
    } catch { return []; }
  }) : [];
  return {record,leadingAlternative:best?{fen:context.fenBefore,uci:best,evidenceId:id}:undefined,snapshot:{version:'simple-board-analysis/1',evidenceId:id,completeRecordRetrieval:'retrieve_evidence',position:{before:context.fenBefore,after:context.fenAfter,moveUci:context.moveUci,moveSan:context.moveSan},authority:'attributed-existing-analysis',classificationPending:source.canonicalAnalysis?.classificationPending===true,nextMoves:{fen:context.fenAfter,perspective:context.fenAfter.split(' ')[1]==='w'?'white':'black',units:'centipawns; positive favors perspective',candidates:responses},classification:text(a.classification),classifierVersion:num(a.classifier_version),recordedReason:classifierDecision??a.missed_opportunity??null,classifierDecision,missedOpportunity:a.missed_opportunity??null,engine:text(a.engine),reportedDepth:num(a.depth),beforeDepth:num(a.before_depth),afterDepth:num(a.after_depth),recordedRequestedDepth:num(a.requested_depth),depthMeaning:'reportedDepth summarizes classification dependencies; recordedRequestedDepth is the board setting recorded at classification, not a verified search depth',evaluation:{perspective:'selected-mover',units:'centipawns; mate separate',...savedScorePresentation({beforeCp:num(a.eval_before),afterCp:num(a.eval_after),lossCp:num(a.cp_loss),mateBefore:num(a.mate_before),mateAfter:num(a.mate_after)})},leadingAlternative:best?{uci:best,san:legal.get(best)}:null,alternatives,limitations:['Saved board analysis may differ in depth or result from fresh searches. Classification is a reported policy decision, not proof of its explanation.','Candidate coverage is restricted; best here means best recorded, not exhaustive proof.','Initial view omits path-edge history, material-offer bookkeeping and other original fields; retrieve the complete record when relevant. No future game moves are supplied.']}};
}
export type SimpleBoardAnalysis = ReturnType<typeof simpleBoardAnalysis>;
