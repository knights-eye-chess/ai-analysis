import { Chess } from 'chess.js';
import { reasoningContextHash, type ReasoningPositionContext } from './poc-contracts';

/** Reconstruct an occurrence from its ordered history, never from a FEN guess. */
export function historyPositionContext(startFen: string, history: string[]): ReasoningPositionContext {
  if (!Array.isArray(history) || history.length > 512) throw Error('Invalid recorded history');
  const board = new Chess(startFen); let before = board.fen(), san = '';
  for (const uci of history) {
    if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw Error('Invalid recorded move');
    before = board.fen(); san = board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}).san;
  }
  return history.length ? {nodeId:'recorded-reference',historyStartFen:startFen,historyUci:history.slice(0,-1),fenBefore:before,fenAfter:board.fen(),moveUci:history.at(-1)!,moveSan:san}
    : {kind:'position',nodeId:'recorded-reference',historyStartFen:startFen,historyUci:[],fenBefore:board.fen(),fenAfter:board.fen(),moveUci:'',moveSan:''};
}
export function recordedEvidenceContext(selected: ReasoningPositionContext, value: unknown): ReasoningPositionContext {
  const p=value as {startFen:string;historyUci:string[];ply:number;fen:string;rootContextHash:string;recordHash:string};
  if (!p || p.startFen !== (selected.historyStartFen ?? new Chess().fen()) || !Array.isArray(p.historyUci) || p.ply !== p.historyUci.length) throw Error('Invalid recorded scope');
  const root=historyPositionContext(p.startFen,p.historyUci);
  if (typeof p.recordHash !== 'string' || reasoningContextHash({...root,nodeId:`recorded:${p.recordHash}:${p.ply}`}) !== p.rootContextHash) throw Error('Recorded identity mismatch');
  if (root.fenAfter !== p.fen) throw Error('Recorded root mismatch');
  return root;
}
export function recordedNavigation(context: ReasoningPositionContext, recorded?: ReasoningPositionContext) {
  return recorded ? {anchorEdgeId:`recorded-reference:${reasoningContextHash(recorded)}`,context:recorded} : {context};
}

/** Reject contradictory engine scope before promoting its paths to navigation/theory. */
export function recordedDetailsMatch(root: ReasoningPositionContext, value: unknown): boolean {
  try {
    const d=value as {phase?:string;played?:{uci:string;san?:string}[];finalFen?:string;searchScope?:{fen?:string};lines?:{pv:string[];rootMove:string;scoreScope?:{fen?:string}}[]};
    if (!d || (d.phase !== undefined && d.phase !== 'after')) return false;
    const board=new Chess(root.fenAfter);
    if(d.played)for(const move of d.played) {
      const m=board.move({from:move.uci.slice(0,2),to:move.uci.slice(2,4),promotion:move.uci[4]});
      if(move.san!==undefined && move.san!==m.san)return false;
    }
    if(d.finalFen!==undefined && board.fen()!==d.finalFen)return false;
    if(d.searchScope?.fen!==undefined && d.searchScope.fen!==board.fen())return false;
    if(d.lines)for(const line of d.lines) {
      if(!Array.isArray(line.pv) || line.rootMove!==line.pv[0] || (line.scoreScope?.fen!==undefined && line.scoreScope.fen!==board.fen()))return false;
    }
    return true;
  } catch { return false; }
}
