import {
  createAblationEvidenceClosureBundle,
  validateAblationEvidenceClosureBundle,
  type AblationEvidenceClosureBundle,
  type AblationEvidenceClosureCoverage,
  type AblationEvidenceReferenceAllowlists,
} from "./ablation-evidence-bundle";
import { REFERENCE_DOMAINS } from "./concept-registry";
import { stableHash } from "./stable";

/**
 * The closure is deliberately larger than the model view: it retains all
 * pre-salience records for evaluator audit.  This projection is the one and
 * only boundary at which that closure becomes provider-visible.
 */
export const ABLATION_MODEL_FACING_EVIDENCE_VIEW_VERSION = "architecture-ablation-model-facing-evidence/1" as const;

/** Lean-only transport: evidence is unchanged; observations are an index, not a second copy of its data. */
export function compactLeanEvidencePacket(bundle: Readonly<AblationEvidenceClosureBundle>) {
  return {
    context: bundle.context, contextHash: bundle.contextHash, question: bundle.question,
    evidence: bundle.evidence,
    observations: bundle.observations.map((item) => ({
      id: item.id, observationType: item.observationType, exactness: item.exactness,
      factEvidenceIds: item.factEvidenceIds,
    })),
    coverage: bundle.coverage,
  };
}

export type AblationModelFacingEvidenceView = Readonly<{
  schemaVersion: typeof ABLATION_MODEL_FACING_EVIDENCE_VIEW_VERSION;
  /** Immutable audit identity of the complete, pre-salience closure. */
  sourceBundleHash: string;
  /** A separately validated, non-mutating closure containing only visible material. */
  bundle: Readonly<AblationEvidenceClosureBundle>;
  visibleObservationIds: readonly string[];
  visibleEvidenceIds: readonly string[];
  viewHash: string;
}>;

const OMIT = Symbol("ablation-model-facing-omit");

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function isRankedObservation(value: unknown): value is { presentedToModel: boolean; salience: number; salienceReasons: unknown[] } {
  return record(value)
    && typeof value.presentedToModel === "boolean"
    && typeof value.salience === "number"
    && Number.isFinite(value.salience)
    && Array.isArray(value.salienceReasons);
}

function redactHiddenIds(value: unknown, hiddenIds: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    if (hiddenIds.has(value)) return OMIT;
    let redacted = value;
    for (const id of hiddenIds) redacted = redacted.replaceAll(id, "[withheld]");
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactHiddenIds(item, hiddenIds)).filter((item) => item !== OMIT);
  }
  if (!record(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const redacted = redactHiddenIds(child, hiddenIds);
    if (redacted !== OMIT) result[key] = redacted;
  }
  return result;
}

function valueContains(value: unknown, sought: string): boolean {
  if (value === sought) return true;
  if (Array.isArray(value)) return value.some((item) => valueContains(item, sought));
  return record(value) && Object.values(value).some((item) => valueContains(item, sought));
}

function visibleCoverage(
  coverage: AblationEvidenceClosureCoverage,
  visibleObservationIds: ReadonlySet<string>,
  visibleEvidenceIds: ReadonlySet<string>,
  hiddenIds: ReadonlySet<string>,
): AblationEvidenceClosureCoverage {
  const belongsToHidden = (value: string) => hiddenIds.has(value)
    || [...hiddenIds].some((id) => value === `observation:${id}` || value === `evidence:${id}` || value.includes(id));
  const visible = (value: string) => visibleObservationIds.has(value) || visibleEvidenceIds.has(value);
  const recordsHidden = hiddenIds.size > 0;
  return {
    // A model-facing subset can never retain the parent closure's exhaustive
    // claim once audit-only records were intentionally withheld.
    complete: recordsHidden ? false : coverage.complete,
    covered: coverage.covered.filter((item) => !belongsToHidden(item)),
    omitted: coverage.omitted.filter((item) => item.domain === "tool" || visible(item.id)),
    unavailable: coverage.unavailable.filter((item) => !belongsToHidden(item.id)),
    limitations: [
      ...coverage.limitations.filter((item) => !belongsToHidden(item)),
      ...(recordsHidden ? ["This model-facing projection intentionally excludes audit-only closure records."] : []),
    ],
  };
}

function visibleAllowlists(
  source: Readonly<AblationEvidenceClosureBundle>,
  observations: readonly typeof source.observations[number][],
  evidence: readonly typeof source.evidence[number][],
  hiddenIds: ReadonlySet<string>,
): AblationEvidenceReferenceAllowlists {
  const visibleEvidenceIds = new Set(evidence.map((item) => item.id));
  const visibleObservationIds = new Set(observations.map((item) => item.id));
  const targetWitnesses = source.referenceAllowlists.moveWitnesses
    .filter((witness) => visibleEvidenceIds.has(witness.evidenceId) && witness.uci === source.context.moveUci);
  const targetSquares = new Set([source.context.moveUci.slice(0, 2), source.context.moveUci.slice(2, 4)]);
  const targetPieces = new Set(targetWitnesses.map((witness) => witness.pieceId));
  const semanticReferences = source.referenceAllowlists.semanticReferences.filter((reference) => {
    if (reference.domain === REFERENCE_DOMAINS.MOVE && reference.id === source.context.moveUci) return true;
    if (reference.domain === REFERENCE_DOMAINS.SQUARE && targetSquares.has(reference.id)) return true;
    if (reference.domain === REFERENCE_DOMAINS.PIECE && targetPieces.has(reference.id)) return true;
    if (observations.some((observation) => observation.participants.some((participant) => participant.ref.domain === reference.domain && participant.ref.id === reference.id))) return true;
    return evidence.some((item) => valueContains(item.data, reference.id) || valueContains(item.replay, reference.id));
  }).map((item) => clone(item));
  return {
    evidenceIds: sorted(visibleEvidenceIds),
    observationIds: sorted(visibleObservationIds),
    toolNames: [...source.referenceAllowlists.toolNames],
    semanticReferences,
    moveWitnesses: source.referenceAllowlists.moveWitnesses
      .filter((witness) => visibleEvidenceIds.has(witness.evidenceId) && !hiddenIds.has(witness.evidenceId))
      .map((witness) => clone(witness)),
  };
}

/**
 * Project a full ablation closure to material that the relevant arm may see.
 * Original observations must retain exact ranked presentation metadata. New
 * acquisition/enrichment records are intentionally visible by lineage, while
 * an unlinked admitted probe remains available as concrete evidence.
 */
export function projectAblationEvidenceForModel(
  source: Readonly<AblationEvidenceClosureBundle>,
): AblationModelFacingEvidenceView {
  validateAblationEvidenceClosureBundle(source);
  const acquiredObservationIds = new Set(source.lineage.kind === "enriched" ? source.lineage.acquiredObservationIds : []);
  const acquiredEvidenceIds = new Set(source.lineage.kind === "enriched" ? source.lineage.acquiredEvidenceIds : []);
  const visibleObservations = source.observations.filter((observation) => {
    if (acquiredObservationIds.has(observation.id)) return true;
    if (!isRankedObservation(observation)) {
      throw new Error(`Ablation model-facing projection requires ranked presentation metadata for original observation ${observation.id}`);
    }
    return observation.presentedToModel;
  });
  const visibleObservationIds = new Set(visibleObservations.map((item) => item.id));
  const visibleEvidenceIds = new Set<string>();
  for (const record of source.evidence) {
    if (record.kind === "context" || record.kind === "probe" || acquiredEvidenceIds.has(record.id)) visibleEvidenceIds.add(record.id);
  }
  for (const observation of visibleObservations) {
    for (const evidenceId of observation.factEvidenceIds) visibleEvidenceIds.add(evidenceId);
  }
  const visibleEvidence = source.evidence.filter((record) => visibleEvidenceIds.has(record.id));
  const hiddenIds = new Set([
    ...source.observations.filter((item) => !visibleObservationIds.has(item.id)).map((item) => item.id),
    ...source.evidence.filter((item) => !visibleEvidenceIds.has(item.id)).map((item) => item.id),
  ]);
  const observations = visibleObservations.map((observation) => {
    const redacted = redactHiddenIds(clone(observation), hiddenIds) as typeof observation & Partial<{ salience: number; salienceReasons: string[]; presentedToModel: boolean }>;
    // Enrichment observations are intentional post-baseline acquisition, not
    // candidates for a second salience decision. Make that membership explicit
    // in the model projection without changing the audited source closure.
    if (!isRankedObservation(redacted)) {
      return { ...redacted, salience: 1, salienceReasons: ["ablation-enriched-acquisition"], presentedToModel: true };
    }
    return redacted;
  });
  const evidence = visibleEvidence.map((item) => redactHiddenIds(clone(item), hiddenIds) as typeof item);
  const coverage = visibleCoverage(source.coverage, visibleObservationIds, visibleEvidenceIds, hiddenIds);
  const referenceAllowlists = visibleAllowlists(source, observations, evidence, hiddenIds);
  const bundle = createAblationEvidenceClosureBundle({
    context: clone(source.context),
    question: source.question,
    observations,
    evidence,
    referenceAllowlists,
    coverage,
  });
  const visibleObservationIdList = sorted(visibleObservationIds);
  const visibleEvidenceIdList = sorted(visibleEvidenceIds);
  return Object.freeze({
    schemaVersion: ABLATION_MODEL_FACING_EVIDENCE_VIEW_VERSION,
    sourceBundleHash: source.bundleHash,
    bundle,
    visibleObservationIds: Object.freeze(visibleObservationIdList),
    visibleEvidenceIds: Object.freeze(visibleEvidenceIdList),
    viewHash: stableHash({
      schemaVersion: ABLATION_MODEL_FACING_EVIDENCE_VIEW_VERSION,
      sourceBundleHash: source.bundleHash,
      bundleHash: bundle.bundleHash,
      visibleObservationIds: visibleObservationIdList,
      visibleEvidenceIds: visibleEvidenceIdList,
    }),
  });
}
