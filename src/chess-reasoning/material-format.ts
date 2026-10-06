/** Presentation only: the legally computed canonical material record is immutable. */
export type MaterialFormat = 'raw' | 'hybrid' | 'text';
export const DEFAULT_MATERIAL_FORMAT: MaterialFormat = 'hybrid';
const order = ['pawn', 'knight', 'bishop', 'rook', 'queen'] as const;
type PieceCounts = Record<typeof order[number], number>;
interface MaterialSnapshot { white: PieceCounts; black: PieceCounts; whiteMinusBlack: PieceCounts; balance: string }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).every(k => expected.includes(k));
const counts = (v: unknown): v is Record<typeof order[number], number> => obj(v)
  && keys(v, [...order]) && order.every(k => Number.isInteger(v[k]));
const snapshot = (v: unknown): v is MaterialSnapshot => obj(v)
  && keys(v, ['white','black','whiteMinusBlack','balance'])
  && counts(v.white) && counts(v.black) && counts(v.whiteMinusBlack) && typeof v.balance === 'string';
const row = (v: Record<string, number>) => order.map(k => v[k]);
const inventory = (v: Record<string, number>) => order.map(k => `${v[k]} ${k}${v[k] === 1 ? '' : 's'}`).join(', ');
const textSnapshot = (v: MaterialSnapshot) => `White: ${inventory(v.white)}. Black: ${inventory(v.black)}. ${v.balance}`;
const hybridSnapshot = (v: MaterialSnapshot) => ({white:row(v.white),black:row(v.black),balance:v.balance});

function formattedMaterial(v: unknown, format: Exclude<MaterialFormat,'raw'>): unknown {
  if (snapshot(v)) return format === 'text' ? {encoding:'material-text/1',position:textSnapshot(v)}
    : {encoding:'material-table/1',pieceOrder:order.join(' '),...hybridSnapshot(v)};
  if (!obj(v) || v.authority !== 'legal-replay-piece-counts'
    || !keys(v,['authority','startFen','plies','start','changes','endFen','end','balanceChangeFromStart','scope'])
    || typeof v.startFen !== 'string' || typeof v.endFen !== 'string' || !Number.isInteger(v.plies)
    || !snapshot(v.start) || !snapshot(v.end) || !counts(v.balanceChangeFromStart) || typeof v.scope !== 'string'
    || !Array.isArray(v.changes) || v.changes.some(c => !obj(c) || !keys(c,['ply','san','whiteMinusBlack','balance'])
      || !Number.isInteger(c.ply) || typeof c.san !== 'string' || !counts(c.whiteMinusBlack) || typeof c.balance !== 'string')) return v;
  const balanceChangeFromStart = v.balanceChangeFromStart;
  const shared = {authority:v.authority,startFen:v.startFen,plies:v.plies,endFen:v.endFen,scope:v.scope};
  if (format === 'hybrid') return {encoding:'material-table/1',...shared,pieceOrder:order.join(' '),
    start:hybridSnapshot(v.start),
    checkpointColumns:'ply san pawn knight bishop rook queen; absolute White minus Black',
    checkpoints:v.changes.map(c => [c.ply,c.san,...row(c.whiteMinusBlack)]),
    end:hybridSnapshot(v.end),balanceChangeFromStart:row(v.balanceChangeFromStart)};
  return {encoding:'material-text/1',...shared,convention:'Balances list all differences; unmentioned piece types have equal counts.',start:textSnapshot(v.start),
    checkpoints:Object.fromEntries(v.changes.map(c => [`After ply ${c.ply} (${c.san})`,c.balance])),
    end:textSnapshot(v.end),
    balanceChangeFromStart:`Change only, White minus Black: ${order.map(k=>`${k} ${balanceChangeFromStart[k] >= 0 ? '+' : ''}${balanceChangeFromStart[k]}`).join(', ')}.`};
}

export function projectMaterial(value: unknown, format: MaterialFormat = DEFAULT_MATERIAL_FORMAT): unknown {
  if (!['raw','hybrid','text'].includes(format)) throw Error('invalid-material-format');
  if (format === 'raw') return value;
  const visit = (v: unknown): unknown => Array.isArray(v) ? v.map(visit) : obj(v)
    ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k,k === 'material' ? formattedMaterial(x,format) : visit(x)])) : v;
  return visit(value);
}
