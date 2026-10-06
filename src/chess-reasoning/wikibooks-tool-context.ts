import { openingTitle, positionKey, type WikibooksIndex } from './wikibooks-index';
import { recordedEvidenceContext, recordedDetailsMatch } from './recorded-reference-context';
import { Chess } from 'chess.js';
import { reasoningContextHash, validateReasoningPositionContext, type ReasoningPositionContext, type ReasoningToolResult } from './poc-contracts';
import { type WikibooksTarget } from './opening-source-contracts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ucis = (value: unknown): string[] | null => Array.isArray(value) && value.every(v => typeof v === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(v)) ? value : null;

/** Legacy unfiltered planner; production uses the indexed entrypoint below. */
export function wikibooksTargetsForTool(context: ReasoningPositionContext, name: string, args: Record<string, unknown>, result: ReasoningToolResult): WikibooksTarget[] {
  return targetsForTool(context,name,args,result).targets;
}
export function wikibooksTargetsForToolIndexed(context: ReasoningPositionContext, name: string, args: Record<string, unknown>, result: ReasoningToolResult, catalog: WikibooksIndex) {
  return targetsForTool(context,name,args,result,catalog);
}

/** Check board positions before allocating possibly long page-address strings.
 * Ancestors follow the actual replayed path, including tool continuations. */
function targetsForTool(context: ReasoningPositionContext, name: string, args: Record<string, unknown>, result: ReasoningToolResult, catalog?: WikibooksIndex): {targets:WikibooksTarget[];positionChecks:number;candidateCount:number} {
  const empty = () => ({targets:[] as WikibooksTarget[],positionChecks:0,candidateCount:0});
  if (result.contextHash !== reasoningContextHash(context) || result.tool !== name) return empty();
  if (name === 'analyze_game_position' || name === 'test_game_line') {
    try {
      const root = recordedEvidenceContext(context,result.data.recordedPosition), details = object(result.data.details);
      if (Number(args.ply) !== Number(object(result.data.recordedPosition).ply) || !recordedDetailsMatch(root,details)) return empty();
      const mapped = name === 'test_game_line' ? 'test_line' : args.rootMoves ? 'compare_moves' : 'explore_continuations';
      return targetsForTool(root,mapped,{...args,phase:'after',...(args.rootMoves?{movesUci:args.rootMoves}:{})},
        {...result,tool:mapped,contextHash:reasoningContextHash(root),data:details as ReasoningToolResult['data']},catalog);
    } catch { return empty(); }
  }
  if (!['analyze_move','inspect_position','compare_moves','enumerate_defenses','explore_continuations','test_line'].includes(name)) return empty();
  try {
    validateReasoningPositionContext(context);
    const board = new Chess();
    if (context.historyStartFen && new Chess(context.historyStartFen).fen() !== board.fen()) return empty();
    const sans:string[] = [], fens = [board.fen()];
    for (const uci of [...context.historyUci,...(context.kind === 'position'?[]:[context.moveUci])]) {
      sans.push(board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}).san); fens.push(board.fen());
    }
    if (board.fen() !== new Chess(context.fenAfter).fen()) return empty();
    const targets = new Map<string,WikibooksTarget>(), seen = new Set<string>();
    let positionChecks=0,candidateCount=0;
    const add = (moves:string[],positions:string[],relation:WikibooksTarget['relation']) => {
      const key=moves.join(' ');
      if (seen.has(key)) return;
      seen.add(key); candidateCount++;
      if (!catalog) {const title=moves.length?openingTitle(moves):'Chess Opening Theory';targets.set(title,{title,relation});return;}
      for (let distance=0;distance<=2 && moves.length-distance>0;distance++) {
        positionChecks++;
        if (!catalog.byPosition.has(positionKey(positions[moves.length-distance]))) continue;
        const title=openingTitle(moves);
        if (!targets.has(title)) targets.set(title,{title,relation});
        break;
      }
    };
    const beforeLength=context.kind === 'position'?sans.length:sans.length-1;
    if (name === 'analyze_move') {
      if(context.kind !== 'position')add(sans.slice(0,beforeLength),fens.slice(0,beforeLength+1),'before');
      add(sans,fens,'current'); return {targets:[...targets.values()],positionChecks,candidateCount};
    }
    const phase=name === 'enumerate_defenses'?'after':args.phase??'after';
    if (phase !== 'before' && phase !== 'after') return empty();
    const length=phase === 'before'?beforeLength:sans.length, baseSans=sans.slice(0,length), baseFens=fens.slice(0,length+1), fen=baseFens.at(-1)!;
    const data=object(result.data),scope=object(data.searchScope);
    if (data.phase !== undefined && data.phase !== phase || name !== 'test_line' && scope.fen !== undefined && scope.fen !== fen) return empty();
    add(baseSans,baseFens,phase === 'before' && context.kind !== 'position'?'before':'current');
    const path=(moves:string[],expectedFen?:string) => {
      const branch=new Chess(fen), branchSans=[...baseSans],branchFens=[...baseFens];
      try {
        for(const uci of moves){branchSans.push(branch.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}).san);branchFens.push(branch.fen());}
        if(expectedFen && branch.fen()!==expectedFen)return false;
        for(let end=baseSans.length+1;end<=branchSans.length;end++)add(branchSans.slice(0,end),branchFens.slice(0,end+1),'continuation');
        return true;
      } catch {return false;}
    };
    if(name === 'compare_moves' || name === 'enumerate_defenses'){
      const requested=ucis(name === 'compare_moves'?args.movesUci:args.rootMoves)??[],returned=ucis(data.rootMoves)??[];
      for(const move of new Set([...requested,...returned]))path([move]);
    } else if(name === 'test_line'){
      const moves=ucis(args.movesUci);
      if(!moves || moves.length>32 || typeof data.finalFen!=='string' || !path(moves,data.finalFen))return empty();
      if(scope.fen===data.finalFen && Array.isArray(data.lines))for(const candidate of data.lines){
        const line=object(candidate),pv=ucis(line.pv);if(pv?.length && line.rootMove===pv[0])path([...moves,...pv].slice(0,32));
      }
    } else if(name === 'explore_continuations' && scope.fen===fen && Array.isArray(data.lines))for(const candidate of data.lines){
      const line=object(candidate),pv=ucis(line.pv);if(pv?.length && line.rootMove===pv[0])path(pv.slice(0,32));
    }
    return {targets:[...targets.values()],positionChecks,candidateCount};
  } catch {return empty();}
}
