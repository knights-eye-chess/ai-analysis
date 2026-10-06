import { effectiveLicensesForRecord } from './evidence-licenses';
import { Chess } from 'chess.js';
import { historyPositionContext, recordedEvidenceContext, recordedDetailsMatch } from './recorded-reference-context';
import { reasoningContextHash, type ReasoningPositionContext, type ReasoningEvidenceRecord } from './poc-contracts';
export type RecordedReferenceLine = {startFen:string; moves:readonly {uci:string;san:string}[]};

type Root = {context:ReasoningPositionContext; records:ReasoningEvidenceRecord[]};
/** Exact frozen witnesses for game:<recorded ply>:<local UCI path> links. */
export function historicalProseRoots(selected:ReasoningPositionContext, records:readonly ReasoningEvidenceRecord[], line?:RecordedReferenceLine) {
  const roots = new Map<number,Root>();
  const paths: Array<{ply:number;path:string[];sans:string[];numbers:string[]}> = [];
  const addPath = (ply:number,context:ReasoningPositionContext,path:string[]) => {
    if (!path.length || path.length > 256) return;
    const board = new Chess(context.fenAfter), sans:string[]=[], numbers:string[]=[];
    try { for (const uci of path) {
      const f=board.fen().split(' '); numbers.push(`${f[5]}${f[1]==='w'?'.':'...'}`);
      sans.push(board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}).san);
    } paths.push({ply,path,sans,numbers}); } catch { /* Invalid whole path is not evidence. */ }
  };
  let recorded:string[]|undefined;
  const recordedNumbers:string[]=[];
  if (line && line.startFen === (selected.historyStartFen ?? new Chess().fen()) && line.moves.length <= 512) {
    try {
      const board = new Chess(line.startFen);
      recorded=line.moves.map(m=>m.uci);
      let before=board.fen();
      for(let ply=0;ply<recorded.length;ply++) {
        const f=board.fen().split(' '); recordedNumbers.push(`${f[5]}${f[1]==='w'?'.':'...'}`);
        const context:ReasoningPositionContext=ply===0 ? historyPositionContext(line.startFen,[]) : {
          nodeId:'recorded-reference',historyStartFen:line.startFen,historyUci:recorded.slice(0,ply-1),
          fenBefore:before,fenAfter:board.fen(),moveUci:recorded[ply-1],moveSan:line.moves[ply-1].san};
        roots.set(ply,{context,records:[]});
        before=board.fen();
        const uci=recorded[ply];
        if(board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}).san!==line.moves[ply].san)throw Error('Invalid recorded SAN');
      }
    } catch { recorded=undefined; roots.clear(); paths.length=0; }
  }
  for (const e of records) {
    if (e.contextHash !== reasoningContextHash(selected) || !e.data.recordedPosition) continue;
    try {
      const p=e.data.recordedPosition as {ply:number;historyUci:string[]};
      const context=recordedEvidenceContext(selected,p);
      if (recorded && p.historyUci.some((uci,i)=>recorded![i]!==uci)) continue;
      const root=roots.get(p.ply) ?? {context,records:[]};
      if(root.context.fenAfter!==context.fenAfter || JSON.stringify(root.context.historyUci)!==JSON.stringify(context.historyUci))continue;
      effectiveLicensesForRecord(e);
      const data=e.data.details as ReasoningEvidenceRecord['data'];
      if(!recordedDetailsMatch(context,data))continue;
      const unwrapped={...e,contextHash:reasoningContextHash(root.context),data};
      root.records.push(unwrapped); roots.set(p.ply,root);
      if(Array.isArray(data.lines))for(const candidate of data.lines) {
        const prefix=Array.isArray(data.played)?data.played.map(m=>(m as {uci:string}).uci):[];
        const pv=(candidate as {pv?:string[]})?.pv;
        if(Array.isArray(pv))addPath(p.ply,context,[...prefix,...pv]);
      }
      if(Array.isArray(data.played))addPath(p.ply,context,data.played.map(m=>(m as {uci:string}).uci));
    } catch { /* Malformed scope never becomes a link. */ }
  }
  // Only numbered notation starts a procedural match. Unnumbered/square prose
  // is never guessed. A complete contiguous sequence must have one exact path.
  const san='(?:O-O(?:-O)?|[KQRBN](?:[a-h1-8])?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?[!?]*';
  const sequence=new RegExp(`(?<![\\w])\\d+\\s*(?:\\.{3}|\\.|…)\\s*${san}(?:\\s+(?:\\d+\\s*(?:\\.{3}|\\.|…)\\s*)?${san})*`,'g');
  const token=new RegExp(`(?:(\\d+)\\s*(\\.{3}|\\.|…)\\s*)?(${san})`,'g');
  const annotate=(text:string)=>text.replace(sequence,(match,offset)=>{
    // Leave authored Markdown links untouched.
    const left=text.slice(0,offset), right=text.slice(offset+match.length);
    if(left.lastIndexOf('[')>left.lastIndexOf(']') || /^\]\(/.test(right))return match;
    const moves=[...match.matchAll(token)];
    const candidates=new Map<string,{ply:number;path:string[]}>();
    for(const witness of paths) for(let from=0;from<witness.path.length;from++) {
      if(from+moves.length>witness.path.length)continue;
      if(!moves.every((m,i)=>m[3].replace(/[!?]/g,'')===witness.sans[from+i]
        && (!m[1] || `${Number(m[1])}${m[2]==='.'?'.':'...'}`===witness.numbers[from+i])))continue;
      const path=witness.path.slice(0,from+moves.length),root=roots.get(witness.ply)!;
      const history=[...root.context.historyUci,...(root.context.kind==='position'?[]:[root.context.moveUci]),...path];
      candidates.set(history.join(','),{ply:witness.ply,path});
    }
    // Consecutive recorded moves may span the one-move witnesses above.
    if(recorded)for(let ply=0;ply<recorded.length;ply++) {
      const root=roots.get(ply);if(!root || ply+moves.length>recorded.length)continue;
      const path=recorded.slice(ply,ply+moves.length);
      if(moves.every((m,i)=>m[3].replace(/[!?]/g,'')===line!.moves[ply+i].san && (!m[1]||`${Number(m[1])}${m[2]==='.'?'.':'...'}`===recordedNumbers[ply+i])))candidates.set(recorded.slice(0,ply+moves.length).join(','),{ply,path});
    }
    if(candidates.size!==1)return match;
    const c=[...candidates.values()][0];
    return `[${match}](game:${c.ply}:${c.path.join(',')})`;
  });
  const witnessedSuffixes=(ply:number,path:string[]) => {
    const target=roots.get(ply);
    if(!recorded || !target || !path.length) return [];
    const suffixes: Array<{root:Root;path:string[]}> = [];
    const seen=new Set<string>();
    for(const witness of paths) {
      if(witness.ply>=ply)continue;
      const omitted=recorded.slice(witness.ply,ply);
      if(omitted.length!==ply-witness.ply || witness.path.length<omitted.length+path.length
        || !omitted.every((uci,i)=>witness.path[i]===uci)
        || !path.every((uci,i)=>witness.path[omitted.length+i]===uci))continue;
      const root=roots.get(witness.ply);
      if(!root?.records.length)continue;
      // The ordered record, not a repeated FEN elsewhere in the game, fixes
      // the omitted prefix and the later root. A source line only proposes a
      // candidate; the caller must still admit its complete evidence witness.
      const board=new Chess(root.context.fenAfter);
      try {
        for(const uci of omitted)board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]});
        if(board.fen()!==target.context.fenAfter)continue;
      } catch {continue;}
      const fullPath=[...omitted,...path],key=`${witness.ply}:${fullPath.join(',')}`;
      if(!seen.has(key)){seen.add(key);suffixes.push({root,path:fullPath});}
    }
    return suffixes.sort((a,b)=>a.path.length-b.path.length);
  };
  return {roots,annotate,recorded,witnessedSuffixes};
}
