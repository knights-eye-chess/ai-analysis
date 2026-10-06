import type { DirectSynthesisIssue } from "./ablation-direct-synthesis";
import { stableJson } from "./stable";

/** A narrow transport-only correction is never a second semantic authoring turn. */
export class AblationTransportCorrectionError extends Error {
  readonly code = "transport-correction-outside-validator-paths" as const;
  constructor(message: string) {
    super(message);
    this.name = "AblationTransportCorrectionError";
  }
}

type TransportPath = Array<string | number>;

function sameRecord(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function transportCorrectionPath(issue: DirectSynthesisIssue): TransportPath | null {
  // Only exact, leaf-level reference defects are reparable. Broad schema and
  // semantic validation errors fail closed rather than becoming a rewrite.
  if (!new Set(["unknown_evidence", "unknown_local_entity", "unknown_local_relation", "invalid_piece_form", "raw_chess_reference"]).has(issue.code)) return null;
  const tokens = [...issue.path.matchAll(/(?:^|\.)([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)]
    .map((match) => match[1] || Number(match[2]));
  if (tokens[0] !== "proposal" || tokens.length < 3 || tokens.some((token) => typeof token === "string" && token === "__proto__")) return null;
  const leaf = tokens.at(-1);
  // Raw concrete chess language is reparable only in an optional
  // qualification text leaf.  The correction may make that one text segment
  // less specific, but may not rewrite the claim, its evidence, or its main
  // narrative.  A raw reference elsewhere remains a hard validation error.
  if (issue.code === "raw_chess_reference") {
    const [proposal, claims, claimIndex, qualifications, qualificationIndex, segmentIndex, text] = tokens;
    return proposal === "proposal"
      && claims === "claims"
      && typeof claimIndex === "number"
      && qualifications === "qualifications"
      && typeof qualificationIndex === "number"
      && typeof segmentIndex === "number"
      && text === "text"
      && tokens.length === 7
      ? tokens
      : null;
  }
  if (!(["evidenceIds", "entityLocalId", "relationLocalId", "form"] as const).includes(leaf as never)) return null;
  if (issue.code === "unknown_evidence" && leaf !== "evidenceIds") return null;
  if ((issue.code === "unknown_local_entity" && leaf !== "entityLocalId")
    || (issue.code === "unknown_local_relation" && leaf !== "relationLocalId")
    || (issue.code === "invalid_piece_form" && leaf !== "form")) return null;
  return tokens;
}

function deleteExactPath(value: unknown, path: TransportPath): void {
  let cursor = value as Record<string, unknown> | unknown[];
  for (const token of path.slice(1, -1)) {
    if (typeof token === "number") {
      if (!Array.isArray(cursor) || !Object.prototype.hasOwnProperty.call(cursor, token)) throw new AblationTransportCorrectionError("Transport correction issue path is not an exact existing array path");
      cursor = cursor[token] as Record<string, unknown> | unknown[];
    } else {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || !Object.prototype.hasOwnProperty.call(cursor, token)) throw new AblationTransportCorrectionError("Transport correction issue path is not an exact existing object path");
      cursor = cursor[token] as Record<string, unknown> | unknown[];
    }
  }
  const leaf = path.at(-1)!;
  if (typeof leaf !== "string" || !cursor || typeof cursor !== "object" || Array.isArray(cursor) || !Object.prototype.hasOwnProperty.call(cursor, leaf)) {
    throw new AblationTransportCorrectionError("Transport correction issue path is too broad or absent");
  }
  delete (cursor as Record<string, unknown>)[leaf];
}

export function isTransportCorrectableDirectSynthesisIssues(issues: readonly DirectSynthesisIssue[]): boolean {
  return issues.length > 0 && issues.every((issue) => transportCorrectionPath(issue) !== null);
}

/**
 * The model may change only exact validator-named reference leaves. Item
 * identity/cardinality and every other semantic/evidence association remain
 * structure-equivalent. This guard is shared by A1 and B/B′ for fairness.
 */
export function assertTransportOnlyDirectCorrection(
  originalProposal: unknown,
  correctedProposal: unknown,
  issues: readonly DirectSynthesisIssue[],
): void {
  const paths = issues.map(transportCorrectionPath);
  if (!paths.length || paths.some((path) => path === null)) throw new AblationTransportCorrectionError("Transport correction does not have a narrow validator-authorized path");
  if (!originalProposal || typeof originalProposal !== "object" || Array.isArray(originalProposal) || !correctedProposal || typeof correctedProposal !== "object" || Array.isArray(correctedProposal)) {
    throw new AblationTransportCorrectionError("Transport correction requires complete object proposals");
  }
  for (const collection of ["hypotheses", "relations", "claims", "demonstrations"] as const) {
    const before = (originalProposal as Record<string, unknown>)[collection];
    const after = (correctedProposal as Record<string, unknown>)[collection];
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) throw new AblationTransportCorrectionError("Transport correction changed proposal item cardinality");
    for (let index = 0; index < before.length; index += 1) {
      const beforeId = before[index] && typeof before[index] === "object" ? (before[index] as Record<string, unknown>).localId : undefined;
      const afterId = after[index] && typeof after[index] === "object" ? (after[index] as Record<string, unknown>).localId : undefined;
      if (beforeId !== afterId) throw new AblationTransportCorrectionError("Transport correction changed a proposal item identity");
    }
  }
  const before = structuredClone(originalProposal);
  const after = structuredClone(correctedProposal);
  for (const path of paths as TransportPath[]) {
    deleteExactPath(before, path);
    deleteExactPath(after, path);
  }
  if (!sameRecord(before, after)) throw new AblationTransportCorrectionError("Transport correction changed semantic content outside validator-authorized paths");
}
