/** Model-facing only. The ledger, search results and UI witnesses stay complete. */
export const COMPACT_ENGINE_VERSION = "simple-engine-evidence/1";
type ObjectValue = Record<string, unknown>;
const object = (x: unknown): x is ObjectValue => !!x && typeof x === "object" && !Array.isArray(x);
const uci = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export const COMPACT_ENGINE_INSTRUCTIONS = `Engine evidence encoding simple-engine-evidence/1 is exact: {$piece:id,square} expands the same-message pieces[id] plus that square. {$move:[uci,san,mover,capture,geometry,extra]} expands a move fact; omitted trailing capture/geometry are null/absent respectively. from/to are UCI squares, promotion is UCI suffix or null, givesCheck follows SAN +/#. extra contains any additional fields. Geometry keeps every attacker, defender and immediate legal recapture at the stated variation ply; legal recapture is not safety. {$table:{columns,rows}} is an array of objects, pairing columns with each row. All scope, authority, actual/requested settings and exceptions remain authoritative. Piece identities are scoped to this message's evidence context, never a global position.`;

/** Unknown shapes/fields survive; only exact standard move defaults are derived. */
export function projectCompactEngineEvidence(value: unknown): unknown {
  const pieces: Record<string, unknown> = {}, pieceIds = new Map<string, string>();
  let changed = false;
  const visit = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      const entries = x.map(visit);
      // Exact equal-key object arrays can share their field names once.
      if (entries.length >= 3 && entries.every(object)) {
        const columns = Object.keys(entries[0]);
        if (columns.length >= 2 && entries.every(e => JSON.stringify(Object.keys(e)) === JSON.stringify(columns) && columns.every(k => e[k] !== undefined))) {
          const table = { $table: { columns, rows: entries.map(e => columns.map(k => e[k])) } };
          if (JSON.stringify(table).length < JSON.stringify(entries).length) { changed = true; return table; }
        }
      }
      return entries;
    }
    if (!object(x)) return x;
    if (typeof x.pieceId === "string" && typeof x.square === "string" && typeof x.color === "string" && typeof x.pieceType === "string") {
      const { square, ...identity } = x;
      const key = JSON.stringify(identity);
      let id = pieceIds.get(key);
      if (!id) { id = `p${pieceIds.size}`; pieceIds.set(key, id); pieces[id] = identity; }
      changed = true;
      return { $piece: id, square };
    }
    if (typeof x.uci === "string" && uci.test(x.uci) && typeof x.san === "string" && x.mover
      && x.from === x.uci.slice(0, 2) && x.to === x.uci.slice(2, 4)
      && x.capture !== undefined && x.captureGeometry !== null && x.promotion === (x.uci.slice(4) || null)
      && x.givesCheck === /[+#]$/.test(x.san)) {
      const { uci: move, san, mover, capture, captureGeometry, from: _from, to: _to, promotion: _promotion, givesCheck: _check, ...extra } = x;
      void _from; void _to; void _promotion; void _check;
      const row: unknown[] = [move, san, visit(mover), visit(capture)];
      if (captureGeometry !== undefined || Object.keys(extra).length) row.push(visit(captureGeometry ?? null));
      if (Object.keys(extra).length) row.push(visit(extra));
      while (row.length > 3 && row.at(-1) === null) row.pop();
      changed = true;
      return { $move: row };
    }
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, visit(v)]));
  };
  // Reserved forms in caller-owned data must never acquire encoding semantics.
  const reserved = (x: unknown): boolean => Array.isArray(x) ? x.some(reserved) : object(x)
    ? Object.keys(x).some(k => ["$piece", "$move", "$table"].includes(k)) || Object.values(x).some(reserved) : false;
  if (reserved(value)) return value;
  const content = visit(value);
  return changed ? { encoding: COMPACT_ENGINE_VERSION, pieces, content } : value;
}

/** Exact decoder for structural verification and isolated replay diagnostics. */
export function expandCompactEngineEvidence(value: unknown): unknown {
  if (!object(value) || value.encoding !== COMPACT_ENGINE_VERSION || !object(value.pieces)) return value;
  const pieces = value.pieces;
  const visit = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(visit);
    if (!object(x)) return x;
    if (typeof x.$piece === "string") return { ...(pieces[x.$piece] as ObjectValue), square: x.square };
    if (object(x.$table)) {
      const { columns, rows } = x.$table as { columns: string[]; rows: unknown[][] };
      return rows.map(row => visit(Object.fromEntries(columns.map((key, i) => [key, row[i]]))));
    }
    if (Array.isArray(x.$move)) {
      const [move, san, mover, capture = null, geometry = null, extra = {}] = x.$move;
      return { uci: move, san, from: move.slice(0, 2), to: move.slice(2, 4), mover: visit(mover), capture: visit(capture),
        ...(geometry !== null ? { captureGeometry: visit(geometry) } : {}), promotion: move.slice(4) || null,
        givesCheck: /[+#]$/.test(san), ...(visit(extra) as ObjectValue) };
    }
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, visit(v)]));
  };
  return visit(value.content);
}
