import { presentMoveMechanisms } from './mechanism-presentation';
import {Chess, type Square} from 'chess.js';
import {reasoningContextHash,type ReasoningEvidenceRecord,type ReasoningPositionContext} from './poc-contracts';
const names:Record<string,string>={p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
const play=(b:Chess,u:string)=>b.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u.slice(4)||undefined});
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export const EXPLANATION_FAMILIES=['accept-offer','central-break','kingside-play','queenside-play','exchange-defender','preserve-piece','direct-tactics','quiet-improvement'] as const;
export const EXPLANATION_REVIEW_SCHEMA:Record<string,unknown>={type:'object',additionalProperties:false,required:['mode','mechanism','challenges','evidenceIds','unresolved'],properties:{
 mode:{type:'string',enum:['positional','tactical','direct','not-explanation']},
 mechanism:{type:'string',maxLength:1200},
 challenges:{type:'array',maxItems:6,items:{type:'string',maxLength:300}},
 evidenceIds:{type:'array',maxItems:8,items:{type:'string',maxLength:300}},
 unresolved:{type:'array',maxItems:6,items:{type:'string',maxLength:300},description:'Concrete unanswered causal questions material to this answer, not generic bounded-search or uniqueness limits.'},
 limitations:{type:'array',maxItems:6,items:{type:'string',maxLength:300},description:'Scope limits to disclose without blocking completion, such as non-exhaustive ranking or no proof of permanent control.'},
 shortLineReasons:{type:'array',maxItems:6,items:{type:'string',maxLength:300},description:'Deprecated compatibility field; omit. Continuation length is reported by the engine tool and never requires a review justification.'},
}};
export type ExplanationReview={mode:'positional'|'tactical'|'direct'|'not-explanation';mechanism:string;challenges:string[];evidenceIds:string[];unresolved:string[];limitations?:string[];shortLineReasons?:string[]};
export function validateExplanationReview(input:Record<string,unknown>,context:ReasoningPositionContext,known:Map<string,ReasoningEvidenceRecord>):ExplanationReview{
 const fail=(code:string,field:string,expected:string,choices?:string[]):never=>{
  throw Object.assign(new Error(`${field}: ${expected}`),{code,field,expected,...(choices?{choices:choices.slice(0,32)}:{})});
 };
 const modes=['positional','tactical','direct','not-explanation'];
 if(typeof input.mode!=='string'||!modes.includes(input.mode))fail('invalid-explanation-review','mode','Choose one of the supported review modes.',modes);
 if(typeof input.mechanism!=='string'||input.mechanism.length>1200)fail('invalid-explanation-review','mechanism','Use a string of at most 1200 characters.');
 for(const [key,max]of [['challenges',6],['evidenceIds',8],['unresolved',6],['limitations',6]] as const){
  if(key==='limitations'&&input[key]===undefined)continue;
  const value=input[key];
  if(!Array.isArray(value)||value.length>max)fail('invalid-explanation-'+key,key,`Use an array of at most ${max} strings.`);
  (value as unknown[]).forEach((x,i)=>{if(typeof x!=='string'||x.length>300)fail('invalid-explanation-'+key,`${key}[${i}]`,'Use a string of at most 300 characters.');});
 }
 const legal=new Set(new Chess(context.fenAfter).moves({verbose:true}).map(m=>m.from+m.to+(m.promotion||'')));
 for(const [i,entry] of (input.challenges as string[]).entries()){
  const [family,uci,...rest]=entry.split('|');
  if(rest.length||!family.trim()||!legal.has(uci))fail('invalid-explanation-challenge',`challenges[${i}]`,'Use a descriptive family label followed by | and a legal UCI reply from the actual after-position.',[...legal]);
 }
 const unknown=(input.evidenceIds as string[]).filter(id=>!known.has(id));
 if(unknown.length)fail('unknown-explanation-evidence','evidenceIds',`Unknown evidence IDs: ${unknown.join(', ')}. Use acquired evidence IDs.`,[...known.keys()]);
 const normalized:Record<string,unknown> = { ...input,
  challenges:[...new Set(input.challenges as string[])],
  evidenceIds:[...new Set(input.evidenceIds as string[])],
 };
 delete normalized.shortLineReasons;
 return normalized as unknown as ExplanationReview;
}
// Retain the longest verified continuation per actual opponent root. Never count
// synthetic pass leads or separate before-position candidate alternatives.
export function explanationBranches(context:ReasoningPositionContext,records:Iterable<ReasoningEvidenceRecord>){
 const roots=new Map<string,{root:string;id:string;pv:string[];san:string[];depth:number;score:unknown;prefixLength:number;prefixEvidenceId:string|null;pvCompletion:unknown;rawPv:unknown;continuationCovered:boolean;unmetHorizonRequests:{evidenceId:string;requested:number;prefixLength:number}[]}>();
 const hash=reasoningContextHash(context),all=[...records];
 // Root searches first; conditional endpoint searches may extend only an already
 // acquired engine prefix, or start after exactly one selected opponent move.
 for(const pass of [0,1])for(const e of all){if(e.kind!=='probe'||e.contextHash!==hash)continue;const d=obj(e.data);if(d.phase!=='after'||!Array.isArray(d.lines)||d.authority!=='bounded-engine'||!e.licenses?.some(x=>x==='engine.bounded-score'||x==='engine.bounded-comparison'))continue;
 const prefix=Array.isArray(d.played)?d.played.map((x:{uci:string})=>x.uci):[];
 if((prefix.length?1:0)!==pass)continue;
 const prior=prefix.length?roots.get(prefix[0]):undefined;
 const licensedPrefix=prior&&prefix.every((u:string,i:number)=>prior.pv[i]===u);
 if(prefix.length>1&&!licensedPrefix)continue;
 const expected=new Chess(context.fenAfter);try{for(const u of prefix)play(expected,u)}catch{continue}
 if(e.replay?.fen!==expected.fen())continue;
 for(const line of d.lines){if(!Array.isArray(line.pv)||!line.pv.length||line.rootMove!==line.pv[0])continue;
 const pv=[...prefix,...line.pv];const board=new Chess(context.fenAfter);let san:string[];
 try{san=pv.map(u=>play(board,u).san)}catch{continue}
 const continuationCovered=(!e.coverage?.unresolved.includes(line.rootMove)) && (line.pv.length>=Number(d.minimumPvPlies||obj(d.searchScope).minimumPvPlies||1)||board.isCheckmate()||board.isStalemate());
 const old=roots.get(pv[0]);const unmetHorizonRequests=[...(old?.unmetHorizonRequests||[])];
 if(!continuationCovered&&!unmetHorizonRequests.some(r=>r.evidenceId===e.id))unmetHorizonRequests.push({evidenceId:e.id,requested:Number(d.minimumPvPlies||obj(d.searchScope).minimumPvPlies||1),prefixLength:prefix.length});
 if(!old||pv.length>=old.pv.length)roots.set(pv[0],{root:pv[0],id:e.id,pv,san,depth:line.depth,continuationCovered,unmetHorizonRequests,prefixLength:prefix.length,prefixEvidenceId:licensedPrefix?prior!.id:null,pvCompletion:line.pvCompletion??null,rawPv:line.rawPv??null,score:{scoreCp:line.scoreCp,matePly:line.matePly,scoreScope:line.scoreScope,scope:d.searchScope,evaluatedFromPly:prefix.length}});else old.unmetHorizonRequests=unmetHorizonRequests;
 }}return [...roots.values()];
}
export function legalInvestigationRoots(context:ReasoningPositionContext){
 return Object.fromEntries(['before','after'].map(phase=>[phase,new Chess(phase==='before'?context.fenBefore:context.fenAfter).moves({verbose:true}).map(m=>({uci:m.from+m.to+(m.promotion||''),san:m.san}))]));
}
function structureAfterCaptures(context:ReasoningPositionContext,pv:string[]){
 const b=new Chess(context.fenAfter),events:unknown[]=[];
 pv.forEach((u,i)=>{const m=play(b,u);if(!m.captured||events.length>=4)return;
 const pieces=b.board().flat().filter(p=>p!==null);
 const bishops=pieces.filter(p=>p!.type==='b').map(p=>({color:p!.color,square:p!.square,squareColor:b.squareColor(p!.square)}));
 events.push({ply:i+1,move:m.san,...(m.piece==='p'?{pawnTransformation:{color:m.color,from:m.from,to:m.to}}:{}),capturedPiece:names[m.captured],remainingBishops:bishops,openFiles:'abcdefgh'.split('').filter(f=>!pieces.some(p=>p!.type==='p'&&p!.square[0]===f)),scope:'exact position after this conditional capture; open file is not proof of productive rook access'});
 });return events;
}
export function explanationSummary(context:ReasoningPositionContext,records:Iterable<ReasoningEvidenceRecord>){
 const branches=explanationBranches(context,records);const owner=new Chess(context.fenBefore).turn();
 const motifs=new Map<string,{piece:string;start:string;destination:string;roots:string[];witnesses:unknown[]}>();
 for(const branch of branches){const board=new Chess(context.fenAfter),ids=new Map<string,string>();
 for(const row of board.board())for(const p of row)if(p)ids.set(p.square,p.square);
 const paths=new Map<string,string[]>();
 branch.pv.forEach((u,index)=>{const from=u.slice(0,2),to=u.slice(2,4),id=ids.get(from)||from;const m=play(board,u);ids.delete(from);ids.set(to,id);if(m.flags.includes('e'))ids.delete(to[0]+from[1]);
 if(m.flags.includes('k')||m.flags.includes('q')){const rfrom=(m.flags.includes('k')?'h':'a')+from[1],rto=(m.flags.includes('k')?'f':'d')+from[1];const rid=ids.get(rfrom);ids.delete(rfrom);if(rid)ids.set(rto,rid)}
 const path=paths.get(id)||[from];path.push(to);paths.set(id,path);
 if(m.color!==owner||m.piece==='p'||m.piece==='k')return;
 const key=id+':'+to;let motif=motifs.get(key);if(!motif){motif={piece:names[m.piece],start:id,destination:to,roots:[],witnesses:[]};motifs.set(key,motif)}
 if(motif.roots.includes(branch.root))return;motif.roots.push(branch.root);
 const pawns=board.board().flat().filter(p=>p?.type==='p');
 const attackers=(color:string)=>pawns.filter(p=>p?.color===color&&Math.abs(p.square.charCodeAt(0)-to.charCodeAt(0))===1&&Number(to[1])-Number(p.square[1])===(color==='w'?1:-1)).map(p=>p!.square);
 const enemy=owner==='w'?'b':'w';const front=to[0]+String(Number(to[1])+(enemy==='w'?-1:1));const blocked=board.get(front as Square);
 motif.witnesses.push({root:branch.root,evidenceId:branch.id,ply:index+1,route:path.join('-'),pawnDefenders:attackers(owner),opponentPawnAttackers:attackers(enemy),...(blocked?.type==='p'&&blocked.color===enemy?{opponentPawnDirectlyBehind:front}:{}),scope:'geometry at arrival only; exchanges and future pawn changes remain possible'});
 });}
 return {authority:'heuristic summary of legally replayed bounded engine lines; recurrence is not causality or force',branches:branches.map(b=>({root:b.root,evidenceId:b.id,plies:b.pv.length,depth:b.depth,continuationCoverage:b.continuationCovered?'selected-record-horizon-covered':'short-or-unresolved',unmetHorizonRequests:b.unmetHorizonRequests,prefixLength:b.prefixLength,prefixEvidenceId:b.prefixEvidenceId,pvCompletion:b.pvCompletion,rawPv:b.rawPv,san:b.san.join(' '),score:b.score,structuralEvents:structureAfterCaptures(context,b.pv)})),observedRoutes:[...motifs.values()].filter(m=>m.roots.length>=2).sort((a,b)=>b.roots.length-a.roots.length).slice(0,24),distinctOpponentRoots:branches.length};
}
export function explanationCoverage(context:ReasoningPositionContext,records:Iterable<ReasoningEvidenceRecord>,review:ExplanationReview|null){
 const branches=explanationBranches(context,records),searched=new Set(branches.map(b=>b.root));const unresolved:string[]=[];
 if(!review)return {status:'unreviewed',unresolved:[],investigated:[],modelJudgment:null,limitation:'Review is optional; absence of a review does not imply evidence is sufficient or insufficient.'};
 const investigated=review.challenges.filter(c=>searched.has(c.split('|')[1]));
 if(review.mode!=='not-explanation'){
  if(!review.mechanism.trim())unresolved.push('causal-mechanism');
  if(!review.evidenceIds.length)unresolved.push('mechanism-support');
  unresolved.push(...review.unresolved);
  if(review.mode==='positional'&&!new Chess(context.fenAfter).isGameOver()){
   for(const c of review.challenges){if(!investigated.includes(c))unresolved.push('unsearched:'+c);}
  }
 }
 return {status:unresolved.length?'unresolved':'reviewed-for-current-answer',unresolved:[...new Set(unresolved)],investigated,modelJudgment:review,limitation:'Model-selected families and causal interpretation are not independently proven; root acquisition is checked. Coverage is advisory, not a proof of explanation correctness or a completion gate.'};
}
/** Remove only expensive per-ply geometry from planning copies; original evidence stays in known. */
export function planningEvidence(result:{contextHash:string;evidence:ReasoningEvidenceRecord[];limitations:readonly string[]}){
 return {...result,evidence:result.evidence.map(e=>{const d=obj(e.data);if(!Array.isArray(d.lines))return e;const {continuationMoveFacts,rootMoveFacts,...data}=d;void rootMoveFacts;
 const lines=d.lines.map((line:Record<string,unknown>)=>{if(!Array.isArray(line.pv))return line;const board=new Chess(String(e.replay!.fen));let san:string[]=[];try{san=line.pv.map((u:string)=>play(board,u).san)}catch{return line}const continuation=obj(Array.isArray(continuationMoveFacts)?continuationMoveFacts.find((f:unknown)=>obj(f).rootMove===line.rootMove):undefined);const mechanismFacts=continuation&&Array.isArray(continuation.moves)?presentMoveMechanisms(continuation.moves):[];return {...line,san:san.join(' '),...(mechanismFacts.length?{mechanismFacts}:{})}});
 return {...e,data:{...data,lines,planningProjection:{omitted:['continuationMoveFacts','rootMoveFacts'],retrieveFullEvidenceId:e.id,limitation:'First-two-ply mechanism measurements retained; deeper/full exact geometry remains retrievable; no strategic concept proven by this projection.'}}} as ReasoningEvidenceRecord;})};
}
