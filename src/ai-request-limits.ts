/** Byte safety ceilings, not token estimates. Wire encoding, server policy and
 * opaque provider continuation require headroom beyond model evidence JSON. */
export const AI_MODEL_CONTEXT_MAX_BYTES = 1_000_000;
export const AI_RELAY_MAX_REQUEST_BYTES = 2_000_000;
