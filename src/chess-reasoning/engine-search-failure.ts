/** Bounded observable cause only: no stack, response headers or provider payload. */
export function engineSearchFailure(error: unknown) {
  const detail = error as { message?: unknown; code?: unknown; status?: unknown; cause?: unknown } | null;
  const message = typeof detail?.message === 'string' ? detail.message.slice(0, 300)
    : typeof error === 'string' ? error.slice(0, 300) : 'engine-search-unavailable';
  const cause = detail?.cause as { message?: unknown; code?: unknown } | null;
  return { error: message,
    ...(typeof detail?.code === 'string' ? { code: detail.code.slice(0, 80) } : {}),
    ...(typeof detail?.status === 'number' && Number.isInteger(detail.status) && detail.status >= 100 && detail.status <= 599 ? { status: detail.status } : {}),
    ...(typeof cause?.message === 'string' ? { cause: cause.message.slice(0, 300) } : {}) };
}
