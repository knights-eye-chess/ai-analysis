/** Per answering episode; only pre-dispatch validation errors enter this cache. */
export function createToolInputLoopGuard() {
  const failures = new Map<string, {message:string; code:string; field?:string; expected?:string}>();
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])) : value;
  let repeatedFailures = 0;
  return {
    get repeatedFailures() { return repeatedFailures; },
    validate(name: string, input: Record<string, unknown>, validate: () => void) {
      // Runtime IDs are not tool arguments: invoke this before adding callId or
      // contextHash. Keep every actual argument in the key, including paths.
      const key = JSON.stringify([name, stable(input)]);
      const previous = failures.get(key);
      if (previous) {
        repeatedFailures++;
        throw Object.assign(new Error(`Repeated invalid request was not executed. ${previous.message} Correct the named field; do not repeat unchanged arguments. If unnecessary, summarize the acquired evidence.`), {
          code:'repeated-invalid-tool-input', field:previous.field, expected:previous.expected,
          originalCode:previous.code, repeatedInvalidInput:true,
        });
      }
      try {
        validate();
        if (['test_line','test_game_line'].includes(name) && input.compareFinalMovesUci !== undefined) {
          if (input.analyzeFinal !== true) throw Object.assign(new Error('compareFinalMovesUci requires analyzeFinal=true. Set analyzeFinal=true to compare the final position, or omit compareFinalMovesUci for replay only.'), {code:'invalid-final-comparison',field:'analyzeFinal',expected:'true when compareFinalMovesUci is supplied'});
        }
      } catch (error) {
        // Only structured, deterministic validation failures. Never cache host,
        // engine, provider, cancellation, evidence-contract or transient errors.
        const detail = error as {message?:unknown;code?:unknown;field?:unknown;expected?:unknown};
        if (typeof detail.code === 'string' && typeof detail.field === 'string') failures.set(key, {
          message:typeof detail.message === 'string' ? detail.message.slice(0,600) : 'Invalid tool input.',
          code:detail.code,field:detail.field,expected:typeof detail.expected === 'string' ? detail.expected : undefined,
        });
        throw error;
      }
    },
  };
}
