/** Public, bounded routing facts only. Never provider text, headers or credentials. */
export const AI_ROUTING_HEADER = 'x-knights-eye-ai-routing';
export type AiRoutingDiagnostics = {
  requestedTier: 'flex' | 'default' | 'priority' | null;
  actualTier: 'flex' | 'default' | 'priority' | null;
  reason: 'flex_available' | 'cooldown_active' | 'storage_unavailable' | 'unsupported' | 'user_disabled' | 'user_standard' | 'user_fast';
  elapsedMs: number;
  slowThresholdMs: number;
  timingEligible?: boolean;
  cooldownUntil: number | null;
  cooldownTriggered: boolean;
  persistenceError?: boolean;
};
export function readAiRoutingDiagnostics(headers?: Headers | Record<string, string>): AiRoutingDiagnostics | undefined {
  try {
    const raw = headers instanceof Headers ? headers.get(AI_ROUTING_HEADER) : headers?.[AI_ROUTING_HEADER];
    if (!raw || raw.length > 2048) return undefined;
    const value = JSON.parse(raw);
    if (!value || ![null,'flex','default','priority'].includes(value.requestedTier)
      || ![null,'flex','default','priority'].includes(value.actualTier)
      || !['flex_available','cooldown_active','storage_unavailable','unsupported','user_disabled','user_standard','user_fast'].includes(value.reason)
      || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0
      || !Number.isFinite(value.slowThresholdMs) || value.slowThresholdMs <= 0
      || (value.cooldownUntil !== null && (!Number.isSafeInteger(value.cooldownUntil) || value.cooldownUntil < 0))
      || typeof value.cooldownTriggered !== 'boolean'
      || (value.timingEligible !== undefined && typeof value.timingEligible !== 'boolean')) return undefined;
    return {requestedTier:value.requestedTier,actualTier:value.actualTier,reason:value.reason,
      elapsedMs:value.elapsedMs,slowThresholdMs:value.slowThresholdMs,cooldownUntil:value.cooldownUntil,
      cooldownTriggered:value.cooldownTriggered,
      ...(typeof value.timingEligible === 'boolean' ? {timingEligible:value.timingEligible} : {}),
      ...(value.persistenceError === true ? {persistenceError:true} : {})};
  } catch { return undefined; }
}
