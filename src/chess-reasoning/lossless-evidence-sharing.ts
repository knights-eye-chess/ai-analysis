import type { ModelMessage } from 'ai';

export const EVIDENCE_SHARING_VERSION = 'evidence-sharing/1';
export const EVIDENCE_SHARING_INSTRUCTIONS = `Evidence encoding evidence-sharing/1 is lossless and self-contained. Read content with each {"$shared":"sN"} replaced by values.sN in the SAME envelope; dictionary values can themselves contain these references. Then interpret existing engine/metadata encodings normally. All values are already supplied: no tool is needed to expand them. References share identical values only, never authority, position scope, scores or search provenance. Dictionary IDs are not evidence IDs or citations.`;
// Keep the server-only prose tree-shakeable from the browser serializer. A test
// binds this sizing allowance to the server instruction's current length.
export const EVIDENCE_SHARING_GUIDANCE_CHARS = 490;
type Obj = Record<string, unknown>;
const object = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Exact JSON-value DAG. Unlike the older metadata pass, definitions are also
 * interned recursively, so repeated children of different shared parents survive
 * only once. Literal strings are counted after object sharing, since repeated
 * object subtrees otherwise exaggerate their actual delivered frequency. No
 * cross-message state or chess inference is involved. */
export function shareEvidence(value: unknown): unknown {
  // A caller-owned envelope is already encoded; never nest/reinterpret it.
  if (object(value) && value.encoding === EVIDENCE_SHARING_VERSION) return value;
  const counts = new Map<string, number>();
  const keys = new WeakMap<object, string>();
  let collision = false;
  const count = (x: unknown) => {
    if (!x || typeof x !== 'object') return;
    if (Object.hasOwn(x, '$shared')) collision = true;
    const key = JSON.stringify(x);
    keys.set(x, key);
    if (key.length >= 96) counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const child of Object.values(x)) count(child);
  };
  count(value);
  if (collision) return value;
  const values: Obj = {}, ids = new Map<string, string>();
  const children = (x: unknown): unknown => Array.isArray(x) ? x.map(visit)
    : object(x) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, visit(v)])) : x;
  const visit = (x: unknown): unknown => {
    if (!x || typeof x !== 'object') return x;
    const key = keys.get(x)!;
    if ((counts.get(key) ?? 0) < 2) return children(x);
    let id = ids.get(key);
    if (!id) {
      id = `s${ids.size}`; ids.set(key, id);
      values[id] = children(x);
    }
    return { $shared: id };
  };
  let content = children(value);
  const stringCounts = new Map<string, number>();
  const objectDefinitions = Object.entries(values);
  const countStrings = (x: unknown): void => {
    if (typeof x === 'string') { stringCounts.set(x, (stringCounts.get(x) ?? 0) + 1); return; }
    if (Array.isArray(x)) { x.forEach(countStrings); return; }
    if (object(x) && !Object.hasOwn(x, '$shared')) Object.values(x).forEach(countStrings);
  };
  countStrings(content);
  for (const [, definition] of objectDefinitions) countStrings(definition);

  const stringIds = new Map<string, string>();
  const shareStrings = (x: unknown): unknown => {
    if (typeof x === 'string') {
      const count = stringCounts.get(x) ?? 0;
      let id = stringIds.get(x);
      if (!id && count >= 2) {
        const nextId = `s${ids.size + stringIds.size}`;
        const literalLength = JSON.stringify(x).length;
        const pointerLength = JSON.stringify({ $shared: nextId }).length;
        const definitionLength = JSON.stringify(nextId).length + 1 + literalLength + 1;
        if (count * literalLength > count * pointerLength + definitionLength) {
          id = nextId; stringIds.set(x, id);
          values[id] = x;
        }
      }
      return id ? { $shared: id } : x;
    }
    if (Array.isArray(x)) return x.map(shareStrings);
    if (object(x) && !Object.hasOwn(x, '$shared')) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, shareStrings(v)]));
    return x;
  };
  content = shareStrings(content);
  // Iterate a snapshot: new string definitions must remain literal values.
  for (const [id, definition] of objectDefinitions) values[id] = shareStrings(definition);
  const result = { encoding: EVIDENCE_SHARING_VERSION, values, content };
  // Pay for the decoding guidance too; small packets stay unchanged.
  return (ids.size || stringIds.size) && JSON.stringify(result).length + EVIDENCE_SHARING_GUIDANCE_CHARS + 128 < JSON.stringify(value).length ? result : value;
}

/** Both SDK and hosted-provider message shapes contain JSON strings. Detect an
 * actual envelope, never an incidental mention of the codec in ordinary prose. */
export function hasSharedEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    if (!value.startsWith('{') || !value.includes(EVIDENCE_SHARING_VERSION)) return false;
    try { return hasSharedEvidence(JSON.parse(value)); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(hasSharedEvidence);
  if (!object(value)) return false;
  if (value.encoding === EVIDENCE_SHARING_VERSION && object(value.values) && Object.hasOwn(value, 'content')) return true;
  return Object.values(value).some(hasSharedEvidence);
}

/** Strict verifier; malformed/dangling/cyclic dictionaries never decode silently. */
export function expandSharedEvidence(value: unknown): unknown {
  if (!object(value) || value.encoding !== EVIDENCE_SHARING_VERSION) return value;
  if (!object(value.values) || !Object.hasOwn(value, 'content')) throw Error('invalid-evidence-sharing');
  const values = value.values, active = new Set<string>(), expanded = new Map<string, unknown>();
  const visit = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(visit);
    if (!object(x)) return x;
    if (Object.hasOwn(x, '$shared')) {
      const id = x.$shared;
      if (Object.keys(x).length !== 1 || typeof id !== 'string' || !Object.hasOwn(values, id) || active.has(id)) throw Error('invalid-evidence-sharing-reference');
      if (!expanded.has(id)) { active.add(id); expanded.set(id, visit(values[id])); active.delete(id); }
      return expanded.get(id);
    }
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, visit(v)]));
  };
  return visit(value.content);
}

/** Serialize a copy at the model boundary, retaining native tool identity and
 * opaque assistant/provider continuation objects without modification. */
export function shareEvidenceMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map(message => {
    if (message.role === 'user' && typeof message.content === 'string') {
      let data: unknown;
      try { data = JSON.parse(message.content); } catch { return message; }
      if (!object(data) || data.scope !== 'CURRENT_QUESTION') return message;
      const shared = shareEvidence(data);
      return shared === data ? message : { ...message, content: JSON.stringify(shared) };
    }
    if (message.role === 'tool') return { ...message, content: message.content.map(part => {
      if (part.type !== 'tool-result' || part.output.type !== 'json') return part;
      return { ...part, output: { ...part.output, value: shareEvidence(part.output.value) as typeof part.output.value } };
    }) };
    return message;
  });
}
