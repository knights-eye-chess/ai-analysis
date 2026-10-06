import type { AnswerScope, ReviewSubject } from './question-routing';
import type { ReasoningEvidenceRecord } from './poc-contracts';
import { Chess } from 'chess.js';
import type { RecordedMainLine } from './answer-host-contracts';
import type { PlayerPerspective } from '../player-perspective';
import type { ReasoningPositionContext, ReasoningToolName } from './poc-contracts';
import { recordedMainLineResult } from './recorded-main-line';
import { recordedPositionContext } from './recorded-position-tools';
import { matchedRootComparison } from './matched-comparison';
import type { PositionAnalysisResult } from './poc-tools';

export type InitialSearch = {tool:ReasoningToolName;input:Record<string,unknown>;reason:string;playedMove?:string};
export type InitialSearchPlan = {version:'initial-search-plan/1';requests:InitialSearch[];limitations:string[];classificationReassessment?:boolean;reviewScope?:{subject:ReviewSubject;resolvedSide:'white'|'black'|'both'|'unknown'}};
const normalize=(san:string)=>san.replace(/[+#?!]+$/,'');
const uci=(m:{from:string;to:string;promotion?:string})=>m.from+m.to+(m.promotion??'');
/** Recognition is deliberately narrow: unresolved language stays with the answering model. */
export function planInitialSearches(input:{question:string;context:ReasoningPositionContext;mainLine?:RecordedMainLine;reviewGame?:boolean;reviewSubject?:ReviewSubject;omitSelectedContext?:boolean;playerPerspective?:PlayerPerspective|null;answerScope?:AnswerScope;positionPreparation?:boolean;classificationQuestion?:boolean}):InitialSearchPlan {
  const {question:q,context,mainLine}=input;
  const result:InitialSearchPlan={version:'initial-search-plan/1',requests:[],limitations:[]};
  const record=mainLine?recordedMainLineResult(mainLine,context):undefined;
  if(input.classificationQuestion && !input.omitSelectedContext && context.kind!=='position') {
    result.classificationReassessment=true;
    result.requests.push({tool:'explore_continuations',input:{phase:'before',depth:18,multiPv:3,minimumPvPlies:10},reason:'Reassess the selected move classification using a depth-18 unrestricted before-position search. Preserve the original decision and refresh the canonical label afterwards.'});
  }
  const names=[...q.matchAll(/(?<![A-Za-z0-9])(?:O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x?[a-h]?[1-8](?:=[QRBN])?)[+#]?(?![A-Za-z0-9])/g)].map(m=>normalize(m[0]));
  const alternative=/\b(better|instead|alternative|compare|rather)\b|\bwhat (?:if|about)\b|\b(?:could|should)\b.*\bplay\b/i.test(q);
  const negated=/\b(?:don't|do not|no need to|without)\b.*\b(?:compare|analy[sz]e|instead|alternative)\b/i.test(q);
  if(names.length && names.length<=6 && alternative && !negated){
    let fen:string|undefined,phase:'before'|'after'='before',ply:number|undefined,played:string|undefined;
    const numbered=[...q.matchAll(/\b(\d+)\s*(\.{1,3}|…)\s*(?=[KQRBNa-hO])/g)];
    const unboundNumber=/\b\d+\b/.test(q.replace(/\b(\d+)\s*(\.{1,3}|…)\s*(?=[KQRBNa-hO])/g,''));
    if(numbered.length && !unboundNumber && record && mainLine){
      const roots=numbered.map(m=>record.recordedMainLine.moves.flatMap((move,i)=>move.moveNumber===Number(m[1])&&move.color===(m[2]==='.'?'w':'b')?[i]:[]));
      if(roots.every(r=>r.length===1&&r[0]===roots[0][0])){ply=roots[0][0];fen=recordedPositionContext(mainLine,ply).fenAfter;played=mainLine.moves[ply]?.uci;}
    }else if(!numbered.length && !/\b\d+\b/.test(q) && !input.omitSelectedContext && !/\b(later|earlier|previous|opening|endgame|middlegame|move\s+\d+)\b/i.test(q)){
      phase=/\b(next|reply|respond)\b/i.test(q)?'after':'before';
      fen=phase==='after'?context.fenAfter:context.fenBefore;
      played=phase==='before'&&context.kind!=='position'?context.moveUci:undefined;
      // Without an explicit role cue, legal in both roots is genuinely ambiguous.
      const explicitRole=/\b(instead|alternative|rather|than|next|reply|respond)\b/i.test(q);
      if(!explicitRole && context.fenBefore!==context.fenAfter){const other=new Chess(context.fenAfter).moves().map(normalize);if(names.every(n=>other.includes(n)))fen=undefined;}
    }
    if(fen){
      const legal=new Chess(fen).moves({verbose:true});
      const resolved=names.map(n=>legal.filter(m=>normalize(m.san)===n));
      if(resolved.every(ms=>ms.length===1)){
        const roots=[...new Set([...resolved.map(ms=>uci(ms[0])),...(played?[played]:[])])];
        if(roots.length && roots.length<=6 && (!played||roots.some(r=>r!==played))){
          result.requests.push({tool:ply===undefined?'compare_moves':'analyze_game_position',input:{...(ply===undefined?{phase,movesUci:roots}:{ply,rootMoves:roots}),depth:18,minimumPvPlies:10},reason:'Explicit named legal alternatives at one resolved root; compare with the recorded/selected move when applicable.'});
          return result;
        }
      }
    }
    result.limitations.push('Named moves were not unambiguously resolved for automatic search; the model may choose the root and query.');
  }
  // The actual current-position assessment starts with the same unrestricted
  // search available to the answering model. Do not search unrelated board
  // state for general theory, omitted selections or retrospective reviews.
  if(input.positionPreparation!==false && !input.omitSelectedContext && !input.reviewGame
    && (input.answerScope==='position_analysis' || (!input.answerScope && context.kind==='position'))
    && !names.length) {
    try {
      const phase=context.kind==='position'?'before':'after';
      const fen=phase==='before'?context.fenBefore:context.fenAfter;
      if(!new Chess(fen).isGameOver())result.requests.push({tool:'explore_continuations',
        input:{phase,depth:18,multiPv:3,minimumPvPlies:24},
        reason:'Initial current-position candidates and continuations. Reuse this evidence and investigate additional relevant plans with the available tools; these returned moves are not exhaustive.'});
    } catch {result.limitations.push('Current-position preparation unavailable: invalid position.');}
    return result;
  }
  if(!record || !mainLine || !input.reviewGame || !input.omitSelectedContext)return result;
  if(names.length || /\b(?:endgame|middlegame|late|last|after|before)\b|\bmove\s+\d+/i.test(q)){result.limitations.push('Specific move or phase boundary requires model-directed investigation.');return result;}
  const subject=input.reviewSubject??'unspecified';
  const relative=subject==='self'||subject==='opponent';
  const playerSide=input.playerPerspective?.side;
  const side=subject==='white'||subject==='black'?subject:relative&&playerSide
    ?subject==='self'?playerSide:playerSide==='white'?'black':'white':undefined;
  result.reviewScope={subject,resolvedSide:side??(relative?'unknown':'both')};
  if(relative&&!side){result.limitations.push('Player side unknown; defer personal/opponent review preparation to the answering model.');return result;}
  const opening=/\bopening\b/i.test(q);
  if(opening && mainLine.startFen!==new Chess().fen()){result.limitations.push('Opening boundary unknown for a custom starting position.');return result;}
  if(opening)result.limitations.push('Preparation uses the first 12 full moves as an opening-review heuristic, not a claim that the opening ends there.');
  const eligible=record.recordedAnalysis.rows.filter(row=>{
    const move=record.recordedMainLine.moves[row[0]-1];
    return (!side||move.color===(side==='white'?'w':'b'))&&(!opening||move.moveNumber<=12);
  });
  // All major classifications qualify, including missed faster mates with zero cp loss.
  const rank=(row:typeof eligible[number])=>row[8]??(row[9]!==null&&row[10]!==null?Math.max(0,Math.abs(row[10])-Math.abs(row[9])):0);
  const ordered=(rows:typeof eligible)=>rows.sort((a,b)=>rank(b)-rank(a)||a[0]-b[0]);
  const major=ordered(eligible.filter(row=>['blunder','mistake','miss'].includes(row[5])));
  const optional=major.length<10?ordered(eligible.filter(row=>row[5]==='dubious')).slice(0,Math.min(5,10-major.length)):[];
  for(const row of [...major,...optional]) {
    const score=row[9]!==null||row[10]!==null?`mate before ${row[9]??'not found'}, mate after ${row[10]??'not found'}`:row[8]!==null?`saved search delta ${row[8]}cp`:'no comparable centipawn loss';
    result.requests.push({tool:'analyze_game_position',input:{ply:row[0]-1,multiPv:3,depth:18,minimumPvPlies:10},playedMove:mainLine.moves[row[0]-1].uci,reason:`Review candidate at recorded ply ${row[0]}: saved ${row[5]}, ${score} at depth ${row[2]}. Discover strongest alternatives and ensure a matched comparison with the played move; classification is historical.`});
  }
  if(!result.requests.length)result.limitations.push('No matching saved Blunder, Mistake, Miss or Dubious moves; model may investigate other useful moments.');
  return result;
}

/** Use the same recorded-position comparison tool the model uses. Discovery may
 * already include played+best at the same depth; otherwise compare explicitly. */
export function preparedMoveComparison(request:InitialSearch,evidence:ReasoningEvidenceRecord[]):InitialSearch|undefined {
  if(!request.playedMove || request.input.rootMoves) return;
  for(const record of evidence) {
    const data=record.data as Record<string,unknown>,details=data?.details as Record<string,unknown>|undefined;
    const lines=details?.lines as Array<{rootMove?:string;depth?:number}>|undefined;
    if(!Array.isArray(lines)||!lines.length)continue;
    const roots=lines.flatMap(l=>typeof l.rootMove==='string'?[l.rootMove]:[]);
    if(!roots.length)continue;
    const scope=details?.searchScope as Record<string,unknown>|undefined;
    if(roots.includes(request.playedMove)&&scope&&typeof scope.fen==='string'&&matchedRootComparison({...details,command:scope.command,cacheProvenance:scope.cacheProvenance,sourceCacheProvenance:scope.sourceCacheProvenance} as unknown as PositionAnalysisResult,scope.fen,roots).status==='matched')return;
    const rootMoves=[...new Set([roots[0],...roots.slice(1,3),request.playedMove])];
    return {tool:'analyze_game_position',input:{ply:request.input.ply,rootMoves,depth:18,minimumPvPlies:10},reason:`Matched comparison of played ${request.playedMove} and discovered strongest alternatives at recorded root ${request.input.ply}. Use these within-search differences for relative move claims.`};
  }
}
