import { Output, generateText, jsonSchema, type LanguageModel, type LanguageModelCallOptions } from "ai";
import { effectiveLicensesForRecord, licensesBoundedRouteRelevance, licensesSemanticChessGrounding } from "./evidence-licenses";
import type { LeanDirectEvidenceSelector } from "./evidence-selector-contract";
import {
  projectAblationEvidenceForModel,
  compactLeanEvidencePacket,
} from "./ablation-model-facing-evidence";
import {
  createAblationEvidenceClosureBundle,
  validateAblationEvidenceClosureBundle,
  type AblationEvidenceClosureBundle,
} from "./ablation-evidence-bundle";
import { bytes, emitObservableTrace, numericUsage, type ObservableLlmTraceSink } from "./ai-sdk-runtime-support";
import { collectReasoningMoveWitnesses } from "./poc-move-witnesses";
import { stableHash } from "./stable";

/**
 * A deliberately small development diagnostic. It is not a product stage and
 * does not create hypotheses, a graph, a checkpoint, or an answer repair
 * loop. Its purpose is to test whether the model can synthesize a useful,
 * evidence-cited answer when the evidence transport is not the bottleneck.
 */
export const ABLATION_LEAN_DIRECT_RUNTIME_VERSION = "architecture-ablation-lean-direct-runtime/8" as const;
export const ABLATION_LEAN_DIRECT_PROPOSAL_VERSION = "architecture-ablation-lean-direct-proposal/3" as const;
export const ABLATION_LEAN_DIRECT_EVIDENCE_VIEW_VERSION = "architecture-ablation-lean-direct-evidence-view/2" as const;

/**
 * The direct arm normally sees the production salience projection.  It also
 * admits at most one already-captured bounded continuation/comparison record,
 * plus observations that cite it. This is deterministic transport selection,
 * not an engine call or a chess-purpose heuristic: it prevents a previously
 * available discriminating witness from being silently withheld before the
 * sole model call.
 */
export type LeanDirectEvidenceView = Readonly<{
  schemaVersion: typeof ABLATION_LEAN_DIRECT_EVIDENCE_VIEW_VERSION;
  sourceBundleHash: string;
  bundle: Readonly<AblationEvidenceClosureBundle>;
  salienceEvidenceIds: readonly string[];
  requiredEvidenceIds: readonly string[];
  supplementalBoundedEvidenceIds: readonly string[];
  /** Present only for the compact fixture-declared packet, never model-authored semantics. */
  selectedSelectorIds: readonly string[];
  viewHash: string;
}>;

export const ablationLeanDirectSystem = `You are Knight's Eye in a private development diagnostic. Return exactly one object matching the supplied schema. This is one compact synthesis call: there are no tools, hypothesis ledger, critic, graph selection, checkpoint, discourse stage, rendering stage, repair call, or hidden answer key.

Answer the user's verbatim chess question naturally and concisely. Before drafting, silently compare the evidence-backed causal chains. Lead with the smallest chain that directly answers the question and explains the move's most decision-relevant change to an option, resource, constraint, threat, or comparison. When exact structured evidence gives the mechanism for an unavailable or legal response--for example a blocking occupant or ray, a pin, or a defender constraint--state that mechanism before any incidental attack, square, or material side effect. Then include only the supporting links needed to show why it works, its practical consequence, or a necessary qualification. Deliberately omit exact but incidental facts: do not enumerate records merely because they are available or use them to make the answer look complete. A factual observation is not automatically a strategic explanation: do not invent purpose, force, safety, or a continuation beyond the cited evidence. Bounded engine evidence establishes only its recorded line, comparison, score, or response coverage. Exact legal facts establish only what they state. If the available evidence does not settle a point, say so in limitations instead of guessing.

Use only the supplied evidence IDs. Cite evidence for every claim. Each claim is plain concise prose; do not encode moves, pieces, squares, or other references as structured fields. The answer remains an unvalidated diagnostic proposal, never a supported Knight's Eye result.`;

const CLAIM_KINDS = new Set(["fact", "interpretation", "consequence", "defense", "uncertainty", "comparison"]);

export const LEAN_DIRECT_PROPOSAL_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "claims", "limitations", "coverage"],
  properties: {
    schemaVersion: { const: ABLATION_LEAN_DIRECT_PROPOSAL_VERSION },
    claims: {
      type: "array", minItems: 1, maxItems: 4,
      items: {
        type: "object", additionalProperties: false,
        required: ["text", "kind", "evidenceIds"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 700 },
          kind: { enum: ["fact", "interpretation", "consequence", "defense", "uncertainty", "comparison"] },
          evidenceIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
    },
    limitations: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 400 } },
    coverage: {
      type: "object", additionalProperties: false,
      required: ["status", "unresolved"],
      properties: {
        status: { enum: ["complete", "partial", "unavailable"] },
        unresolved: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 400 } },
      },
    },
  },
} as const;

export type LeanDirectClaim = {
  text: string;
  kind: "fact" | "interpretation" | "consequence" | "defense" | "uncertainty" | "comparison";
  evidenceIds: string[];
};

export type LeanDirectArtifact = {
  schemaVersion: typeof ABLATION_LEAN_DIRECT_PROPOSAL_VERSION;
  sourceBundleHash: string;
  modelFacingEvidenceViewHash: string;
  claims: LeanDirectClaim[];
  limitations: string[];
  coverage: { status: "complete" | "partial" | "unavailable"; unresolved: string[] };
  admission: "diagnostic-proposed";
  productSupport: "not-a-validated-graph-checkpoint-or-product-result";
};

export type LeanDirectFailure = {
  kind: "provider-or-structured-output" | "lean-contract-rejected" | "aborted" | "wall-time";
  code: string;
  issues?: Array<{ path: string; code: string }>;
};

export type LeanDirectCallDiagnostic = {
  stage: "lean-direct" | "lean-acquisition";
  runtime: typeof ABLATION_LEAN_DIRECT_RUNTIME_VERSION;
  model: string;
  route: string;
  effort: string;
  temperature: number | null;
  bundleHash: string;
  inputBytes: number;
  schemaBytes: number;
  outputBytes: number;
  finishReason: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  cacheTokens: number | null;
  outcome: "succeeded" | "failed" | "aborted";
  failureCode: string | null;
};

export type LeanDirectRuntimeOptions = {
  model: LanguageModel;
  modelName?: string;
  providerRoute?: string;
  reasoning?: NonNullable<LanguageModelCallOptions["reasoning"]>;
  temperature?: number;
  maxOutputTokens: number;
  maxWallTimeMs: number;
  benchmarkNonce?: string | null;
  /** Deterministically acquired, fixture-scoped evidence that must reach this sole synthesis call. */
  requiredEvidenceIds?: readonly string[];
  /**
   * Fixture-declared fact/observation selectors for a deliberately compact
   * evidence packet. Absent selectors retain the generic salience projection
   * used by non-fixture diagnostics.
   */
  evidenceSelectors?: readonly LeanDirectEvidenceSelector[];
  /** Generic acquisition: only records actually presented or retrieved in this episode. */
  modelEvidenceIds?: readonly string[];
  episodeCoverage?: AblationEvidenceClosureBundle["coverage"];
  consumeProviderMetadata?: () => readonly { cost?: number | null; cacheTokens?: number | null; model?: string | null; route?: string | null; effort?: string | null }[];
  observableTraceSink?: ObservableLlmTraceSink;
};

export type LeanDirectResult =
  | { ok: true; artifact: LeanDirectArtifact; diagnostics: LeanDirectCallDiagnostic[]; modelView: LeanDirectEvidenceView }
  | { ok: false; diagnostics: LeanDirectCallDiagnostic[]; failure: LeanDirectFailure; modelView: LeanDirectEvidenceView };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown, path: string, max = 600): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new LeanAdmissionError(path, "invalid-string");
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) throw new LeanAdmissionError(path, "invalid-shape");
}

class LeanAdmissionError extends Error {
  constructor(readonly path: string, readonly code: string) { super(`${path}:${code}`); }
}

function modelName(options: LeanDirectRuntimeOptions): string {
  if (options.modelName) return options.modelName;
  return typeof options.model !== "string" && "modelId" in options.model && typeof options.model.modelId === "string" ? options.model.modelId : "unspecified";
}

function effectiveSystem(nonce: string | null | undefined): string {
  if (!nonce) return ablationLeanDirectSystem;
  if (typeof nonce !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(nonce)) throw new Error("Lean direct requires a bounded opaque benchmark nonce");
  return `[Benchmark cache-isolation nonce: ${nonce}. Ignore this opaque identifier; it has no chess, workflow, or output meaning.]\n\n${ablationLeanDirectSystem}`;
}

function now(): number { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

function abortContext(signal: AbortSignal | undefined, maxWallTimeMs: number) {
  if (!Number.isFinite(maxWallTimeMs) || maxWallTimeMs < 1) throw new Error("Lean direct requires a positive wall-time budget");
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(signal?.reason || new Error("Lean direct cancelled"));
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error("Lean direct timed out")); }, maxWallTimeMs);
  return { signal: controller.signal, timedOut: () => timedOut, dispose: () => { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); } };
}

function classify(error: unknown, timedOut: boolean, externallyAborted: boolean): LeanDirectFailure {
  if (timedOut) return { kind: "wall-time", code: "wall-time-budget" };
  if (externallyAborted) return { kind: "aborted", code: "aborted" };
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error || "");
  if (/schema/i.test(message)) return { kind: "provider-or-structured-output", code: "structured-output-schema" };
  if (/parse|json/i.test(message)) return { kind: "provider-or-structured-output", code: "structured-output-parse" };
  if (/empty|content|output/i.test(message)) return { kind: "provider-or-structured-output", code: "structured-output-missing" };
  return { kind: "provider-or-structured-output", code: "provider-runtime" };
}

function factKind(observation: Readonly<AblationEvidenceClosureBundle>["observations"][number]): string | null {
  const attributes = observation.attributes;
  const kind = attributes && typeof attributes === "object" && !Array.isArray(attributes) ? attributes.factKind : null;
  return typeof kind === "string" ? kind : null;
}

function selectorMatches(selector: LeanDirectEvidenceSelector, observation: Readonly<AblationEvidenceClosureBundle>["observations"][number]): boolean {
  const matchesFact = Boolean(selector.factKinds?.includes(factKind(observation) || ""));
  const matchesType = Boolean(selector.observationTypes?.includes(observation.observationType));
  return matchesFact || matchesType;
}

const SQUARE = /^[a-h][1-8]$/;
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const COMPACT_AUDIT_LIST_LIMIT = 8;
const LEAN_CAUSAL_FOCUS_LIMIT = 3;

function hasStructuredField(value: unknown, matcher: RegExp): boolean {
  if (Array.isArray(value)) return value.some((item) => hasStructuredField(item, matcher));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => matcher.test(key) || hasStructuredField(child, matcher));
}

/**
 * This is transport ranking, not a chess conclusion: response constraints
 * and their exact mechanisms carry more explanatory information than broad
 * geometry deltas. The order is independent of any fixture, question, or
 * model-authored answer.
 */
function causalFocusRank(
  observation: Readonly<AblationEvidenceClosureBundle>["observations"][number],
  evidenceById: ReadonlyMap<string, AblationEvidenceClosureBundle["evidence"][number]>,
): number {
  const kind = factKind(observation);
  const evidence = observation.factEvidenceIds.map((id) => evidenceById.get(id)).filter((item): item is AblationEvidenceClosureBundle["evidence"][number] => Boolean(item));
  const mechanismFields = /(?:block|occup|ray|pin|defend|constraint)/i;
  const hasMechanism = evidence.some((item) => hasStructuredField(item.data, mechanismFields));
  switch (kind) {
    case "move.capture_response_availability_after": return hasMechanism ? 500 : 470;
    case "piece.absolute_pin": return 460;
    case "move.legal_recaptures_after": return 440;
    case "move.blocks_check_line":
    case "move.unblocks_line":
    case "king.checkers_after":
    case "king.legal_moves": return 400;
    case "move.legal_transition": return 360;
    case "piece.attack_delta":
    case "square.attacker_delta":
    case "square.attackers_delta_inventory": return 120;
    default: return 240;
  }
}

function presentationSalience(observation: Readonly<AblationEvidenceClosureBundle>["observations"][number]): number {
  const value = (observation as { salience?: unknown }).salience;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function focusedLeanProjection(
  source: Readonly<AblationEvidenceClosureBundle>,
  alwaysIncludedEvidenceIds: readonly string[],
): { bundle: Readonly<AblationEvidenceClosureBundle>; selectedEvidenceIds: string[]; selectedObservationIds: string[] } {
  const evidenceById = new Map(source.evidence.map((item) => [item.id, item]));
  const alwaysIncluded = new Set(alwaysIncludedEvidenceIds);
  const requiredObservations = source.observations.filter((observation) => observation.factEvidenceIds.some((id) => alwaysIncluded.has(id)));
  const selectedObservationIds = new Set(requiredObservations.map((observation) => observation.id));
  const ranked = source.observations
    .filter((observation) => !selectedObservationIds.has(observation.id))
    .sort((left, right) => (
      causalFocusRank(right, evidenceById) - causalFocusRank(left, evidenceById)
      || presentationSalience(right) - presentationSalience(left)
      || left.id.localeCompare(right.id)
    ));
  for (const observation of ranked.slice(0, LEAN_CAUSAL_FOCUS_LIMIT)) selectedObservationIds.add(observation.id);
  const observations = source.observations.filter((observation) => selectedObservationIds.has(observation.id));
  const selectedEvidenceIds = new Set(alwaysIncluded);
  observations.forEach((observation) => observation.factEvidenceIds.forEach((id) => selectedEvidenceIds.add(id)));
  if ([...selectedEvidenceIds].some((id) => !evidenceById.has(id))) throw new Error("Lean direct causal focus references unadmitted evidence");
  const evidence = source.evidence.filter((item) => selectedEvidenceIds.has(item.id));
  const sourceOmissions = source.coverage.omitted.slice(0, COMPACT_AUDIT_LIST_LIMIT);
  const sourceUnavailable = source.coverage.unavailable.slice(0, COMPACT_AUDIT_LIST_LIMIT);
  const omittedCount = source.observations.length - observations.length + source.evidence.length - evidence.length;
  return {
    bundle: createAblationEvidenceClosureBundle({
      context: source.context,
      question: source.question,
      observations,
      evidence,
      referenceAllowlists: referenceAllowlistsForSelection(source, observations, evidence),
      coverage: {
        complete: false,
        covered: evidence.map((item) => item.id),
        omitted: sourceOmissions,
        unavailable: sourceUnavailable,
        limitations: [
          ...source.coverage.limitations.slice(0, COMPACT_AUDIT_LIST_LIMIT),
          "This Lean diagnostic uses a deterministic causal-focus projection of presented exact evidence plus required bounded evidence.",
          `${omittedCount} lower-information or non-required record(s) are retained only in the immutable source-bundle audit, not this model packet.`,
          ...(source.coverage.omitted.length > sourceOmissions.length ? [`${source.coverage.omitted.length - sourceOmissions.length} additional source omission record(s) remain in source-bundle audit only.`] : []),
          ...(source.coverage.unavailable.length > sourceUnavailable.length ? [`${source.coverage.unavailable.length - sourceUnavailable.length} additional unavailable-domain record(s) remain in source-bundle audit only.`] : []),
        ],
      },
    }),
    selectedEvidenceIds: evidence.map((item) => item.id).sort(),
    selectedObservationIds: observations.map((item) => item.id).sort(),
  };
}

function stringsIn(value: unknown, values: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") values.add(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, values));
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach((item) => stringsIn(item, values));
  return values;
}

function referenceAllowlistsForSelection(
  source: Readonly<AblationEvidenceClosureBundle>,
  observations: readonly AblationEvidenceClosureBundle["observations"][number][],
  evidence: readonly AblationEvidenceClosureBundle["evidence"][number][],
) {
  const witnesses = collectReasoningMoveWitnesses(evidence, source.context);
  const groundedMoves = new Set([
    ...source.context.historyUci,
    source.context.moveUci,
    ...witnesses.map((witness) => witness.uci),
  ]);
  const supportedStrings = new Set<string>();
  observations.forEach((observation) => stringsIn({ participants: observation.participants, attributes: observation.attributes }, supportedStrings));
  evidence.forEach((item) => stringsIn({ data: item.data, replay: item.replay }, supportedStrings));
  for (const witness of witnesses) {
    supportedStrings.add(witness.uci);
    supportedStrings.add(witness.pieceId);
    supportedStrings.add(witness.uci.slice(0, 2));
    supportedStrings.add(witness.uci.slice(2, 4));
  }
  const semanticReferences = source.referenceAllowlists.semanticReferences.filter((reference) => (
    // A UCI-shaped string in a retained record is not itself a replayable
    // chess reference. A compact projection may have dropped the record that
    // supplied its witness, so moves must still be grounded by the retained
    // context or retained evidence witnesses.
    (reference.domain !== "move" || groundedMoves.has(reference.id))
    && (
      (reference.domain === "move" && reference.id === source.context.moveUci)
    || observations.some((observation) => observation.participants.some((participant) => participant.ref.domain === reference.domain && participant.ref.id === reference.id))
    || supportedStrings.has(reference.id)
    )
  ));
  const explicitWitnessReferences = witnesses.flatMap((witness) => [
    { domain: "move" as const, id: witness.uci },
    { domain: "piece" as const, id: witness.pieceId },
    { domain: "square" as const, id: witness.uci.slice(0, 2) },
    { domain: "square" as const, id: witness.uci.slice(2, 4) },
  ]);
  const exactSquareReferences = [...supportedStrings]
    .filter((value) => SQUARE.test(value))
    .map((id) => ({ domain: "square" as const, id }));
  const exactMoveReferences = [...supportedStrings]
    .filter((value) => UCI.test(value) && witnesses.some((witness) => witness.uci === value))
    .map((id) => ({ domain: "move" as const, id }));
  return {
    evidenceIds: evidence.map((item) => item.id),
    observationIds: observations.map((item) => item.id),
    toolNames: source.referenceAllowlists.toolNames,
    semanticReferences: [...semanticReferences, ...explicitWitnessReferences, ...exactSquareReferences, ...exactMoveReferences]
      .filter((reference, index, all) => all.findIndex((candidate) => candidate.domain === reference.domain && candidate.id === reference.id) === index),
    moveWitnesses: witnesses,
  };
}

function compactFixtureProjection(
  source: Readonly<AblationEvidenceClosureBundle>,
  requiredEvidenceIds: readonly string[],
  selectors: readonly LeanDirectEvidenceSelector[],
): { bundle: Readonly<AblationEvidenceClosureBundle>; selectedEvidenceIds: string[]; selectedObservationIds: string[]; selectorIds: string[] } {
  const selectorIds = selectors.map((selector) => selector.id);
  if (!selectors.length || selectorIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(selectorIds).size !== selectorIds.length) {
    throw new Error("Lean direct compact evidence selection requires uniquely named selectors");
  }
  for (const selector of selectors) {
    if ((!selector.factKinds?.length && !selector.observationTypes?.length)
      || selector.factKinds?.some((kind) => typeof kind !== "string" || !kind.trim())
      || selector.observationTypes?.some((type) => typeof type !== "string" || !type.trim())) {
      throw new Error(`Lean direct selector ${selector.id} must declare bounded fact or observation names`);
    }
  }
  const evidenceById = new Map(source.evidence.map((item) => [item.id, item]));
  const selectedObservations = source.observations.filter((observation) => selectors.some((selector) => selectorMatches(selector, observation)));
  for (const selector of selectors) {
    if (!selectedObservations.some((observation) => selectorMatches(selector, observation))) {
      throw new Error(`Lean direct compact evidence selector ${selector.id} found no observation`);
    }
  }
  const selectedEvidenceIds = new Set<string>(requiredEvidenceIds);
  for (const observation of selectedObservations) observation.factEvidenceIds.forEach((id) => selectedEvidenceIds.add(id));
  if ([...selectedEvidenceIds].some((id) => !evidenceById.has(id))) throw new Error("Lean direct compact evidence selection references unadmitted evidence");
  const evidence = source.evidence.filter((item) => selectedEvidenceIds.has(item.id));
  const sourceOmissions = source.coverage.omitted.slice(0, COMPACT_AUDIT_LIST_LIMIT);
  const sourceUnavailable = source.coverage.unavailable.slice(0, COMPACT_AUDIT_LIST_LIMIT);
  const omittedCount = source.observations.length - selectedObservations.length + source.evidence.length - evidence.length;
  const bundle = createAblationEvidenceClosureBundle({
    context: source.context,
    question: source.question,
    observations: selectedObservations,
    evidence,
    referenceAllowlists: referenceAllowlistsForSelection(source, selectedObservations, evidence),
    coverage: {
      complete: false,
      covered: evidence.map((item) => item.id),
      omitted: sourceOmissions,
      unavailable: sourceUnavailable,
      limitations: [
        ...source.coverage.limitations.slice(0, COMPACT_AUDIT_LIST_LIMIT),
        "This Lean diagnostic uses only fixture-declared, pre-semantic evidence selectors plus its required witness.",
        `${omittedCount} non-selected pre-semantic record(s) are retained only in the immutable source-bundle audit, not this model packet.`,
        ...(source.coverage.omitted.length > sourceOmissions.length ? [`${source.coverage.omitted.length - sourceOmissions.length} additional source omission record(s) remain in source-bundle audit only.`] : []),
        ...(source.coverage.unavailable.length > sourceUnavailable.length ? [`${source.coverage.unavailable.length - sourceUnavailable.length} additional unavailable-domain record(s) remain in source-bundle audit only.`] : []),
      ],
    },
  });
  return {
    bundle,
    selectedEvidenceIds: evidence.map((item) => item.id).sort(),
    selectedObservationIds: selectedObservations.map((item) => item.id).sort(),
    selectorIds: [...selectorIds].sort(),
  };
}

export function projectLeanDirectEvidence(
  bundle: Readonly<AblationEvidenceClosureBundle>,
  requiredEvidenceIds: readonly string[] = [],
  evidenceSelectors: readonly LeanDirectEvidenceSelector[] = [],
): LeanDirectEvidenceView {
  validateAblationEvidenceClosureBundle(bundle);
  const required = [...new Set(requiredEvidenceIds)].sort();
  if (required.some((id) => typeof id !== "string" || !id.trim())) throw new Error("Lean direct required evidence IDs must be bounded non-empty strings");
  const sourceEvidence = new Map(bundle.evidence.map((item) => [item.id, item]));
  if (required.some((id) => !sourceEvidence.has(id))) throw new Error("Lean direct required evidence is not in the frozen bundle");
  if (evidenceSelectors.length) {
    const compact = compactFixtureProjection(bundle, required, evidenceSelectors);
    const focused = focusedLeanProjection(compact.bundle, required);
    return Object.freeze({
      schemaVersion: ABLATION_LEAN_DIRECT_EVIDENCE_VIEW_VERSION,
      sourceBundleHash: bundle.bundleHash,
      bundle: focused.bundle,
      salienceEvidenceIds: Object.freeze(focused.selectedEvidenceIds),
      requiredEvidenceIds: Object.freeze(required),
      supplementalBoundedEvidenceIds: Object.freeze([]),
      selectedSelectorIds: Object.freeze(compact.selectorIds),
      viewHash: stableHash({
        schemaVersion: ABLATION_LEAN_DIRECT_EVIDENCE_VIEW_VERSION,
        sourceBundleHash: bundle.bundleHash,
        projectedBundleHash: focused.bundle.bundleHash,
        selectedEvidenceIds: focused.selectedEvidenceIds,
        selectedObservationIds: focused.selectedObservationIds,
        requiredEvidenceIds: required,
        selectedSelectorIds: compact.selectorIds,
      }),
    });
  }
  const salience = projectAblationEvidenceForModel(bundle);
  const salienceEvidenceIds = new Set(salience.bundle.evidence.map((item) => item.id));
  const requiredSupplemental = required.flatMap((id) => {
    const record = sourceEvidence.get(id);
    return record && !salienceEvidenceIds.has(id) ? [record] : [];
  });
  const boundedSupplemental = bundle.evidence
    .filter((item) => !salienceEvidenceIds.has(item.id) && !required.includes(item.id) && licensesBoundedRouteRelevance(effectiveLicensesForRecord(item)))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 1);
  const supplemental = [...requiredSupplemental, ...boundedSupplemental];
  const supplementalIds = new Set(supplemental.map((item) => item.id));
  const observations = [
    ...salience.bundle.observations,
    ...bundle.observations.filter((item) => !salience.bundle.observations.some((visible) => visible.id === item.id)
      && item.factEvidenceIds.some((id) => supplementalIds.has(id))),
  ];
  const evidence = [...salience.bundle.evidence, ...supplemental];
  const projected = createAblationEvidenceClosureBundle({
    context: bundle.context,
    question: bundle.question,
    observations,
    evidence,
    referenceAllowlists: referenceAllowlistsForSelection(bundle, observations, evidence),
    coverage: {
      ...salience.bundle.coverage,
      limitations: [
        ...salience.bundle.coverage.limitations,
        ...(supplemental.length ? ["One already-captured bounded continuation/comparison record was included for this one-call diagnostic."] : []),
      ],
    },
  });
  const supplementalBoundedEvidenceIds = boundedSupplemental.map((item) => item.id);
  const focused = focusedLeanProjection(projected, [...required, ...supplementalBoundedEvidenceIds]);
  return Object.freeze({
    schemaVersion: ABLATION_LEAN_DIRECT_EVIDENCE_VIEW_VERSION,
    sourceBundleHash: bundle.bundleHash,
    bundle: focused.bundle,
    salienceEvidenceIds: Object.freeze(focused.selectedEvidenceIds),
    requiredEvidenceIds: Object.freeze(required),
    supplementalBoundedEvidenceIds: Object.freeze(supplementalBoundedEvidenceIds),
    selectedSelectorIds: Object.freeze([]),
    viewHash: stableHash({
      schemaVersion: ABLATION_LEAN_DIRECT_EVIDENCE_VIEW_VERSION,
      sourceBundleHash: bundle.bundleHash,
      projectedBundleHash: focused.bundle.bundleHash,
      salienceEvidenceIds: focused.selectedEvidenceIds,
      requiredEvidenceIds: required,
      supplementalBoundedEvidenceIds,
    }),
  });
}

/** Exact episode membership; no salience reranking or fixture selection at synthesis. */
export function projectLeanEpisodeEvidence(source: Readonly<AblationEvidenceClosureBundle>, ids: readonly string[], coverage = source.coverage): LeanDirectEvidenceView {
  validateAblationEvidenceClosureBundle(source);
  const selected = new Set(ids);
  const evidence = source.evidence.filter((item) => selected.has(item.id));
  if (evidence.length !== selected.size) throw new Error("Lean episode references unknown evidence");
  const observations = source.observations.filter((item) => item.factEvidenceIds.every((id) => selected.has(id)));
  const bundle = createAblationEvidenceClosureBundle({ context: source.context, question: source.question, observations, evidence,
    referenceAllowlists: referenceAllowlistsForSelection(source, observations, evidence),
    coverage: { ...coverage, complete: false, covered: [...selected],
      limitations: [...coverage.limitations, `${source.evidence.length - evidence.length} retained records were not retrieved; absence from this packet is not absence on the board.`] },
  });
  return Object.freeze({ schemaVersion: ABLATION_LEAN_DIRECT_EVIDENCE_VIEW_VERSION, sourceBundleHash: source.bundleHash,
    bundle, salienceEvidenceIds: [...selected], requiredEvidenceIds: [], supplementalBoundedEvidenceIds: [], selectedSelectorIds: [],
    viewHash: stableHash({ source: source.bundleHash, selected: [...selected].sort(), bundle: bundle.bundleHash }) });
}

function modelPrompt(view: LeanDirectEvidenceView, compact = false) {
  return {
    schemaVersion: ABLATION_LEAN_DIRECT_RUNTIME_VERSION,
    proposalVersion: ABLATION_LEAN_DIRECT_PROPOSAL_VERSION,
    sourceBundleHash: view.sourceBundleHash,
    modelFacingEvidenceViewHash: view.viewHash,
    frozenEvidence: compact ? compactLeanEvidencePacket(view.bundle) : view.bundle,
  };
}

/** Deterministic admission checks evidence identity and source ceilings; it never interprets generated prose. */
export function materializeLeanDirectProposal(view: LeanDirectEvidenceView, proposal: unknown): LeanDirectArtifact {
  validateAblationEvidenceClosureBundle(view.bundle);
  if (!isRecord(proposal)) throw new LeanAdmissionError("proposal", "invalid-shape");
  exactKeys(proposal, ["schemaVersion", "claims", "limitations", "coverage"], "proposal");
  if (proposal.schemaVersion !== ABLATION_LEAN_DIRECT_PROPOSAL_VERSION) throw new LeanAdmissionError("proposal.schemaVersion", "unsupported-version");
  if (!Array.isArray(proposal.claims) || !proposal.claims.length || proposal.claims.length > 4) throw new LeanAdmissionError("proposal.claims", "invalid-claims");
  const evidence = new Map(view.bundle.evidence.map((item) => [item.id, item]));
  const allowedEvidenceIds = new Set(view.bundle.referenceAllowlists.evidenceIds);
  const claims = proposal.claims.map((raw, index) => {
    const path = `proposal.claims[${index}]`;
    if (!isRecord(raw)) throw new LeanAdmissionError(path, "invalid-claim");
    exactKeys(raw, ["text", "kind", "evidenceIds"], path);
    const text = nonEmpty(raw.text, `${path}.text`, 700);
    if (typeof raw.kind !== "string" || !CLAIM_KINDS.has(raw.kind)) throw new LeanAdmissionError(`${path}.kind`, "invalid-kind");
    if (!Array.isArray(raw.evidenceIds) || !raw.evidenceIds.length || raw.evidenceIds.length > 8) throw new LeanAdmissionError(`${path}.evidenceIds`, "invalid-evidence");
    const evidenceIds = raw.evidenceIds.map((value, evidenceIndex) => nonEmpty(value, `${path}.evidenceIds[${evidenceIndex}]`, 200));
    if (new Set(evidenceIds).size !== evidenceIds.length) throw new LeanAdmissionError(`${path}.evidenceIds`, "duplicate-evidence");
    const cited = evidenceIds.map((id) => allowedEvidenceIds.has(id) ? evidence.get(id) : undefined).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (cited.length !== evidenceIds.length) throw new LeanAdmissionError(`${path}.evidenceIds`, "unknown-evidence");
    if (!cited.some((item) => licensesSemanticChessGrounding(effectiveLicensesForRecord(item)))) {
      throw new LeanAdmissionError(`${path}.evidenceIds`, "evidence-license-insufficient");
    }
    return {
      text,
      kind: raw.kind as LeanDirectClaim["kind"],
      evidenceIds,
    };
  });
  if (!Array.isArray(proposal.limitations) || proposal.limitations.length > 4) throw new LeanAdmissionError("proposal.limitations", "invalid-limitations");
  const limitations = proposal.limitations.map((value, index) => nonEmpty(value, `proposal.limitations[${index}]`, 400));
  if (!isRecord(proposal.coverage)) throw new LeanAdmissionError("proposal.coverage", "invalid-coverage");
  exactKeys(proposal.coverage, ["status", "unresolved"], "proposal.coverage");
  if (proposal.coverage.status !== "complete" && proposal.coverage.status !== "partial" && proposal.coverage.status !== "unavailable") throw new LeanAdmissionError("proposal.coverage.status", "invalid-coverage");
  if (!Array.isArray(proposal.coverage.unresolved) || proposal.coverage.unresolved.length > 4) throw new LeanAdmissionError("proposal.coverage.unresolved", "invalid-coverage");
  const unresolved = proposal.coverage.unresolved.map((value, index) => nonEmpty(value, `proposal.coverage.unresolved[${index}]`, 400));
  return Object.freeze({
    schemaVersion: ABLATION_LEAN_DIRECT_PROPOSAL_VERSION,
    sourceBundleHash: view.sourceBundleHash,
    modelFacingEvidenceViewHash: view.viewHash,
    claims,
    limitations,
    coverage: { status: proposal.coverage.status as LeanDirectArtifact["coverage"]["status"], unresolved },
    admission: "diagnostic-proposed",
    productSupport: "not-a-validated-graph-checkpoint-or-product-result",
  });
}

export async function runLeanDirect(
  options: LeanDirectRuntimeOptions,
  bundle: Readonly<AblationEvidenceClosureBundle>,
  signal?: AbortSignal,
): Promise<LeanDirectResult> {
  if (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) throw new Error("Lean direct requires a positive output-token budget");
  validateAblationEvidenceClosureBundle(bundle);
  const modelView = options.modelEvidenceIds ? projectLeanEpisodeEvidence(bundle, options.modelEvidenceIds, options.episodeCoverage) : projectLeanDirectEvidence(bundle, options.requiredEvidenceIds, options.evidenceSelectors);
  const prompt = JSON.stringify(modelPrompt(modelView, Boolean(options.modelEvidenceIds)));
  const system = effectiveSystem(options.benchmarkNonce) + (options.modelEvidenceIds
    ? "\nScope and licensing: before/after means immediately around the target move, not after later moves in a witness. Do not carry a position relation into a later line unless it persists there. A legality-only witness or attention affordance alone cannot ground a strategic consequence. Legal recaptures are unranked possibilities, not evidence that recapturing is profitable or preferred. Nominal arithmetic is not exchange safety. Cite the evidence that establishes the claimed relation, not merely a nearby legal sequence."
    : "");
  const diagnostic: LeanDirectCallDiagnostic = {
    stage: "lean-direct", runtime: ABLATION_LEAN_DIRECT_RUNTIME_VERSION, model: modelName(options), route: options.providerRoute || "unspecified",
    effort: String(options.reasoning || "provider-default"), temperature: options.temperature ?? null, bundleHash: bundle.bundleHash,
    inputBytes: bytes({ system, prompt }), schemaBytes: bytes(LEAN_DIRECT_PROPOSAL_JSON_SCHEMA), outputBytes: 0, finishReason: null,
    latencyMs: null, inputTokens: null, outputTokens: null, cost: null, cacheTokens: null, outcome: "failed", failureCode: null,
  };
  emitObservableTrace(options.observableTraceSink, {
    stage: "ablation-lean-direct", direction: "input", model: diagnostic.model, providerRoute: diagnostic.route, reasoningEffort: diagnostic.effort,
    payload: { system, prompt, responseSchema: LEAN_DIRECT_PROPOSAL_JSON_SCHEMA, tools: [], maxOutputTokens: options.maxOutputTokens, maxWallTimeMs: options.maxWallTimeMs, temperature: options.temperature ?? null, benchmarkNonce: options.benchmarkNonce ?? null },
  });
  const abort = abortContext(signal, options.maxWallTimeMs);
  const started = now();
  try {
    const generated = await generateText({
      model: options.model,
      system,
      prompt,
      output: Output.object({
        schema: jsonSchema<Record<string, unknown>>(LEAN_DIRECT_PROPOSAL_JSON_SCHEMA as unknown as Parameters<typeof jsonSchema<Record<string, unknown>>>[0]),
        name: "knights_eye_lean_direct_answer",
        description: "A one-call evidence-cited chess-answer diagnostic.",
      }),
      abortSignal: abort.signal,
      maxOutputTokens: options.maxOutputTokens,
      maxRetries: 0,
      reasoning: options.reasoning || "provider-default",
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      onStepFinish(step) {
        const metadata = options.consumeProviderMetadata?.().at(-1);
        diagnostic.model = metadata?.model || step.model.modelId || diagnostic.model;
        diagnostic.route = metadata?.route || diagnostic.route;
        diagnostic.effort = metadata?.effort || diagnostic.effort;
        diagnostic.finishReason = String(step.finishReason || "");
        diagnostic.latencyMs = step.performance.responseTimeMs ?? null;
        diagnostic.inputTokens = numericUsage(step.usage.inputTokens);
        diagnostic.outputTokens = numericUsage(step.usage.outputTokens);
        diagnostic.cost = typeof metadata?.cost === "number" && Number.isFinite(metadata.cost) ? metadata.cost : null;
        diagnostic.cacheTokens = typeof metadata?.cacheTokens === "number" && Number.isFinite(metadata.cacheTokens) ? metadata.cacheTokens : null;
      },
    });
    if (abort.signal.aborted) throw abort.signal.reason;
    diagnostic.latencyMs ??= Math.round(now() - started);
    diagnostic.outputBytes = bytes(generated.output);
    let artifact: LeanDirectArtifact;
    try { artifact = materializeLeanDirectProposal(modelView, generated.output); }
    catch (error) {
      const issue = error instanceof LeanAdmissionError ? [{ path: error.path, code: error.code }] : [{ path: "proposal", code: "invalid" }];
      const failure: LeanDirectFailure = { kind: "lean-contract-rejected", code: "lean-direct-rejected", issues: issue };
      diagnostic.outcome = "failed"; diagnostic.failureCode = failure.code;
      emitObservableTrace(options.observableTraceSink, { stage: "ablation-lean-direct", direction: "output", model: diagnostic.model, providerRoute: diagnostic.route, reasoningEffort: diagnostic.effort, payload: { structuredOutput: generated.output, materialization: { status: "rejected", issues: issue } } });
      return { ok: false, diagnostics: [diagnostic], failure, modelView };
    }
    diagnostic.outcome = "succeeded";
    emitObservableTrace(options.observableTraceSink, { stage: "ablation-lean-direct", direction: "output", model: diagnostic.model, providerRoute: diagnostic.route, reasoningEffort: diagnostic.effort, payload: { text: generated.text, structuredOutput: generated.output, finishReason: generated.finishReason, usage: generated.usage, materialization: { status: "mechanically-admitted", checked: ["shape", "evidence-id-existence", "record-licensing"], unchecked: ["prose-entailment", "embedded-chess-references", "factual-and-conceptual-correctness"] } } });
    return { ok: true, artifact, diagnostics: [diagnostic], modelView };
  } catch (error) {
    const failure = classify(error, abort.timedOut(), Boolean(signal?.aborted && !abort.timedOut()));
    diagnostic.latencyMs ??= Math.round(now() - started);
    diagnostic.outcome = failure.kind === "aborted" || failure.kind === "wall-time" ? "aborted" : "failed";
    diagnostic.failureCode = failure.code;
    emitObservableTrace(options.observableTraceSink, { stage: "ablation-lean-direct", direction: "error", model: diagnostic.model, providerRoute: diagnostic.route, reasoningEffort: diagnostic.effort, payload: { failure: { kind: failure.kind, code: failure.code } } });
    return { ok: false, diagnostics: [diagnostic], failure, modelView };
  } finally {
    abort.dispose();
  }
}
