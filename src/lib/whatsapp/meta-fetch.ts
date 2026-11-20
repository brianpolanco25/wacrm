const META_TIMEOUT_MS = 15_000;
/** Media bytes travel through these; a big file needs more than 15 s. */
export const META_MEDIA_TIMEOUT_MS = 120_000;

/**
 * `fetch` with a deadline: a Graph call or CDN download that accepts the
 * connection and never answers would otherwise stall the webhook
 * delivery (or the send route) behind it. A caller's own `signal` wins.
 */
export function metaFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = META_TIMEOUT_MS
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}
