/**
 * The fixture server's Passwords vault, through Walnut's API, for every spec that needs a vault
 * session (or only a vault) without going through the unlock UI.
 *
 * Specs that share one fixture server reach for the vault at the same moment, and the server
 * checks one master password at a time (vault-v1.ts `attempt`): a second unlock or setup is
 * answered `429 unlock_busy` with a `waitMs`, and a setup that lost the race to another spec's
 * is answered `409 vault_exists` (2026-11-05: extension-agent failed on CI with unlock_busy).
 * These helpers set up or unlock, wait out those answers, and give up only after `timeoutMs`.
 * Every other route that checks the master password (a hint change, say) is busy the same way:
 * vaultCheckedRequest sends one of those. tests/scripts/browser-spec-ratchets.test.ts fails on
 * a spec that reaches any of those routes another way.
 */
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'

/** The master password every browser spec gives the shared fixture vault. */
export const VAULT_MASTER = 'Correct Horse Battery Staple 42'

export interface VaultOptions {
  /** The master password (default VAULT_MASTER). */
  password?: string
  /** How long to keep trying through busy answers, in all (default 60 s). */
  timeoutMs?: number
}

type Request = APIRequestContext | { request: APIRequestContext }

const DEFAULT_TIMEOUT_MS = 60_000
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const reqOf = (r: Request): APIRequestContext => ('request' in r ? r.request : r)

/** Why to try again (the time to wait first), or null: the answer is final. */
function retryAfter(status: number, body: { code?: string; waitMs?: number }): number | null {
  // Another check runs now (unlock_busy), or wrong passwords slowed every check (unlock_slowed).
  if (status === 429) return Math.max(200, Number(body.waitMs) || 1000)
  // Another spec set the vault up first, or changed its key salt after we read it: read again.
  if (status === 409 && (body.code === 'vault_exists' || body.code === 'kdf_changed')) return 100
  return null
}

async function bodyOf(r: APIResponse): Promise<{ text: string; json: Record<string, any> }> {
  const text = await r.text()
  try { return { text, json: JSON.parse(text) } } catch { return { text, json: {} } }
}

/**
 * A vault session token: sets the vault up when nothing did yet, else unlocks it. Retries
 * through `unlock_busy` / `unlock_slowed` (honoring `waitMs`), a lost setup race and a changed
 * salt, within `timeoutMs` in all; any other refusal fails at once with the server's answer.
 */
export async function vaultSession(req: Request, base: string, opts: VaultOptions = {}): Promise<string> {
  const request = reqOf(req)
  const password = opts.password ?? VAULT_MASTER
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let last = ''
  for (;;) {
    const st = await (await request.get(`${base}/api/v1/vault/status`)).json()
    const r = st.setUp
      ? await request.post(`${base}/api/v1/vault/unlock`, { data: { password, kdfSalt: st.kdf?.salt } })
      : await request.post(`${base}/api/v1/vault/setup`, { data: { password } })
    const { text, json } = await bodyOf(r)
    if (r.ok()) return String(json.session?.token ?? '')
    last = `${r.status()} ${text}`
    const wait = retryAfter(r.status(), json)
    expect(wait, `vault ${st.setUp ? 'unlock' : 'setup'}: ${last}`).not.toBeNull()
    if (Date.now() + wait! > deadline) break
    await sleep(wait!)
  }
  throw new Error(`vault session: still refused after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms: ${last}`)
}

/**
 * Any other request the server checks the master password for (a hint change, a new master
 * password, an export, a recovery: every vault-v1.ts route that runs under `attempt`). Sent
 * again while the check is busy or slowed (429, honoring `waitMs`), within `timeoutMs` in all;
 * the last answer is returned for the spec to judge.
 */
export async function vaultCheckedRequest(
  req: Request,
  method: 'post' | 'put',
  url: string,
  options: { data?: unknown; headers?: Record<string, string> },
  opts: { timeoutMs?: number } = {},
): Promise<APIResponse> {
  const request = reqOf(req)
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  for (;;) {
    const r = await request[method](url, options)
    if (r.status() !== 429) return r
    const wait = retryAfter(429, (await bodyOf(r)).json)!
    if (Date.now() + wait > deadline) return r
    await sleep(wait)
  }
}

/**
 * The vault set up (when no other spec did yet), opening no session when it already is: for a
 * spec whose own unlock goes through the UI. Same retries as vaultSession.
 */
export async function ensureVaultSetUp(req: Request, base: string, opts: VaultOptions = {}): Promise<void> {
  const request = reqOf(req)
  const password = opts.password ?? VAULT_MASTER
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let last = ''
  for (;;) {
    const st = await (await request.get(`${base}/api/v1/vault/status`)).json()
    if (st.setUp) return
    const r = await request.post(`${base}/api/v1/vault/setup`, { data: { password } })
    if (r.ok()) return
    const { text, json } = await bodyOf(r)
    last = `${r.status()} ${text}`
    const wait = retryAfter(r.status(), json)
    expect(wait, `vault setup: ${last}`).not.toBeNull()
    if (Date.now() + wait! > deadline) break
    await sleep(wait!)
  }
  throw new Error(`vault setup: still refused after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms: ${last}`)
}
