const DEFAULT_API_URL = 'http://127.0.0.1:3456'

/** Deadline on EVERY call: a plugin author's terminal must never hang on a wedged server. */
export const API_TIMEOUT_MS = 3000

/** Base URL of the Walnut this CLI talks to. */
export function apiBaseUrl(): string {
  return process.env.OPEN_WALNUT_API_URL ?? DEFAULT_API_URL
}

/** A failed call; `offline` means nothing answered, as opposed to Walnut answering no. */
export class ApiError extends Error {
  readonly status?: number
  readonly offline: boolean
  /** A 404 with no JSON error of its own: no such route, not a route reporting "not found". */
  readonly routeMissing: boolean

  constructor(
    message: string,
    options: { status?: number; offline?: boolean; routeMissing?: boolean } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = options.status
    this.offline = options.offline ?? false
    this.routeMissing = options.routeMissing ?? false
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const base = apiBaseUrl()
  const url = new URL(path, base)
  // The deadline is unconditional; a caller's own signal is composed with it, never a substitute for it.
  const deadline = AbortSignal.timeout(API_TIMEOUT_MS)
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      signal,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ApiError(`Walnut at ${base} did not answer within ${API_TIMEOUT_MS}ms (${reason})`, {
      offline: true,
    })
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const reported = typeof body.error === 'string' ? body.error : undefined
    throw new ApiError(reported ?? `Walnut API returned ${response.status}`, {
      status: response.status,
      routeMissing: response.status === 404 && reported === undefined,
    })
  }
  return body as T
}
