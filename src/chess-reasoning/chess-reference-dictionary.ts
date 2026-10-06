/** Stable, position-independent geometry. a1 is dark, regardless of orientation. */
export type SquareColor = 'light' | 'dark';

export function chessSquareColor(square: string): SquareColor | null {
  if (!/^[a-h][1-8]$/.test(square)) return null;
  return (square.charCodeAt(0) - 97 + Number(square[1]) - 1) % 2 === 0 ? 'dark' : 'light';
}

const squares = Array.from({ length: 64 }, (_, i) =>
  `${String.fromCharCode(97 + i % 8)}${1 + Math.floor(i / 8)}`);

/** Grouping is a complete square->colour dictionary without 64 repeated keys. */
export const CHESS_REFERENCE_DICTIONARY = Object.freeze({
  version: 'square-colors-v1',
  scope: 'Position-independent square colors; not piece ownership or a position assessment.',
  squareColors: Object.freeze({
    light: Object.freeze(squares.filter(square => chessSquareColor(square) === 'light')),
    dark: Object.freeze(squares.filter(square => chessSquareColor(square) === 'dark')),
  }),
  use: 'A bishop occupies squares of its color complex. Identify the bishop and the relevant position before applying this reference; do not infer which bishop a move frees from square colors alone.',
});
