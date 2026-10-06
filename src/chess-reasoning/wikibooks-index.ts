import { Chess } from 'chess.js';
const ROOT = 'Chess Opening Theory';
export type WikibooksIndexData = { v: number; at: string; run: string; extractor: string; entries: string[][] };
export type IndexedOpening = { title: string; canonicalTitle: string; positionKey: string; plies: number };
export type WikibooksIndex = { at: string; byPath: Map<string, IndexedOpening[]>; byPosition: Map<string, IndexedOpening[]> };
export function openingTitle(moves: string[]): string {
  return ROOT + '/' + moves.map((san, ply) => `${Math.floor(ply / 2) + 1}${ply % 2 ? '...' : '. '}${san.replace(/[+#?!]+$/g, '')}`).join('/');
}
export function decodeWikibooksIndex(data: WikibooksIndexData): WikibooksIndex {
  if (data.v !== 1 || !data.at || !Array.isArray(data.entries) || data.entries.length > 20_000) throw Error('Invalid opening catalog');
  const byPath = new Map<string, IndexedOpening[]>(), byPosition = new Map<string, IndexedOpening[]>();
  for (const row of data.entries) {
    if (row.length < 2 || row.length > 3 || row.some(x => typeof x !== 'string')) throw Error('Invalid opening catalog row');
    const moves = row[0].split(' '), canonicalTitle = openingTitle(moves);
    const entry = {title: row[2] ? ROOT + '/' + row[2] : canonicalTitle, canonicalTitle, positionKey: row[1], plies: moves.length};
    for (const [map, key] of [[byPath, canonicalTitle], [byPosition, entry.positionKey]] as const) {
      const values = map.get(key) || []; values.push(entry); map.set(key, values);
    }
  }
  return {at: data.at, byPath, byPosition};
}
export function positionKey(fen: string): string { return fen.split(' ').slice(0, 4).join(' '); }
/** Normalize only title notation; every move must replay legally with its actual side/number. */
export function replayWikibooksTitle(title: string): string | null {
  if (title === ROOT) return new Chess().fen();
  if (!title.startsWith(ROOT + '/')) return null;
  const board = new Chess();
  try {
    for (const part of title.slice(ROOT.length + 1).replace(/\/$/, '').split('/')) {
      const tokens = part.trim().replace(/…/g, '...').replace(/^\d+\s*\.+\s*/, '').split(/\s+/);
      for (const token of tokens) {
        const moveText = token.replace(/0/g, 'O').replace(/[+#?!]+$/g, '');
        if (!/^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?$|^O-O(?:-O)?$/.test(moveText)) return null;
        board.move(moveText);
      }
    }
    return board.fen();
  } catch { return null; }
}
export type IndexedSelection = { entry: IndexedOpening; requestedTitle: string; ancestorPlies: number; transposition: boolean };
export function selectIndexedOpening(index: WikibooksIndex, title: string, maxAncestorPlies = 2, minSourcePlies = 0): IndexedSelection | null {
  let ancestor = title;
  for (let distance = 0; distance <= maxAncestorPlies && ancestor !== ROOT; distance++) {
    const fen = replayWikibooksTitle(ancestor);
    if (!fen) return null;
    const key = positionKey(fen), exact = index.byPath.get(ancestor) || [];
    const candidates = [...exact, ...(index.byPosition.get(key) || []).filter(e => !exact.includes(e))];
    for (const entry of candidates) {
      const actual = replayWikibooksTitle(entry.title);
      if (entry.plies >= minSourcePlies && entry.positionKey === key && actual && positionKey(actual) === key)
        return {entry, requestedTitle: title, ancestorPlies: distance, transposition: entry.canonicalTitle !== ancestor};
    }
    ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'));
  }
  return null;
}
