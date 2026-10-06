import { projectEnginePresentation } from './simple-engine-presentation';
import { projectMaterial, DEFAULT_MATERIAL_FORMAT, type MaterialFormat } from './material-format';
import { materialAlongLine } from './material-accounting';
import { Chess } from 'chess.js';
import { validateReasoningPositionContext, type ReasoningPositionContext } from './poc-contracts';
import { retainedEvidenceCatalogue } from "./ablation-adaptive-evidence-loop";
import { compactLeanEvidencePacket } from "./ablation-model-facing-evidence";
import type { AblationEvidenceClosureBundle } from "./ablation-evidence-bundle";
import { projectCompactEngineEvidence } from "./simple-compact-evidence";

export const SIMPLE_EVIDENCE_VIEW_VERSION = "simple-evidence-view/5";
export function compactSimpleEngineResult(value: unknown, format: MaterialFormat = DEFAULT_MATERIAL_FORMAT, fullGeometry = false): unknown {
  value = projectMaterial(projectEnginePresentation(value, fullGeometry), format);
  const baseline = compactSimpleToolResult(value);
  const candidate = compactSimpleToolResult(projectCompactEngineEvidence(value));
  return JSON.stringify(candidate).length < JSON.stringify(baseline).length ? candidate : baseline;
}
/** Self-contained, lossless interning of byte-identical repeated evidence subtrees. */
export function compactSimpleToolResult(value: unknown): unknown {
  const counts = new Map<string, number>();
  let reservedKeyPresent = false;
  const visit = (item: unknown, replace: boolean): unknown => {
    if (!item || typeof item !== "object") return item;
    const encoded = JSON.stringify(item);
    if (Object.hasOwn(item, "$metadata")) reservedKeyPresent = true;
    if (encoded.length >= 80) {
      if (!replace) counts.set(encoded, (counts.get(encoded) || 0) + 1);
      else if ((counts.get(encoded) || 0) > 1) {
        let id = ids.get(encoded);
        if (!id) { id = `m${ids.size}`; ids.set(encoded, id); metadata[id] = item; }
        return { $metadata: id };
      }
    }
    return Array.isArray(item) ? item.map(entry => visit(entry, replace))
      : Object.fromEntries(Object.entries(item).map(([childKey, entry]) => [childKey, visit(entry, replace)]));
  };
  const ids = new Map<string, string>(), metadata: Record<string, unknown> = {};
  visit(value, false);
  // Never reinterpret a caller-owned pointer-shaped value.
  if (reservedKeyPresent) return value;
  const content = visit(value, true);
  const compact = { metadata, content };
  return ids.size && JSON.stringify(compact).length < JSON.stringify(value).length ? compact : value;
}
/** Readable past only; the authoritative exact FEN/UCI context remains unchanged. */
export function simplePastHistory(context: ReasoningPositionContext) {
  validateReasoningPositionContext(context);
  const chess = new Chess(context.historyStartFen);
  const moves = [...context.historyUci, ...(context.kind === "position" ? [] : [context.moveUci])];
  const san = moves.map(uci => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined }).san);
  return { scope: "past-through-question-only", plies: san.length, san: san.join(" ") };
}
/** Remove only catalogue entries whose complete records are already in this message. */
export function compactSimpleInitialPacket(packet: ReturnType<typeof compactLeanEvidencePacket> & Record<string, unknown>, format: MaterialFormat = DEFAULT_MATERIAL_FORMAT) {
  // Remove retired experiment descriptions, not missing coverage or chess limits.
  const retired = new Set([
    "This Lean diagnostic uses a deterministic causal-focus projection of presented exact evidence plus required bounded evidence.",
    "This immutable closure contains only supplied, already-admitted presemantic evidence; no evidence discovery occurred during capture.",
  ]);
  const coverage = { ...packet.coverage, limitations: packet.coverage.limitations.filter(item => !retired.has(item)) };
  return compactSimpleEngineResult({ ...packet, material: materialAlongLine(packet.context.fenBefore, packet.context.kind === "position" ? [] : [packet.context.moveUci]), historyThroughQuestion: simplePastHistory(packet.context), coverage }, format) as Record<string, unknown>;
}
export function simpleInitialEvidenceView(initial: Readonly<AblationEvidenceClosureBundle>, full: Readonly<AblationEvidenceClosureBundle>, budgets: unknown, boardContextAvailable = false, format: MaterialFormat = DEFAULT_MATERIAL_FORMAT) {
  const visible = new Set(initial.evidence.map(record => record.id));
  const original = compactLeanEvidencePacket(initial);
  const packet = {...original, coverage:{...original.coverage}};
  if (boardContextAvailable) packet.coverage.limitations = packet.coverage.limitations.filter(s => !s.includes("No valid existing analysis context") && !s.includes("deliberately hidden by the development ablation"));
  return compactSimpleInitialPacket({ ...packet, retainedEvidenceCatalogue: retainedEvidenceCatalogue(full).filter(record => !visible.has(record.id)), budgets }, format);
}
