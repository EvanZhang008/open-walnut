/**
 * The 409 body for a Start that a host refuses (host-problem.ts re-exports it, so every
 * caller keeps one import). Pure: no imports, so the browser reads this file too.
 */

export type HostGateCode = 'host_not_ready' | 'host_unreachable' | 'host_off' | 'host_removed'

export interface HostGateBody {
  error: string
  code: HostGateCode
  kind?: string
  host: string
  headline: string
  hint: string
  allowOverride?: true
}

/** 'Headline. Hint' with no doubled or dangling punctuation. */
export function joinHeadlineHint(headline: string, hint?: string): string {
  const h = headline.trim()
  const t = (hint ?? '').trim()
  // No hint: the headline alone. A sentence keeps its own single period; a
  // headline never grows a dangling '. '.
  if (!t) return h
  return /[.!?:]$/.test(h) ? `${h} ${t}` : `${h}. ${t}`
}

/** The 409 body for a refused Start. Old clients read `error`; new ones render headline + hint. */
export function hostGateBody(input: {
  code: HostGateCode; host: string; kind?: string; headline: string; hint?: string; allowOverride?: boolean
}): HostGateBody {
  const hint = (input.hint ?? '').trim()
  return {
    error: joinHeadlineHint(input.headline, hint),
    code: input.code,
    ...(input.kind ? { kind: input.kind } : {}),
    host: input.host,
    headline: input.headline.trim(),
    hint,
    ...(input.allowOverride ? { allowOverride: true as const } : {}),
  }
}
