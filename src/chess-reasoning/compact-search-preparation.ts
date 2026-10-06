import { presentMoveMechanisms } from './mechanism-presentation';
import { Chess } from 'chess.js';
import type { MaterialFormat } from './material-format';
import type { ReasoningEvidenceRecord, ReasoningToolResult } from './poc-contracts';
import { compactSimpleEngineResult } from './simple-evidence-view';

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
const known = (value: Obj, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const detailsKeys = [
  'phase', 'rootMoves', 'rootSelection', 'bestMove', 'engine', 'engineBuild', 'searchScope',
  'rootMoveFacts', 'continuationMoveFacts', 'lines', 'minimumPvPlies',
  'requestedPvCoverage', 'authority', 'branchExpansion',
] as const;
const lineKeys = [
  'multipv', 'rootMove', 'pv', 'depth', 'nodes', 'scoreCp', 'matePly', 'scoreScope', 'scoreProvenance',
  'rawPv', 'pvCompletion', 'material',
] as const;
const completionKeys = ['requestedPlies', 'actualPlies', 'status', 'conditional', 'segments'] as const;
const segmentKeys = [
  'fen', 'startPly', 'depth', 'pv', 'scoreCp', 'matePly', 'scoreScope', 'scoreProvenance',
  'command', 'engine', 'engineBuild', 'cacheProvenance',
] as const;

/** The initial projection must not silently discard a new engine field. */
export function compactSearchRecord(record: ReasoningEvidenceRecord, playedMove?: string): ReasoningEvidenceRecord | null {
  const data = record.data as Obj;
  if (!known(data, ['recordedPosition', 'details']) || !object(data.recordedPosition) || !object(data.details)) return null;
  const recordedPosition = data.recordedPosition;
  const details = data.details;
  if (!known(details, detailsKeys) || !object(details.searchScope) || typeof details.searchScope.fen !== 'string'
    || !Array.isArray(details.lines) || !details.lines.length || !Array.isArray(details.continuationMoveFacts)) return null;
  const positionKeys = ['recordHash', 'ply', 'startFen', 'fen', 'historyUci', 'rootContextHash', 'nextRecordedMove', 'scope'];
  if (!known(recordedPosition, positionKeys) || !Number.isInteger(recordedPosition.ply)
    || typeof recordedPosition.fen !== 'string') return null;

  const strongestOther = details.lines.find(line => object(line) && line.rootMove !== playedMove);
  const mechanismAlternative = details.bestMove && details.bestMove !== playedMove ? details.bestMove
    : object(strongestOther) ? strongestOther.rootMove : details.bestMove;
  const lines: Obj[] = [];
  for (const line of details.lines) {
    if (!object(line) || !known(line, lineKeys) || !Array.isArray(line.pv)
      || !line.pv.every(move => typeof move === 'string')
      || typeof line.rootMove !== 'string' || !object(line.pvCompletion)
      || !known(line.pvCompletion, completionKeys) || !Array.isArray(line.pvCompletion.segments)) return null;
    // SAN is useful to the answering model; derive it from the exact rooted PV,
    // never from move-number strings that may belong to another position.
    let pvSan: string[];
    try {
      const board = new Chess(details.searchScope.fen);
      pvSan = line.pv.map(move => {
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw Error('invalid PV move');
        const replayed = board.move({from:move.slice(0,2),to:move.slice(2,4),promotion:move.slice(4)||undefined});
        if (!replayed) throw Error('illegal PV move');
        return replayed.san;
      });
    } catch { return null; }
    const segments: Obj[] = [];
    for (const segment of line.pvCompletion.segments) {
      if (!object(segment) || !known(segment,segmentKeys)
        || !Array.isArray(segment.pv) || !Number.isInteger(segment.startPly)) return null;
      const start = segment.startPly as number;
      const same = start >= 0 && JSON.stringify(line.pv.slice(start,start+segment.pv.length)) === JSON.stringify(segment.pv);
      const {pv: _pv, ...remaining} = segment;
      void _pv;
      segments.push(same ? {...remaining,pvFromLinePly:start,pvLength:segment.pv.length} : {...remaining,pv:segment.pv});
    }
    const {segments:_segments, ...completion} = line.pvCompletion;
    void _segments;
    const material = object(line.material) && object(line.material.start) && object(line.material.end)
      ? {authority:line.material.authority,
          startBalance:line.material.start.balance,
          endBalance:line.material.end.balance,
          balanceChangeFromStart:line.material.balanceChangeFromStart,
          scope:line.material.scope}
      : undefined;
    // rawPv is sometimes different from the displayed continuation. Retain it
    // in that case; only equal bytes may be omitted.
    const separateRawPv = Array.isArray(line.rawPv)
      && JSON.stringify(line.rawPv) !== JSON.stringify(line.pv) ? {rawPv:line.rawPv} : {};
    const continuation = details.continuationMoveFacts.find(f => object(f) && f.rootMove === line.rootMove);
    const mechanismRelevant = line.rootMove === playedMove || line.rootMove === mechanismAlternative
      || (!mechanismAlternative && lines.length === 0);
    const mechanismFacts = mechanismRelevant && object(continuation) && Array.isArray(continuation.moves) ? presentMoveMechanisms(continuation.moves) : [];
    lines.push({
      ...(object(continuation) && Array.isArray(continuation.moves) ? {mechanismAvailablePlies:continuation.moves.length} : {}),
      ...(mechanismFacts.length ? {mechanismFacts} : {}),
      ...(line.multipv !== undefined ? {multipv:line.multipv} : {}), rootMove:line.rootMove,
      ...(playedMove ? {playedMove:playedMove === line.rootMove} : {}), pv:line.pv, pvSan,
      depth:line.depth, scoreCp:line.scoreCp, matePly:line.matePly,
      scoreScope:line.scoreScope, ...(line.scoreProvenance ? {scoreProvenance:line.scoreProvenance} : {}), pvCompletion:{...completion,segments},
      ...(material ? {materialSummary:material} : {}), ...separateRawPv,
    });
  }
  const {historyUci:_historyUci, ...root} = recordedPosition;
  void _historyUci;
  const {rootMoveFacts:_rootMoveFacts,continuationMoveFacts:_continuationMoveFacts,lines:_lines,...search} = details;
  void _rootMoveFacts; void _continuationMoveFacts; void _lines;
  const projection = {
    ...record,
    data:{recordedPosition:root,details:{...search,lines,
      modelPresentation:{scope:'compact initial preparation only; supplied PVs are complete, mechanismFacts cover first two plies for played and strongest roots with scoped control targets; deeper geometry remains retrievable',
        mechanismRoots:lines.filter(line=>Array.isArray(line.mechanismFacts)).map(line=>line.rootMove),
        omitted:['otherRootMechanisms','rootMoveFacts','continuationMoveFacts','captureGeometry','materialCheckpoints','duplicatePvSegmentMoves'],
        retrieveFullEvidenceId:record.id,
        segmentPvReference:'A segment with pvFromLinePly=N and pvLength=L repeats exactly L moves of that line.pv starting at zero-based index N; its own depth, score, FEN, command and cache provenance remain specific to that segment.',
        instruction:'For deeper or omitted geometry, other control squares, piece identities or material checkpoints, call retrieve_evidence with this evidence ID. This reuses the acquired record without another engine search. mechanismAvailablePlies states the retained geometry horizon; inspect later moves with test_game_line/inspectPlies.'}}},
    // replay duplicates the full PV arrays. The PVs above remain available for
    // game links, while the immutable replay stays in the authoritative record.
    replay:null,
  };
  return projection as ReasoningEvidenceRecord;
}

/** Only automatic preparation is thinned. The caller keeps the original tool
 * result in its evidence ledger and observable trace for retrieval/replay. */
export function compactPreparedSearchResult(result: ReasoningToolResult, playedMove?: string, format?: MaterialFormat): unknown {
  const packet = {
    contextHash:result.contextHash,
    evidence:result.evidence.map(record => compactSearchRecord(record,playedMove) ?? record),
    limitations:[...result.limitations,
      'Initial preparation shows complete supplied PV moves and bounded scores, with first-two-ply mechanism measurements for played/strongest roots, but omits deeper geometry and material checkpoints. retrieve_evidence(evidenceIds) returns the already acquired full records without a new search.'],
  };
  return compactSimpleEngineResult(packet,format);
}
