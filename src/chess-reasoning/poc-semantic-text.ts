/**
 * Board objects must travel as typed narrative segments. This pattern catches
 * piece names, coordinates, UCI, common SAN (including captures and
 * disambiguation), and castling when they leak into opaque text.
 */
export const RAW_CHESS_TEXT_PATTERN_SOURCE = String.raw`(?:\b(?:(?:[Ww]hite|[Bb]lack)(?:['’]s)?\s+)?(?:[Bb]ishop|[Kk]night(?!['’]s\s+[Ee]ye\b)|[Rr]ook|[Qq]ueen(?!-[Ss]ide\b)|[Kk]ing(?!-[Ss]ide\b)|[Pp]awn)\b|\b(?:[a-h][1-8][a-h][1-8][qrbn]?|[KQRBN][a-h1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?|O-O(?:-O)?|[a-h][1-8])\b)`;

export const RAW_CHESS_TEXT = new RegExp(RAW_CHESS_TEXT_PATTERN_SOURCE, "i");

export const SEMANTIC_TEXT_JSON_PATTERN = `^(?![\\s\\S]*${RAW_CHESS_TEXT_PATTERN_SOURCE})[\\s\\S]{1,600}$`;
