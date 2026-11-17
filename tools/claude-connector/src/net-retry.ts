// Retry for requests whose transport failed: no HTTP response came back
// ("fetch failed", a reset, or our own timeout). Under heavy load on the Mac
// (MS-3886: load 131, 14 sync errors in 24 h) these are transient, and one
// lost push leaves a Trello card stale until the next full pass.
//
// A request that got no response may still have reached the server. Repeating
// it is only safe for methods the APIs treat idempotently; a POST is repeated
// only when the connection was never established, so a card or comment is
// never created twice.

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])
const NOT_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
])

export const netRetryDelaysMs = [1_000, 3_000]

/** The low-level reason of a failed fetch, e.g. ECONNRESET or TimeoutError. */
export function transportCause(err: unknown): string | null {
  if (!(err instanceof Error)) return null
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return err.name
  if (err instanceof TypeError && err.message === 'fetch failed') {
    const cause = err.cause as { code?: string; name?: string } | undefined
    return cause?.code ?? cause?.name ?? 'unknown'
  }
  return null
}

/**
 * Runs attempt (which must build a fresh request, including its abort signal)
 * and repeats it after a transport failure when that is safe for method. The
 * final error names the cause and the number of attempts, so the log tells a
 * refused connection (local server down) from a timeout (load) or a reset
 * (network).
 */
export async function withNetRetry<T>(
  method: string,
  attempt: () => Promise<T>,
  delays: number[] = netRetryDelaysMs,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (err) {
      const cause = transportCause(err)
      if (cause === null) throw err
      const safe = IDEMPOTENT.has(method.toUpperCase()) || NOT_CONNECTED.has(cause)
      if (!safe || i >= delays.length) {
        throw new Error(`${(err as Error).message} [${cause}, ${i + 1} Versuch${i ? 'e' : ''}]`, { cause: err })
      }
      await new Promise((r) => setTimeout(r, delays[i]))
    }
  }
}
