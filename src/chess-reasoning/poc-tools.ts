import { moveMechanismFacts } from './move-mechanism-facts';
import { expandPrincipalBranches, type BranchExpansionConfig } from './branch-expansion';
import { materialAlongLine, materialAtPosition, materialForVariations } from './material-accounting';
import { MAX_INTERACTIVE_LINE_PLIES } from "./reference-limits";
import { Chess, SQUARES, type Color, type Square } from "chess.js";
import type { ConceptRegistry } from "./concept-registry";
import { applyIdentityMove } from "./piece-identities";
import { EXPLAIN_PLAN_SELECTION_DESCRIPTOR } from "./poc-hypotheses";
import { resolveAndSelectPlan } from "./poc-plan-model";
import { createPocIdentityTimeline, pieceIdAt } from "./poc-piece-refs";
import { stableHash } from "./stable";
import { withEvidenceLicenses } from "./evidence-licenses";
import { scopePositionAnalysis } from "./position-analysis-scope";
import { matchedRootComparison } from './matched-comparison';
import {
  REASONING_POC_VERSION,
  reasoningContextHash,
  validateReasoningPositionContext,
  type ReasoningEvidenceKind,
  type ReasoningEvidenceRecord,
  type ReasoningPositionContext,
  type ReasoningToolDescriptor,
  type ReasoningToolName,
  type ReasoningToolResult,
  type ReasoningToolSet,
  type ReasoningToolExecutionContext,
} from "./poc-contracts";
import type { IdeaGraph, IdentityState, ProofStrength, SemanticEntity, SemanticRelation, SemanticValue } from "./types";

export type PositionAnalysisLine = {
  rootMove: string;
  pv: string[];
  depth: number;
  nodes: number | null;
  scoreCp: number | null;
  /** @deprecated Legacy name: signed mate distance in moves, NOT plies. Rename before public release. */
  matePly: number | null;
  /** Added at the adapter/tool boundary; old saved records remain unchanged. */
  scoreScope?: Record<string, string>;
  scoreProvenance?: Record<string, SemanticValue>;
  /** The unmodified engine line from the original search root. */
  rawPv?: string[];
  /** Joined endpoint searches are conditional, each with its own score/search scope. */
  pvCompletion?: {
    requestedPlies: number;
    actualPlies: number;
    status: "complete" | "terminal" | "short-budget" | "short-attempt-limit" | "short-no-progress" | "short-error" | "invalid";
    conditional: boolean;
    segments: Array<{
      fen: string; startPly: number; depth: number; pv: string[];
      scoreCp: number | null; matePly: number | null; scoreScope?: Record<string, string>;
      scoreProvenance?: Record<string, SemanticValue>;
      command: string; engine: string; engineBuild: string;
      cacheProvenance: string;
    }>;
  };
};

export type PositionAnalysisRequest = {
  fen: string;
  depth: number;
  multiPv: number;
  rootMoves: string[];
  minimumPvPlies?: number;
  /** Defaults to `default`; `bypass` is reserved for independently sampled probes. */
  cachePolicy?: "default" | "bypass";
  signal?: AbortSignal;
};

/** Identifies the exact local source that supplied a browser analysis result. */
export type PositionAnalysisCacheProvenance = "engine" | "widget-analysis-cache" | "browser-completed-cache";

export type PositionAnalysisResult = {
  engine: string;
  engineBuild: string;
  command: string;
  bestMove: string | null;
  lines: PositionAnalysisLine[];
  /** Present for browser-backed analyses so callers can distinguish local reuse from a search. */
  cacheProvenance?: PositionAnalysisCacheProvenance;
  sourceCacheProvenance?: PositionAnalysisCacheProvenance;
};

export interface PositionAnalysisProvider {
  analyze(request: PositionAnalysisRequest): Promise<PositionAnalysisResult>;
}

export type PocToolHostOptions = {
  analyzer?: PositionAnalysisProvider;
  graph?: IdeaGraph;
  registry?: ConceptRegistry;
  defaultDepth?: number;
  minimumDepth?: number;
  maxDepth?: number;
  maxRootMoves?: number;
  leadingAlternative?: {fen:string;uci:string;evidenceId:string};
  /** Explicit, bounded option; omitted for ordinary hosts. */
  branchExpansion?: BranchExpansionConfig;
};

const TOOL_DESCRIPTORS: ReasoningToolDescriptor[] = [
  {
    name: "inspect_position",
    category: "fact",
    description: "inspect_position", // Provider-facing prose is injected by the server policy.
    inputSchema: {
      type: "object",
      properties: {
        phase: { type: "string", enum: ["before", "after"] },
        squares: { type: "array", maxItems: 12, items: { type: "string", maxLength: 300, pattern: "^[a-h][1-8]$" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "analyze_move",
    category: "fact",
    description: "analyze_move", // Provider-facing prose is injected by the server policy.
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "explore_continuations",
    category: "probe",
    description: "explore_continuations", // Provider-facing prose is injected by the server policy.
    inputSchema: {
      type: "object",
      required: ["phase"],
      properties: {
        phase: { type: "string", enum: ["before", "after"] },
        minimumPvPlies: { type: "integer", minimum: 1, maximum: 32 },
        multiPv: { type: "integer", minimum: 1, maximum: 3 },
        depth: { type: "integer", minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "compare_moves",
    category: "probe",
    description: "compare_moves", // Provider-facing prose is injected by the server policy.
    inputSchema: {
      type: "object",
      required: ["phase", "movesUci"],
      properties: {
        phase: { type: "string", enum: ["before", "after"] },
        movesUci: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", maxLength: 300 } },
        depth: { type: "integer", minimum: 1, maximum: 30 },
        minimumPvPlies: { type: "integer", minimum: 1, maximum: 32 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "enumerate_defenses",
    category: "probe",
    description: "enumerate_defenses", // Provider-facing prose is injected by the server policy.
    inputSchema: {
      type: "object",
      required: ["rootMoves"],
      properties: {
        rootMoves: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", maxLength: 300 } },
        depth: { type: "integer", minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "test_line",
    category: "probe",
    description: "test_line", // Provider-facing prose is injected by the server policy.
    inputSchema: {
      type: "object",
      required: ["phase", "movesUci"],
      properties: {
        phase: { type: "string", enum: ["before", "after"] },
        movesUci: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", maxLength: 300 } },
        inspectSquares: { type: "array", maxItems: 12, items: { type: "string", maxLength: 300, pattern: "^[a-h][1-8]$" } },
        inspectPlies: { type: "array", maxItems: 8, items: { type: "integer", minimum: 1, maximum: 32 } },
        analyzeFinal: { type: "boolean" },
        compareFinalMovesUci: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", maxLength: 5, pattern: "^[a-h][1-8][a-h][1-8][qrbn]?$" } },
        minimumPvPlies: { type: "integer", minimum: 1, maximum: 32 },
        depth: { type: "integer", minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
  EXPLAIN_PLAN_SELECTION_DESCRIPTOR,
  {
    name: "trace_idea",
    category: "graph",
    description: "Return selected generic idea entities, relations, proof state, and evidence links from the current semantic lineage.",
    inputSchema: {
      type: "object",
      properties: {
        entityIds: { type: "array", maxItems: 12, items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
];

function asSquareList(value: unknown): Square[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error("squares must be an array of at most 12 squares");
  const values = value.map(String);
  if (values.some((square) => !/^[a-h][1-8]$/.test(square))) throw new Error("Invalid square in tool input");
  return [...new Set(values)] as Square[];
}

function asUciList(value: unknown, max: number, deduplicate = true): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new Error(`moves must contain 1..${max} UCI moves`);
  const values = value.map(String);
  if (values.some((move) => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))) throw new Error("Invalid UCI move in tool input");
  return deduplicate ? [...new Set(values)] : values;
}

function minimumPvPlies(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 32) {
    throw new Error("minimumPvPlies must be an integer from 1 to 32");
  }
  return value as number;
}

function applyUci(chess: Chess, uci: string) {
  return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
}

function replayPv(chess: Chess, line: PositionAnalysisLine): { position: Chess; observedDraw: boolean } | null {
  if (!line.rootMove || !Array.isArray(line.pv) || !line.pv.length || line.pv[0] !== line.rootMove) return null;
  const replay = new Chess(chess.fen());
  let observedDraw = false;
  try {
    for (const uci of line.pv) {
      // A claimable draw does not make later engine moves illegal. Preserve the
      // complete raw engine PV, but do not extend beyond an observed draw.
      if (replay.isCheckmate() || replay.isStalemate() || typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci) || !applyUci(replay, uci)) return null;
      observedDraw ||= replay.isDraw();
    }
  } catch {
    return null;
  }
  return { position: replay, observedDraw };
}

function coversRequestedPv(chess: Chess, line: PositionAnalysisLine, minimum: number): boolean {
  const replay = replayPv(chess, line);
  return !!replay && (line.pv.length >= minimum || replay.position.isGameOver() || replay.observedDraw);
}

function pieceRef(chess: Chess, square: Square, identities?: IdentityState) {
  const piece = chess.get(square);
  return piece ? (identities ? pieceIdAt(identities, square) : null) || `${piece.color}-${piece.type}:${square}` : null;
}

function attackers(chess: Chess, square: Square, color: Color, identities?: IdentityState) {
  return chess.attackers(square, color).map((origin) => ({ square: origin, piece: pieceRef(chess, origin, identities) }));
}

function squareFacts(chess: Chess, squares: Square[], identities?: IdentityState): SemanticValue[] {
  return squares.map((square) => ({
    square,
    occupant: pieceRef(chess, square, identities),
    whiteAttackers: attackers(chess, square, "w", identities),
    blackAttackers: attackers(chess, square, "b", identities),
    legalMovesFrom: chess.get(square)?.color === chess.turn()
      ? chess.moves({ square, verbose: true }).map((move) => ({ uci: `${move.from}${move.to}${move.promotion || ""}`, san: move.san }))
      : [],
  }));
}

function allPieces(chess: Chess, identities?: IdentityState): SemanticValue[] {
  return SQUARES.flatMap((square) => {
    const piece = chess.get(square);
    return piece ? [{ square, color: piece.color, type: piece.type, ref: pieceRef(chess, square, identities) }] : [];
  });
}

function proofForCoverage(complete: boolean, lines: PositionAnalysisLine[]): ProofStrength | null {
  return complete ? "supported" : lines.length ? "observed" : null;
}

function exactPieceDescriptor(chess: Chess, square: Square, identities?: IdentityState) {
  const piece = chess.get(square);
  const pieceId = pieceRef(chess, square, identities);
  return piece && pieceId
    ? { pieceId, color: piece.color, pieceType: piece.type, square }
    : null;
}

/**
 * This is deliberately geometry, not exchange evaluation.  A pinned piece is
 * still a geometric attacker; callers that need legal recapture information
 * must inspect the separate post-capture legal move list below.
 */
function exactGeometricAttackers(chess: Chess, square: Square, color: Color, identities?: IdentityState) {
  return chess.attackers(square, color).flatMap((origin) => {
    const descriptor = exactPieceDescriptor(chess, origin, identities);
    return descriptor ? [descriptor] : [];
  });
}

function exactRootMoveFacts(chess: Chess, identities: IdentityState, roots: string[]): SemanticValue[] {
  return roots.flatMap((uci) => {
    const from = uci.slice(0, 2) as Square;
    const to = uci.slice(2, 4) as Square;
    const mover = chess.get(from);
    const moverPieceId = pieceIdAt(identities, from);
    if (!mover || !moverPieceId) return [];
    const candidate = new Chess(chess.fen());
    const move = applyUci(candidate, uci);
    if (!move) return [];
    const captureSquare = move.captured
      ? (move.isEnPassant() ? `${to[0]}${from[1]}` : to) as Square
      : null;
    const captured = captureSquare ? chess.get(captureSquare) : null;
    const capturedPieceId = captureSquare ? pieceIdAt(identities, captureSquare) : null;
    let afterIdentities: IdentityState | null = null;
    try {
      afterIdentities = applyIdentityMove(identities, {
        from,
        to,
        promotion: uci.slice(4) || undefined,
      }).state;
    } catch {
      // The legal chess move remains a useful exact witness even when an
      // unrelated identity timeline is unavailable.  In that case preserve
      // the legal data and omit only stable-ID-dependent details.
      afterIdentities = null;
    }
    const immediateRecaptures = captured && afterIdentities
      ? candidate.moves({ verbose: true })
        .filter((reply) => reply.to === to && Boolean(reply.captured))
        .flatMap((reply) => {
          const recapturer = exactPieceDescriptor(candidate, reply.from as Square, afterIdentities || undefined);
          return recapturer ? [{
            uci: `${reply.from}${reply.to}${reply.promotion || ""}`,
            san: reply.san,
            mover: recapturer,
            from: reply.from,
            to: reply.to,
            capturedPieceId: moverPieceId,
          }] : [];
        })
      : [];
    return [{
      uci,
      san: move.san,
      from,
      to,
      mover: { pieceId: moverPieceId, color: mover.color, pieceType: mover.type, square: from },
      capture: captured && capturedPieceId && captureSquare
        ? { pieceId: capturedPieceId, color: captured.color, pieceType: captured.type, square: captureSquare }
        : null,
      ...(captured && capturedPieceId && captureSquare ? {
        // Keep the historic capture identity shape stable. The adjacent
        // details are an exact optional enrichment, not an exchange verdict.
        // En passant removes a pawn from a different square, so the geometry
        // deliberately concerns the capturer's landing/recapture square `to`.
        captureGeometry: {
          capturedPieceId,
          capturedSquare: captureSquare,
          postCaptureSquare: to,
          preCaptureLandingSquareDefenders: exactGeometricAttackers(chess, to, captured.color, identities),
          preCaptureLandingSquareAttackers: exactGeometricAttackers(chess, to, mover.color, identities),
          immediateLegalRecaptures: immediateRecaptures,
        },
      } : {}),
      promotion: move.promotion || null,
      givesCheck: candidate.isCheck(),
      mechanism: moveMechanismFacts(chess, candidate, from, to, identities, afterIdentities || undefined),
    }];
  });
}

function exactContinuationMoveFacts(
  chess: Chess,
  identities: IdentityState,
  lines: PositionAnalysisLine[],
): SemanticValue[] {
  return lines.flatMap((line) => {
    const position = new Chess(chess.fen());
    let identityState = identities;
    const moves: SemanticValue[] = [];
    // Tactical-detail budget only; replay witnesses retain the supported PV prefix independently.
    for (const uci of line.pv.slice(0, 10)) {
      try {
        const fact = exactRootMoveFacts(position, identityState, [uci])[0];
        if (!fact) return [];
        const from = uci.slice(0, 2) as Square;
        const to = uci.slice(2, 4) as Square;
        const applied = applyIdentityMove(identityState, {
          from,
          to,
          promotion: uci.slice(4) || undefined,
        });
        if (!applyUci(position, uci)) return [];
        identityState = applied.state;
        moves.push(fact);
      } catch {
        return [];
      }
    }
    return [{ rootMove: line.rootMove, moves }];
  });
}

export function createPocToolHost(contextInput: ReasoningPositionContext, options: PocToolHostOptions = {}): ReasoningToolSet {
  const context = validateReasoningPositionContext(contextInput);
  const contextHash = reasoningContextHash(context);
  const identityTimeline = createPocIdentityTimeline(context);
  const defaultDepth = Math.max(1, Math.min(options.defaultDepth || 12, options.maxDepth || 16));
  const maxDepth = Math.max(defaultDepth, options.maxDepth || 16);
  const maxRootMoves = Math.max(1, Math.min(options.maxRootMoves || 12, 32));
  const priorEvidence = new Map<string, ReasoningEvidenceRecord>();
  let graph = options.graph;

  function position(phase: unknown): { chess: Chess; identities: IdentityState } {
    if (phase !== "before" && phase !== "after") throw new Error("phase must be before or after");
    return {
      chess: new Chess(phase === "before" ? context.fenBefore : context.fenAfter),
      identities: phase === "before" ? identityTimeline.before : identityTimeline.after,
    };
  }

  function envelope(input: Record<string, unknown>) {
    const callId = String(input.callId || "");
    if (!callId) throw new Error("Harness callId is required");
    if (input.contextHash !== contextHash) throw new Error("Tool request context is stale");
    const clean = { ...input };
    delete clean.callId;
    delete clean.contextHash;
    return { callId, clean };
  }

  function evidence(input: {
    kind: ReasoningEvidenceKind;
    source: string;
    proofStrength: ProofStrength | null;
    summary: string;
    data: Record<string, SemanticValue>;
    coverage?: ReasoningEvidenceRecord["coverage"];
    replay?: ReasoningEvidenceRecord["replay"];
  }): ReasoningEvidenceRecord {
    const authority = input.kind === "probe" ? "bounded-engine" : input.kind === "fact" ? "legal-exact" : null;
    const data = authority && typeof input.data.authority !== "string"
      ? { ...input.data, authority }
      : input.data;
    const identity = {
      contextHash,
      kind: input.kind,
      source: input.source,
      summary: input.summary,
      data,
      coverage: input.coverage || null,
      replay: input.replay || null,
    };
    return withEvidenceLicenses({
      schemaVersion: REASONING_POC_VERSION,
      id: `evidence:poc:${stableHash(identity)}`,
      contextHash,
      kind: input.kind,
      source: input.source,
      proofStrength: input.proofStrength,
      summary: input.summary,
      data,
      coverage: input.coverage || null,
      replay: input.replay || null,
    });
  }

  async function analyzeRoots(
    chess: Chess,
    roots: string[],
    depthInput: unknown,
    signal?: AbortSignal,
    multiPvInput?: unknown,
    minimumPvPlies?: number,
    execution?: ReasoningToolExecutionContext,
    rootField = "rootMoves",
    additional = false,
    minimumDepthOverride?: number,
  ) {
    if (!options.analyzer) return null;
    if (roots.length > maxRootMoves) throw new Error(`At most ${maxRootMoves} root moves can be probed`);
    const legal = new Set(chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion || ""}`));
    const illegal = roots.filter((move) => !legal.has(move));
    if (illegal.length) throw Object.assign(new Error(`Illegal root move(s) in ${rootField}: ${illegal.join(", ")}. Legal moves from this position: ${[...legal].slice(0, 32).join(", ")}`), {code:"illegal-root-move",field:rootField,expected:"legal UCI moves from the selected phase",choices:[...legal].slice(0,32)});
    const requestedDepth = typeof depthInput === "number" && Number.isInteger(depthInput) ? depthInput : defaultDepth;
    const depth = Math.max(Math.min(minimumDepthOverride ?? options.minimumDepth ?? 1, maxDepth), Math.min(requestedDepth, maxDepth));
    const requestedMultiPv = typeof multiPvInput === "number" && Number.isInteger(multiPvInput) ? multiPvInput : 3;
    const multiPv = roots.length || Math.max(1, Math.min(requestedMultiPv, 3));
    const request = {
      fen: chess.fen(),
      depth,
      multiPv,
      rootMoves: roots,
      ...(minimumPvPlies ? { minimumPvPlies } : {}),
      signal,
    };
    signal?.throwIfAborted();
    const reserve=additional ? (execution?.reserveSearch ? execution.reserveAdditionalSearch : undefined) : execution?.reserveSearch;
    if (reserve && !reserve()) throw Object.assign(new Error("Engine search budget exhausted"), {code:"search-budget-exhausted",field:"searches",expected:"remaining engine search slot"});
    let analysis: ReturnType<typeof scopePositionAnalysis>;
    try {
      analysis = scopePositionAnalysis(await options.analyzer.analyze(request), request);
      signal?.throwIfAborted();
    } catch (error) {
      if (!signal?.aborted) execution?.recordSearchOutcome?.('failed');
      throw error;
    }
    execution?.recordSearchOutcome?.('succeeded');
    return { ...analysis, searchScope: { fen: request.fen, requestedDepth: depth,
      command:analysis.command,
      minimumPvPlies: minimumPvPlies ?? 1,
      cacheProvenance: analysis.cacheProvenance ?? "unreported",
      sourceCacheProvenance: analysis.sourceCacheProvenance ?? analysis.cacheProvenance ?? "unreported",
      ...((roots.length || multiPv) > 1 ? {comparison:matchedRootComparison(analysis, request.fen, roots)} : {}),
      requestedRootMoves: roots, requestedMultiPv: multiPv, history: "FEN-root search; prior repetition history not sent to engine" } };
  }

  async function completeRequestedPv(
    root: Chess,
    analysis: NonNullable<Awaited<ReturnType<typeof analyzeRoots>>>,
    requestedPlies: number | undefined,
    signal: AbortSignal | undefined,
    execution: ReasoningToolExecutionContext | undefined,
  ) {
    if (!requestedPlies) return analysis;
    const lines: PositionAnalysisLine[] = [];
    for (const original of analysis.lines) {
      const rawPv = Array.isArray(original.pv) ? [...original.pv] : [];
      const segments: NonNullable<PositionAnalysisLine["pvCompletion"]>["segments"] = [{
        fen: root.fen(), startPly: 0, depth: original.depth, pv: rawPv,
        scoreCp: original.scoreCp, matePly: original.matePly, scoreScope: original.scoreScope,
        ...(original.scoreProvenance ? {scoreProvenance:original.scoreProvenance} : {}),
        command: analysis.command, engine: analysis.engine, engineBuild: analysis.engineBuild,
        cacheProvenance: analysis.sourceCacheProvenance ?? analysis.cacheProvenance ?? "unreported",
      }];
      const replay = replayPv(root, original);
      if (!replay) {
        lines.push({ ...original, rawPv, pvCompletion: {
          requestedPlies, actualPlies: rawPv.length, status: "invalid", conditional: false, segments,
        } });
        continue;
      }
      const pv = [...rawPv];
      const position = replay.position;
      let status: NonNullable<PositionAnalysisLine["pvCompletion"]>["status"] = replay.observedDraw || position.isGameOver()
        ? "terminal" : pv.length >= requestedPlies ? "complete" : "short-budget";
      for (let attempt = 0; attempt < 2 && status === "short-budget"; attempt++) {
        signal?.throwIfAborted();
        if (execution?.reserveSearch ? false : !execution?.reserveAdditionalSearch?.()) break;
        const fen = position.fen();
        let endpoint;
        try {
          endpoint = await analyzeRoots(position, [], analysis.searchScope.requestedDepth, signal, 1,
            Math.min(32, requestedPlies - pv.length), execution, "rootMoves", true);
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof Error && error.name === "AbortError") throw error;
          status = (error as {code?:string})?.code === "search-budget-exhausted" ? "short-budget" : "short-error";
          break;
        }
        signal?.throwIfAborted();
        const continuation = endpoint?.lines[0];
        const endpointReplay = continuation && replayPv(position, continuation);
        if (!continuation || !endpointReplay) {
          status = "short-no-progress";
          break;
        }
        const available = continuation.pv.slice(0, Math.min(32 - pv.length, requestedPlies - pv.length));
        const appended: string[] = [];
        for (const uci of available) {
          if (position.isGameOver() || !applyUci(position, uci)) break;
          appended.push(uci);
        }
        if (!appended.length) {
          status = "short-no-progress";
          break;
        }
        const startPly = pv.length;
        pv.push(...appended);
        segments.push({
          fen, startPly, depth: continuation.depth, pv: appended,
          scoreCp: continuation.scoreCp, matePly: continuation.matePly, scoreScope: continuation.scoreScope,
          ...(continuation.scoreProvenance ? {scoreProvenance:continuation.scoreProvenance} : {}),
          command: endpoint!.command, engine: endpoint!.engine, engineBuild: endpoint!.engineBuild,
          cacheProvenance: endpoint!.sourceCacheProvenance ?? endpoint!.cacheProvenance ?? "unreported",
        });
        status = position.isGameOver() ? "terminal" : pv.length >= requestedPlies ? "complete" : "short-budget";
      }
      if (status === "short-budget" && segments.length === 3) status = "short-attempt-limit";
      lines.push({ ...original, pv, rawPv, pvCompletion: {
        requestedPlies, actualPlies: pv.length, status, conditional: segments.length > 1, segments,
      } });
    }
    return { ...analysis, lines };
  }

  async function expandEvidence(
    phase: 'before' | 'after',
    phaseRoot: Chess,
    parentRoot: Chess,
    basePrefix: string[],
    analysis: NonNullable<Awaited<ReturnType<typeof analyzeRoots>>>,
    signal?: AbortSignal,
    execution?: ReasoningToolExecutionContext,
  ) {
    const config=options.branchExpansion;
    if (!config || !options.analyzer || config.maxNodes < 1) return { records:[] as ReasoningEvidenceRecord[], summary:undefined };
    const expanded=await expandPrincipalBranches({rootFen:parentRoot.fen(),lines:analysis.lines,parentDepth:analysis.searchScope.requestedDepth,
      config,signal,search:async (fen,depth)=>analyzeRoots(new Chess(fen),[],depth,signal,3,undefined,execution,'rootMoves',true,config.depthFloor)});
    const records:ReasoningEvidenceRecord[]=[];
    const nodeSummaries:SemanticValue[]=[];
    for(const node of expanded.nodes){
      const legal=node.analysis.lines.filter(line=>replayPv(new Chess(node.finalFen),line));
      if(!legal.length)continue;
      const played:SemanticValue[]=[];
      const board=new Chess(phaseRoot.fen());
      for(const uci of [...basePrefix,...node.prefix]){
        const move=applyUci(board,uci);
        if(!move)throw Error('branch-parent-prefix-invalid');
        played.push({uci,san:move.san});
      }
      if(board.fen()!==node.finalFen || node.analysis.searchScope.fen!==node.finalFen)throw Error('branch-endpoint-mismatch');
      const data:Record<string,SemanticValue>={phase,played,finalFen:node.finalFen,
        branchOrigin:{parentRootFen:parentRoot.fen(),parentPrefix:basePrefix,followedPvPrefix:node.prefix,
          limitation:'This is one conditional prefix of a parent PV, not proof that its moves are forced or best.'},
        engine:node.analysis.engine,engineBuild:node.analysis.engineBuild,searchScope:node.analysis.searchScope,
        lines:materialForVariations(node.finalFen,legal)};
      const record=evidence({kind:'probe',source:`${node.analysis.engine}/test-line-final`,proofStrength:'observed',
        summary:`Independent continuation search after ${basePrefix.length+node.prefix.length} legal plies from the ${phase} root; ${legal.length} local alternatives.`,
        data,coverage:{complete:false,covered:legal.map(line=>line.rootMove),unresolved:['non-enumerated alternatives']},
        replay:{fen:node.finalFen,command:node.analysis.command}});
      records.push(record);
      nodeSummaries.push({evidenceId:record.id,played:played.map(m=>(m as {uci:string}).uci),finalFen:node.finalFen,
        searchScope:node.analysis.searchScope,rootMoves:legal.map(line=>line.rootMove)});
    }
    return {records,summary:{...expanded.summary,admittedNodes:records.length,
      rejectedNodes:expanded.nodes.length-records.length,evidenceNodes:nodeSummaries,
      note:'Child scores remain local to their own search; parent ranking, requested-root coverage and completed PVs are unchanged.'}};
  }

  return {
    reservesSearchAtDispatch: true,
    descriptors: () => TOOL_DESCRIPTORS.filter(item => !(context.kind === "position" && ["analyze_move", "enumerate_defenses"].includes(item.name))).map((item) => ({ ...item, inputSchema: { ...item.inputSchema } })),
    seedEvidence(records) {
      for (const record of records) {
        if (record.contextHash !== contextHash) throw new Error("Cannot seed stale reasoning evidence");
        priorEvidence.set(record.id, record);
      }
    },
    async execute(name: ReasoningToolName, rawInput: Record<string, unknown>, signal?: AbortSignal, execution?: ReasoningToolExecutionContext): Promise<ReasoningToolResult> {
      if (context.kind === "position" && ["analyze_move", "enumerate_defenses"].includes(name)) throw Error("This tool requires a played target move.");
      const started = performance.now();
      const { callId, clean: input } = envelope(rawInput);
      const finish = (
        support: ReasoningToolResult["support"],
        data: Record<string, SemanticValue>,
        records: ReasoningEvidenceRecord[],
        limitations: string[] = [],
      ): ReasoningToolResult => {
        for (const record of records) priorEvidence.set(record.id, record);
        return {
          schemaVersion: REASONING_POC_VERSION,
          callId,
          tool: name,
          contextHash,
          support,
          data,
          evidence: records,
          limitations,
          durationMs: performance.now() - started,
        };
      };

      if (name === "inspect_position") {
        const phase = input.phase || "after";
        const { chess, identities } = position(phase);
        const squares = asSquareList(input.squares);
        const data: Record<string, SemanticValue> = {
          phase: String(phase),
          fen: chess.fen(),
          turn: chess.turn(),
          inCheck: chess.isCheck(),
          legalMoveCount: chess.moves().length,
          pieces: allPieces(chess, identities),
          material: materialAtPosition(chess),
          squareFacts: squareFacts(chess, squares, identities),
        };
        const record = evidence({
          kind: "fact",
          source: "chess.js/legal-position",
          proofStrength: "observed",
          summary: `Exact ${phase} position facts${squares.length ? ` for ${squares.join(", ")}` : ""}.`,
          data,
          replay: { fen: chess.fen(), squares },
        });
        return finish("supported", data, [record]);
      }

      if (name === "analyze_move") {
        const before = new Chess(context.fenBefore);
        const after = new Chess(context.fenAfter);
        const from = context.moveUci.slice(0, 2) as Square;
        const to = context.moveUci.slice(2, 4) as Square;
        const changedAttacks: SemanticValue[] = [];
        for (const square of SQUARES) {
          const beforeWhite = before.attackers(square, "w");
          const afterWhite = after.attackers(square, "w");
          const beforeBlack = before.attackers(square, "b");
          const afterBlack = after.attackers(square, "b");
          if (String(beforeWhite) === String(afterWhite) && String(beforeBlack) === String(afterBlack)) continue;
          changedAttacks.push({ square, beforeWhite, afterWhite, beforeBlack, afterBlack });
        }
        const data: Record<string, SemanticValue> = {
          moveUci: context.moveUci,
          moveSan: context.moveSan,
          mover: pieceRef(before, from, identityTimeline.before),
          from,
          to,
          captured: pieceRef(before, to),
          changedAttacks,
          material: materialAlongLine(context.fenBefore, [context.moveUci]),
        };
        const record = evidence({
          kind: "fact",
          source: "chess.js/move-delta",
          proofStrength: "observed",
          summary: `${context.moveSan} moved ${String(data.mover)} from ${from} to ${to} and changed ${changedAttacks.length} attack maps.`,
          data,
          replay: { fen: context.fenBefore, move: context.moveUci },
        });
        return finish("supported", data, [record]);
      }

      if (name === "explore_continuations") {
        const phase = input.phase;
        const { chess, identities } = position(phase);
        const requested = minimumPvPlies(input.minimumPvPlies);
        const initial = await analyzeRoots(chess, [], input.depth, signal, input.multiPv, requested ?? 2, execution);
        const analysis = initial && await completeRequestedPv(chess, initial, requested, signal, execution);
        if (!analysis?.lines.length) return finish("unsupported", { phase: String(phase), lines: [] }, [], ["No position-analysis provider returned a principal variation."]);
        const lines = analysis.lines.slice(0, 3);
        const expanded=await expandEvidence(phase as 'before'|'after',chess,chess,[],analysis,signal,execution);
        const principal = lines[0];
        const data: Record<string, SemanticValue> = {
          phase: String(phase),
          bestMove: analysis.bestMove,
          engine: analysis.engine,
          engineBuild: analysis.engineBuild,
          searchScope: analysis.searchScope,
          rootMoveFacts: exactRootMoveFacts(chess, identities, lines.map((line) => line.rootMove)),
          continuationMoveFacts: exactContinuationMoveFacts(chess, identities, lines),
          lines: materialForVariations(chess.fen(), lines),
          ...(expanded.summary?{branchExpansion:expanded.summary}:{}),
        };
        const record = evidence({
          kind: "probe",
          source: `${analysis.engine}/explore-continuations`,
          proofStrength: "observed",
          summary: `Stockfish returned ${lines.length} bounded principal variation${lines.length === 1 ? "" : "s"} from the ${String(phase)} position.`,
          data,
          coverage: { complete: false, covered: lines.map((line) => line.rootMove), unresolved: ["non-enumerated alternatives"] },
          replay: {
            fen: chess.fen(),
            command: analysis.command,
            moves: principal.pv.slice(0, MAX_INTERACTIVE_LINE_PLIES),
            linesUci: lines.map((line) => line.pv.slice(0, MAX_INTERACTIVE_LINE_PLIES)),
          },
        });
        return finish("supported", data, [record,...expanded.records], ["Principal variations are bounded search evidence; they do not prove a unique plan or human intent."]);
      }

      if (name === "compare_moves" || name === "enumerate_defenses") {
        const phase = name === "enumerate_defenses" ? "after" : input.phase;
        const { chess, identities } = position(phase);
        const requestedRoots = asUciList(name === "enumerate_defenses" ? input.rootMoves : input.movesUci, maxRootMoves);
        const roots = [...requestedRoots];
        const lead = options.leadingAlternative;
        const eligible = name === "compare_moves" && lead?.fen === chess.fen() && chess.moves({verbose:true}).some(m=>`${m.from}${m.to}${m.promotion||""}` === lead.uci);
        const omittedLead = eligible && !roots.includes(lead!.uci) && roots.length >= maxRootMoves;
        if (eligible && !roots.includes(lead!.uci) && roots.length < maxRootMoves) roots.push(lead!.uci);
        const rootSelection = {modelRequested:requestedRoots,automaticallyAdded:roots.filter(r=>!requestedRoots.includes(r)),...(eligible?{sourceEvidenceId:lead!.evidenceId}:{}),...(omittedLead?{notAdded:lead!.uci,reason:"root limit; request separately to resolve known alternative"}:{}),scope:"restricted roots, not exhaustive legal-move coverage"};
        const requestedMinimumPvPlies = name === "compare_moves" ? minimumPvPlies(input.minimumPvPlies) : undefined;
        const initial = await analyzeRoots(chess, roots, input.depth, signal, undefined, requestedMinimumPvPlies, execution, name === "compare_moves" ? "movesUci" : "rootMoves");
        const analysis = initial && await completeRequestedPv(chess, initial, requestedMinimumPvPlies, signal, execution);
        if (!analysis) return finish("unsupported", { phase: String(phase), rootMoves: roots }, [], ["No position-analysis provider is configured."]);
        // Expand explicitly requested comparison moves before an automatically
        // added leading alternative, without changing the parent ranking.
        const expansionAnalysis={...analysis,lines:[...analysis.lines.filter(line=>requestedRoots.includes(line.rootMove)),...analysis.lines.filter(line=>!requestedRoots.includes(line.rootMove))]};
        const expanded=await expandEvidence(phase as 'before'|'after',chess,chess,[],expansionAnalysis,signal,execution);
        const requiredPvPlies = requestedMinimumPvPlies || 1;
        const covered = [...new Set(analysis.lines
          .filter((line) => replayPv(chess, line))
          .map((line) => line.rootMove))];
        const unresolved = roots.filter((move) => !covered.includes(move));
        const complete = unresolved.length === 0;
        const requestedPvCoverage = { requestedPlies: requiredPvPlies,
          satisfied: analysis.lines.filter((line) => coversRequestedPv(chess, line, requiredPvPlies)).map((line) => line.rootMove),
          short: covered.filter((move) => !analysis.lines.some((line) => line.rootMove === move && coversRequestedPv(chess, line, requiredPvPlies))) };
        const data: Record<string, SemanticValue> = {
          phase: String(phase),
          rootMoves: roots,
          rootSelection,
          bestMove: analysis.bestMove,
          engine: analysis.engine,
          engineBuild: analysis.engineBuild,
          searchScope: analysis.searchScope,
          rootMoveFacts: exactRootMoveFacts(chess, identities, roots),
          continuationMoveFacts: exactContinuationMoveFacts(chess, identities, analysis.lines),
          lines: materialForVariations(chess.fen(), analysis.lines),
          ...(expanded.summary?{branchExpansion:expanded.summary}:{}),
          ...(requestedMinimumPvPlies ? { minimumPvPlies: requestedMinimumPvPlies } : {}),
          ...(requestedMinimumPvPlies ? { requestedPvCoverage } : {}),
        };
        const record = evidence({
          kind: "probe",
          source: `${analysis.engine}/${name}`,
          proofStrength: proofForCoverage(complete, analysis.lines),
          summary: `${name} covered ${covered.length}/${roots.length} compared roots at original requested depth ${analysis.searchScope.requestedDepth}${requestedMinimumPvPlies ? `; ${requestedPvCoverage.satisfied.length}/${covered.length} legal roots reached ${requestedMinimumPvPlies} PV plies or a verified terminal position` : ""}.`,
          data,
          coverage: { complete, covered, unresolved },
          replay: {
            fen: chess.fen(),
            command: analysis.command,
            linesUci: analysis.lines.map((line) => line.pv.slice(0, MAX_INTERACTIVE_LINE_PLIES)),
          },
        });
        return finish(complete ? "supported" : "insufficient-evidence", data, [record,...expanded.records], [
          ...(analysis.searchScope.comparison?.status === 'unmatched' ? [analysis.searchScope.comparison.reason + ' These scores cannot establish a matched relative ranking.'] : []),
          ...(unresolved.length ? [`Unresolved roots: ${unresolved.join(", ")}`] : []),
          ...(requestedPvCoverage.short.length ? [`Available legal continuation is shorter than ${requiredPvPlies} plies for: ${requestedPvCoverage.short.join(", ")}.`] : []),
        ]);
      }

      if (name === "test_line") {
        const phase = input.phase;
        const positionState = position(phase);
        const chess = positionState.chess;
        let identities = positionState.identities;
        const moves = asUciList(input.movesUci, 32, false);
        const comparisonRequested = input.compareFinalMovesUci !== undefined;
        if (comparisonRequested && input.analyzeFinal !== true) throw new Error("compareFinalMovesUci requires analyzeFinal=true");
        const finalRoots = comparisonRequested ? asUciList(input.compareFinalMovesUci, Math.min(6,maxRootMoves)) : [];
        const inspectPlies = input.inspectPlies === undefined ? [] : input.inspectPlies;
        if (!Array.isArray(inspectPlies) || inspectPlies.length > 8 || inspectPlies.some(p => !Number.isInteger(p) || Number(p) < 1 || Number(p) > moves.length)) {
          throw new Error("inspectPlies must contain at most 8 one-based indices within movesUci");
        }
        const played: SemanticValue[] = [];
        const moveFacts: SemanticValue[] = [];
        for (const uci of moves) {
          const beforeMove = new Chess(chess.fen());
          let move;
          try { move = applyUci(chess, uci); } catch { move = null; }
          if (!move) { const legal=chess.moves({verbose:true}).map(m=>`${m.from}${m.to}${m.promotion||""}`); throw Object.assign(new Error(`Illegal line move at movesUci[${played.length}]: ${uci}. Legal moves from this prefix: ${legal.slice(0,32).join(", ")}`), {code:"illegal-line-move",field:`movesUci[${played.length}]`,expected:"legal UCI move from this line prefix",choices:legal.slice(0,32)}); }
          // Reject illegal prefixes before computing geometry: the geometry
          // validator otherwise masks the structured legal-move diagnostic.
          const fact = exactRootMoveFacts(beforeMove, identities, [uci])[0];
          identities = applyIdentityMove(identities, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined }).state;
          played.push({ uci, san: move.san });
          if (fact) moveFacts.push(fact);
        }
        const inspectSquares = asSquareList(input.inspectSquares);
        const baseData: Record<string, SemanticValue> = {
          phase: String(phase),
          played,
          moveFacts,
          mechanismInspection: { inspectPlies: inspectPlies as number[], inspectSquares, scope: "One-based plies within this legal replay; full move-local measurements retained for evidence retrieval." },
          material: materialAlongLine(phase === "before" ? context.fenBefore : context.fenAfter, moves),
          finalFen: chess.fen(),
          finalTurn: chess.turn(),
          finalInCheck: chess.isCheck(),
          finalCheckmate: chess.isCheckmate(),
          finalStalemate: chess.isStalemate(),
          finalDraw: chess.isDraw(),
          squareFacts: squareFacts(chess, inspectSquares, identities),
        };
        const records = [evidence({
          kind: "fact",
          source: "chess.js/legal-line",
          proofStrength: "observed",
          summary: `The proposed ${moves.length}-ply line is legal from the ${phase} position.`,
          data: baseData,
          replay: { fen: phase === "before" ? context.fenBefore : context.fenAfter, moves },
        })];
        if (input.analyzeFinal === true) {
          const requestedMinimumPvPlies = minimumPvPlies(input.minimumPvPlies);
          signal?.throwIfAborted();
          if (chess.isGameOver() && !comparisonRequested) {
            return finish("supported", baseData, records, ["The legal line reaches a terminal position; this does not prove earlier moves are forced."]);
          }
          const initial = await analyzeRoots(chess, finalRoots, input.depth, signal, undefined, requestedMinimumPvPlies, execution, "compareFinalMovesUci");
          const analysis = initial && await completeRequestedPv(chess, initial, requestedMinimumPvPlies, signal, execution);
          if (analysis) {
            const expanded=await expandEvidence(phase as 'before'|'after',position(phase).chess,chess,moves,analysis,signal,execution);
            const requiredPlies = requestedMinimumPvPlies || 1;
            const covered = analysis.lines.filter((line) => replayPv(chess, line)).map((line) => line.rootMove);
            const unresolved = [...new Set([...finalRoots.filter(root => !covered.includes(root)), ...analysis.lines.filter((line) => !covered.includes(line.rootMove)).map((line) => line.rootMove)])];
            const short = covered.filter((move) => !analysis.lines.some((line) => line.rootMove === move && coversRequestedPv(chess, line, requiredPlies)));
            const probeData: Record<string, SemanticValue> = { ...baseData, ...(comparisonRequested ? {rootMoves:finalRoots,comparisonScope:"Only named legal alternatives at finalFen, not the original line root; earlier prefix choices are unverified."} : {}), engine: analysis.engine, engineBuild: analysis.engineBuild, searchScope: analysis.searchScope, lines: materialForVariations(chess.fen(), analysis.lines), ...(expanded.summary?{branchExpansion:expanded.summary}:{}), ...(requestedMinimumPvPlies ? {minimumPvPlies: requestedMinimumPvPlies, requestedPvCoverage: { requestedPlies: requiredPlies, satisfied: covered.filter(move => !short.includes(move)), short }} : {}) };
            records.push(evidence({
              kind: "probe",
              source: `${analysis.engine}/${comparisonRequested ? "test-line-comparison" : "test-line"}`,
              proofStrength: analysis.lines.length ? "observed" : null,
              summary: comparisonRequested ? `Stockfish compared ${covered.filter(root => finalRoots.includes(root)).length}/${finalRoots.length} named moves at the exact line endpoint.` : `Stockfish analyzed the final position of the proposed line.`,
              data: probeData,
              coverage: { complete: comparisonRequested && unresolved.length === 0, covered, unresolved: comparisonRequested ? unresolved : [...unresolved, "non-enumerated alternatives"] },
              replay: { fen: chess.fen(), command: analysis.command },
            }));
            records.push(...expanded.records);
            return finish(covered.length && !unresolved.length ? "supported" : "insufficient-evidence", probeData, records, [
              "Final-position analysis does not validate earlier choices or prove the proposed line is forced.",
              ...(comparisonRequested ? ["Restricted comparison covers only named endpoint moves; discovery and original-root scores remain separate searches."] : []),
              ...(short.length ? [`The available legal continuation is shorter than the requested ${requestedMinimumPvPlies}-ply horizon for: ${short.join(", ")}.`] : []),
            ]);
          }
          return finish("insufficient-evidence", baseData, records, ["The line is legal, but no engine provider is configured for its final position."]);
        }
        return finish("supported", baseData, records);
      }

      if (name === "explain_plan") {
        const resolved = resolveAndSelectPlan(input, context, contextHash, priorEvidence.values(), options.registry);
        graph = resolved.graph;
        const selectedEntities = graph.entities.filter((entity) => resolved.selectedEntityIds.includes(entity.id));
        const selectedRelations = graph.relations.filter((relation) => resolved.selectedRelationIds.includes(relation.id));
        const data: Record<string, SemanticValue> = {
          graphHash: graph.inputHash,
          hypothesisLedgerRevision: resolved.hypothesisLedgerRevision,
          localToGraphIds: resolved.localToGraphIds,
          selectedEntities: selectedEntities as unknown as SemanticValue,
          selectedRelations: selectedRelations as unknown as SemanticValue,
          sourceEvidenceIds: resolved.evidenceIds,
        };
        const record = evidence({
          kind: "graph",
          source: "chess-idea-graph/plan-selector",
          proofStrength: null,
          summary: `Resolved ${graph.entities.length} generic hypotheses and selected a shortest ${selectedEntities.length}-entity evidence-linked plan path.`,
          data,
          coverage: { complete: true, covered: resolved.selectedEntityIds, unresolved: [] },
          replay: { graphHash: graph.inputHash, hypothesisLedgerRevision: resolved.hypothesisLedgerRevision, selectedEntityIds: resolved.selectedEntityIds },
        });
        return finish("supported", data, [record]);
      }

      if (name === "trace_idea") {
        if (!graph) return finish("unsupported", {}, [], ["No Chess Idea Graph is available for this context."]);
        const ids = input.entityIds == null
          ? graph.entities.map((entity) => entity.id)
          : Array.isArray(input.entityIds) && input.entityIds.length <= 12
            ? [...new Set(input.entityIds.map(String))]
            : (() => { throw new Error("entityIds must be an array of at most 12 IDs"); })();
        const entities = graph.entities.filter((entity) => ids.includes(entity.id));
        const entityIds = new Set(entities.map((entity) => entity.id));
        const relations = graph.relations.filter((relation) => entityIds.has(relation.from) || entityIds.has(relation.to));
        const data: Record<string, SemanticValue> = {
          entities: entities as unknown as SemanticValue,
          relations: relations as unknown as SemanticValue,
          graphHash: graph.inputHash,
        };
        const records = entities.map((entity: SemanticEntity) => evidence({
          kind: "graph",
          source: "chess-idea-graph",
          proofStrength: entity.proofStrength,
          summary: `${entity.entityType} ${entity.id} is ${entity.state}.`,
          data: { entity: entity as unknown as SemanticValue, relations: relations.filter((relation: SemanticRelation) => relation.from === entity.id || relation.to === entity.id) as unknown as SemanticValue },
          replay: { graphHash: graph!.inputHash, entityId: entity.id },
        }));
        return finish(records.length ? "supported" : "insufficient-evidence", data, records, records.length ? [] : ["No requested idea entity exists in this lineage."]);
      }

      throw new Error(`Unsupported reasoning tool: ${name}`);
    },
  };
}
