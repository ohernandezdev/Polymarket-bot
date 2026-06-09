/**
 * fetch() with a hard timeout.
 *
 * A bare `fetch` has NO timeout: if the endpoint hangs (RPC stall, dropped
 * connection), the await never settles and the caller — often on the bot's hot
 * path (the paper resolver, the copy pipeline) — blocks forever. This wraps fetch
 * with an AbortController so a stalled request rejects after `timeoutMs` and the
 * caller can retry next cycle instead of wedging.
 */

const DEFAULT_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '10000', 10);

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
