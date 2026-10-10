import { Chess } from 'chess.js';
import { historicalProseRoots } from './historical-prose';
import { normalizedEvidenceCitations } from './evidence-citation-normalization';
import type { RecordedReferenceLine } from './historical-prose';
export type AuthoredReferenceResult = {label:string;target:string;resolved:boolean;reason?:string;canonicalLabel?:string};
import { MAX_INTERACTIVE_LINE_PLIES } from "./reference-limits";
import type { Square } from "chess.js";
import { createPocIdentityTimeline } from "./poc-piece-refs";
import { applyIdentityMove } from "./piece-identities";
import { reasoningEvidenceReplayStartPhase } from "./poc-move-witnesses";
import { reasoningContextHash, validateReasoningPositionContext, type ReasoningPositionContext, type ReasoningEvidenceRecord } from "./poc-contracts";
import { effectiveLicensesForRecord } from "./evidence-licenses";
import { admitFreshEnginePvWitnesses, type FreshEnginePvWitness, type FreshEnginePvReferenceEvidence } from './fresh-engine-pv-witnesses';
export type { FreshEnginePvWitness } from './fresh-engine-pv-witnesses';
export type SimpleProseReferenceOptions = { freshEnginePvWitnesses?: readonly FreshEnginePvWitness[] };
export type SimpleReferenceGapCounts = {
  version: 'simple-reference-gap-counts/1'; unboundProseSpans: number; unboundMentions: number;
  unresolvedReferences: number; unknownCitations: number; formattingWarnings: number;
};

export const SIMPLE_REFERENCE_VERSION = "simple-references/22";
const MAX_EVIDENCE_REPLAY_PLIES = 256;
const INTERNAL_WITNESS = Symbol('internal-evidence-witness');
const MAX_AUTHORED_REFERENCE_PLIES = MAX_INTERACTIVE_LINE_PLIES;
type Phase = "before" | "after";
export type SimplePosition = { recordedContext?: ReasoningPositionContext; start: Phase; moves: { uci: string; san: string; pieceId: string }[]; fen: string };
export type SimpleReference = { kind: "move" | "piece" | "square" | "sequence"; label: string; displayLabel?: string; position: SimplePosition;
  evidenceIds: string[]; engineEvidence?: FreshEnginePvReferenceEvidence[]; square?: string; pieceId?: string; san?: string; uci?: string; copyText?: string; pieceCode?: string };
export type SimpleToken = { text: string; reference?: SimpleReference; sourceLink?: { href: string }; gap?: string; variationIndex?: number; variationStart?: boolean; variationEnd?: boolean; variationPlayFrom?: number; variationMoveIndices?: number[] };
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

/** An authored piece SAN may omit only a canonical source file/rank. */
function compatibleMoveSan(authored: string, canonical: string) {
  if (authored.replace(/[+#]$/, '') === canonical.replace(/[+#]$/, '')) return true;
  const pattern = /^([KQRBN])([a-h]?)([1-8]?)(x?)([a-h][1-8])([+#]?)$/;
  const given = pattern.exec(authored), actual = pattern.exec(canonical);
  return Boolean(given && actual && (actual[2] || actual[3])
    && given[1] === actual[1] && given[4] === actual[4] && given[5] === actual[5]
    && (!given[2] || given[2] === actual[2]) && (!given[3] || given[3] === actual[3])
    && Number(Boolean(given[2])) + Number(Boolean(given[3])) < Number(Boolean(actual[2])) + Number(Boolean(actual[3])));
}

function canonicalMoveLabel(label: string, refs: readonly SimpleReference[]) {
  const parts = [...label.trim().matchAll(/(?:(\d+)?(\.{1,3}|…)[ \t]*)?([^\s.]+)/g)];
  if (parts.length !== refs.length || parts.map(part => part[0]).join('').replace(/\s/g, '') !== label.replace(/\s/g, '')) return label;
  let index = 0;
  return label.replace(/(?:(\d+)?(\.{1,3}|…)[ \t]*)?([^\s.]+)/g, (whole, _number, _dots, san: string) => {
    const ref = refs[index++];
    const canonical = ref.san;
    if (!canonical || !compatibleMoveSan(san.replace(/[!?]+$/, ''), canonical)) return whole;
    return whole.slice(0, whole.length - san.length) + canonical + (san.match(/[!?]+$/)?.[0] ?? '');
  });
}

/** Source attribution links are presentation-only; they never confer chess evidence. */
export function safeSimpleSourceLink(target: string): { href: string } | null {
  let url: URL;
  try { url = new URL(target); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
  if (url.hostname === "creativecommons.org") {
    return url.pathname === "/licenses/by-sa/4.0/" && !url.search ? { href: url.href } : null;
  }
  if (url.hostname !== "en.wikibooks.org" || url.pathname !== "/w/index.php") return null;
  const title = url.searchParams.getAll("title");
  if (title.length !== 1 || !title[0].trim()) return null;
  const keys = [...url.searchParams.keys()].sort();
  const revision = url.searchParams.get("oldid");
  if (keys.join(",") === "oldid,title" && revision && /^[1-9]\d*$/.test(revision) && Number.isSafeInteger(Number(revision))) return { href: url.href };
  if (keys.join(",") === "action,title" && url.searchParams.get("action") === "history") return { href: url.href };
  return null;
}

/** Preserve the model's prose while removing presentation-only fence markers. */
export function stripSimpleMarkdownFences(value: string) {
  return value.replace(/^[ \t]*```(?:text|plaintext|markdown|md|pgn|chess)?[ \t]*$/gim, "");
}

const internalCitationLink = /\[([^\]\n]+)\]\(\s*(?:evidence|recorded-main-line):[\w:-]+\s*\)/g;
/** Internal citation labels are not user prose or navigation. Raw output is retained. */
export function stripSimpleCitationLinks(value: string) {
  return value.replace(internalCitationLink, "");
}
/** Repair only trailing legacy labels attested as internal links in the raw answer. */
export function repairFrozenCitationLabels(value: string, rawParagraph: string) {
  let result = stripSimpleCitationLinks(value);
  const suffix = rawParagraph.match(/(?:\s*\[[^\]\n]+\]\(\s*(?:evidence|recorded-main-line):[\w:-]+\s*\))+\s*$/)?.[0];
  if (!suffix) return result;
  const labels = [...suffix.matchAll(internalCitationLink)].map(match => `[${match[1]}]`).reverse();
  for (const label of labels) {
    const trimmed = result.trimEnd();
    if (!trimmed.endsWith(label)) break;
    result = trimmed.slice(0, -label.length).trimEnd();
  }
  return result;
}

/** Presentation admission only: no claim-entailment or strategic validator. */
export function simpleProseReferences(answer: string, context: ReasoningPositionContext, records: readonly ReasoningEvidenceRecord[], recordedLine?: RecordedReferenceLine, recordedPath?: string[], onReference?: (reference:AuthoredReferenceResult) => void, internalWitness?: typeof INTERNAL_WITNESS | SimpleProseReferenceOptions) {
  const authoredPathLimit = internalWitness === INTERNAL_WITNESS ? MAX_EVIDENCE_REPLAY_PLIES : MAX_AUTHORED_REFERENCE_PLIES;
  validateReasoningPositionContext(context);
  answer = normalizedEvidenceCitations(answer, records.filter(record => record.contextHash === reasoningContextHash(context))).answer;
  answer = stripSimpleMarkdownFences(answer);
  const historical = historicalProseRoots(context, records, recordedLine);
  const historicalVariations: Array<{start:Phase;ucis:string[];evidenceIds:string[];authority:string;recordedContext:ReasoningPositionContext}> = [];
  const historicalRefs = new Map<string, SimpleReference[]>();
  const timeline = createPocIdentityTimeline(context), hash = reasoningContextHash(context);
  const evidence = records.filter(record => {
    if (record.contextHash !== hash) return false;
    try { effectiveLicensesForRecord(record); return true; } catch { return false; }
  });
  // Request-local only: exact root and ordered path, never shared across answers.
  const replayCache = new Map<string, { state: typeof timeline.before; position: SimplePosition; copyText: string }>();
  const replay = (start: Phase, ucis: string[]) => {
    // Evidence can have a long PV; authored targets retain their separate 32-ply cap.
    if (ucis.length > MAX_EVIDENCE_REPLAY_PLIES || ucis.some(uci => !UCI.test(uci))) throw Error("Invalid or overlong path");
    const key = `${start}:${ucis.join(",")}`;
    const cached = replayCache.get(key);
    if (cached) return cached;
    let state = timeline[start];
    const moves: SimplePosition["moves"] = [];
    let copyText = "";
    for (const uci of ucis) {
      const fen = state.fen.split(" ");
      const applied = applyIdentityMove(state, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
      moves.push({ uci, san: applied.delta.san, pieceId: applied.delta.mover });
      copyText = `${fen[5]}${fen[1] === "b" ? "..." : "."} ${applied.delta.san}`;
      state = applied.state;
    }
    const result = { state, position: { start, moves, fen: state.fen } as SimplePosition, copyText };
    replayCache.set(key, result);
    return result;
  };
  const freshEnginePvAdmission = admitFreshEnginePvWitnesses(context, typeof internalWitness === 'object' ? internalWitness.freshEnginePvWitnesses ?? [] : []);
  const lines: { start: Phase; ucis: string[]; evidenceIds: string[]; authority: string; engineEvidence?: FreshEnginePvReferenceEvidence[] }[] = freshEnginePvAdmission.lines;
  if (recordedPath?.length) {
    try { replay('after',recordedPath); lines.push({start:'after',ucis:recordedPath,evidenceIds:[],authority:'Recorded game play'}); } catch { /* Invalid record path is not admitted. */ }
  }
  const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  for (const record of evidence) {
    if (record.data.recordedPosition) continue;
    const replayPhase = reasoningEvidenceReplayStartPhase(record, context);
    const start = replayPhase && context.kind === "position" ? "after" : replayPhase, r = record.replay;
    // test_line's separate engine record starts at the tested line's endpoint.
    // Its explicit phase + played prefix must reproduce BOTH declared FENs;
    // never infer a root by searching the board or joining unrelated records.
    const phase = record.data.phase, played = record.data.played, scope = object(record.data.searchScope);
    if ((phase === "before" || phase === "after") && Array.isArray(played) && Array.isArray(record.data.lines)
      && effectiveLicensesForRecord(record).includes("engine.bounded-continuation")) {
      try {
        const prefix = played.map(move => object(move)?.uci);
        if (prefix.some(uci => typeof uci !== "string")) throw Error("Invalid tested prefix");
        const tested = replay(phase, prefix as string[]);
        if (tested.position.fen !== r?.fen || tested.position.fen !== scope?.fen || tested.position.fen !== record.data.finalFen) throw Error("Tested endpoint mismatch");
        if (tested.position.moves.some((move, index) => move.san !== object(played[index])?.san)) throw Error("Tested SAN mismatch");
        for (const candidate of record.data.lines) {
          const line = object(candidate), pv = line?.pv;
          if (!Array.isArray(pv) || !pv.length || pv.some(uci => typeof uci !== "string") || line?.rootMove !== pv[0]) continue;
          try {
            const ucis = [...prefix, ...pv] as string[];
            replay(phase, ucis);
            lines.push({ start: phase, ucis, evidenceIds: [record.id], authority: "Bounded engine line" });
          } catch { /* Never admit an invalid tail. */ }
        }
      } catch { /* A malformed continuation record contributes no path. */ }
    }
    if (!start || !r) continue;
    const sequence = r.movesUci ?? r.moves ?? r.line ?? (r.move ? [r.move] : []);
    const candidates = [sequence, ...(Array.isArray(r.linesUci) ? r.linesUci : [])];
    // Older producers retained only a replay prefix while delivering the full
    // engine PV. Admit its extension only in the same exact licensed scope,
    // with an existing matching witness and a completely legal tail.
    if ((phase === start || context.kind === "position" && phase === replayPhase) && scope?.fen === r.fen && r.fen === timeline[start].fen
      && Array.isArray(record.data.lines) && effectiveLicensesForRecord(record).some(license => license === "engine.bounded-continuation" || license === "engine.bounded-comparison")) {
      for (const candidate of record.data.lines) {
        const line = object(candidate), pv = line?.pv;
        if (!Array.isArray(pv) || !pv.length || pv.some(uci => typeof uci !== "string")
          || line?.rootMove !== pv[0] || object(line?.scoreScope)?.fen !== r.fen) continue;
        if (!candidates.some(prefix => Array.isArray(prefix) && prefix.length > 0
          && prefix.length <= pv.length && prefix.every((uci, index) => uci === pv[index]))) continue;
        try {
          replay(start, pv as string[]);
          lines.push({ start, ucis: pv as string[], evidenceIds: [record.id], authority: "Bounded engine line" });
        } catch { /* Invalid full PVs never supply a partial extension. */ }
      }
    }
    for (const value of candidates) {
      if (!Array.isArray(value) || !value.length || value.some(x => typeof x !== "string")) continue;
      try {
        replay(start, value as string[]); // Full line must be legal, including omitted tail.
        lines.push({ start, ucis: value as string[], evidenceIds: [record.id], authority: effectiveLicensesForRecord(record).some(license => license.startsWith("engine.bounded-")) ? "Bounded engine line" : "Illustrative legal line" });
      } catch { /* Invalid evidence replay is never partially admitted. */ }
    }
  }
  const normalizedPath = (start: Phase, moves: string[]) => context.kind === "position" ? { start: "after", moves } : start === "before" && moves[0] === context.moveUci
    ? { start: "after", moves: moves.slice(1) } : { start, moves };
  const matchingLines = (start: Phase, moves: string[]) => {
    if (!moves.length) return [];
    const path = normalizedPath(start, moves);
    if (!path.moves.length) return [];
    return lines.filter(line => { const candidate = normalizedPath(line.start, line.ucis); return candidate.start === path.start && path.moves.every((uci, i) => candidate.moves[i] === uci); });
  };
  // Aliases are declared in this answer only, after exact-context evidence
  // admission. No global registry, previous-answer lookup, or persisted pointer.
  const registered = new Map<string, { start: Phase; ucis: string[] }>();
  const rejected = new Set<string>();
  for (const match of answer.matchAll(/\[([^\]\n]+)\]\(line:([a-zA-Z][a-zA-Z0-9_-]{0,15}):(before|after):([^)\n]+)\)/g)) {
    const [, label, id, start, path] = match;
    if (registered.has(id) || rejected.has(id)) { registered.delete(id); rejected.add(id); continue; }
    try {
      const ucis = path.split(",");
      if (!ucis.length || ucis.length > authoredPathLimit || id === "before" || id === "after") throw Error("Unsupported registered line");
      const terminal = replay(start as Phase, ucis); // Validate the entire tail, not just a cited ply.
      const authored = label.replace(/^(?:\d+)?(?:\.{1,3}|…)\s*/, "").replace(/[!?]+$/, "");
      if (ucis.length === 1 && !compatibleMoveSan(authored, terminal.position.moves.at(-1)?.san ?? '')) throw Error("Registered SAN mismatch");
      if (!matchingLines(start as Phase, ucis).length) throw Error("Unwitnessed registered line");
      registered.set(id, { start: start as Phase, ucis });
    } catch { rejected.add(id); }
  }
  const canonicalTarget = (target: string) => {
    const [kind, id, ply, square, ...extra] = target.split(":");
    if (id === "before" || id === "after") return target;
    if (!["line", "move", "piece", "square"].includes(kind)) return target;
    const line = registered.get(id);
    if (!line || rejected.has(id)) throw Error("Unknown or invalid answer-local variation");
    if (kind === "line") {
      if (ply !== line.start || square !== line.ucis.join(",") || extra.length) throw Error("Invalid variation declaration");
      return `move:${line.start}:${line.ucis.join(",")}`;
    }
    if (!/^(0|[1-9]\d*)$/.test(ply) || Number(ply) > line.ucis.length || extra.length
      || (kind === "move" && (square !== undefined || Number(ply) === 0))
      || (kind !== "move" && !/^[a-h][1-8]$/.test(square || ""))) throw Error("Invalid variation ply");
    const prefix = line.ucis.slice(0, Number(ply)).join(",");
    return `${kind}:${line.start}:${prefix}${kind === "move" ? "" : `:${square}`}`;
  };
  const notationCorrections: string[] = [];
  const resolve = (label: string, target: string): SimpleReference => {
    const parts = target.split(":"), kind = parts.shift(), start = parts.shift();
    if (!["move", "piece", "square"].includes(kind || "") || (start !== "before" && start !== "after")) throw Error("Missing exact position");
    // A square-only label is an unambiguous coordinate, not natural-language
    // inference. Tolerate the omitted terminal square only for a valid UCI list.
    const implicitSquare = kind === "square" && /^[a-h][1-8]$/.test(label)
      && parts.length === 1 && parts[0].split(",").every(uci => UCI.test(uci));
    const square = kind === "move" ? undefined : implicitSquare ? label : parts.pop();
    const ucis = parts.length === 1 && parts[0] ? parts[0].split(",") : [];
    if (parts.length > 1 || ucis.length > authoredPathLimit) throw Error("Unsupported replay path");
    const result = replay(start, ucis), matching = matchingLines(start, ucis);
    if (ucis.length > 1 && !matching.length) throw Error("Path not witnessed in acquired evidence");
    const evidenceIds = [...new Set(matching.flatMap(line => line.evidenceIds))];
    const witnessedEngineEvidence = matching.flatMap(line => line.engineEvidence ?? []);
    const engineEvidence = witnessedEngineEvidence.length ? { engineEvidence: witnessedEngineEvidence } : {};
    if (kind === "move") {
      const last = result.position.moves.at(-1);
      const authored = label.replace(/^(?:\d+)?(?:\.{1,3}|…)\s*/, "").replace(/[!?]+$/, "");
      if (!last || !compatibleMoveSan(authored, last.san)) throw Error("Move label does not match legal SAN");
      const mover = result.state.pieces[last.pieceId];
      return { kind, label: last.san, ...last, position: result.position, copyText: result.copyText, evidenceIds, ...engineEvidence, pieceCode: mover.color + mover.type };
    }
    if (!square || !/^[a-h][1-8]$/.test(square)) throw Error("Invalid square");
    if (kind === "square") {
      if (/^[a-h][1-8]$/.test(label) && label !== square) throw Error("Square label mismatch");
      return { kind, label: square, displayLabel: label, square, position: result.position, evidenceIds, ...engineEvidence };
    }
    const pieceId = result.state.squares[square as Square], piece = pieceId && result.state.pieces[pieceId];
    if (!piece) throw Error("No piece at the scoped square");
    // Labels are arbitrary localized prose. Only the replayed board supplies
    // identity and the accessible name; visible wording remains model-authored.
    const canonicalLabel = `${piece.color === "w" ? "White" : "Black"} ${names[piece.type]} on ${square}`;
    return { kind: "piece", label: canonicalLabel, displayLabel: label, square, pieceId: piece.id, pieceCode: piece.color + piece.type, position: result.position, evidenceIds, ...engineEvidence };
  };
  // A labelled move link can show the terminal move or a contiguous SAN suffix.
  // Preserve valid SAN labels; prose labels remain one witnessed playback link.
  const resolveLabel = (label: string, target: string): SimpleReference[] => {
    if (!target.startsWith("move:")) return [resolve(label, target)];
    const [kind, phase, path, ...extra] = target.split(":");
    if (extra.length || !path || (phase !== "before" && phase !== "after")) throw Error("Missing exact position");
    const ucis = path.split(",");
    try {
      // Remove numbering separately so both "2. d4" and "2.d4" are accepted.
      const labels = [...label.trim().matchAll(/(?:(\d+)?(\.{1,3}|…)\s*)?([^\s.]+)/g)];
      if (!labels.length || labels.length > ucis.length
        || labels.map(match => match[0]).join("").replace(/\s/g, "") !== label.replace(/\s/g, "")) throw Error("Move label does not match legal SAN");
      const offset = ucis.length - labels.length;
      return labels.map((match, index) => {
        const ref = resolve(match[3], `${kind}:${phase}:${ucis.slice(0, offset + index + 1).join(",")}`);
        if (match[1]) {
          const prefix = ref.copyText!.split(" ")[0];
          const expected = `${Number(match[1])}${match[2] === "." ? "." : "..."}`;
          if (expected !== prefix) throw Error("Move number does not match legal position");
        }
        return ref;
      });
    } catch (error) {
      if (ucis.length < 2) throw error;
      // The target is navigation authority; prose labels cannot supply a path.
      // Validate the entire path and witness before deriving any replacement.
      const result = replay(phase, ucis);
      if (!matchingLines(phase, ucis).length) throw Error("Path not witnessed in acquired evidence");
      const terminal = result.position.moves.at(-1)!;
      const validated = resolve(terminal.san, target);
      return [{ kind: 'sequence', label, position: validated.position, evidenceIds: validated.evidenceIds,
        ...(validated.engineEvidence ? { engineEvidence: validated.engineEvidence } : {}) }];
    }
  };
  const gaps: string[] = [], usedLines = new Map<string, typeof lines[number]>();
  const referenceGapCounts: SimpleReferenceGapCounts = { version: 'simple-reference-gap-counts/1',
    unboundProseSpans: 0, unboundMentions: 0, unresolvedReferences: 0, unknownCitations: 0, formattingWarnings: 0 };
  let resolved = 0, total = 0;
  const blocks = answer.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).filter(Boolean).map(raw => {
    const cited = [...raw.matchAll(/(?:evidence|recorded-main-line):[\w:-]+/g)].map(match => match[0]);
    for (const id of cited) if (!evidence.some(record => record.id === id)) {
      referenceGapCounts.unknownCitations++;
      gaps.push(`Unknown citation: ${id}`);
    }
    const withoutCitationControls = raw.replace(/\uE200cite[^\uE201]*\uE201/g, "");
    if (withoutCitationControls !== raw) {
      referenceGapCounts.formattingWarnings++;
      gaps.push("Provider citation formatting hidden; raw output remains in the trace.");
    }
    const text = historical.annotate(stripSimpleCitationLinks(withoutCitationControls).replace(/\[(?:\s*(?:evidence|recorded-main-line):[\w:-]+\s*[,;]?\s*)+\]/g, "").replace(/(?:evidence|recorded-main-line):[\w:-]+/g, "").replace(/\([\s,;]*\)/g, "").trim());
    const tokens: SimpleToken[] = [];
    const plain = (value: string) => {
      if (!value) return;
      // Count unbound concrete chess mentions without guessing their context.
      const unbound = value.match(/\b(?:[KQRBN](?:[a-h1-8])?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?\b|\b(?:the|White(?:’s|'s)?|Black(?:’s|'s)?) (?:knight|bishop|rook|queen|king|pawn)\b/g) || [];
      total += unbound.length;
      if (unbound.length) {
        referenceGapCounts.unboundProseSpans++;
        referenceGapCounts.unboundMentions += unbound.length;
        gaps.push(`Unbound text: ${unbound.join(", ")}`);
      }
      tokens.push({ text: value });
    };
    let end = 0;
    for (const match of text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
      plain(text.slice(end, match.index));
      const sourceLink = safeSimpleSourceLink(match[2]);
      if (sourceLink) {
        tokens.push({ text: match[1], sourceLink });
        end = match.index! + match[0].length;
        continue;
      }
      total++;
      try {
        let refs: SimpleReference[];
        if (match[2].startsWith('game:')) {
          const parsed = /^game:(\d+):([a-h1-8qrbn,]+)$/.exec(match[2]);
          const root = parsed && historical.roots.get(Number(parsed[1]));
          if (!parsed || !root) throw Error('Unknown recorded position');
          const path = parsed[2].split(',');
          // Recorded actual paths are authoritative for navigation, not chess conclusions.
          const actual = historical.recorded?.slice(Number(parsed[1]),Number(parsed[1])+path.length);
          const isActual = actual?.length === path.length && actual.every((uci,i)=>uci===path[i]);
          let v=simpleProseReferences(`[${match[1]}](move:after:${parsed[2]})`,root.context,root.records,undefined,isActual?path:undefined);
          let witnessedRefs=v.blocks.flatMap(b=>b.tokens.flatMap(t=>t.reference?[t.reference]:[]));
          let suffixWitness: {evidenceIds:string[];authority:string}|undefined;
          if(!witnessedRefs.length || v.gaps.some(g=>!g.startsWith('Unbound'))) {
            // An engine witness rooted before this game link may contain the
            // exact suffix. The omitted moves must be actual recorded play;
            // validate the whole original source path with the usual evidence
            // admission before projecting navigation to this later root.
            for(const candidate of historical.witnessedSuffixes(Number(parsed[1]),path)) {
              const board=new Chess(candidate.root.context.fenAfter);
              const fullLabel=candidate.path.map(uci=>{
                const f=board.fen().split(' '),san=board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}).san;
                return `${f[5]}${f[1]==='w'?'.':'...'}${san}`;
              }).join(' ');
              const source=simpleProseReferences(`[${fullLabel}](move:after:${candidate.path.join(',')})`,candidate.root.context,candidate.root.records,undefined,undefined,undefined,INTERNAL_WITNESS);
              const sourceRefs=source.blocks.flatMap(b=>b.tokens.flatMap(t=>t.reference?[t.reference]:[]));
              if(source.coverage.resolved!==1 || source.gaps.some(g=>!g.startsWith('Unbound')) || sourceRefs.length!==candidate.path.length)continue;
              const evidenceIds=sourceRefs.at(-1)?.evidenceIds ?? [];
              if(!evidenceIds.length)continue;
              const sourceLine=source.variations.find(line=>line.ucis.join(',')===candidate.path.join(','));
              if(!sourceLine)continue;
              const projected=simpleProseReferences(`[${match[1]}](move:after:${parsed[2]})`,root.context,[],undefined,path);
              const projectedRefs=projected.blocks.flatMap(b=>b.tokens.flatMap(t=>t.reference?[t.reference]:[]));
              if(projected.coverage.resolved!==1 || projected.gaps.some(g=>!g.startsWith('Unbound')) || !projectedRefs.length)continue;
              suffixWitness={evidenceIds,authority:sourceLine.authority};
              v={...projected,variations:projected.variations.map(line=>({...line,evidenceIds,authority:sourceLine.authority,
                references:line.references.map(ref=>({...ref,evidenceIds}))}))};
              witnessedRefs=projectedRefs.map(ref=>({...ref,evidenceIds}));
              break;
            }
          }
          refs=witnessedRefs.map(ref=>({...ref,position:{...ref.position,recordedContext:root.context}}));
          if(!refs.length || v.gaps.some(g=>!g.startsWith('Unbound')))throw Error('Unwitnessed historical path');
          let witnessedVariations = v.variations;
          if (!witnessedVariations.length && path.length > 1) {
            const board = new Chess(root.context.fenAfter);
            const sans = path.map(uci=>board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}).san).join(' ');
            const expanded = simpleProseReferences(`[${sans}](move:after:${parsed[2]})`,root.context,suffixWitness?[]:root.records,undefined,suffixWitness?path:isActual?path:undefined).variations;
            witnessedVariations = suffixWitness ? expanded.map(line=>({...line,evidenceIds:suffixWitness.evidenceIds,authority:suffixWitness.authority,
              references:line.references.map(ref=>({...ref,evidenceIds:suffixWitness.evidenceIds}))})) : expanded;
          }
          for(const line of witnessedVariations) {
            historicalVariations.push({...line,recordedContext:root.context});
            historicalRefs.set(`${reasoningContextHash(root.context)}:${line.ucis.join(',')}`,line.references.map(r=>({...r,position:{...r.position,recordedContext:root.context}})));
          }
        } else refs = resolveLabel(match[1], canonicalTarget(match[2]));
        const canonicalLabel = refs.every(ref => ref.kind === 'move') ? canonicalMoveLabel(match[1], refs) : match[1];
        if (canonicalLabel !== match[1]) notationCorrections.push(`${match[1]} → ${canonicalLabel} (derived from legal replay)`);
        onReference?.({label:match[1],target:match[2],resolved:true,canonicalLabel});
        resolved++;
        for (const [index, ref] of refs.entries()) {
          if (index) tokens.push({ text: " " });
          tokens.push({ text: ref.label, reference: ref });
          const ucis = ref.position.moves.map(move => move.uci);
          if (!ref.position.recordedContext && ref.kind === "move" && ucis.length) for (const line of matchingLines(ref.position.start, ucis)) {
            // Offer exactly the cited/witnessed prefix, never an unmentioned tail.
            if (ucis.length > 1) {
              const key = `${ref.position.start}:${ucis.join(",")}`, previous = usedLines.get(key);
              usedLines.set(key, { ...line, start: ref.position.start, ucis,
                evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), ...line.evidenceIds])],
                ...((previous?.engineEvidence?.length || line.engineEvidence?.length) ? {
                  engineEvidence: [...(previous?.engineEvidence ?? []), ...(line.engineEvidence ?? [])].filter((item, index, all) =>
                    all.findIndex(other => other.evidenceId === item.evidenceId && other.rootMove === item.rootMove) === index),
                } : {}),
                authority: previous?.authority === "Bounded engine line" ? previous.authority : line.authority });
            }
          }
        }
      } catch (error) {
        referenceGapCounts.unresolvedReferences++;
        const gap = `${match[1]}: ${error instanceof Error ? error.message : "Unresolved reference"}`;
        onReference?.({label:match[1],target:match[2],resolved:false,reason:gap});
        gaps.push(gap); tokens.push({ text: match[1], gap });
      }
      end = match.index! + match[0].length;
    }
    plain(text.slice(end));
    return { tokens, evidenceIds: cited.filter(id => evidence.some(record => record.id === id)), leadingVariationIndex: undefined as number | undefined };
  });
  const variations: Array<typeof lines[number] & {recordedContext?:ReasoningPositionContext}> = [...usedLines.values(), ...historicalVariations];
  decorateSimpleVariations(blocks, variations);
  const visibleVariations = new Set(blocks.flatMap(block => block.tokens.flatMap(token => token.variationIndex === undefined ? [] : [token.variationIndex])));
  const visibleIndices = [...visibleVariations].sort((a, b) => a - b);
  for (const block of blocks) for (const token of block.tokens) if (token.variationIndex !== undefined)
    token.variationIndex = visibleIndices.indexOf(token.variationIndex);
  for (const block of blocks) if (block.leadingVariationIndex !== undefined)
    block.leadingVariationIndex = visibleIndices.indexOf(block.leadingVariationIndex);
  return { blocks, evidence, gaps, notationCorrections, coverage: { resolved, total },
    ...(typeof internalWitness === 'object' ? { freshEnginePvAdmission: freshEnginePvAdmission.audit, referenceGapCounts } : {}),
    variations: visibleIndices.map(index => variations[index]).map(line => ({
    ...line, position: line.recordedContext ? historicalRefs.get(`${reasoningContextHash(line.recordedContext)}:${line.ucis.join(',')}`)!.at(-1)!.position : replay(line.start, line.ucis).position,
    references: line.recordedContext ? historicalRefs.get(`${reasoningContextHash(line.recordedContext)}:${line.ucis.join(',')}`)! : replay(line.start, line.ucis).position.moves.map((move, index) =>
      resolve(move.san, `move:${line.start}:${line.ucis.slice(0, index + 1).join(",")}`)),
  })) };
}

/** Formatting only: use already validated paths, including persisted answer views. */
export function decorateSimpleVariations(
  blocks: { tokens: SimpleToken[]; leadingVariationIndex?: number }[],
  variations: readonly { start: Phase; ucis: string[]; recordedContext?:ReasoningPositionContext }[],
) {
  const sameRoot = (a?:ReasoningPositionContext,b?:ReasoningPositionContext) => (!a&&!b) || Boolean(a&&b&&a.historyStartFen===b.historyStartFen&&a.moveUci===b.moveUci&&a.historyUci.join(',')===b.historyUci.join(','));
  for (const block of blocks) {
    block.leadingVariationIndex = undefined;
    for (const token of block.tokens) { delete token.variationIndex; delete token.variationStart; delete token.variationEnd; delete token.variationPlayFrom; delete token.variationMoveIndices; }
  }
  // Number-only text is notation, not intervening prose. Normalize only
  // between consecutive legally resolved occurrences of the same path.
  for (const block of blocks) for (let i = 1; i < block.tokens.length - 1; i++) {
    const token = block.tokens[i], previous = block.tokens[i - 1].reference, next = block.tokens[i + 1].reference;
    if (token.reference || !/^[\s,;]*(?:\d+\s*(?:\.{1,3}|…)\s*)+$/.test(token.text)
      || previous?.kind !== "move" || next?.kind !== "move" || !sameRoot(previous.position.recordedContext,next.position.recordedContext) || previous.position.start !== next.position.start
      || next.position.moves.length !== previous.position.moves.length + 1
      || !previous.position.moves.every((move, index) => move.uci === next.position.moves[index].uci)) continue;
    token.text = " ";
  }
  // Attach only at an exact witnessed occurrence, never by matching prose SAN.
  // Suppress shorter prefixes only within this paragraph, preserving earlier explanations.
  for (const block of blocks) {
    const mentioned = variations.map((line, variationIndex) => ({ line, variationIndex,
      candidates: block.tokens.filter(token => token.reference?.kind === "move"
        && sameRoot(token.reference.position.recordedContext,line.recordedContext)
        && token.reference.position.start === line.start
        && token.reference.position.moves.length === line.ucis.length
        && token.reference.position.moves.every((move, i) => move.uci === line.ucis[i]))
    })).filter(item => item.candidates.length);
    for (const item of mentioned) {
      if (mentioned.some(other => sameRoot(other.line.recordedContext,item.line.recordedContext) && other.line.start === item.line.start && other.line.ucis.length > item.line.ucis.length
        && item.line.ucis.every((uci, i) => other.line.ucis[i] === uci))) continue;
      const target = item.candidates.find(token => token.reference?.kind === "move") ?? item.candidates[0];
      if (target.reference?.kind === "move") {
        const belongs = (token: SimpleToken) => token.reference?.kind === "move"
          && sameRoot(token.reference.position.recordedContext,item.line.recordedContext)
          && token.reference.position.start === item.line.start
          && token.reference.position.moves.length <= item.line.ucis.length
          && token.reference.position.moves.every((move, i) => move.uci === item.line.ucis[i]);
        const end = block.tokens.indexOf(target);
        const mentions = block.tokens.slice(0, end + 1).map((token, index) => ({ token, index })).filter(({ token }) => belongs(token));
        // A navigation path is not a displayed combination. A lone endpoint
        // (or repeated mention of it) keeps its move link, without replay.
        if (new Set(mentions.map(({ token }) => token.reference!.position.moves.length)).size < 2) continue;
        target.variationIndex = item.variationIndex;
        const interrupted = mentions.length > 1 && block.tokens.slice(mentions[0].index, end)
          .some(token => !belongs(token) && (token.reference || !/^[\s,;*]*$/.test(token.text)));
        if (interrupted) {
          // Replay only witnessed mentions; the board positions omitted prerequisites.
          target.variationMoveIndices = [...new Set(mentions.map(({ token }) => token.reference!.position.moves.length - 1))].sort((a, b) => a - b);
          // Only a single coherent line owns a paragraph-leading action. Mixed
          // comparisons retain their per-line action at the exact endpoint.
          const distinctMoves = new Set(mentions.map(({ token }) => token.reference!.position.moves.length));
          if (distinctMoves.size > 1 && block.tokens.filter(token => token.reference?.kind === "move").every(belongs)
            && !/^\s*(?:#{1,3} |[-*] |\d+\. )/.test(block.tokens[0]?.text || "")) block.leadingVariationIndex = item.variationIndex;
          continue;
        }
        let first = block.tokens.indexOf(target), nextLength = target.reference.position.moves.length;
        for (let cursor = first - 1; cursor >= 0; cursor--) {
          const prior = block.tokens[cursor];
          if (!prior.reference && /^[\s,;]*$/.test(prior.text)) continue;
          const ref = prior.reference;
          if (ref?.kind !== "move" || !sameRoot(ref.position.recordedContext,item.line.recordedContext) || ref.position.start !== item.line.start
            || ref.position.moves.length !== nextLength - 1
            || !ref.position.moves.every((move, i) => move.uci === item.line.ucis[i])) break;
          first = cursor; nextLength--;
        }
        if (first !== block.tokens.indexOf(target)) {
          const prefix = block.tokens[first - 1];
          if (prefix && !prefix.reference) prefix.text = prefix.text.replace(/\b\d+\s*(?:\.{1,3}|…)\s*$/, "");
          block.tokens[first].variationStart = true;
          target.variationEnd = true;
          target.variationPlayFrom = nextLength - 1;
        }
      }
    }
  }
}
