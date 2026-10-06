import { Chess, SQUARES, type Color, type Move, type Square } from "chess.js";
import { PARTICIPANT_ROLES, REFERENCE_DOMAINS, participant } from "./concept-registry";
import {
  REASONING_POC_VERSION,
  reasoningContextHash,
  type ObservationProvider,
  type QueryContract,
  type ReasoningEvidenceRecord,
  type ReasoningObservation,
  type ReasoningObservationSet,
  type ReasoningPositionContext,
  type ReasoningProbeRecipe,
  type ReasoningRankedObservationSet,
  type ReasoningRunControls,
  type SaliencePolicy,
} from "./poc-contracts";
import { createPocIdentityTimeline, pieceIdAt } from "./poc-piece-refs";
import { stableHash } from "./stable";
import { withEvidenceLicenses } from "./evidence-licenses";
import type { IdentityState, SemanticParticipant, SemanticValue } from "./types";
import { factProofStrength } from "./fact-provider";

export const DETERMINISTIC_OBSERVATION_PROVIDER_VERSION = "deterministic-position-observations/5" as const;
export const QUESTION_SALIENCE_POLICY_VERSION = "question-conditioned-observation-salience/4" as const;

const PROVIDER_ID = "knights-eye/deterministic-position-observations";
const CENTRAL_SQUARES = new Set(["c3", "d3", "e3", "f3", "c4", "d4", "e4", "f4", "c5", "d5", "e5", "f5", "c6", "d6", "e6", "f6"]);

type ObservationSeed = {
  observationType: string;
  participants: SemanticParticipant[];
  attributes: Record<string, SemanticValue>;
  exactness: "exact" | "heuristic";
  methods: string[];
  probeRecipes?: ReasoningProbeRecipe[];
  summary: string;
  replay: Record<string, SemanticValue>;
};

type CoverageAffordance = { observation: ReasoningObservation; square: Square; redundantSquares: Square[]; entryMoves: Move[] };

function opposite(color: Color): Color {
  return color === "w" ? "b" : "w";
}

function uci(move: Move): string {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function play(chess: Chess, moveUci: string): Move | null {
  return chess.move({ from: moveUci.slice(0, 2), to: moveUci.slice(2, 4), promotion: moveUci.slice(4) || undefined });
}

function stablePieceRef(state: IdentityState, square: Square): string | null {
  return pieceIdAt(state, square);
}

function attackedSquares(chess: Chess, origin: Square, color: Color): Square[] {
  return SQUARES.filter((square) => chess.attackers(square, color).includes(origin));
}

function isCheck(move: Move | null): boolean {
  return Boolean(move?.san.includes("+") || move?.san.includes("#"));
}

function kingSquare(chess: Chess, color: Color): Square | null {
  return SQUARES.find((square) => {
    const piece = chess.get(square);
    return piece?.color === color && piece.type === "k";
  }) || null;
}

function distance(left: Square, right: Square): number {
  return Math.max(Math.abs(left.charCodeAt(0) - right.charCodeAt(0)), Math.abs(Number(left[1]) - Number(right[1])));
}

function quietMoves(chess: Chess, excludedSquares: Set<string> = new Set()): Move[] {
  return chess.moves({ verbose: true })
    .filter((move) => !move.isCapture() && !move.isPromotion() && !isCheck(move) && !excludedSquares.has(move.from) && !excludedSquares.has(move.to))
    .sort((left, right) => uci(left).localeCompare(uci(right)));
}

function makeObservation(contextHash: string, seed: ObservationSeed): { observation: ReasoningObservation; evidence: ReasoningEvidenceRecord[] } {
  const identity = {
    observationType: seed.observationType,
    participants: [...seed.participants].sort((left, right) => `${left.role}:${left.ref.domain}:${left.ref.id}`.localeCompare(`${right.role}:${right.ref.domain}:${right.ref.id}`)),
    attributes: seed.attributes,
    exactness: seed.exactness,
    methods: [...seed.methods].sort(),
  };
  const id = `observation:${stableHash({ contextHash, identity })}`;
  const evidenceId = `evidence:observation-fact:${stableHash({ contextHash, id, replay: seed.replay })}`;
  const authority = seed.exactness === "heuristic" ? "heuristic-affordance" : "deterministic-derived";
  const witnessEvidenceId = seed.exactness === "heuristic"
    ? `evidence:observation-witness:${stableHash({ contextHash, id, replay: seed.replay })}`
    : null;
  const observation: ReasoningObservation = {
    schemaVersion: REASONING_POC_VERSION,
    id,
    contextHash,
    observationType: seed.observationType,
    participants: identity.participants,
    attributes: seed.attributes,
    exactness: seed.exactness,
    provenance: {
      provider: PROVIDER_ID,
      version: DETERMINISTIC_OBSERVATION_PROVIDER_VERSION,
      trust: "deterministic",
      methods: [...new Set(seed.methods)].sort(),
    },
    factEvidenceIds: [evidenceId, ...(witnessEvidenceId ? [witnessEvidenceId] : [])],
    probeRecipes: seed.probeRecipes || [],
  };
  const evidence: ReasoningEvidenceRecord = withEvidenceLicenses({
    schemaVersion: REASONING_POC_VERSION,
    id: evidenceId,
    contextHash,
    kind: "fact",
    source: `${PROVIDER_ID}/${DETERMINISTIC_OBSERVATION_PROVIDER_VERSION}`,
    proofStrength: factProofStrength(authority),
    summary: seed.summary,
    data: {
      observationId: id,
      observationType: seed.observationType,
      participants: identity.participants as unknown as SemanticValue,
      attributes: seed.attributes,
      exactness: seed.exactness,
      authority,
      ...(witnessEvidenceId ? { derivedFromEvidenceIds: [witnessEvidenceId] } : {}),
    },
    coverage: null,
    replay: seed.exactness === "heuristic" ? null : seed.replay,
  });
  const witnessEvidence: ReasoningEvidenceRecord[] = witnessEvidenceId ? [withEvidenceLicenses({
    schemaVersion: REASONING_POC_VERSION,
    id: witnessEvidenceId,
    contextHash,
    kind: "fact",
    source: `${PROVIDER_ID}/${DETERMINISTIC_OBSERVATION_PROVIDER_VERSION}/legal-witness`,
    proofStrength: factProofStrength("legal-exact"),
    summary: `A complete legal witness associated with ${seed.observationType} exists; it establishes sequence legality and identity only, not strategic relevance, purpose, or plan.`,
    data: {
      authority: "legal-exact",
      witnessForObservationId: id,
      scope: "sequence-legality-and-identity",
    },
    coverage: null,
    replay: seed.replay,
  })] : [];
  return { observation, evidence: [evidence, ...witnessEvidence] };
}

function findOccupationWitness(after: Chess, square: Square, entries: Move[], redundantSquares: Square[]) {
  for (const entry of entries) {
    const entered = new Chess(after.fen());
    if (!play(entered, uci(entry))) continue;
    const exchanges = entered.moves({ verbose: true })
      .filter((move) => move.to === square && move.isCapture() && redundantSquares.includes(move.from as Square))
      .sort((left, right) => uci(left).localeCompare(uci(right)));
    for (const exchange of exchanges) {
      const exchanged = new Chess(entered.fen());
      if (!play(exchanged, uci(exchange))) continue;
      const recapture = exchanged.moves({ verbose: true })
        .filter((move) => move.to === square && move.isCapture())
        .sort((left, right) => Number(left.piece !== "p") - Number(right.piece !== "p") || uci(left).localeCompare(uci(right)))
        .find((move) => move.piece !== entry.piece);
      if (!recapture) continue;
      return { line: [uci(entry), uci(exchange), uci(recapture)], entry, exchange, recapture };
    }
  }
  return null;
}

function findQueenRoute(chess: Chess, owner: Color, enemyKing: Square, weakenedPawnOrigin: Square) {
  const routes: Array<{ first: Move; spacer: Move; second: Move; score: number }> = [];
  const firstMoves = chess.moves({ verbose: true }).filter((move) => move.color === owner && move.piece === "q").sort((a, b) => uci(a).localeCompare(uci(b)));
  for (const first of firstMoves) {
    const afterFirst = new Chess(chess.fen());
    if (!play(afterFirst, uci(first))) continue;
    for (const spacer of quietMoves(afterFirst)) {
      const afterSpacer = new Chess(afterFirst.fen());
      if (!play(afterSpacer, uci(spacer))) continue;
      const secondMoves = afterSpacer.moves({ square: first.to as Square, verbose: true })
        .filter((move) => move.piece === "q" && distance(move.to as Square, enemyKing) <= 2);
      for (const second of secondMoves) {
        const score = (second.isCapture() ? 4 : 0) + (3 - distance(second.to as Square, enemyKing))
          + (distance(second.to as Square, weakenedPawnOrigin) <= 1 ? 6 : 0)
          + (CENTRAL_SQUARES.has(first.to) ? 0.25 : 0);
        routes.push({ first, spacer, second, score });
      }
    }
  }
  return routes.sort((left, right) => right.score - left.score || `${uci(left.first)}:${uci(left.second)}`.localeCompare(`${uci(right.first)}:${uci(right.second)}`))[0] || null;
}

function findRemovalAffordance(after: Chess, attackerSquare: Square, targetSquare: Square, owner: Color) {
  const opponent = opposite(owner);
  const targetControl = attackedSquares(after, targetSquare, opponent);
  const waitingMoves = after.moves({ verbose: true })
    .filter((move) => move.from !== targetSquare && !move.isCapture() && !move.isPromotion() && !isCheck(move))
    .map((move) => {
      const position = new Chess(after.fen());
      play(position, uci(move));
      return { move, score: position.attackers(attackerSquare, opponent).includes(move.to as Square) ? 10 + (move.piece === "p" ? 3 : 0) : 0 };
    })
    .sort((left, right) => right.score - left.score || uci(left.move).localeCompare(uci(right.move)));

  for (const waiting of waitingMoves) {
    const afterWaiting = new Chess(after.fen());
    if (!play(afterWaiting, uci(waiting.move))) continue;
    const capture = afterWaiting.moves({ square: attackerSquare, verbose: true }).find((move) => move.to === targetSquare && move.isCapture());
    if (!capture) continue;
    const afterCapture = new Chess(afterWaiting.fen());
    if (!play(afterCapture, uci(capture))) continue;
    const recaptures = afterCapture.moves({ verbose: true }).filter((move) => move.to === targetSquare && move.isCapture())
      .sort((left, right) => Number(left.piece !== "p") - Number(right.piece !== "p") || uci(left).localeCompare(uci(right)));
    for (const recapture of recaptures) {
      const afterRecapture = new Chess(afterCapture.fen());
      if (!play(afterRecapture, uci(recapture))) continue;
      const followUps = afterRecapture.moves({ verbose: true })
        .filter((move) => targetControl.includes(move.to as Square) && !["p", "k", "q"].includes(move.piece))
        .sort((left, right) => Number(!CENTRAL_SQUARES.has(left.to)) - Number(!CENTRAL_SQUARES.has(right.to)) || uci(left).localeCompare(uci(right)));
      for (const followUp of followUps) {
        const afterFollowUp = new Chess(afterRecapture.fen());
        if (!play(afterFollowUp, uci(followUp))) continue;
        const firstSpacer = quietMoves(afterFollowUp, new Set([targetSquare]))[0];
        if (!firstSpacer) continue;
        const beforeQueen = new Chess(afterFollowUp.fen());
        if (!play(beforeQueen, uci(firstSpacer))) continue;
        const enemyKing = kingSquare(beforeQueen, opponent);
        if (!enemyKing) continue;
        const queenRoute = findQueenRoute(beforeQueen, owner, enemyKing, recapture.from as Square);
        if (!queenRoute) continue;
        return {
          defenseRoots: after.moves({ square: targetSquare, verbose: true }).map(uci).sort(),
          exchangeLine: [uci(waiting.move), uci(capture), uci(recapture)],
          followUp: uci(followUp),
          queenRoute: [uci(queenRoute.first), uci(queenRoute.second)],
          queenWaypoints: [queenRoute.first.from, queenRoute.first.to, queenRoute.second.to],
          fullWitnessLine: [uci(waiting.move), uci(capture), uci(recapture), uci(followUp), uci(firstSpacer), uci(queenRoute.first), uci(queenRoute.spacer), uci(queenRoute.second)],
          followUpSquare: followUp.to as Square,
          goalSquare: queenRoute.second.to as Square,
          supportingPieceSquare: followUp.from as Square,
          queenSquare: queenRoute.first.from as Square,
        };
      }
    }
  }
  return null;
}

export class DeterministicObservationProvider implements ObservationProvider {
  readonly id = PROVIDER_ID;
  readonly version = DETERMINISTIC_OBSERVATION_PROVIDER_VERSION;

  observe(context: ReasoningPositionContext, _controls: ReasoningRunControls, signal?: AbortSignal): ReasoningObservationSet {
    if (signal?.aborted) throw signal.reason || new Error("Observation extraction cancelled");
    const contextHash = reasoningContextHash(context);
    const before = new Chess(context.fenBefore);
    const after = new Chess(context.fenAfter);
    const owner = before.turn();
    const opponent = opposite(owner);
    const from = context.moveUci.slice(0, 2) as Square;
    const to = context.moveUci.slice(2, 4) as Square;
    const moverBefore = before.get(from);
    const identities = createPocIdentityTimeline(context);
    const moverId = stablePieceRef(identities.before, from);
    const observations: ReasoningObservation[] = [];
    const evidence: ReasoningEvidenceRecord[] = [];
    const coverageAffordances: CoverageAffordance[] = [];
    const add = (seed: ObservationSeed) => {
      const made = makeObservation(contextHash, seed);
      observations.push(made.observation);
      evidence.push(...made.evidence);
      return made.observation;
    };

    if (moverBefore && moverId) {
      const beforeAttacks = attackedSquares(before, from, owner);
      const afterAttacks = attackedSquares(after, to, owner);
      const newlyAttackedSquares = afterAttacks.filter((square) => !beforeAttacks.includes(square));
      const retainedAttacks = afterAttacks.filter((square) => beforeAttacks.includes(square));
      const lostAttacks = beforeAttacks.filter((square) => !afterAttacks.includes(square));
      const newlyAttackedOccupiedTargets = newlyAttackedSquares.flatMap((square) => {
        const target = after.get(square);
        const pieceId = target?.color === opponent ? stablePieceRef(identities.after, square) : null;
        return target?.color === opponent && pieceId
          ? [{ square, pieceId, pieceType: target.type }]
          : [];
      });
      const newlyDefendedOccupiedAllies = newlyAttackedSquares.flatMap((square) => {
        const target = after.get(square);
        const pieceId = target?.color === owner ? stablePieceRef(identities.after, square) : null;
        return target?.color === owner && pieceId
          ? [{ square, pieceId, pieceType: target.type }]
          : [];
      });
      const salientNewAttacks = newlyAttackedSquares.filter((square) => {
        const target = after.get(square);
        return target?.color === opponent && target.type !== "p" && target.type !== "k";
      });
      add({
        observationType: "target-move-delta",
        participants: [
          participant(PARTICIPANT_ROLES.ACTOR, REFERENCE_DOMAINS.PIECE, moverId),
          ...newlyAttackedOccupiedTargets.flatMap((target) => [
            participant(PARTICIPANT_ROLES.TARGET, REFERENCE_DOMAINS.PIECE, target.pieceId),
            participant(PARTICIPANT_ROLES.TARGET, REFERENCE_DOMAINS.SQUARE, target.square),
          ]),
          ...newlyDefendedOccupiedAllies.flatMap((target) => [
            participant(PARTICIPANT_ROLES.RESOURCE, REFERENCE_DOMAINS.PIECE, target.pieceId),
            participant(PARTICIPANT_ROLES.TARGET, REFERENCE_DOMAINS.SQUARE, target.square),
          ]),
        ],
        attributes: { moveUci: context.moveUci, from, to, newlyAttackedSquares, retainedAttacks, lostAttacks, salientNewAttacks, newlyAttackedOccupiedTargets, newlyDefendedOccupiedAllies },
        exactness: "exact",
        methods: ["legal-move-replay", "before-after-attack-delta", "stable-piece-identity", "occupied-target-resolution"],
        summary: `Exact move and attack-map delta for ${context.moveUci}, including stable identities for newly attacked opponents and newly defended allies; no tactical or strategic meaning is assigned.`,
        replay: { fen: context.fenBefore, move: context.moveUci },
      });

      for (const square of lostAttacks) {
        const redundantSquares = after.attackers(square, owner).filter((origin) => origin !== to);
        const entryMoves = after.moves({ verbose: true }).filter((move) => move.color === opponent && move.to === square && move.piece !== "p");
        if (!redundantSquares.length || !entryMoves.length) continue;
        const redundantIds = redundantSquares.map((origin) => stablePieceRef(identities.after, origin)).filter((id): id is string => Boolean(id));
        const observation = add({
          observationType: "coverage-handoff-affordance",
          participants: [
            participant(PARTICIPANT_ROLES.ACTOR, REFERENCE_DOMAINS.PIECE, moverId),
            participant(PARTICIPANT_ROLES.TARGET, REFERENCE_DOMAINS.SQUARE, square),
            ...redundantIds.map((id) => participant(PARTICIPANT_ROLES.RESOURCE, REFERENCE_DOMAINS.PIECE, id)),
          ],
          attributes: { square, movedPieceNoLongerAttacks: true, retainedFriendlyAttackers: redundantIds, opponentNonPawnEntryMoves: entryMoves.map(uci).sort() },
          exactness: "exact",
          methods: ["before-after-attack-delta", "legal-entry-enumeration"],
          summary: `The moved piece no longer attacks ${square}; another friendly piece still does, and a non-pawn entry to ${square} is legal.`,
          replay: { fenBefore: context.fenBefore, fenAfter: context.fenAfter, square },
          probeRecipes: [{ tool: "inspect_position", input: { phase: "after", squares: [square, from, to] }, purpose: `Inspect exact occupancy and attack relations around ${square}.` }],
        });
        coverageAffordances.push({ observation, square, redundantSquares, entryMoves });
      }
    }

    for (const coverage of coverageAffordances) {
      const witness = findOccupationWitness(after, coverage.square, coverage.entryMoves, coverage.redundantSquares);
      if (!witness) continue;
      add({
        observationType: "occupation-change-legal-witness",
        participants: [
          participant(PARTICIPANT_ROLES.SUBJECT, REFERENCE_DOMAINS.SQUARE, coverage.square),
          ...(stablePieceRef(identities.after, witness.entry.from as Square) ? [participant(PARTICIPANT_ROLES.ACTOR, REFERENCE_DOMAINS.PIECE, stablePieceRef(identities.after, witness.entry.from as Square)!)] : []),
          ...(stablePieceRef(identities.after, witness.exchange.from as Square) ? [participant(PARTICIPANT_ROLES.RESOURCE, REFERENCE_DOMAINS.PIECE, stablePieceRef(identities.after, witness.exchange.from as Square)!)] : []),
        ],
        attributes: { square: coverage.square, legalLine: witness.line, initialOccupantType: witness.entry.piece, finalOccupantType: witness.recapture.piece },
        exactness: "exact",
        methods: ["legal-line-enumeration", "occupant-type-comparison"],
        summary: `A legal exchange sequence changes the type of piece occupying ${coverage.square}; the observation does not decide its strategic meaning.`,
        replay: { fen: context.fenAfter, moves: witness.line },
        probeRecipes: [{ tool: "test_line", input: { phase: "after", movesUci: witness.line, inspectSquares: [coverage.square] }, purpose: `Replay the exact occupation change on ${coverage.square}.` }],
      });
    }

    if (moverBefore && moverId) {
      const opposingKing = kingSquare(after, opponent);
      const targetSquares = SQUARES.filter((square) => {
        const target = after.get(square);
        return target?.color === opponent
          && target.type !== "p"
          && target.type !== "k"
          && Boolean(opposingKing)
          && distance(square, opposingKing!) <= 2
          && after.attackers(square, owner).includes(to)
          && !before.attackers(square, owner).includes(from);
      });
      for (const targetSquare of targetSquares) {
        const targetId = stablePieceRef(identities.after, targetSquare);
        if (!targetId) continue;
        const removal = findRemovalAffordance(after, to, targetSquare, owner);
        if (!removal || !removal.defenseRoots.length) continue;
        const supportId = stablePieceRef(identities.after, removal.supportingPieceSquare);
        const queenId = stablePieceRef(identities.after, removal.queenSquare);
        add({
          observationType: "exchange-follow-up-legal-affordance",
          participants: [
            participant(PARTICIPANT_ROLES.ACTOR, REFERENCE_DOMAINS.PIECE, moverId),
            participant(PARTICIPANT_ROLES.TARGET, REFERENCE_DOMAINS.PIECE, targetId),
            ...(supportId ? [participant(PARTICIPANT_ROLES.RESOURCE, REFERENCE_DOMAINS.PIECE, supportId)] : []),
          ],
          attributes: { targetSquare, legalTargetMoves: removal.defenseRoots, exchangeLine: removal.exchangeLine, followUpMove: removal.followUp, followUpSquare: removal.followUpSquare, conditional: true },
          exactness: "heuristic",
          methods: ["new-attack-delta", "legal-exchange-enumeration", "central-follow-up-search"],
          summary: `A legal conditional exchange-and-follow-up witness exists after the newly created pressure; it is not a forced plan.`,
          replay: { fen: context.fenAfter, moves: [...removal.exchangeLine, removal.followUp] },
          probeRecipes: [
            { tool: "enumerate_defenses", input: { rootMoves: removal.defenseRoots, depth: 12 }, purpose: "Compare the complete enumerated legal-move class for the pressured piece." },
            { tool: "test_line", input: { phase: "after", movesUci: removal.fullWitnessLine, inspectSquares: [targetSquare, removal.followUpSquare, removal.goalSquare] }, purpose: "Replay the complete legal witness without presenting it as a forced variation." },
          ],
        });
        if (queenId) {
          add({
            observationType: "conditional-route-affordance",
            participants: [
              participant(PARTICIPANT_ROLES.ACTOR, REFERENCE_DOMAINS.PIECE, queenId),
              participant(PARTICIPANT_ROLES.GOAL, REFERENCE_DOMAINS.SQUARE, removal.goalSquare),
            ],
            attributes: { pieceId: queenId, waypoints: removal.queenWaypoints, routeMoves: removal.queenRoute, prerequisitesWitness: [...removal.exchangeLine, removal.followUp], fullLegalWitness: removal.fullWitnessLine, routeKind: "conditional-route" },
            exactness: "heuristic",
            methods: ["legal-route-search", "king-proximity-ranking", "full-line-witness"],
            summary: `A queen route through the listed waypoints appears inside a legal witness line. The route is conditional and is not a principal variation or proof of intent.`,
            replay: { fen: context.fenAfter, moves: removal.fullWitnessLine },
            probeRecipes: [{ tool: "test_line", input: { phase: "after", movesUci: removal.fullWitnessLine, inspectSquares: removal.queenWaypoints }, purpose: "Replay the legal witness containing the conditional queen route." }],
          });
        }
        break;
      }
    }

    const deduped = [...new Map(observations.map((observation) => [observation.id, observation])).values()].sort((a, b) => a.id.localeCompare(b.id));
    const usedEvidence = new Set(deduped.flatMap((observation) => observation.factEvidenceIds));
    return {
      schemaVersion: REASONING_POC_VERSION,
      contextHash,
      observations: deduped,
      evidence: evidence.filter((record) => usedEvidence.has(record.id)),
      providers: [{ provider: this.id, version: this.version }],
      limitations: [
        "Deterministic observations describe facts and affordances only; they do not name plans, roles, changed constraints, or causal intent.",
      ],
    };
  }
}

export class CompositeObservationProvider implements ObservationProvider {
  readonly id = "knights-eye/composite-observation-provider";
  readonly version: string;

  constructor(private readonly providers: ObservationProvider[]) {
    if (!providers.length) throw new Error("CompositeObservationProvider requires at least one provider");
    this.version = stableHash(providers.map((provider) => ({ id: provider.id, version: provider.version })));
  }

  async observe(context: ReasoningPositionContext, controls: ReasoningRunControls, signal?: AbortSignal): Promise<ReasoningObservationSet> {
    const contextHash = reasoningContextHash(context);
    const sets = await Promise.all(this.providers.map((provider) => provider.observe(context, controls, signal)));
    for (const set of sets) if (set.contextHash !== contextHash) throw new Error("Observation provider returned stale context");
    const observations = [...new Map(sets.flatMap((set) => set.observations).map((item) => [item.id, item])).values()];
    const evidence = [...new Map(sets.flatMap((set) => set.evidence).map((item) => [item.id, item])).values()];
    return {
      schemaVersion: REASONING_POC_VERSION,
      contextHash,
      observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
      evidence,
      providers: [...new Map(sets.flatMap((set) => set.providers).map((provider) => [`${provider.provider}\u0000${provider.version}`, provider])).values()],
      limitations: [...new Set(sets.flatMap((set) => set.limitations))],
    };
  }
}

const BASE_SALIENCE: Record<string, number> = {
  "target-move-delta": 0.92,
  "analysis-context:material-offer-set": 0.96,
  "analysis-context:engine.bounded-assessment": 0.88,
  "analysis-context:classification.label": 0.28,
  "analysis-context:classifier.missed-opportunity": 0.7,
  "analysis-context:semantic.lifecycle.material-exchange": 0.58,
  "analysis-context:path.semantic.lifecycle.material-exchange": 0.42,
  "coverage-handoff-affordance": 0.86,
  // Preserve salience for older composable records; provider /5 never emits it.
  "recent-castling-and-check-response": 0.82,
  "occupation-change-legal-witness": 0.84,
  "exchange-follow-up-legal-affordance": 0.9,
  "conditional-route-affordance": 0.32,
};

function semanticRecord(value: SemanticValue | undefined): Record<string, SemanticValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, SemanticValue> : null;
}

function semanticList(value: SemanticValue | undefined): SemanticValue[] {
  return Array.isArray(value) ? value : [];
}

function mechanicalObservationBase(observation: ReasoningObservation): number | null {
  if (!observation.observationType.startsWith("chess-fact:")) return null;
  const kind = String(observation.attributes.factKind || observation.observationType.slice("chess-fact:".length));
  const data = semanticRecord(observation.attributes.data) || {};
  switch (kind) {
    case "move.blocks_check_line": return 0.98;
    case "castling.king_rook_transition": return 0.95;
    case "move.unblocks_line": return 0.93;
    case "king.checkers_after": return 0.92;
    case "king.legal_moves": return 0.88;
    case "king.geometry_after": return semanticRecord(data.distance)?.chebyshev === 2 ? 0.85 : 0.48;
    case "king_rook.castling_history": return semanticList(data.events).length ? 0.82 : 0.35;
    case "line.occupied_ray_alignment_after_exchange": return data.rearPieceType === "q" || data.rearPieceType === "k" ? 0.52 : 0.44;
    case "piece.absolute_pin": return semanticList(data.pins).length ? 0.9 : 0.45;
    case "move.legal_recaptures_after": return semanticList(data.moves).length
      ? data.allCapturesLoseAfterImmediateSameSquareRecapture === true ? 0.64 : 0.91
      : 0.47;
    case "move.capture_response_availability_after": return semanticList(data.preCaptureBlockedSliderCapturers).length
      || semanticList(data.unavailableGeometricDefenderPieceIds).length
      ? 0.98
      : semanticList(data.legalSameSquareRecaptures).length ? 0.9 : 0.32;
    case "move.capture_check_delta": return data.capture === true || data.givesCheck === true ? 0.94 : 0.5;
    case "piece.attack_delta": return semanticList(data.occupiedOpponentTargets).length ? 0.9 : semanticList(data.gained).length ? 0.8 : 0.55;
    case "piece.legal_moves": return data.pieceType === "q" ? 0.9 : data.pieceType === "r" ? 0.87 : data.pieceType === "b" || data.pieceType === "n" ? 0.84 : 0.68;
    case "square.attacker_delta": return data.occupiedOpponentLostAttack === true
      ? 0.96
      : data.remainsAttackedAfterLoss === true && semanticList(data.sideToMoveLegalEntries).length
        ? 0.88
        : data.newlyContestedLegalEntry === true
          ? 0.86
          : data.remainsAttackedAfterLoss === true
            ? 0.76
            : 0.58;
    case "square.friendly_nonpawn_reachers_after": return semanticList(data.friendlyNonPawnReachers).some((item) => semanticRecord(item)?.pieceType === "n") ? 0.84 : 0.54;
    case "square.same_square_exchange_witnesses": {
      const outcomes = semanticList(data.lineOutcomes).map(semanticRecord).filter(Boolean);
      const allFirstCapturesLose = outcomes.length > 0 && outcomes.every((outcome) => typeof outcome!.finalNominalBalanceDeltaForFirstCapturingSide === "number" && outcome!.finalNominalBalanceDeltaForFirstCapturingSide < 0);
      return allFirstCapturesLose ? 0.6 : data.attackerLossRetainedAndLegalEntry === true ? 0.87 : 0.57;
    }
    case "pawn.advance_state": return data.ranksRemaining === 1 ? 0.97 : 0.94;
    case "position.legal_moves": return semanticList(data.moves).length <= 5 ? 0.92 : 0.52;
    case "king.check_state": return data.inCheck === true ? observation.attributes.phase === "before" ? 0.97 : 0.93 : 0.46;
    case "material.nominal_delta": return semanticRecord(data.delta) && Object.values(semanticRecord(data.delta)!).some((value) => typeof value === "number" && value !== 0) ? 0.82 : 0.38;
    case "move.legal_transition": return 0.74;
    case "square.attackers_delta_inventory": return 0.3;
    case "material.inventory": return 0.28;
    case "position.legal_move_count": return 0.25;
    default: return 0.5;
  }
}

function existingAnalysisObservationBase(observation: ReasoningObservation, question: string): { base: number; reason: string } | null {
  if (!observation.observationType.startsWith("analysis-context:")) return null;
  const asksAboutClassification = /\b(classif(?:y|ied|ication)?|label(?:led|ed)?|call(?:ed|ing)?|grade(?:d)?|rating)\b/i.test(question);
  const asksForComparison = /\b(best|better|worse|prefer(?:able|red)?|instead|alternative|compar(?:e|ed|ison)|score|evaluation|engine|support(?:s|ed)?)\b/i.test(question);
  const asksAboutMaterial = /\b(material|offer(?:ed|ing)?|sacrific(?:e|ed|ial)?|captur(?:e|ed|ing)|exchange|pawn|piece)\b/i.test(question);
  const asksAboutHistory = /\b(earlier|later|previous|prior|subsequent|persist(?:s|ed|ent)?|retain(?:s|ed)?|redirect(?:s|ed)?|abandon(?:s|ed)?|settle(?:s|d)?|convert(?:s|ed)?|throughout|over the game)\b/i.test(question);
  switch (observation.observationType) {
    case "analysis-context:material-offer-set": {
      const offers = semanticList(observation.attributes.offers);
      const screened = semanticList(observation.attributes.screenedCandidates);
      if (offers.length) return { base: 0.96, reason: "context-content:qualifying-offer" };
      if (asksAboutMaterial) return { base: screened.length ? 0.78 : 0.68, reason: "question-relevance:material" };
      return { base: screened.length ? 0.38 : 0.16, reason: screened.length ? "context-content:screened-only" : "context-content:empty-offer-set" };
    }
    case "analysis-context:classification.label":
      return asksAboutClassification
        ? { base: 0.92, reason: "question-relevance:reported-classification" }
        : { base: 0.28, reason: "context-authority:label-only" };
    case "analysis-context:engine.bounded-assessment":
      return asksForComparison || asksAboutClassification
        ? { base: 0.94, reason: "question-relevance:bounded-assessment" }
        : { base: 0.88, reason: "context-content:bounded-assessment" };
    case "analysis-context:classifier.missed-opportunity":
      return asksForComparison
        ? { base: 0.82, reason: "question-relevance:missed-opportunity" }
        : { base: 0.4, reason: "context-authority:diagnostic-affordance" };
    case "analysis-context:semantic.lifecycle.material-exchange":
    case "analysis-context:path.semantic.lifecycle.material-exchange":
      return asksAboutMaterial || asksAboutHistory
        ? { base: observation.observationType.startsWith("analysis-context:path.") ? 0.72 : 0.8, reason: "question-relevance:material-lifecycle" }
        : { base: observation.observationType.startsWith("analysis-context:path.") ? 0.24 : 0.32, reason: "context-authority:lifecycle-affordance" };
    default:
      return { base: 0.5, reason: "context-content:generic" };
  }
}

export class QuestionConditionedSaliencePolicy implements SaliencePolicy {
  readonly id = QUESTION_SALIENCE_POLICY_VERSION;

  constructor(private readonly maxPresented = 16) {}

  rank(observations: ReasoningObservationSet, contract: QueryContract): ReasoningRankedObservationSet {
    const moveIdeaQuestion = /\b(idea|plan|why|purpose|point|prepare|threat)\b/i.test(contract.question);
    const ranked = observations.observations.map((observation) => {
      const mechanicalBase = mechanicalObservationBase(observation);
      const analysisContext = existingAnalysisObservationBase(observation, contract.question);
      const base = mechanicalBase ?? analysisContext?.base ?? BASE_SALIENCE[observation.observationType] ?? 0.5;
      const questionBoost = moveIdeaQuestion
        && observation.observationType !== "target-move-delta"
        && !analysisContext
        ? 0.06
        : 0;
      const exactnessBoost = observation.exactness === "exact" ? 0.02 : 0;
      return {
        ...observation,
        salience: Math.min(1, Math.round((base + questionBoost + exactnessBoost) * 1_000) / 1_000),
        salienceReasons: [
          moveIdeaQuestion ? "question-shape:move-idea" : "question-shape:general",
          `observation-type:${observation.observationType}`,
          ...(analysisContext ? [analysisContext.reason] : []),
          `exactness:${observation.exactness}`,
        ],
        presentedToModel: false,
      };
    }).sort((a, b) => b.salience - a.salience || a.id.localeCompare(b.id));
    ranked.forEach((observation, index) => { observation.presentedToModel = index < this.maxPresented; });
    return { ...observations, observations: ranked, saliencePolicy: this.id };
  }
}

export function createDefaultObservationProvider(): ObservationProvider {
  return new CompositeObservationProvider([new DeterministicObservationProvider()]);
}

export function createDefaultSaliencePolicy(maxPresented = 16): SaliencePolicy {
  return new QuestionConditionedSaliencePolicy(maxPresented);
}
