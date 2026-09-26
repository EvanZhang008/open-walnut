/**
 * A routine, trigger or watcher refused by the host gate (host-start-gate.ts):
 * the run fails with the gate's sentence, and the human is told ONCE per
 * standing problem, keyed `${routineId}|${host}|${code}|${kind}` (C91). A launch
 * that goes through re-arms every key of its routine, so the same problem coming
 * back later is told again.
 *
 * Callers RETURN the refusal as an error result, never rethrow it: a throw marks
 * the run retryable (registry.ts runExecutor), and a trigger fire would then be
 * replayed into the same refusal on every delivery attempt.
 */

export interface HostGateRefusal {
  code: string
  kind: string
  message: string
}

export type HostGateNotify = (input: { title: string; body: string; dedupKey: string }) => Promise<void>

const notified = new Set<string>()

/** The gate's 409 (a QuickStartError whose body code is host_*), or null for any other failure. */
export function hostGateRefusal(err: unknown): HostGateRefusal | null {
  // Duck-typed so a routine module need not import the whole quick-start core to ask.
  const e = err as { name?: unknown; statusCode?: unknown; body?: { code?: unknown; kind?: unknown }; message?: unknown } | null
  if (!e || e.name !== 'QuickStartError' || e.statusCode !== 409) return null
  const code = e.body?.code
  if (typeof code !== 'string' || !code.startsWith('host_')) return null
  return { code, kind: typeof e.body?.kind === 'string' ? e.body.kind : '', message: String(e.message ?? '') }
}

/**
 * If `err` is a gate refusal: notify once for this routine + host + problem and
 * answer the sentence the run should fail with. null = not a gate refusal (the
 * caller handles it as before).
 */
export async function noteHostGateRefusal(input: {
  jobId: string
  host: string | undefined
  title: string
  err: unknown
  notify: HostGateNotify
}): Promise<string | null> {
  const refusal = hostGateRefusal(input.err)
  if (!refusal) return null
  const key = `${input.jobId}|${input.host ?? ''}|${refusal.code}|${refusal.kind}`
  if (!notified.has(key)) {
    notified.add(key)
    await input.notify({ title: input.title, body: refusal.message, dedupKey: key }).catch(() => { /* never fail the run twice */ })
  }
  return refusal.message
}

/** A launch of this routine went through: its problems are over, so a return is news again. */
export function clearHostGateNotices(jobId: string): void {
  for (const key of [...notified]) if (key.startsWith(`${jobId}|`)) notified.delete(key)
}

/** Test seam. */
export function resetHostGateNotices(): void {
  notified.clear()
}
