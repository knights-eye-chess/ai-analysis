import type { PositionAnalysisProvider, PositionAnalysisResult } from './position-analysis-contracts';

/** Consumer-owned structural contract. No dependency on an engine implementation. */
export type AnalysisEngineClient = {
  search(request: {
    fen: string; limit: { depth: number }; multiPv: number; rootMoves: string[];
    requireRootCoverage?: boolean; signal?: AbortSignal;
  }): Promise<({
    noMove?: false; bestmove: string; engineBuild?: string; weightsId?: string;
    candidates: Array<{
      pv: string[]; depth: number; nodes?: number | null; scoreCp: number | null; mate: number | null;
      scoreProvenance?: { engineBuild: string; weightsId?: string };
    }>;
  } | {
    noMove: true; bestmove: null; candidates: []; engineBuild: string; weightsId?: string;
  }) & { diagnostics?: unknown }>;
};

/** Adapt a host-owned depth-search client without acquiring or closing it.
 * Short PVs remain short; evidence admission stays with the existing consumers.
 */
export function createEngineAnalysisProvider(client: AnalysisEngineClient): PositionAnalysisProvider {
  return { async analyze(request): Promise<PositionAnalysisResult> {
    request.signal?.throwIfAborted();
    const result = await client.search({ fen: request.fen, limit: { depth: request.depth },
      multiPv: request.multiPv, rootMoves: request.rootMoves,
      ...(request.rootMoves.length ? { requireRootCoverage: true } : {}), signal: request.signal });
    request.signal?.throwIfAborted();
    const command = 'go depth ' + request.depth + (request.rootMoves.length ? ' searchmoves ' + request.rootMoves.join(' ') : '');
    if (result.noMove === true) {
      if (result.bestmove !== null || result.candidates.length !== 0 || !result.engineBuild) {
        throw new Error('Invalid UCI no-move result.');
      }
      // A UCI no-move report is unscored; the host must check the legal board
      // before interpreting it as checkmate, stalemate, or another terminal.
      return { engine: result.engineBuild, engineBuild: result.engineBuild, command,
        bestMove: null, cacheProvenance: 'engine', lines: [],
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
    }
    const build = result.candidates[0]?.scoreProvenance?.engineBuild;
    if (typeof build !== 'string' || !build) throw new Error('Engine returned no attributed build identity.');
    if (!result.bestmove || result.bestmove !== result.candidates[0]?.pv[0] ||
      (result.engineBuild && result.engineBuild !== build) ||
      (result.weightsId && result.weightsId !== result.candidates[0]?.scoreProvenance?.weightsId)) {
      throw new Error('Engine returned an incomplete or inconsistent best move.');
    }
    // A provider result represents one engine search, not a blend of engines.
    if (result.candidates.some(line => line.scoreProvenance?.engineBuild !== build ||
      line.scoreProvenance?.weightsId !== result.candidates[0]?.scoreProvenance?.weightsId)) {
      throw new Error('Engine returned inconsistent build identity.');
    }
    return {
      engine: build, engineBuild: build,
      command, bestMove: result.bestmove,
      cacheProvenance: 'engine',
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
      lines: result.candidates.map(candidate => ({ rootMove: candidate.pv[0], pv: candidate.pv,
        depth: candidate.depth, nodes: candidate.nodes ?? null, scoreCp: candidate.scoreCp,
        mateInMoves: candidate.mate, scoreProvenance: candidate.scoreProvenance ? { ...candidate.scoreProvenance } : undefined })),
    };
  } };
}
