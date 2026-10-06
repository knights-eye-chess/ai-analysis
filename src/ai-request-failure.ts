/** Public finite error vocabulary. Never copy arbitrary provider text or transport bodies. */
export type AiFailureDetails = { code: string; status?: number; retryAfterSeconds?: number; providerDispatched?: boolean; requestId?: string; providerRequestId?: string; stage: string; reportable: boolean };
const known = new Set(['insufficient_credits','invalid_key','rate_limited','model_unavailable','provider_unavailable','free_unavailable','free_funds_exhausted','ai_request_active','ai_hourly_limit','ai_admission_busy','sign_in_required','forbidden','connection_changed','cancelled','request_too_large','request_timeout','network_error','response_invalid','unknown_error','tool_evidence_contract_failed','output_truncated','empty_answer','no_final_answer','context_byte_budget']);
const expected = new Set(['insufficient_credits','invalid_key','rate_limited','model_unavailable','free_unavailable','free_funds_exhausted','ai_hourly_limit','sign_in_required','forbidden','connection_changed','cancelled']);
export function aiFailureDetails(code: string, fields: Partial<AiFailureDetails> = {}): AiFailureDetails {
  code = known.has(code) ? code : 'unknown_error';
  return { ...fields, code, stage: fields.stage || 'simple-model', reportable: !expected.has(code) };
}
export function aiFailureMessage(f: AiFailureDetails, reported = false): string {
  const minutes = Math.max(1, Math.ceil((f.retryAfterSeconds ?? 0) / 60));
  const wait = f.retryAfterSeconds ? ` Please try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.` : ' Please wait a moment and try again.';
  switch(f.code) {
    case 'ai_request_active': return 'Your previous AI request is still processing or being released after it stopped.' + wait;
    case 'ai_hourly_limit': return 'The hourly AI allowance has been reached.' + wait;
    case 'rate_limited': return 'Your AI provider is temporarily limiting requests.' + wait;
    case 'insufficient_credits': return 'Your AI account has insufficient credits or reached its spending limit. Add credits or adjust the limit, then try again.';
    case 'invalid_key': case 'connection_changed': return 'Your AI connection needs attention. Open your profile and reconnect your AI account.';
    case 'sign_in_required': return 'Your session has expired. Please sign in again to ask a question.';
    case 'forbidden': return 'You cannot ask questions about this game with the current account. Sign in to the owning account or create your own copy.';
    case 'model_unavailable': return 'The selected model is unavailable. Check your AI connection in your profile or try again later.';
    case 'free_unavailable': case 'free_funds_exhausted': return 'Free AI is temporarily unavailable. Connect your own AI account in your profile, or try again later.';
    case 'cancelled': return 'The request was cancelled.';
    case 'network_error': return 'We could not reach the AI service. Check your internet connection and try again.';
    case 'request_timeout': return 'The AI request took too long. Please try again later. The provider may have charged for this attempt.';
    case 'request_too_large': case 'context_byte_budget': return 'This question and its context are too large to send. Try a shorter question or start a new chat.';
    default: return reported ? "Something went wrong. We've received an automatic report and will look into it. Please try again." : 'Something went wrong. Please try again. You can also report this problem to us.';
  }
}
export function failureFromError(error: unknown, code = 'unknown_error'): AiFailureDetails {
  const e = error as { details?: AiFailureDetails; name?: string } | null;
  if(e?.details) return e.details;
  if(e?.name === 'AbortError') return aiFailureDetails('cancelled');
  return aiFailureDetails(code);
}
