/**
 * A failed Codex turn's kind, read from Codex's own error code (`codexErrorInfo`)
 * and HTTP status rather than its words, so a usage limit, a rate limit, an
 * overloaded service and a dropped connection each get their own row. The row's
 * words (worker.ts safeWorkerErrorMessage) are what Walnut's retry reads
 * (daemon-core.ts classifyTurnError): the passing kinds name a retryable signature,
 * the others a terminal one.
 */

export type CodexFailureKind =
  | 'usage_limit' | 'auth_required' | 'rate_limited' | 'overloaded' | 'server_error' | 'connection'
  | 'context_window' | 'app_server_exited' | 'turn_stalled'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function httpStatusOf(info: unknown): number | undefined {
  if (!isRecord(info)) return undefined
  for (const value of Object.values(info)) {
    if (isRecord(value) && typeof value.httpStatusCode === 'number') return value.httpStatusCode
  }
  return undefined
}

/** undefined: not a Codex failure this client recognises (the caller's generic rules apply). */
export function classifyCodexFailure(data: unknown): CodexFailureKind | undefined {
  if (!isRecord(data)) return undefined
  if (data.walnutError === 'app_server_exited') return 'app_server_exited'
  if (data.walnutError === 'turn_stalled') return 'turn_stalled'
  const info = data.codexErrorInfo
  const status = httpStatusOf(info)
  if (info === 'usageLimitExceeded') return 'usage_limit'
  if (info === 'unauthorized' || status === 401) return 'auth_required'
  if (info === 'contextWindowExceeded') return 'context_window'
  if (info === 'rateLimitExceeded' || status === 429) return 'rate_limited'
  if (info === 'serverOverloaded' || status === 503 || status === 529) return 'overloaded'
  if (info === 'internalServerError' || (status !== undefined && status >= 500)) return 'server_error'
  if (isRecord(info) && ('httpConnectionFailed' in info || 'responseStreamConnectionFailed' in info
    || 'responseStreamDisconnected' in info || 'responseTooManyFailedAttempts' in info)) return 'connection'
  return undefined
}
