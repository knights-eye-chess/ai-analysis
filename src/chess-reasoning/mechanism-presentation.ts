type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const COLUMNS = {
  mover: ['pieceId','pieceIdAfter','fromSquare','toSquare','color','pieceTypeBefore','pieceTypeAfter','attackersBefore','attackersAfter'],
  unmoved: ['pieceId','square','pieceType','attackersBefore','attackersAfter'],
  rays: ['pieceId','fromSquare','color','pieceType','direction','gainedSquares','lostSquares'],
  control: ['square','color','attackersBefore','attackersAfter'],
} as const;
type ColumnGroup = keyof typeof COLUMNS;
const GROUPS: ColumnGroup[] = ['mover','unmoved','rays','control'];

function exactKeys(value: unknown, columns: readonly string[]): value is Obj {
  return object(value) && Object.keys(value).length === columns.length
    && columns.every(column => Object.hasOwn(value,column));
}

function encodeRows(value: Obj, columns: readonly string[]): unknown[] {
  return columns.map(column => value[column]);
}

function decodeRow(row: unknown, columns: readonly string[]): Obj | null {
  if (!Array.isArray(row) || row.length !== columns.length) return null;
  return Object.fromEntries(columns.map((column,index) => [column,row[index]]));
}

/** Restores the precise bounded projection, including its coverage/omission markers.
 * Unknown versions or schemas pass through unchanged rather than losing fields. */
export function expandMechanismPresentation(value: unknown): unknown {
  if (!object(value) || value.encoding !== 'move-mechanism/1') return value;
  if (!object(value.columns) || !object(value.rows)
    || Object.keys(value.columns).length !== GROUPS.length
    || Object.keys(value.rows).length !== GROUPS.length) return value;
  for (const group of GROUPS) {
    if (JSON.stringify(value.columns[group]) !== JSON.stringify(COLUMNS[group])) return value;
  }
  const mover = decodeRow(value.rows.mover,COLUMNS.mover);
  if (!mover || !Array.isArray(value.rows.unmoved) || !Array.isArray(value.rows.rays)
    || !Array.isArray(value.rows.control)) return value;
  const unmoved = value.rows.unmoved.map(row => decodeRow(row,COLUMNS.unmoved));
  const rays = value.rows.rays.map(row => decodeRow(row,COLUMNS.rays));
  const control = value.rows.control.map(row => decodeRow(row,COLUMNS.control));
  if ([...unmoved,...rays,...control].some(row => row === null)) return value;
  const {encoding:_encoding,columns:_columns,rows:_rows,...rest} = value;
  void _encoding; void _columns; void _rows;
  return {...rest,mover,attackedUnmovedFriendlyPieces:unmoved,
    stationarySliderRays:rays,controlDelta:control};
}

/** A measured but untransmitted square is not a negative result. Full control
 * deltas stay on the immutable evidence record for retrieval. */
export function compactMechanism(value: unknown, targetSquares: string[]): unknown {
  if (!object(value) || !Array.isArray(value.controlDelta)) return value;
  const targets = [...new Set(targetSquares)].filter(s => /^[a-h][1-8]$/.test(s));
  const controlDelta = value.controlDelta.filter(d => object(d) && targets.includes(String(d.square)));
  const rays = Array.isArray(value.stationarySliderRays) ? value.stationarySliderRays.map(ray => {
    if (!object(ray)) return ray;
    const {beforeSquares:_before,afterSquares:_after,...changes} = ray;
    void _before; void _after;
    return changes;
  }) : value.stationarySliderRays;
  const projected: Obj = {...value, stationarySliderRays:rays, controlDelta,
    presentation:{controlSquares:targets, omittedControlDeltaCount:value.controlDelta.length-controlDelta.length,
      scope:'All changed stationary rays and mover/unmoved attack measurements retained. Control deltas shown only for controlSquares; an omitted square is not checked-negative in this view. Full ray extents and all control deltas are retrievable.'}};
  // Additions to the canonical contract must travel verbatim until an explicit
  // versioned schema can represent them; never silently discard an unknown fact.
  if (!exactKeys(value,['mover','attackedUnmovedFriendlyPieces','stationarySliderRays','controlDelta','checksRun','scope'])
    || !exactKeys(projected.mover,COLUMNS.mover)
    || !Array.isArray(projected.attackedUnmovedFriendlyPieces)
    || !projected.attackedUnmovedFriendlyPieces.every(item => exactKeys(item,COLUMNS.unmoved))
    || !Array.isArray(rays) || !rays.every(item => exactKeys(item,COLUMNS.rays))
    || !controlDelta.every(item => exactKeys(item,COLUMNS.control))) return projected;
  return {
    encoding:'move-mechanism/1',columns:COLUMNS,
    rows:{
      mover:encodeRows(projected.mover,COLUMNS.mover),
      unmoved:projected.attackedUnmovedFriendlyPieces.map(item => encodeRows(item as Obj,COLUMNS.unmoved)),
      rays:rays.map(item => encodeRows(item as Obj,COLUMNS.rays)),
      control:controlDelta.map(item => encodeRows(item,COLUMNS.control)),
    },
    checksRun:projected.checksRun,scope:projected.scope,presentation:projected.presentation,
  };
}

/** Root + first reply by default; explicit one-based replay targets, and moves
 * landing on inspected squares, can expose a deeper mechanism without a search. */
export function presentMoveMechanisms(moves: unknown[], inspectPlies: number[] = [], inspectSquares: string[] = []): unknown[] {
  return moves.flatMap((fact,index) => {
    if (!object(fact) || !object(fact.mechanism)) return [];
    if (index >= 2 && !inspectPlies.includes(index+1) && !inspectSquares.includes(String(fact.to))) return [];
    const targets = [...inspectSquares, ...moves.slice(index,index+3).flatMap(m => object(m) && typeof m.to === 'string' ? [m.to] : [])];
    return [{ply:index+1,uci:fact.uci,san:fact.san,mechanism:compactMechanism(fact.mechanism,targets)}];
  });
}
