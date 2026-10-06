import { compactMechanism, presentMoveMechanisms } from './mechanism-presentation';
import { Chess } from 'chess.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Selective model view only. Full records remain in the evidence ledger and
 * retrieve_evidence uses fullGeometry to deliver omitted tactical details. */
export function projectEnginePresentation(value: unknown, fullGeometry = false): unknown {
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (!object(v)) return v;
    if (typeof v.id !== 'string' || !object(v.data)) {
      return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, visit(child)]));
    }
    const nested = object(v.data.details) && (Array.isArray(v.data.details.lines) || Array.isArray(v.data.details.moveFacts));
    const d = nested ? v.data.details as Obj : v.data;
    if (Object.hasOwn(d,'modelPresentation')) return v;
    if (object(d.selectedMoveMechanism) && Array.isArray(d.selectedMoveMechanism.controlDelta) && !fullGeometry) {
      // A selected historical move has no continuation target selector. Preserve
      // every changed square, with both complete controller sets, in the initial view.
      const squares = d.selectedMoveMechanism.controlDelta.flatMap(delta =>
        object(delta) && typeof delta.square === 'string' ? [delta.square] : []);
      const projected = {...d, selectedMoveMechanism:compactMechanism(d.selectedMoveMechanism,squares)};
      return {...v, data:nested ? {...v.data,details:projected} : projected};
    }
    if (Array.isArray(d.moveFacts) && !fullGeometry) {
      const inspection = object(d.mechanismInspection) ? d.mechanismInspection : {};
      const {moveFacts, ...rest} = d;
      const projected = {...rest, mechanismFacts:presentMoveMechanisms(moveFacts,
        Array.isArray(inspection.inspectPlies) ? inspection.inspectPlies as number[] : [],
        Array.isArray(inspection.inspectSquares) ? inspection.inspectSquares as string[] : []),
        modelPresentation:{mechanismThroughPly:2, explicitInspection:inspection,
          retrieveFullEvidenceId:v.id, geometryNotice:'Mechanisms shown for first two plies, explicit inspectPlies and moves landing on inspectSquares. Other plies omitted, not absent; retrieve full evidence for all replayed move facts.'}};
      return {...v, data:nested ? {...v.data,details:projected} : projected};
    }
    if (!Array.isArray(d.lines)) return v;
    const rootFen = object(d.searchScope) && typeof d.searchScope.fen === 'string' ? d.searchScope.fen : undefined;
    let omittedGeometry = 0, omittedRaw = false, referencedFen = false;
    const lines = (d.lines as unknown[]).map(line => {
      if (!object(line) || !Array.isArray(line.pv)) return line;
      const next = { ...line };
      if (!Object.hasOwn(line,'rawPvSameAsPv') && Array.isArray(line.rawPv) && JSON.stringify(line.rawPv) === JSON.stringify(line.pv)) {
        delete next.rawPv; next.rawPvSameAsPv = true; omittedRaw = true;
      }
      if (rootFen && object(line.pvCompletion) && Array.isArray(line.pvCompletion.segments)) {
        const fens: string[] = [];
        try {
          const chess = new Chess(rootFen); fens.push(chess.fen());
          for (const move of line.pv) {
            if (typeof move !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) break;
            chess.move({from:move.slice(0,2),to:move.slice(2,4),promotion:move.slice(4)||undefined});
            fens.push(chess.fen());
          }
        } catch { /* Preserve every segment not verified by the legal prefix. */ }
        next.pvCompletion = { ...line.pvCompletion, segments: line.pvCompletion.segments.map(segment => {
          if (!object(segment) || !Number.isInteger(segment.startPly) || (segment.startPly as number) < 0
            || typeof segment.fen !== 'string' || fens[segment.startPly as number] !== segment.fen
            || Object.hasOwn(segment,'fenFromLinePvPly')) return segment;
          const {fen: _fen, ...rest} = segment; void _fen;
          referencedFen = true;
          return {...rest, fenFromLinePvPly:segment.startPly};
        }) };
      }
      return next;
    });
    const continuations = !fullGeometry && Array.isArray(d.continuationMoveFacts)
      ? d.continuationMoveFacts.map(c => {
        if (!object(c) || !Array.isArray(c.moves)) return c;
        const compact = presentMoveMechanisms(c.moves);
        return {...c, moves:c.moves.map((m,i) => {
          if (!object(m)) return m;
          const next = {...m};
          if (i >= 2 && Object.hasOwn(next,'captureGeometry')) { delete next.captureGeometry; omittedGeometry++; }
          if (Object.hasOwn(next,'mechanism')) {
            const delivered = compact.find(f => object(f) && f.ply === i+1);
            if (object(delivered)) next.mechanism = delivered.mechanism;
            else { delete next.mechanism; omittedGeometry++; }
          }
          return next;
        })};
      }) : d.continuationMoveFacts;
    const roots = !fullGeometry && Array.isArray(d.rootMoveFacts) ? d.rootMoveFacts.map(f => !object(f) || !f.mechanism ? f
      : {...f,mechanism:compactMechanism(f.mechanism,[String(f.to)])}) : d.rootMoveFacts;
    if (!omittedGeometry && !omittedRaw && !referencedFen && !Array.isArray(d.rootMoveFacts)) return v;
    const projected = {...d, lines, ...(roots !== undefined ? {rootMoveFacts:roots} : {}), ...(d.continuationMoveFacts !== undefined ? {continuationMoveFacts:continuations} : {}),
      modelPresentation:{
        ...(omittedGeometry ? {captureGeometryThroughPly:2, omittedCaptureGeometry:omittedGeometry,
          retrieveFullEvidenceId:v.id, geometryNotice:'Deeper capture and mechanism geometry omitted, not absent. Retrieve this evidence ID for full geometry; basic move and capture facts remain complete.'} : {}),
        ...(referencedFen ? {segmentFenReference:'fenFromLinePvPly=N is the exact position after N moves of this line.pv, legally replayed from this engine result’s searchScope.fen. Segment scores, depth and search provenance still apply only to that segment.'} : {}),
      }};
    return {...v, data:nested ? {...v.data,details:projected} : projected};
  };
  return visit(value);
}
