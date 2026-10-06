import type { ReasoningEvidenceRecord } from "./poc-contracts";
import { projectCompactEngineEvidence } from "./simple-compact-evidence";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const FACT_DELIVERY_INSTRUCTIONS = `{$priorFact:[toolCallId,evidenceId,variation,ply]} reuses an identical tactical fact from an earlier tool result in this CURRENT_QUESTION only. Locate the native result for toolCallId, then that evidence record's continuationMoveFacts[variation].moves[ply-1]; variation=-1 instead means rootMoveFacts[ply-1]. Expand its same-message encoding/metadata. Position, ordered prefix and the complete fact were checked for equality; this does NOT reuse scores or search provenance. Every current comparison retains its own ranking, settings and coverage. No references point to previous chat exchanges.`;

/** Request-local reuse, valid only while the loop's earlier tool messages remain. */
export class SimpleFactDelivery {
  private delivered = new Map<string, { pointer: unknown; size: number }>();
  private pending = new Map<string, { pointer: unknown; size: number }>();
  /** Called only after complete native response messages have entered context. */
  commit() { for (const [key, value] of this.pending) if (!this.delivered.has(key)) this.delivered.set(key, value); this.pending.clear(); }
  constructor(private readonly contextHash: string) {}

  project(callId: string, result: { contextHash: string; evidence: readonly ReasoningEvidenceRecord[]; limitations: readonly string[] }) {
    if (result.contextHash !== this.contextHash) throw Error("cross-context-fact-delivery");
    if (JSON.stringify(result).includes('"$priorFact"')) throw Error("reserved-fact-reference");
    const evidence = result.evidence.map(record => {
      if (record.contextHash !== this.contextHash) throw Error("cross-context-fact-delivery");
      const data = record.data;
      const search = object(data.searchScope) ? data.searchScope : null;
      const fen = search?.fen ?? record.replay?.fen;
      if (typeof fen !== "string" || !["before", "after"].includes(String(data.phase))) return record;
      const fact = (value: unknown, prefix: string[], variation: number, ply: number) => {
        if (!object(value) || typeof value.uci !== "string") return value;
        const key = JSON.stringify({ contextHash: this.contextHash, fen, phase: data.phase, prefix, fact: value });
        const previous = this.delivered.get(key);
        const encoded = projectCompactEngineEvidence(value);
        const size = JSON.stringify(object(encoded) && encoded.encoding ? encoded.content : encoded).length;
        // Retain the first literal occurrence, so no pointer chain is introduced.
        if (previous && previous.size < size / 2) return previous.pointer;
        if (!previous) {
          const pointer = { $priorFact: [callId, record.id, variation, ply] };
          if (!this.pending.has(key)) this.pending.set(key, { pointer, size: JSON.stringify(pointer).length });
        }
        return value;
      };
      const continuationMoveFacts = Array.isArray(data.continuationMoveFacts) ? data.continuationMoveFacts.map((line, variation) => {
        if (!object(line) || !Array.isArray(line.moves)) return line;
        const prefix: string[] = [];
        return { ...line, moves: line.moves.map((move, index) => {
          const projected = fact(move, [...prefix], variation, index + 1);
          if (object(move) && typeof move.uci === "string") prefix.push(move.uci);
          return projected;
        }) };
      }) : undefined;
      const rootMoveFacts = Array.isArray(data.rootMoveFacts) ? data.rootMoveFacts.map((move, i) => fact(move, [], -1, i + 1)) : undefined;
      return { ...record, data: { ...data, ...(continuationMoveFacts ? { continuationMoveFacts } : {}), ...(rootMoveFacts ? { rootMoveFacts } : {}) } };
    });
    return { ...result, evidence };
  }
}
