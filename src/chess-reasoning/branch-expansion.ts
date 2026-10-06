import { Chess } from 'chess.js';
import type { PositionAnalysisLine } from './poc-tools';

export type BranchExpansionConfig = {
  maxNodes: number;
  maxPlies: number;
  maxLines: number;
  depthFloor: number;
  depthMode: 'fixed' | 'decreasing';
  maxElapsedMs?: number;
};

export type BranchNode<T> = { prefix: string[]; finalFen: string; analysis: T };
export type BranchExpansionResult<T> = {
  nodes: BranchNode<T>[];
  summary: { requestedNodes: number; searchedNodes: number; returnedNodes: number; skippedDuplicate: number;
    skippedInvalid: number; failedNodes: number; stopped: 'complete' | 'node-limit' | 'elapsed-limit';
    scope: string };
};

/** Only the original PVs are traversed. New alternatives are retained, never
 * recursively scheduled. Each node is an independent FEN-root search. */
export async function expandPrincipalBranches<T extends {lines: PositionAnalysisLine[]}>(input: {
  rootFen: string;
  lines: readonly PositionAnalysisLine[];
  parentDepth: number;
  config: BranchExpansionConfig;
  signal?: AbortSignal;
  search: (fen: string, depth: number) => Promise<T | null>;
}): Promise<BranchExpansionResult<T>> {
  const started = performance.now();
  const config = input.config;
  const roots = input.lines.slice(0, Math.max(0,config.maxLines)).map(line => {
    if (!Array.isArray(line.pv) || line.pv[0] !== line.rootMove) return [];
    // Completed PV suffixes are independently searched from another root. They
    // must not become the parent search's own branch-selection evidence.
    return Array.isArray(line.rawPv) ? line.rawPv : line.pv;
  });
  const seen = new Set<string>();
  const nodes: BranchNode<T>[] = [];
  let requestedNodes = 0, searchedNodes = 0, skippedDuplicate = 0, skippedInvalid = 0, failedNodes = 0;
  let stopped: BranchExpansionResult<T>['summary']['stopped'] = 'complete';
  outer: for (let ply = 1; ply <= config.maxPlies; ply++) {
    for (const pv of roots) {
      if (pv.length < ply) continue;
      input.signal?.throwIfAborted();
      if (searchedNodes >= config.maxNodes) { stopped = 'node-limit'; break outer; }
      if (config.maxElapsedMs != null && performance.now() - started >= config.maxElapsedMs) { stopped = 'elapsed-limit'; break outer; }
      requestedNodes++;
      const prefix = pv.slice(0,ply);
      let finalFen: string;
      try {
        const chess = new Chess(input.rootFen);
        for (const uci of prefix) {
          if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)
            || !chess.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci.slice(4)||undefined})) throw Error('invalid-parent-pv');
        }
        if (chess.isGameOver()) continue;
        finalFen = chess.fen();
      } catch { skippedInvalid++; continue; }
      if (seen.has(finalFen)) { skippedDuplicate++; continue; }
      seen.add(finalFen);
      const depth = config.depthMode === 'fixed' ? input.parentDepth
        : Math.max(config.depthFloor,input.parentDepth-ply);
      searchedNodes++;
      try {
        const analysis = await input.search(finalFen,depth);
        input.signal?.throwIfAborted();
        if (analysis?.lines.length) nodes.push({prefix,finalFen,analysis});
        else failedNodes++;
      } catch (error) {
        input.signal?.throwIfAborted();
        if ((error as {code?:string})?.code === 'search-budget-exhausted') { stopped='node-limit'; break outer; }
        failedNodes++;
      }
    }
  }
  return {nodes,summary:{requestedNodes,searchedNodes,returnedNodes:nodes.length,skippedDuplicate,skippedInvalid,failedNodes,stopped,
    scope:'Independent searches at exact legal PV-prefix positions. Child scores compare moves only within the same child search; no child score validates the parent move. No new branches recursively expanded.'}};
}
