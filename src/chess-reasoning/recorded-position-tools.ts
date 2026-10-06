import { Chess } from 'chess.js';
import type { RecordedMainLine } from './answer-host-contracts';
import { recordedMainLineResult } from './recorded-main-line';
import { createPocToolHost, type PocToolHostOptions } from './poc-tools';
import { reasoningContextHash, type ReasoningPositionContext, type ReasoningToolDescriptor, type ReasoningToolSet, type ReasoningToolResult } from './poc-contracts';
import { stableHash } from './stable';

export const RECORDED_POSITION_TOOLS = ['analyze_game_position', 'test_game_line'] as const;
export const isRecordedPositionTool = (name: string) => (RECORDED_POSITION_TOOLS as readonly string[]).includes(name);
const moves = { type:'array', maxItems:32, items:{type:'string',maxLength:5,pattern:'^[a-h][1-8][a-h][1-8][qrbn]?$'} };
const common = { ply:{type:'integer',minimum:0,maximum:512}, depth:{type:'integer',minimum:18,maximum:18}, minimumPvPlies:{type:'integer',minimum:1,maximum:32} };
export const RECORDED_POSITION_DESCRIPTORS: ReasoningToolDescriptor[] = [
  {name:'analyze_game_position',category:'probe',description:'analyze_game_position',inputSchema:{type:'object',additionalProperties:false,required:['ply'],properties:{...common,rootMoves:{...moves,minItems:1,maxItems:6},multiPv:{type:'integer',minimum:1,maximum:3}}}},
  {name:'test_game_line',category:'probe',description:'test_game_line',inputSchema:{type:'object',additionalProperties:false,required:['ply','movesUci'],properties:{...common,movesUci:{...moves,minItems:1},analyzeFinal:{type:'boolean'},compareFinalMovesUci:{...moves,minItems:1,maxItems:6},inspectPlies:{type:'array',maxItems:8,items:{type:'integer',minimum:1,maximum:32}},inspectSquares:{type:'array',maxItems:12,items:{type:'string',maxLength:2,pattern:'^[a-h][1-8]$'}}}}},
];

/** No caller supplied FEN. Every root is an exact occurrence in the frozen record. */
export function recordedPositionContext(line: RecordedMainLine, ply: number): ReasoningPositionContext {
  if (!Number.isInteger(ply) || ply < 0 || ply > line.moves.length) throw Object.assign(Error(`ply must be between 0 and ${line.moves.length}; 0 is the initial position`),{code:'invalid-recorded-ply',field:'ply',expected:`integer 0..${line.moves.length}`});
  const chess=new Chess(line.startFen), prefix=line.moves.slice(0,ply);
  let before=chess.fen();
  for(const item of prefix){before=chess.fen(); const m=chess.move({from:item.uci.slice(0,2),to:item.uci.slice(2,4),promotion:item.uci.slice(4)||undefined}); if(m.san!==item.san)throw Error('recorded-SAN-mismatch');}
  const id=`recorded:${stableHash({startFen:line.startFen,moves:line.moves.map(m=>m.uci)})}:${ply}`;
  return ply===0 ? {kind:'position',nodeId:id,historyStartFen:line.startFen,historyUci:[],fenBefore:chess.fen(),fenAfter:chess.fen(),moveUci:'',moveSan:''}
    : {nodeId:id,historyStartFen:line.startFen,historyUci:prefix.slice(0,-1).map(m=>m.uci),fenBefore:before,fenAfter:chess.fen(),moveUci:prefix.at(-1)!.uci,moveSan:prefix.at(-1)!.san};
}

export function withRecordedPositionTools(selected: ReasoningPositionContext, base: ReasoningToolSet, options: PocToolHostOptions, getLine: (signal?:AbortSignal)=>Promise<RecordedMainLine>): ReasoningToolSet {
  const hash=reasoningContextHash(selected);
  let frozen: RecordedMainLine | undefined;
  return {
    reservesSearchAtDispatch:true,
    descriptors:()=>[...base.descriptors(),...RECORDED_POSITION_DESCRIPTORS],
    seedEvidence:records=>base.seedEvidence?.(records),
    async execute(name,args,signal,execution){
      if(!isRecordedPositionTool(name))return base.execute(name,args,signal,execution);
      signal?.throwIfAborted();
      if(args.contextHash!==hash || typeof args.callId!=='string')throw Error('stale-recorded-tool-envelope');
      if(!frozen){const line=structuredClone(await getLine(signal));recordedMainLineResult(line,selected);frozen=line;}
      signal?.throwIfAborted();
      const root=recordedPositionContext(frozen,Number(args.ply)), rootHash=reasoningContextHash(root);
      // Never carry a selected-edge leading alternative into another root.
      const host=createPocToolHost(root,{...options,leadingAlternative:undefined});
      const board=new Chess(root.fenAfter);
      const tool=name==='test_game_line'?'test_line':args.rootMoves?'compare_moves':board.isCheckmate()||board.isStalemate()?'inspect_position':'explore_continuations';
      const request={contextHash:rootHash,callId:args.callId,phase:'after',depth:args.depth??18,minimumPvPlies:args.minimumPvPlies??10,
        ...(tool==='test_line'?{movesUci:args.movesUci,analyzeFinal:args.analyzeFinal,compareFinalMovesUci:args.compareFinalMovesUci,inspectSquares:args.inspectSquares,inspectPlies:args.inspectPlies}:tool==='compare_moves'?{movesUci:args.rootMoves}:{multiPv:args.multiPv??3})};
      const result=await host.execute(tool,request,signal,execution);
      const recordedPosition={recordHash:stableHash({startFen:frozen.startFen,moves:frozen.moves.map(m=>m.uci)}),ply:Number(args.ply),startFen:frozen.startFen,fen:root.fenAfter,historyUci:frozen.moves.slice(0,Number(args.ply)).map(m=>m.uci),rootContextHash:rootHash,
        nextRecordedMove:frozen.moves[Number(args.ply)]?.san??null,scope:'position after exactly ply recorded half-moves; independent of board selection'};
      return {...result,tool:name,contextHash:hash,data:{recordedPosition,details:result.data},
        evidence:result.evidence.map(e=>({...e,id:`evidence:game:${hash}:${rootHash}:${e.id.replaceAll(':','-')}`,contextHash:hash,data:{recordedPosition,details:e.data}})),
        limitations:[...result.limitations,'Historical root: phases and piece identities inside details refer only to recordedPosition. Use game:PLY:uci,uci links for this exact recorded ply and witnessed local path; selected before/after links cannot address this root.']} satisfies ReasoningToolResult;
    },
  };
}

/** Request-local exact successful result reuse, including automatically prepared searches. */
export function memoizeToolResults(host: ReasoningToolSet): ReasoningToolSet {
  const cache=new Map<string,ReasoningToolResult>();
  return {...host,async execute(name,args,signal,execution){
    signal?.throwIfAborted();
    const {callId,...input}=args;
    const key=JSON.stringify([name,Object.keys(input).sort().map(k=>[k,input[k]])]);
    const old=cache.get(key);
    if(old)return {...structuredClone(old),callId:String(callId),durationMs:0,limitations:[...old.limitations,'Reused the exact successful request-local result; no new engine search.']};
    const result=await host.execute(name,args,signal,execution);
    signal?.throwIfAborted();
    const short=result.evidence.some(e=>{
      const d=(e.data.recordedPosition?e.data.details:e.data) as Record<string,unknown>;
      const minimum=Number((d.searchScope as Record<string,unknown>|undefined)?.minimumPvPlies??1);
      return Array.isArray(d.lines)&&d.lines.some(line=>line.pv.length<minimum&&line.pvCompletion?.status!=='terminal');
    });
    // A short legal line is valid evidence, but not coverage for a longer request.
    if(result.support==='supported' && result.evidence.length && !short)cache.set(key,structuredClone(result));
    return result;
  }};
}
