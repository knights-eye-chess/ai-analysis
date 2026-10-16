/** Four independent preparation chains only; never a model-tool scheduler. */
export type PreparedChainItem<Request, Result> = {
  request: Request; callId: string; discoveryCallId?: string; elapsedMs: number;
  outcome: { value: Result } | { error: unknown };
};
export async function scheduleInitialSearches<Request, Result>(input: {
  requests: readonly Request[]; signal: AbortSignal; shouldDefer: () => boolean;
  execute: (request: Request, callId: string) => Promise<Result>;
  comparison: (request: Request, result: Result) => Request | undefined;
}) {
  const requests = structuredClone([...input.requests]);
  const chains: PreparedChainItem<Request, Result>[][] = requests.map(() => []);
  let cursor = 0, deferred = 0;
  const worker = async () => {
    while (cursor < requests.length) {
      input.signal.throwIfAborted();
      const index = cursor++;
      let request: Request | undefined = requests[index];
      const discoveryCallId = `initial-chain-${index + 1}-discovery`;
      for (const phase of ['discovery', 'comparison'] as const) {
        if (request === undefined) break;
        input.signal.throwIfAborted();
        if (input.shouldDefer()) { deferred++; break; }
        const callId = `initial-chain-${index + 1}-${phase}`;
        const started = performance.now();
        const item: PreparedChainItem<Request, Result> = { request, callId, elapsedMs: 0,
          ...(phase === 'comparison' ? { discoveryCallId } : {}), outcome: { error: undefined } };
        chains[index].push(item);
        try {
          const value = await input.execute(request, callId);
          input.signal.throwIfAborted();
          // Derivation is part of acquisition admission, not an outcome-dependent retry.
          const next: Request | undefined = phase === 'discovery' ? input.comparison(request, value) : undefined;
          item.outcome = { value };
          request = next;
        } catch (error) {
          if (input.signal.aborted) throw error;
          item.outcome = { error }; break;
        } finally { item.elapsedMs = performance.now() - started; }
      }
    }
  };
  // Wait for every active chain even when abort makes one reject first.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(4, requests.length) }, worker));
  input.signal.throwIfAborted();
  const failure = settled.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return { items: chains.flat(), deferred };
}
