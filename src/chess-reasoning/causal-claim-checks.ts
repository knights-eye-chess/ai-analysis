import { Chess, type Square } from 'chess.js';
import { historicalProseRoots, type RecordedReferenceLine } from './historical-prose';
import { simpleProseReferences } from './simple-prose-references';
import type { ReasoningEvidenceRecord, ReasoningPositionContext } from './poc-contracts';

export type CausalClaimCheck = {
  claim: string;
  /** Half-open UTF-16 offsets into the final reference-repaired answer. */
  claimRange: { start: number; end: number };
  sentenceContext: { text: string; start: number; end: number };
  reference: string;
  predicate: 'moving-piece-escape' | 'stationary-slider-ray' | 'square-control-release';
  verdict: 'supported' | 'contradicted' | 'unresolved';
  reason: string;
};

const names: Record<string, string> = { rook: 'r', bishop: 'b', queen: 'q', knight: 'n', pawn: 'p', king: 'k' };
const uci = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const pieceBinding = /\b(the|a|white(?:'s|’s)?|black(?:'s|’s)?|your)\s+(rook|bishop|queen|knight|pawn|king)\s+(?:on|at)\s+([a-h][1-8])\b/i;
const compactBinding = /\b([RBQNKP])([a-h][1-8])\b/;

/** Mask markup punctuation without changing string offsets (including surrogate pairs). */
function sentenceRanges(answer: string) {
  const masked = answer.replace(/\[[^\]\n]+\]\([^\n)]*\)/g, text => ' '.repeat(text.length))
    .replace(/\b\d+\.(?:\.\.)?/g, text => ' '.repeat(text.length));
  const ranges: Array<{start:number;end:number}> = [];
  let start = 0;
  for (const boundary of masked.matchAll(/[.!?](?:[”"’']?)(?=\s|$)|\n+/g)) {
    const end = boundary.index + boundary[0].length;
    ranges.push({start,end});
    start = end;
  }
  ranges.push({start,end:answer.length});
  return ranges;
}

function trimRange(answer:string, start:number, end:number) {
  while(start<end && /\s/.test(answer[start])) start++;
  while(end>start && /\s/.test(answer[end-1])) end--;
  return {start,end};
}

function binding(clause: string): {type:string;at:Square;color?:'w'|'b'}|null {
  const all=[...clause.matchAll(new RegExp(pieceBinding.source,'gi'))];
  const compact=[...clause.matchAll(new RegExp(compactBinding.source,'g'))];
  const identities=[...all.map(match=>`${names[match[2].toLowerCase()]}:${match[3]}`),
    ...compact.map(match=>`${match[1].toLowerCase()}:${match[2]}`)];
  if(new Set(identities).size>1)return null;
  const named=clause.match(pieceBinding);
  if(named) return {type:names[named[2].toLowerCase()],at:named[3] as Square,
    color:/^white/i.test(named[1])?'w':/^black/i.test(named[1])?'b':undefined};
  return compact[0] ? {type:compact[0][1].toLowerCase(),at:compact[0][2] as Square} : null;
}

function direction(from:Square,to:Square):[number,number]|null {
  const dx=to.charCodeAt(0)-from.charCodeAt(0),dy=Number(to[1])-Number(from[1]);
  if(!dx && !dy || dx && dy && Math.abs(dx)!==Math.abs(dy))return null;
  return [Math.sign(dx),Math.sign(dy)];
}

function ray(board:Chess,from:Square,to:Square):boolean {
  const d=direction(from,to);
  if(!d)return false;
  let file=from.charCodeAt(0)+d[0],rank=Number(from[1])+d[1];
  while(file!==to.charCodeAt(0)||rank!==Number(to[1])) {
    if(board.get(`${String.fromCharCode(file)}${rank}` as Square))return false;
    file+=d[0];rank+=d[1];
  }
  return true;
}

function parseTarget(target:string, historical:ReturnType<typeof historicalProseRoots>, label:string,
  context:ReasoningPositionContext, records:readonly ReasoningEvidenceRecord[],recordedLine?:RecordedReferenceLine) {
  const match=/^game:(0|[1-9]\d*):([a-h1-8qrbn,]+)$/.exec(target);
  if(!match)return null;
  const root=historical.roots.get(Number(match[1]));
  if(!root)return null;
  const path=match[2].split(',');
  if(!path.length||path.length>32||path.some(move=>!uci.test(move)))return null;
  try {
    const before=new Chess(root.context.fenAfter);
    const start=new Chess(before.fen());
    let san='';
    for(const move of path) {
      const actual=before.move({from:move.slice(0,2),to:move.slice(2,4),promotion:move[4]});
      if(actual.from+actual.to+(actual.promotion??'')!==move) return null;
      san=actual.san;
    }
    const last=path.at(-1)!;
    // A recorded path must reproduce the frozen record, not merely be legal.
    const recorded=historical.recorded?.slice(Number(match[1]),Number(match[1])+path.length);
    if(recorded?.length===path.length && recorded.every((move,i)=>move===path[i])) {
      // witnessed recorded path
    } else if(!root.records.length || simpleProseReferences(`[${label}](${target})`,context,records,recordedLine).coverage.resolved!==1) return null;
    // Only single-move links have unambiguous move-local prose binding here.
    if(path.length!==1)return { ambiguous:true as const };
    const fields=start.fen().split(' ');
    const notation=label.trim().match(/^(?:(\d+)\s*(\.{1,3}|…)\s*)?([^\s]+)$/);
    if(!notation||notation[3].replace(/[!?]+$/,'')!==san
      || notation[1] && (Number(notation[1])!==Number(fields[5])||(notation[2]==='.'?'w':'b')!==fields[1])) return null;
    return {ambiguous:false as const,before:start,after:before,from:last.slice(0,2) as Square,to:last.slice(2,4) as Square};
  }catch{return null;}
}

/** Bounded geometry diagnostics only. No answer modification, strategic judgment or intent inference. */
export function checkCausalClaims(answer:string,context:ReasoningPositionContext,
  records:readonly ReasoningEvidenceRecord[],recordedLine?:RecordedReferenceLine):CausalClaimCheck[] {
  const historical=historicalProseRoots(context,records,recordedLine);
  const output:CausalClaimCheck[]=[];
  const sentences=sentenceRanges(answer);
  const links=[...answer.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)];
  let sentenceIndex=0;
  for(const [linkIndex,match] of links.entries()) {
    const [full,label,reference]=match;
    if(!reference.startsWith('game:'))continue;
    const index=match.index;
    while(sentences[sentenceIndex].end<=index && sentenceIndex<sentences.length-1)sentenceIndex++;
    const sentence=trimRange(answer,sentences[sentenceIndex].start,sentences[sentenceIndex].end);
    const previous=links[linkIndex-1],next=links[linkIndex+1];
    // Neighbouring links cannot lend their piece binding to this move.
    const claimRange=trimRange(answer,Math.max(sentence.start,previous?previous.index+previous[0].length:0),
      Math.min(sentence.end,next?.index??answer.length));
    const left=answer.slice(claimRange.start,index).replace(/[*_`]/g,'');
    const right=answer.slice(index+full.length,claimRange.end).replace(/[*_`]/g,'');
    // The SAN label names the move, not a second piece in the explanatory prose.
    const clause=`${left} ${right}`.trim();
    // Readable context is complete, but predicate recognition stays local.
    // Longer sentences must not attach a later subject's action to this move.
    const local=right.slice(0,90);
    const escape=/\b(?:escap(?:e|ed|es|ing)|fle(?:e|d)|evad(?:e|ed|es|ing))\b/i.test(local)
      || /\bmoved?\s+out\s+of\s+attack\b/i.test(local)
      || /\b(?:escap(?:e|ed|es|ing)|fle(?:e|d)|evad(?:e|ed|es|ing))\s+(?:with|by|on)\s*$/i.test(left);
    const presentAttack=/\b(?:escap(?:e|ed|es|ing)|fle(?:e|d)|evad(?:e|ed|es|ing))\s+(?:from\s+)?(?:(?:the|an?)\s+)?(?:(?:rook|bishop|queen|knight|pawn|king)['’]s\s+)?attack\b/i.test(local)
      || /\bmoved?\s+out\s+of\s+attack\b/i.test(local);
    const targets=[...local.matchAll(/\b(?:toward(?:s)?|to|along)\s+([a-h][1-8])\b/gi)];
    const slider=/\b(?:open(?:s|ed|ing)?|clear(?:s|ed|ing)?|block(?:s|ed|ing)?|clos(?:e|es|ed|ing))\b/i.exec(local);
    const competingSliderVerbs=[...local.matchAll(/\b(?:open(?:s|ed|ing)?|clear(?:s|ed|ing)?|block(?:s|ed|ing)?|clos(?:e|es|ed|ing))\b/gi)];
    const release=/\b(?:releas(?:e|es|ed|ing)|los(?:e|es|t|ing)|no longer controls?)\s+(?:control\s+(?:of|over)\s+)?([a-h][1-8])\b/i.exec(local);
    if(!escape&&!slider&& !release)continue;
    let parsedReady=false,parsedValue:ReturnType<typeof parseTarget>;
    const parsed=()=>{
      if(!parsedReady){parsedValue=parseTarget(reference,historical,label,context,records,recordedLine);parsedReady=true;}
      return parsedValue;
    };
    const negated=/\b(?:not|never|didn't|did not|doesn't|does not)\b/i.test(clause);
    const strategicConclusion=/\b(?:force(?:d|s)?|mate|tempo|wins?|winning)\b/i.test(clause);
    const result=(predicate:CausalClaimCheck['predicate'],verdict:CausalClaimCheck['verdict'],reason:string)=>
      output.push({claim:answer.slice(claimRange.start,claimRange.end),claimRange,
        sentenceContext:{...sentence,text:answer.slice(sentence.start,sentence.end)},reference,predicate,
        verdict:negated||strategicConclusion?'unresolved':verdict,
        reason:negated?'Negated mechanism wording is outside this narrow check.'
          :strategicConclusion?'This clause mixes geometry with a forcing, mating, winning or tempo claim.':reason});
    if(escape) {
      let bound=binding(clause);
      const directEscape=/^\s*[,;:]?\s*(?:both\s+)?(?:escapes?|escaped|evades?|evaded|flees?|fled|moves?\s+out\s+of\s+attack)\b/i.test(local);
      // Only a direct finite verb with a neutral lead-in licenses the move as
      // grammatical subject. This is not general pronoun or noun resolution.
      const moveSubject=/^\s*(?:(?:instead|however|then|here|but|and|now)[,:]?\s*)?$/i.test(left)
        && directEscape;
      if(!bound && moveSubject && !pieceBinding.test(clause) && !compactBinding.test(clause)) {
        const move=parsed();
        if(move && !move.ambiguous) {
          const mover=move.before.get(move.from);
          if(mover)bound={type:mover.type,at:move.from,color:mover.color};
        }
      }
      // A condition before another link can still qualify this whole sentence.
      const futureOrConditional=/\b(?:if|unless|future|potential|possible|could|might|may|would|will|later|threat|threatened|threatening|preemptive|anticipat(?:e|ed|ing))\b/i
        .test(answer.slice(sentence.start,sentence.end));
      if(!directEscape||!presentAttack||futureOrConditional)result('moving-piece-escape','unresolved','Escape wording does not unambiguously assert a present attack on the moving piece.');
      else if(!bound)result('moving-piece-escape','unresolved','Move or moving piece is not uniquely bound to a witnessed single move and square.');
      else {
        const move=parsed();
        if(!move||move.ambiguous)result('moving-piece-escape','unresolved','Move is not uniquely bound to a witnessed single ply.');
        else {
        const mover=move.before.get(move.from);
        if(!mover||bound.at!==move.from||bound.type!==mover.type||bound.color&&bound.color!==mover.color)result('moving-piece-escape','unresolved','Named piece does not identify the moving piece at the referenced ply.');
        else {
          const attacked=move.before.attackers(move.from,mover.color==='w'?'b':'w').length>0;
          const stillAttacked=move.after.attackers(move.to,mover.color==='w'?'b':'w').length>0;
          const attackerType=/\b(rook|bishop|queen|knight|pawn|king)['’]s\s+attack\b/i.exec(local)?.[1]?.toLowerCase();
          if(attackerType && !move.before.attackers(move.from,mover.color==='w'?'b':'w')
            .some(square=>move.before.get(square)?.type===names[attackerType])) {
            result('moving-piece-escape','unresolved','The named kind of attacker is not established on the starting square.');
            continue;
          }
          result('moving-piece-escape',!attacked?'contradicted':stillAttacked?'unresolved':'supported',!attacked
            ?'The moving piece was not geometrically attacked on its starting square.'
            :stillAttacked?'The piece was attacked on both squares; whether this was an escape is not established.'
              :'The moving piece left an attacked square for a geometrically unattacked square; safety or necessity is not established.');
        }
        }
      }
    }
    // Opening a file or keeping the center closed describes a wider structure,
    // not necessarily a ray from a stationary slider. Enter this predicate only
    // when prose explicitly names both the piece and a target square.
    const explicitSliderRay=slider && targets.length>0 &&
      (pieceBinding.test(clause)||compactBinding.test(clause));
    if(explicitSliderRay) {
      const bound=binding(clause),wantOpen=/^(?:open|clear)/i.test(slider[0]);
      if(!bound||targets.length!==1||competingSliderVerbs.length!==1)
        result('stationary-slider-ray','unresolved','Slider, target ray, causal clause or referenced move is ambiguous.');
      else {
        const move=parsed();
        if(!move||move.ambiguous) {
          result('stationary-slider-ray','unresolved','Referenced move is not a witnessed single ply.');
          continue;
        }
        const target=targets[0];
        const piece=move.before.get(bound.at),same=move.after.get(bound.at);
        const d=direction(bound.at,target[1] as Square);
        const namedAxis=new RegExp(`\\b(diagonal|rank|file)\\s+(?:toward(?:s)?|to|along)\\s+${target[1]}\\b`,'i').exec(local)?.[1]?.toLowerCase();
        const axis=d ? d[0]&&d[1]?'diagonal':d[0]?'rank':'file' : null;
        const valid=piece&&same&&piece.type===bound.type&&same.type===piece.type&&same.color===piece.color&&(!bound.color||bound.color===piece.color)
          && (piece.type==='q'||piece.type==='r'&&d&&(!d[0]||!d[1])||piece.type==='b'&&d&&!!d[0]&&!!d[1]);
        if(piece&&same&&piece.type===bound.type&&same.type===piece.type&&same.color===piece.color&&(!bound.color||bound.color===piece.color)&&(!d||namedAxis&&namedAxis!==axis))
          result('stationary-slider-ray','contradicted','The named target is not on the claimed ray from the stationary piece.');
        else if(!valid)result('stationary-slider-ray','unresolved','The named stationary slider or its geometric ray is not established at this ply.');
        else {
          const previous=ray(move.before,bound.at,target[1] as Square),next=ray(move.after,bound.at,target[1] as Square);
          const changed=wantOpen?!previous&&next:previous&&!next;
          result('stationary-slider-ray',changed?'supported':'contradicted',
            `The named ray was ${previous?'clear':'blocked'} before and ${next?'clear':'blocked'} after the move; this checks geometry only.`);
        }
      }
    }
    // Explicit source piece and target square only. A bare 'releases g4' has no controller.
    if(release) {
      const bound=binding(clause),target=release[1] as Square;
      if(!bound)result('square-control-release','unresolved','Controlling piece or referenced ply is ambiguous.');
      else {
        const move=parsed();
        if(!move||move.ambiguous) {
          result('square-control-release','unresolved','Referenced move is not a witnessed single ply.');
          continue;
        }
        const piece=move.before.get(bound.at);
        if(!piece||piece.type!==bound.type||bound.color&&bound.color!==piece.color)result('square-control-release','unresolved','Named controller is not on its stated square before the move.');
        else {
          const prior=move.before.attackers(target,piece.color).includes(bound.at);
          const finalSquare=bound.at===move.from?move.to:bound.at;
          const nextPiece=move.after.get(finalSquare);
          if(!nextPiece||nextPiece.color!==piece.color||nextPiece.type!==piece.type)
            result('square-control-release','unresolved','The named controller cannot be tracked across this move.');
          else {
            const current=move.after.attackers(target,piece.color).includes(finalSquare);
            result('square-control-release',prior&&!current?'supported':'contradicted',
              `The named piece ${prior?'controlled':'did not control'} ${target} before and ${current?'controls':'does not control'} it after the move.`);
          }
        }
      }
    }
  }
  return output;
}
