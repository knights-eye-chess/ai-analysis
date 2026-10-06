import { Chess } from 'chess.js';

const pieces = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' } as const;
type Counts = Record<typeof pieces[keyof typeof pieces], number>;
const empty = (): Counts => ({ pawn: 0, knight: 0, bishop: 0, rook: 0, queen: 0 });
const difference = (a: Counts, b: Counts): Counts => Object.fromEntries(
  Object.values(pieces).map(name => [name, a[name] - b[name]]),
) as Counts;

/** Absolute counts, independent of turn, engine evaluation or starting inventory. */
export function materialAtPosition(board: Chess) {
  const white = empty(), black = empty();
  for (const piece of board.board().flat()) {
    if (piece && piece.type !== 'k') (piece.color === 'w' ? white : black)[pieces[piece.type]]++;
  }
  const whiteMinusBlack = difference(white, black);
  const extras = (sign: number) => Object.entries(whiteMinusBlack)
    .filter(([, n]) => n * sign > 0)
    .map(([name, n]) => `${Math.abs(n)} ${name}${Math.abs(n) === 1 ? '' : 's'}`);
  const w = extras(1), b = extras(-1);
  return { white, black, whiteMinusBlack, balance: !w.length && !b.length
    ? 'Equal piece counts.'
    : [w.length ? `White has ${w.join(' and ')} more than Black` : '',
      b.length ? `Black has ${b.join(' and ')} more than White` : ''].filter(Boolean).join('; ') + '.' };
}

/** Count by legal replay; never report a partial replay as a complete endpoint. */
export function materialAlongLine(startFen: string, movesUci: readonly string[]) {
  const board = new Chess(startFen), start = materialAtPosition(board);
  const changes: { ply: number; san: string; whiteMinusBlack: Counts; balance: string }[] = [];
  for (const [index, uci] of movesUci.entries()) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw Error('Invalid material replay move');
    const move = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    if (move.captured || move.promotion) {
      const { whiteMinusBlack, balance } = materialAtPosition(board);
      changes.push({ ply: index + 1, san: move.san, whiteMinusBlack, balance });
    }
  }
  const end = materialAtPosition(board);
  return { authority: 'legal-replay-piece-counts', startFen, plies: movesUci.length,
    start, changes, endFen: board.fen(), end,
    balanceChangeFromStart: difference(end.whiteMinusBlack, start.whiteMinusBlack),
    scope: 'Absolute piece counts at the stated positions; balanceChangeFromStart is only a change, not the final balance. Conditional line, not proof of force, safety or compensation.' };
}

export function materialForVariations<T extends { rootMove: string; pv: string[] }>(startFen: string, lines: readonly T[]) {
  return lines.map(line => {
    try {
      if (!line.pv.length || line.rootMove !== line.pv[0]) throw Error('Missing root');
      return { ...line, material: materialAlongLine(startFen, line.pv) };
    } catch {
      return { ...line, material: { status: 'unavailable', reason: 'The complete variation could not be legally replayed from its stated root.' } };
    }
  });
}
