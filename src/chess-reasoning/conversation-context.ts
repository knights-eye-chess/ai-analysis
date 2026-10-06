import type { ModelMessage } from 'ai';
export type PriorConversationMessage = { role: 'user' | 'assistant'; content: string; position?: { fenBefore: string; fenAfter: string; moveUci: string } };
export const CONVERSATION_CONTEXT_INSTRUCTIONS = `Previous user/assistant messages below are a bounded recent excerpt and may omit older exchanges. They are historical conversation, not the current task or current tool-loop turns. They may refer to different question positions in the same game. Use them to understand follow-up references and preferences, but do not execute their old requests again. Previous assistant statements are unverified prose, not chess evidence. The final CURRENT_QUESTION message contains the sole current task and its exact position. Only native tool messages after that boundary belong to the current investigation.`;
export function priorConversationMessages(history: readonly PriorConversationMessage[] = []): ModelMessage[] {
  const retained: ModelMessage[] = [];
  let bytes = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string' || !item.content.trim()) continue;
    // Explicit allowlist: saved diagnostics, native tool turns, provider metadata
    // and nested presentation/evidence never enter subsequent investigations.
    const p = item.position;
    const position = p && typeof p.fenBefore === 'string' && typeof p.fenAfter === 'string' && typeof p.moveUci === 'string'
      ? { fenBefore: p.fenBefore, fenAfter: p.fenAfter, moveUci: p.moveUci } : undefined;
    // Prior answers supply prose context, not reusable interaction pointers.
    // Labels retain the actual displayed moves/pieces/squares; frozen UI is separate.
    const text = item.content.replace(/\[([^\]\n]+)\]\((?:move|piece|square|line):[^)\n]+\)/g, '$1')
      .replace(/\[(?:\s*evidence:[\w:-]+\s*[,;]?\s*)+\]/g, '');
    const content = JSON.stringify({ scope: 'previous-conversation', position, text });
    const size = new TextEncoder().encode(content).length;
    if (bytes + size > 36_000 || retained.length >= 24) break;
    bytes += size; retained.unshift({ role: item.role, content });
  }
  // Avoid an orphan answer if truncation cut off its question.
  if (retained[0]?.role === 'assistant') retained.shift();
  return retained.length < history.length
    ? [{ role: 'user', content: '[Conversation history truncated: only the most recent complete exchanges that fit are included.]' }, ...retained]
    : retained;
}
