/**
 * Passwords (core/vault/, docs/reference/passwords.md): a person's own use of the vault.
 *
 *   GET    /api/v1/vault/status                    → status (+ `unlocked` for this request's session)
 *   POST   /api/v1/vault/setup                     { passwordKey | password, kdf, agentsWhileAway } → { secretKey, session }
 *   POST   /api/v1/vault/unlock                    { passwordKey | password, secretKey?, client? } → { session }
 *   POST   /api/v1/vault/lock                      { all? } → { ended }
 *   GET    /api/v1/vault/items                     → { items: summaries }       (session)
 *   POST   /api/v1/vault/items                     { item } → { item }          (session)
 *   GET    /api/v1/vault/items/:id                 → { item }                   (session)
 *   PUT    /api/v1/vault/items/:id                 { item, expectedUpdatedAt? } (session)
 *   POST   /api/v1/vault/items/:id/{trash,restore,favorite,used}                (session)
 *   DELETE /api/v1/vault/items/:id                 (session; only from the trash)
 *   GET    /api/v1/vault/items/:id/totp            → { code, period, remaining } (session)
 *   POST   /api/v1/vault/import                    { text, format?, fileName?, dryRun } (session)
 *   GET    /api/v1/vault/report                    → security report            (session)
 *   POST   /api/v1/vault/settings                  { agentsWhileAway, passwordKey | password } (session)
 *   POST   /api/v1/vault/secret-key                { passwordKey | password } → { secretKey } (session)
 *   POST   /api/v1/vault/password                  { oldPasswordKey, newPasswordKey, kdf } (session)
 *   POST   /api/v1/vault/export                    { passwordKey | password, format: csv|json } (session)
 *
 * Who: a person only (no session caller, no CLI automation mark, this machine or a paired
 * device), the approvals rule. Agents use the vault only through the agent ops, each use
 * gated by policy and a person's approval. Every item route also needs a vault session,
 * which only the master password buys, so a process here that drops the headers still
 * reads nothing. A test run is refused outright: the vault is the person's real one. The
 * cloud companion never carries these calls (v1-forward/policy.ts keeps them) and a
 * follower holds no vault.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { requestOrigin } from '../middleware/request-origin.js'
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN } from '../../lib/caller-origin.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'
import { isFollower, role } from '../../core/server-role.js'
import { ambientTestRun } from '../../core/test-run.js'
import { derivePasswordKey, toB64, type KdfParams } from '../../core/vault/crypto.js'
import type { VaultItemInput } from '../../core/vault/types.js'

export const vaultV1Router = Router()

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function param(v: unknown): string {
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
}

/**
 * Answers the refusal and returns false when this request may not touch the vault at all.
 * `readStatus`: the status route, which a test run may read (it holds no secret), so an
 * automated browser can see the Passwords page on the person's own Walnut without using it.
 */
function gate(req: Request, res: Response, readStatus = false): boolean {
  res.setHeader('Cache-Control', 'no-store')
  if (role() !== 'leader' || isFollower()) {
    res.status(503).json({ error: 'Passwords are kept on your Mac and open only from it, its own network or Tailscale.', code: 'vault_not_here' })
    return false
  }
  if (ambientTestRun() && !readStatus) {
    res.status(403).json({ error: 'A test run cannot open the vault: it is the person\'s real one.', code: 'test_run' })
    return false
  }
  const origin = requestOrigin(req)
  const person = !header(req, 'x-walnut-caller-sid') && !header(req, CALLER_KIND_HEADER)
    && (origin === LOCAL_ORIGIN || origin === REMOTE_HTTP_ORIGIN)
  if (!person) {
    res.status(403).json({ error: 'Only a person opens the vault: an agent asks through walnut pass, which a person approves.', code: 'human_only' })
    return false
  }
  return true
}

let expiryHooked = false
async function sessions() {
  const s = await import('../../core/vault/sessions.js')
  if (!expiryHooked) {
    expiryHooked = true
    // The last window idling out closes the vault as a Lock would.
    s.onSessionsExpired(() => { void closeIfNobody().catch(() => undefined) })
  }
  return s
}

async function store() {
  return import('../../core/vault/store.js')
}

/** The person's vault session for this request, or a 401 answered. */
async function needSession(req: Request, res: Response, touch = true): Promise<boolean> {
  const s = await sessions()
  if (s.useSession(header(req, s.SESSION_HEADER), touch)) return true
  res.status(401).json({ error: 'The vault is locked in this window: unlock it with the master password.', code: 'vault_session_needed' })
  return false
}

async function autoLockMinutes(): Promise<number> {
  const { getConfig } = await import('../../core/config-manager.js')
  const m = (await getConfig()).passwords?.auto_lock_minutes
  return typeof m === 'number' && m > 0 ? m : 15
}

/** A route that already answered (a brake's refusal) returns this, and run() sends nothing more. */
const SENT = Symbol('sent')

async function run(res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  try {
    const out = await work()
    if (out === SENT || res.headersSent) return
    res.json(out)
  } catch (err) {
    const { VaultError } = await store()
    const { ImportError } = await import('../../core/vault/import.js')
    if (err instanceof VaultError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    if (err instanceof ImportError) { res.status(400).json({ error: err.message, code: 'bad_import' }); return }
    next(err)
  }
}

/**
 * The client's password key, or the server derives it from a typed password: a browser
 * on plain http (not a secure context) has no WebCrypto, so it sends the password itself.
 */
async function passwordKeyOf(req: Request, body: { passwordKey?: unknown; password?: unknown }, kdf: KdfParams | undefined): Promise<string> {
  if (typeof body.passwordKey === 'string' && body.passwordKey) return body.passwordKey
  const { VaultError, checkKdf } = await store()
  if (typeof body.password === 'string' && body.password && kdf) {
    // The password itself crosses the wire only on a link nobody else reads: this machine,
    // https, or Tailscale. Plain http on a shared network gets a refusal, not the password.
    if (!privateLink(req)) throw new VaultError('Open Walnut over https or Tailscale to unlock Passwords from this device: plain http would send the master password readable on the network.', 400, 'insecure_link')
    checkKdf(kdf)
    return toB64(await derivePasswordKey(body.password, kdf))
  }
  throw new VaultError('passwordKey (or password) is required', 400, 'bad_password_key')
}

/**
 * Nobody else reads this link: https here, this machine (a local proxy such as Tailscale Serve
 * included), or Tailscale's own addresses. A forwarded-proto header is not trusted: any client
 * can send one.
 */
function privateLink(req: Request): boolean {
  if (req.secure) return true
  // This machine, by the caller-origin rule (a loopback self-call made for someone else is not).
  if (requestOrigin(req) === LOCAL_ORIGIN) return true
  const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
  const m = /^100\.(\d+)\./.exec(ip)
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true // Tailscale's 100.64.0.0/10
  return /^fd7a:115c:a1e0:/i.test(ip)
}

/**
 * Run one check of the master password under the brake (sessions.beginAttempt): refused while
 * slowed or while another check runs, and a wrong password counts, whichever route it came by.
 * `work` does everything a guess costs (deriving a typed password included), so a burst of
 * guesses is refused before any of that work. Null: the refusal was answered.
 */
async function attempt<T>(res: Response, work: () => Promise<T>): Promise<{ value: T } | null> {
  const s = await sessions()
  const { VaultError } = await store()
  const busy = s.beginAttempt()
  if (busy) {
    res.status(429).json({
      error: busy.code === 'unlock_slowed' ? `Too many wrong passwords: try again in ${Math.ceil(busy.waitMs / 1000)} s.` : 'Another unlock is being checked; try again in a moment.',
      code: busy.code, waitMs: busy.waitMs,
    })
    return null
  }
  let outcome: 'ok' | 'wrong' | 'other' = 'other'
  try {
    const value = await work()
    outcome = 'ok'
    return { value }
  } catch (err) {
    if (err instanceof VaultError && err.code === 'wrong_password') outcome = 'wrong'
    throw err
  } finally {
    s.endAttempt(outcome)
  }
}

/**
 * With "agents may ask while you are away" off, the vault stays open on this server only
 * while some window has it unlocked: once the last one locks or goes idle, the key goes.
 */
export async function closeIfNobody(): Promise<void> {
  const s = await sessions()
  if (s.liveSessionCount() > 0 || s.isAttemptRunning()) return
  const st = await store()
  if (!st.isOpen()) return
  if ((await st.vaultStatus()).agentsWhileAway) return
  // Checked again with no await before the close: an unlock may have opened a window meanwhile.
  if (s.liveSessionCount() > 0 || s.isAttemptRunning()) return
  st.closeVault()
}

function clientName(req: Request): string {
  const c = (req.body as { client?: unknown } | undefined)?.client
  if (typeof c === 'string' && c.trim()) return c.trim()
  return String(req.headers['user-agent'] ?? 'browser').slice(0, 80)
}

vaultV1Router.get('/vault/status', async (req, res, next) => {
  if (!gate(req, res, true)) return
  await run(res, next, async () => {
    const s = await sessions()
    const unlocked = !!s.useSession(header(req, s.SESSION_HEADER))
    await closeIfNobody()
    const st = await (await store()).vaultStatus()
    return { ...st, unlocked, autoLockMinutes: await autoLockMinutes(), waitMs: s.unlockWaitMs(), privateLink: privateLink(req) }
  })
})

vaultV1Router.post('/vault/setup', async (req, res, next) => {
  if (!gate(req, res)) return
  await run(res, next, async () => {
    const st = await store()
    const body = (req.body ?? {}) as { kdf?: KdfParams; agentsWhileAway?: boolean }
    const kdf = body.kdf ?? st.defaultKdf()
    st.checkKdf(kdf)
    const minutes = await autoLockMinutes()
    const s = await sessions()
    const r = await attempt(res, async () => {
      const passwordKey = await passwordKeyOf(req, req.body ?? {}, kdf)
      const made = await st.setupVault({ passwordKey, kdf, agentsWhileAway: body.agentsWhileAway === true })
      return { ...made, session: s.createSession(clientName(req), minutes) }
    })
    return r ? r.value : SENT
  })
})

vaultV1Router.post('/vault/unlock', async (req, res, next) => {
  if (!gate(req, res)) return
  await run(res, next, async () => {
    const st = await store()
    const status = await st.vaultStatus()
    const body = (req.body ?? {}) as { secretKey?: string; kdfSalt?: string }
    // A window that read the KDF before another one changed the master password derives with
    // the old salt: tell it to read again instead of counting a wrong password.
    if (typeof body.kdfSalt === 'string' && status.kdf && body.kdfSalt !== status.kdf.salt) {
      throw new st.VaultError('The master password was changed in another window: try again.', 409, 'kdf_changed')
    }
    const s = await sessions()
    const minutes = await autoLockMinutes()
    // The session is made inside the check, so no close can run between the open and it.
    const r = await attempt(res, async () => {
      const passwordKey = await passwordKeyOf(req, req.body ?? {}, status.kdf)
      await st.unlockVault({ passwordKey, ...(typeof body.secretKey === 'string' && body.secretKey ? { secretKey: body.secretKey } : {}) })
      return { session: s.createSession(clientName(req), minutes) }
    })
    return r ? r.value : SENT
  })
})

vaultV1Router.post('/vault/lock', async (req, res, next) => {
  if (!gate(req, res)) return
  await run(res, next, async () => {
    const s = await sessions()
    let ended = 1
    if ((req.body as { all?: boolean } | undefined)?.all) {
      ended = s.endAllSessions()
      // Lock all also ends every agent grant and withdraws the asks still waiting.
      const { endAllGrants } = await import('../../core/vault/agent.js')
      const { endAgentAccess } = await import('./vault-agent-v1.js')
      await endAgentAccess(endAllGrants())
    } else s.endSession(header(req, s.SESSION_HEADER))
    await closeIfNobody()
    return { ended }
  })
})

vaultV1Router.get('/vault/items', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => ({ items: await (await store()).listItems() }))
})

vaultV1Router.post('/vault/items', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const [item] = await (await store()).createItems([(req.body as { item: VaultItemInput }).item])
    return { item }
  })
})

vaultV1Router.get('/vault/items/:id', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => ({ item: await (await store()).getItem(param(req.params.id)) }))
})

vaultV1Router.put('/vault/items/:id', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const body = req.body as { item: VaultItemInput; expectedUpdatedAt?: string }
    return { item: await (await store()).updateItem(param(req.params.id), body.item, body.expectedUpdatedAt) }
  })
})

for (const action of ['trash', 'restore', 'favorite', 'used'] as const) {
  vaultV1Router.post(`/vault/items/:id/${action}`, async (req, res, next) => {
    if (!gate(req, res) || !(await needSession(req, res))) return
    await run(res, next, async () => {
      const st = await store()
      const id = param(req.params.id)
      if (action === 'trash') return { item: await st.trashItem(id) }
      if (action === 'restore') return { item: await st.restoreItem(id) }
      if (action === 'favorite') return { item: await st.setFavorite(id, (req.body as { favorite?: boolean })?.favorite !== false) }
      await st.markUsed(id)
      return { ok: true }
    })
  })
}

vaultV1Router.delete('/vault/items/:id', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    await (await store()).deleteItem(param(req.params.id))
    return { ok: true }
  })
})

vaultV1Router.get('/vault/items/:id/totp', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res, false))) return
  await run(res, next, async () => {
    const st = await store()
    const item = await st.getItem(param(req.params.id))
    const { parseTotp, totpAt } = await import('../../core/vault/totp.js')
    const p = item.totp ? parseTotp(item.totp) : null
    if (!p) throw new st.VaultError('This item has no usable one-time code', 404, 'no_totp')
    return totpAt(p, Date.now())
  })
})

vaultV1Router.post('/vault/import', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const body = (req.body ?? {}) as { text?: string; format?: string; fileName?: string; dryRun?: boolean }
    const { parseImport, IMPORT_FORMATS } = await import('../../core/vault/import.js')
    const st = await store()
    if (typeof body.text !== 'string' || !body.text) throw new st.VaultError('text (the exported file) is required', 400, 'bad_import')
    const format = body.format && body.format in IMPORT_FORMATS ? body.format as keyof typeof IMPORT_FORMATS : undefined
    const parsed = parseImport(body.text, format, body.fileName)
    const existing = await st.allItems()
    const seen = new Set(existing.filter((i) => !i.trashedAt).map((i) => `${i.title}\0${i.username ?? ''}\0${i.password ?? ''}`))
    const fresh = parsed.items.filter((i) => !seen.has(`${i.title}\0${i.username ?? ''}\0${i.password ?? ''}`))
    const report = {
      format: parsed.format, found: parsed.items.length, duplicates: parsed.items.length - fresh.length, toAdd: fresh.length,
      skipped: parsed.skipped, passkeys: parsed.passkeys,
      byType: fresh.reduce<Record<string, number>>((m, i) => { m[i.type] = (m[i.type] ?? 0) + 1; return m }, {}),
    }
    if (body.dryRun !== false) return { dryRun: true, report }
    const made = await st.createItems(fresh)
    return { dryRun: false, report, added: made.length }
  })
})

vaultV1Router.get('/vault/report', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const { securityReport } = await import('../../core/vault/strength.js')
    return securityReport(await (await store()).allItems())
  })
})

vaultV1Router.post('/vault/settings', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const body = (req.body ?? {}) as { agentsWhileAway?: boolean }
    const st = await store()
    if (typeof body.agentsWhileAway === 'boolean') {
      const status = await st.vaultStatus()
      const r = await attempt(res, async () => st.setAgentsWhileAway(body.agentsWhileAway!, await passwordKeyOf(req, req.body ?? {}, status.kdf)))
      if (!r) return SENT
    }
    return st.vaultStatus()
  })
})

vaultV1Router.post('/vault/password', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const st = await store()
    const status = await st.vaultStatus()
    const body = (req.body ?? {}) as { oldPasswordKey?: string; oldPassword?: string; newPasswordKey?: string; newPassword?: string; kdf?: KdfParams }
    const kdf = body.kdf ?? st.defaultKdf()
    st.checkKdf(kdf)
    const r = await attempt(res, async () => {
      const oldPasswordKey = await passwordKeyOf(req, { passwordKey: body.oldPasswordKey, password: body.oldPassword }, status.kdf)
      const newPasswordKey = await passwordKeyOf(req, { passwordKey: body.newPasswordKey, password: body.newPassword }, kdf)
      await st.changeMasterPassword({ oldPasswordKey, newPasswordKey, kdf })
    })
    if (!r) return SENT
    const s = await sessions()
    return { ok: true, otherWindowsLocked: s.endOtherSessions(header(req, s.SESSION_HEADER)) }
  })
})

vaultV1Router.post('/vault/export', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const st = await store()
    const status = await st.vaultStatus()
    const body = (req.body ?? {}) as { format?: string }
    // An export is every secret in one file: the master password again, whatever the session.
    if (!await attempt(res, async () => st.revealSecretKey(await passwordKeyOf(req, req.body ?? {}, status.kdf)))) return SENT
    const { exportItems } = await import('../../core/vault/export.js')
    const format = body.format === 'json' ? 'json' : 'csv'
    return { format, fileName: `walnut-passwords-${new Date().toISOString().slice(0, 10)}.${format}`, text: exportItems(await st.allItems(), format) }
  })
})

vaultV1Router.post('/vault/secret-key', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const st = await store()
    const status = await st.vaultStatus()
    const r = await attempt(res, async () => st.revealSecretKey(await passwordKeyOf(req, req.body ?? {}, status.kdf)))
    return r ? { secretKey: r.value } : SENT
  })
})
