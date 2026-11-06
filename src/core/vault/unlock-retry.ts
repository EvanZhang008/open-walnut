/**
 * What an unlock client does with the server's answers to POST /vault/unlock, shared by the web
 * app (web/src/api/vault.ts) and the browser extension (packages/browser-extension/src/popup.ts,
 * key-pop.ts). Pure: no DOM, no Node.
 *
 * The server checks one master password at a time (routes/vault-v1.ts `attempt`): a second
 * check while one runs is answered `429 unlock_busy` with a `waitMs`. That says nothing about the
 * password, so a client waits and sends it again, a few times within a few seconds, showing
 * "Checking…" meanwhile; before, the person read "Another unlock is being checked" under a correct
 * password and had to press Unlock again (2026-11-06: two browser specs, each typing the right
 * password while another spec unlocked). Any other answer, a wrong password above all, is final.
 *
 * UNLOCK_REFUSALS is every code the unlock route can answer with and what a client says for it:
 * tests/web/unlock-refusal-guard.test.ts reads the codes from the route and fails on one missing.
 */

/** How many times an unlock is sent again while another check runs. */
export const UNLOCK_BUSY_RETRIES = 3
/** The most time spent waiting on busy answers for one unlock, in all. */
export const UNLOCK_BUSY_WAIT_CAP_MS = 5_000
/** The shortest wait between tries, whatever the server says. */
const MIN_WAIT_MS = 100

export interface RetryOptions {
  /** Called before each wait, with its length: the place to show "Checking…". */
  onWait?: (ms: number) => void
  /** Waits `ms` (tests pass their own). */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Run `attempt` and run it again while `busyWait` reads its outcome as "another check runs"
 * (the wait the server asked for, in ms; null for any other outcome): at most UNLOCK_BUSY_RETRIES
 * more times, waiting UNLOCK_BUSY_WAIT_CAP_MS in all. The last outcome is returned as it is.
 */
export async function whileUnlockBusy<T>(attempt: () => Promise<T>, busyWait: (outcome: T) => number | null, opts: RetryOptions = {}): Promise<T> {
  const sleep = opts.sleep ?? realSleep
  let waited = 0
  for (let tries = 0; ; tries++) {
    const outcome = await attempt()
    const asked = busyWait(outcome)
    if (asked === null || tries >= UNLOCK_BUSY_RETRIES) return outcome
    const wait = Math.max(MIN_WAIT_MS, Number.isFinite(asked) ? asked : 1000)
    if (waited + wait > UNLOCK_BUSY_WAIT_CAP_MS) return outcome
    opts.onWait?.(wait)
    await sleep(wait)
    waited += wait
  }
}

/** The same for an attempt that throws its refusals (the web app's vaultApi.unlock). */
export async function throwingWhileUnlockBusy<T>(attempt: () => Promise<T>, busyWait: (err: unknown) => number | null, opts: RetryOptions = {}): Promise<T> {
  type Out = { ok: true; value: T } | { ok: false; err: unknown }
  const out = await whileUnlockBusy<Out>(
    () => attempt().then((value) => ({ ok: true as const, value }), (err: unknown) => ({ ok: false as const, err })),
    (o) => (o.ok ? null : busyWait(o.err)),
    opts,
  )
  if (out.ok) return out.value
  throw out.err
}

/** The wait a refusal asks for when it is "another check runs", else null. */
export function busyWaitOf(r: { code?: string; waitMs?: number } | null | undefined): number | null {
  if (!r || r.code !== 'unlock_busy') return null
  return typeof r.waitMs === 'number' ? r.waitMs : 1000
}

const seconds = (ms: number | undefined) => Math.max(1, Math.ceil(Number(ms ?? 0) / 1000))
const tooMany = (r: { waitMs?: number }) => (typeof r.waitMs === 'number' && r.waitMs > 0 ? `Too many tries. Wait ${seconds(r.waitMs)} s.` : null)

/**
 * Every code POST /vault/unlock can answer with, and the words a client shows for it: a function
 * of the refusal, or null for the server's own words (already written for a person).
 */
export const UNLOCK_REFUSALS: Record<string, ((r: { waitMs?: number; message?: string }) => string | null) | null> = {
  // Wrong passwords slowed every check (the brake in core/vault/sessions.ts).
  unlock_slowed: tooMany,
  // An older Walnut's name for the same brake.
  too_many_attempts: tooMany,
  // Another check still ran after every retry.
  unlock_busy: () => 'Another unlock is being checked. Try again in a moment.',
  wrong_password: null,
  secret_key_needed: null,
  bad_secret_key: null,
  vault_not_set_up: null,
  // The master password changed in another window, after the client's own read again.
  kdf_changed: null,
  insecure_link: null,
  bad_password_key: null,
  bad_kdf: null,
  vault_not_here: null,
  test_run: null,
  human_only: null,
}

/** What a client says under its unlock form for a refusal. */
export function unlockRefusalText(r: { code?: string; waitMs?: number; message?: string }, fallback = 'That did not unlock.'): string {
  const words = r.code ? UNLOCK_REFUSALS[r.code] : undefined
  return (words ? words(r) : null) ?? r.message ?? fallback
}
