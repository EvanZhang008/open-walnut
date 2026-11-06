/**
 * Passwords (core/vault/, docs/reference/passwords.md): a person's own use of the vault.
 *
 *   GET    /api/v1/vault/status                    → status (+ `unlocked` for this request's session)
 *   POST   /api/v1/vault/setup                     { passwordKey | password, kdf, agentsWhileAway, hint? } → { secretKey, recoveryCode, session }
 *   POST   /api/v1/vault/unlock                    { passwordKey | password, secretKey?, client? } → { session, browserKey? }
 *   POST   /api/v1/vault/recover                   { recoveryCode, secretKey?, newPasswordKey | newPassword, kdf, hint? } → { secretKey, recoveryCode, session }
 *   POST   /api/v1/vault/join                      → { session }  (this computer's extension or a Walnut window here, sharing an unlock made here)
 *   POST   /api/v1/vault/lock                      { all? | everywhere? } → { ended }  (none: this window; everywhere: every window; all: and every agent grant)
 *   GET    /api/v1/vault/items                     → { items: summaries }       (session)
 *   POST   /api/v1/vault/items                     { item } → { item }          (session)
 *   GET    /api/v1/vault/items/:id                 → { item }                   (session)
 *   PUT    /api/v1/vault/items/:id                 { item, expectedUpdatedAt? } (session)
 *   POST   /api/v1/vault/items/:id/{trash,restore,favorite,used}                (session)
 *   DELETE /api/v1/vault/items/:id                 (session; only from the trash)
 *   GET    /api/v1/vault/items/:id/totp            → { code, period, remaining } (session)
 *   POST   /api/v1/vault/passkeys/match            { origin, rpId?, allow? } → { passkeys }        (session, quiet)
 *   POST   /api/v1/vault/passkeys/create           { origin, rpId?, rpName?, user, clientDataJSON, exclude?, itemId? } (session)
 *   POST   /api/v1/vault/passkeys/assert           { origin, rpId?, credentialId, clientDataJSON } → signature (session)
 *   POST   /api/v1/vault/import                    { text, format?, fileName?, dryRun } (session)
 *   GET    /api/v1/vault/report                    → security report            (session)
 *   POST   /api/v1/vault/settings                  { agentsWhileAway, passwordKey | password } → status + recoveryKit? (session)
 *   POST   /api/v1/vault/secret-key                { passwordKey | password } → { secretKey } (session)
 *   POST   /api/v1/vault/recovery-kit              { passwordKey | password } → { secretKey, recoveryCode } (session; a new code)
 *   POST   /api/v1/vault/recovery-kit/confirm      → { ok } (session; the person saved the newest kit)
 *   POST   /api/v1/vault/password                  { oldPasswordKey, newPasswordKey, kdf, hint? } → { ok, recoveryKit? } (session)
 *   PUT    /api/v1/vault/hint                      { hint, passwordKey | password } → { ok, hint? } (session; hint "" removes it, no password)
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
import { isOnBehalfOfRemote, requestOrigin } from '../middleware/request-origin.js'
import { classifyLocalRequest } from '../middleware/local-trust.js'
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN } from '../../lib/caller-origin.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'
import { isFollower, role } from '../../core/server-role.js'
import { ambientTestRun } from '../../core/test-run.js'
import { onCredentialsRevoked } from '../../core/device-auth.js'
import { currentExposeStatus } from '../../core/expose/status.js'
import { derivePasswordKey, toB64, type KdfParams } from '../../core/vault/crypto.js'
import type { VaultItem, VaultItemInput } from '../../core/vault/types.js'

export const vaultV1Router = Router()

/** A Walnut window's browser key (core/vault/browser-keys.ts BROWSER_HEADER; kept here so the route loads no vault module at start). */
const BROWSER_HEADER = 'x-walnut-vault-browser'

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
export function gate(req: Request, res: Response, readStatus = false): boolean {
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
    // A changed "Keep Passwords unlocked" applies to the windows open now (a shorter one may lock them).
    const { onConfigWritten } = await import('../../core/config-store.js')
    onConfigWritten(() => { void unlockLength().then((u) => s.retimeSessions(u.limits)).catch(() => undefined) })
  }
  // The windows a Walnut restart kept are back before any of them is read (core/vault/session-store.ts).
  await (await import('../../core/vault/session-store.js')).sessionsRestored()
  return s
}

// A device removed (Settings, `walnut device revoke`): every vault unlock it holds ends with it.
onCredentialsRevoked((names) => {
  void import('../../core/vault/sessions.js').then((s) => { for (const n of names) s.endDeviceSessions(n) }).catch(() => undefined)
})

async function store() {
  return import('../../core/vault/store.js')
}

/** The person's vault session for this request, or a 401 answered. */
async function needSession(req: Request, res: Response, touch = true): Promise<boolean> {
  const s = await sessions()
  // `x-walnut-vault-quiet: 1`: a read a client makes by itself (the browser extension looking up
  // a page's logins as the person browses) never keeps the vault unlocked.
  const quiet = header(req, 'x-walnut-vault-quiet') === '1'
  if (s.useSession(header(req, s.SESSION_HEADER), touch && !quiet, deviceOf(req))) return true
  res.status(401).json({ error: 'The vault is locked in this window: unlock it with the master password.', code: 'vault_session_needed' })
  return false
}

/** A new vault keeps windows unlocked 48 hours, written down (an install with no choice keeps the old idle lock); a choice already made stays. */
async function writeNewVaultUnlockLength(): Promise<void> {
  const { getConfig, updateConfig } = await import('../../core/config-manager.js')
  const { NEW_VAULT_UNLOCK_FOR } = await import('../../core/vault/unlock-length.js')
  const cur = (await getConfig()).passwords ?? {}
  if (cur.unlock_for) return
  await updateConfig({ passwords: { ...cur, unlock_for: NEW_VAULT_UNLOCK_FOR } })
}

/** "Keep Passwords unlocked" in effect (core/vault/unlock-length.ts): the session limits and what the status reports. */
async function unlockLength(machineKeyOn?: boolean) {
  const { getConfig } = await import('../../core/config-manager.js')
  const { unlockChoice } = await import('../../core/vault/unlock-length.js')
  const away = machineKeyOn ?? (await (await store()).vaultStatus()).agentsWhileAway
  return unlockChoice((await getConfig()).passwords, away)
}

/** An item as a client gets it: its passkeys without their private keys, which never leave Walnut. */
async function shown(item: VaultItem | null): Promise<VaultItem | null> {
  if (!item?.passkeys?.length) return item
  const { publicPasskey } = await import('../../core/vault/passkey.js')
  return { ...item, passkeys: item.passkeys.map(publicPasskey) }
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
    const { PasskeyError } = await import('../../core/vault/passkey.js')
    if (err instanceof PasskeyError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    next(err)
  }
}

/**
 * The client's password key, or the server derives it from a typed password: a browser
 * on plain http (not a secure context) has no WebCrypto, so it sends the password itself.
 */
async function passwordKeyOf(req: Request, body: { passwordKey?: unknown; password?: unknown }, kdf: KdfParams | undefined): Promise<string> {
  const { VaultError, checkKdf } = await store()
  // A derived key replays as the password wherever this Mac holds the Secret Key: it crosses
  // only the same private links a typed password does.
  if (typeof body.passwordKey === 'string' && body.passwordKey) {
    if (!keyLink(req)) throw new VaultError('Open Walnut over https or Tailscale to unlock Passwords from this device: plain http would send your unlock readable on the network.', 400, 'insecure_link')
    return body.passwordKey
  }
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
 * The master password hint sent with a password (core/vault/hint.ts), refused (400 bad_hint) when
 * it gives the password away. Undefined or '' means none. With only the key, the server can tell
 * just a hint that IS the password; the page that has the password checks the rest first.
 */
async function checkedHint(raw: unknown, password: unknown, passwordKey: string, kdf: KdfParams): Promise<string | undefined> {
  const { readHint, hintProblem, hintIsPasswordKey } = await import('../../core/vault/hint.js')
  const hint = readHint(raw)
  if (!hint) return hint
  const problem = hintProblem(hint, typeof password === 'string' ? password : undefined)
    ?? (await hintIsPasswordKey(hint, passwordKey, kdf) ? hintProblem(hint, hint) : null)
  if (problem) throw new (await store()).VaultError(problem, 400, 'bad_hint')
  return hint
}

/**
 * Nobody else reads this link: https here, this machine (a local proxy such as Tailscale Serve
 * included, and a loopback caller on another origin), Walnut's own tunnel while its public
 * address is https, or Tailscale's own addresses. A forwarded-proto header is not trusted here:
 * any client can send one, and a plain relay passes it on.
 */
function privateLink(req: Request): boolean {
  // A loopback self-call made for a caller off this machine is that caller's link, not this one.
  if (isOnBehalfOfRemote(req)) return false
  if (req.secure) return true
  // This machine, by the caller-origin rule.
  if (requestOrigin(req) === LOCAL_ORIGIN) return true
  // A page or extension on this machine: a loopback connection with no proxy header, addressed
  // to a loopback name, from another origin (the browser extension). Its bytes never left this
  // machine. A loopback request addressed to another name is not: that is how a header-less
  // relay (socat, an ssh gateway port) from the network looks.
  const t = classifyLocalRequest(req)
  if (!t.trusted && t.reason === 'foreign-origin') return true
  // Walnut's own tunnel (a loopback connection on its port), while what it publishes is https:
  // https from the browser to its edge, then this machine's loopback (or a host server's way back).
  if (!t.trusted && t.reason === 'tunnel-port') {
    const st = currentExposeStatus()
    if (st.url?.startsWith('https://') && (st.port === req.socket.localPort || st.runsOn)) return true
  }
  const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
  const m = /^100\.(\d+)\./.exec(ip)
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true // Tailscale's 100.64.0.0/10
  return /^fd7a:115c:a1e0:/i.test(ip)
}

/**
 * A key the client derived (it never sends the password) may also come through the person's own
 * TLS proxy on this machine (Caddy, nginx: loopback, a forwarded proto of https). Only a page in
 * a secure context derives one, so a browser behind a plain-http relay never sends a key; a typed
 * password through the same proxy is still refused, since a browser that types one is on http.
 */
function keyLink(req: Request): boolean {
  if (isOnBehalfOfRemote(req)) return false
  if (privateLink(req)) return true
  // A loopback connection off the tunnel's port that carries proxy headers: a proxy on this machine.
  const t = classifyLocalRequest(req)
  if (t.trusted || t.reason !== 'proxied') return false
  const proto = req.headers['x-forwarded-proto']
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https'
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
    if (err instanceof VaultError && (err.code === 'wrong_password' || err.code === 'wrong_recovery_code')) outcome = 'wrong'
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

/**
 * The paired device a request came with (its token), if any (auth middleware). Every read of a
 * vault session passes it: a session a device opened holds only for that device.
 */
export function deviceOf(req: Request): string | undefined {
  return (req as Request & { deviceName?: string }).deviceName
}

/**
 * The request came over this computer's own network path: a loopback connection with no proxy
 * header, addressed to a loopback name, off the tunnel's port, from Walnut's own page or another
 * origin (the browser extension), and no session made it. An unlock made so is the person's on
 * this computer, which this computer's extension and Walnut windows may share (POST /vault/join). Known limit, the
 * one local-trust.ts names: a forward that adds no proxy header looks the same.
 */
function fromThisComputer(req: Request): boolean {
  if (header(req, 'x-walnut-caller-sid') || isOnBehalfOfRemote(req)) return false
  const t = classifyLocalRequest(req)
  return t.trusted || t.reason === 'foreign-origin'
}

/**
 * An unlock the person made in a browser on this computer (a Walnut window, the Mac app's page,
 * an extension: each sends its Origin), which this computer's extension and windows may share. A request with
 * no Origin (a script, the CLI) is not a window, and shares nothing.
 */
function unlockedHere(req: Request): boolean {
  return typeof req.headers.origin === 'string' && fromThisComputer(req)
}

/** A paired Walnut browser extension (browser-pair.ts names its device `extension-<hex>`). */
const EXTENSION_DEVICE = /^extension-[0-9a-f]+$/

/** This computer's extension, which may share an unlock made here with its device token. */
function joiningDevice(req: Request): string | null {
  const device = deviceOf(req)
  return device && EXTENSION_DEVICE.test(device) && fromThisComputer(req) ? device : null
}

/**
 * A Walnut window on this computer: Walnut's own page (its own Origin; a same-origin GET sends
 * none) over this computer's own path (local-trust.ts: loopback, no proxy header, a loopback Host,
 * off the tunnel's port), with no session's or automation's mark and no device token (a browser
 * here holds none; one that does is a paired device from elsewhere). A local process can send all
 * of that too, so this alone shares nothing: a window also needs its browser key (joiningWindow).
 */
function walnutWindowHere(req: Request): boolean {
  if (header(req, 'x-walnut-caller-sid') || header(req, CALLER_KIND_HEADER) || isOnBehalfOfRemote(req) || deviceOf(req)) return false
  return classifyLocalRequest(req).trusted
}

/**
 * A Walnut window here that may share an unlock made on this computer: it presents a browser key
 * this vault issued to it when the person typed the master password in it (core/vault/browser-keys.ts).
 * Only read while the vault is open (it is whenever there is an unlock to share).
 */
async function joiningWindow(req: Request): Promise<{ joiner: string; key: string } | null> {
  if (!walnutWindowHere(req) || !(await store()).isOpen()) return null
  const key = header(req, BROWSER_HEADER)
  const { knownBrowser } = await import('../../core/vault/browser-keys.js')
  const joiner = await knownBrowser(key)
  return joiner && key ? { joiner, key } : null
}

/** The window's own auto-lock is kept against its browser key's id (no need to know the key: a lock only ever withholds). */
async function windowSelfLock(req: Request): Promise<string | undefined> {
  const key = header(req, BROWSER_HEADER)
  if (!walnutWindowHere(req)) return undefined
  const { browserKeyShape, windowJoiner } = await import('../../core/vault/browser-keys.js')
  return browserKeyShape(key) ? windowJoiner(key) : undefined
}

/**
 * A new master password (or a recovery): no unlock made before it is shared with any window or
 * extension (sessions.endJoinsBefore), and every browser key ends, so a browser that was let in
 * before types the new password once (the window making the change gets a new key: browserKeyFor
 * after this). `epoch: false`: the caller set the epoch itself (a recovery, before its own unlock).
 */
async function endSharing(opts: { epoch?: boolean } = {}): Promise<void> {
  const s = await sessions()
  if (opts.epoch !== false) s.endJoinsBefore()
  const { forgetAllBrowsers } = await import('../../core/vault/browser-keys.js')
  // The password is changed already: a failed write still leaves no old unlock shareable (the epoch).
  await forgetAllBrowsers().catch(async (err) => {
    const { log } = await import('../../logging/index.js')
    log.web.warn('passwords: could not forget the browsers let in before the new master password', { error: (err as Error).message })
  })
  await (await import('../../core/vault/session-store.js')).saveSessionsNow()
}

/**
 * The person typed the master password in a Walnut window on this computer (setup, unlock,
 * recovery): the browser key that lets this browser share a later unlock made here. Nothing for a
 * script (no Origin), the extension (its device token is its secret), or any caller from elsewhere.
 */
async function browserKeyFor(req: Request): Promise<{ browserKey?: string }> {
  if (!unlockedHere(req) || !walnutWindowHere(req)) return {}
  const { issueBrowserKey } = await import('../../core/vault/browser-keys.js')
  const browserKey = await issueBrowserKey(header(req, BROWSER_HEADER), clientName(req))
  return browserKey ? { browserKey } : {}
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
    // A status a client reads by itself (x-walnut-vault-quiet: a page checking it is still unlocked) is no use.
    const unlocked = !!s.useSession(header(req, s.SESSION_HEADER), header(req, 'x-walnut-vault-quiet') !== '1', deviceOf(req))
    await closeIfNobody()
    const st = await (await store()).vaultStatus()
    const u = await unlockLength(st.agentsWhileAway)
    // This computer's extension, or a Walnut window here, locked while the person has Passwords
    // unlocked on this computer: it may share that unlock.
    const device = unlocked ? null : joiningDevice(req)
    let canJoin = !!device && !!s.joinSource(device)
    if (!unlocked && !device) {
      const w = await joiningWindow(req)
      canJoin = !!w && !!s.joinSource(w.joiner)
    }
    return { ...st, unlocked, ...(canJoin ? { canJoin } : {}), autoLockMinutes: u.autoLockMinutes, unlockFor: u.unlockFor, lockAfterIdleMinutes: u.lockAfterIdleMinutes, waitMs: s.unlockWaitMs(), privateLink: privateLink(req) }
  })
})

vaultV1Router.post('/vault/setup', async (req, res, next) => {
  if (!gate(req, res)) return
  await run(res, next, async () => {
    const st = await store()
    const body = (req.body ?? {}) as { kdf?: KdfParams; agentsWhileAway?: boolean; hint?: unknown; password?: unknown }
    const kdf = body.kdf ?? st.defaultKdf()
    st.checkKdf(kdf)
    const s = await sessions()
    const r = await attempt(res, async () => {
      const passwordKey = await passwordKeyOf(req, req.body ?? {}, kdf)
      const hint = await checkedHint(body.hint, body.password, passwordKey, kdf)
      const made = await st.setupVault({ passwordKey, kdf, agentsWhileAway: body.agentsWhileAway === true, hint })
      await writeNewVaultUnlockLength()
      const minutes = (await unlockLength()).limits
      return { ...made, session: s.createSession(clientName(req), minutes, deviceOf(req), unlockedHere(req)) }
    })
    return r ? { ...r.value, ...(await browserKeyFor(req)) } : SENT
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
    const minutes = (await unlockLength()).limits
    // The session is made inside the check, so no close can run between the open and it.
    const r = await attempt(res, async () => {
      const passwordKey = await passwordKeyOf(req, req.body ?? {}, status.kdf)
      await st.unlockVault({ passwordKey, ...(typeof body.secretKey === 'string' && body.secretKey ? { secretKey: body.secretKey } : {}) })
      return { session: s.createSession(clientName(req), minutes, deviceOf(req), unlockedHere(req)) }
    })
    return r ? { ...r.value, ...(await browserKeyFor(req)) } : SENT
  })
})

/**
 * One unlock for this computer: the browser extension on the computer Walnut runs on, or a Walnut
 * window there (the /passwords page, the Mac app's page), locked while the person has Passwords
 * unlocked on this computer (in a Walnut window, or a browser's extension), gets a session of its
 * own sharing that unlock, with no password (sessions.joinSession: on the same clocks, so it never
 * lasts longer). The extension proves itself with its device token, a window with the browser key
 * it got when the person typed the master password in it (a page and a local process look the same
 * otherwise). Nothing else may: a browser elsewhere, a phone, a tunnel or a session (gate). A Lock
 * ends it with the rest; one that locked only itself shares nothing until the person unlocks again.
 */
vaultV1Router.post('/vault/join', async (req, res, next) => {
  if (!gate(req, res)) return
  await run(res, next, async () => {
    const s = await sessions()
    const device = joiningDevice(req)
    // A window's POST always carries its Origin: a request without one is no window.
    const asWindow = !device && typeof req.headers.origin === 'string' && walnutWindowHere(req)
    // Passwords closed everywhere: nothing to share, whoever asks (no key can be checked, none is needed).
    if (asWindow && !(await store()).isOpen()) {
      res.status(409).json({ error: 'Passwords is locked: unlock it with the master password.', code: 'nothing_to_join' })
      return SENT
    }
    const win = asWindow ? await joiningWindow(req) : null
    if (!device && !win) {
      res.status(403).json({ error: 'Only the Walnut extension, or a Walnut window that unlocked before, on the computer Walnut runs on shares an unlock: unlock with the master password.', code: 'join_refused' })
      return SENT
    }
    const session = device ? s.joinSession(device, clientName(req)) : s.joinSession(win!.joiner, clientName(req), 'window')
    if (!session) {
      res.status(409).json({ error: 'Passwords is locked: unlock it with the master password.', code: 'nothing_to_join' })
      return SENT
    }
    if (win) void import('../../core/vault/browser-keys.js').then((b) => b.touchBrowser(win.key)).catch(() => undefined)
    return { session }
  })
})

vaultV1Router.post('/vault/lock', async (req, res, next) => {
  if (!gate(req, res)) return
  await run(res, next, async () => {
    const s = await sessions()
    let ended = 1
    const body = (req.body ?? {}) as { all?: boolean; everywhere?: boolean }
    if (body.all) {
      ended = s.endAllSessions()
      // Lock all also ends every agent grant and withdraws the asks still waiting.
      const { endAllGrants } = await import('../../core/vault/agent.js')
      const { endAgentAccess } = await import('./vault-agent-v1.js')
      await endAgentAccess(endAllGrants())
    } else if (body.everywhere) {
      // A person's Lock (a window's Lock button): every window and the extension lock with it.
      // No body is one window only, what an older client (and an auto-lock) means by it.
      ended = s.endAllSessions()
    } else s.endSession(header(req, s.SESSION_HEADER), deviceOf(req) ?? await windowSelfLock(req))
    // Written before the answer: a restart right after a Lock must not bring the windows back.
    await (await import('../../core/vault/session-store.js')).saveSessionsNow()
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
    return { item: await shown(item) }
  })
})

vaultV1Router.get('/vault/items/:id', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => ({ item: await shown(await (await store()).getItem(param(req.params.id))) }))
})

vaultV1Router.put('/vault/items/:id', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const body = req.body as { item: VaultItemInput; expectedUpdatedAt?: string }
    return { item: await shown(await (await store()).updateItem(param(req.params.id), body.item, body.expectedUpdatedAt)) }
  })
})

for (const action of ['trash', 'restore', 'favorite', 'used'] as const) {
  vaultV1Router.post(`/vault/items/:id/${action}`, async (req, res, next) => {
    if (!gate(req, res) || !(await needSession(req, res))) return
    await run(res, next, async () => {
      const st = await store()
      const id = param(req.params.id)
      if (action === 'trash') return { item: await shown(await st.trashItem(id)) }
      if (action === 'restore') return { item: await shown(await st.restoreItem(id)) }
      if (action === 'favorite') return { item: await shown(await st.setFavorite(id, (req.body as { favorite?: boolean })?.favorite !== false)) }
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

// ── passkeys (core/vault/passkey-store.ts): the browser extension signs in and registers with them ──

vaultV1Router.post('/vault/passkeys/match', async (req, res, next) => {
  // Looked up as the person browses (a site asking for a passkey): quiet, like the logins of a page.
  if (!gate(req, res) || !(await needSession(req, res, false))) return
  await run(res, next, async () => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const { matchPasskeys } = await import('../../core/vault/passkey-store.js')
    return { passkeys: await matchPasskeys({ origin: b.origin, rpId: b.rpId, allow: b.allow }) }
  })
})

vaultV1Router.post('/vault/passkeys/create', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const { createPasskey } = await import('../../core/vault/passkey-store.js')
    return createPasskey((req.body ?? {}) as Parameters<typeof createPasskey>[0])
  })
})

vaultV1Router.post('/vault/passkeys/assert', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const { signInWithPasskey } = await import('../../core/vault/passkey-store.js')
    return signInWithPasskey((req.body ?? {}) as Parameters<typeof signInWithPasskey>[0])
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
    let kit: Awaited<ReturnType<typeof st.setAgentsWhileAway>>['kit']
    if (typeof body.agentsWhileAway === 'boolean') {
      const status = await st.vaultStatus()
      const r = await attempt(res, async () => st.setAgentsWhileAway(body.agentsWhileAway!, await passwordKeyOf(req, req.body ?? {}, status.kdf)))
      if (!r) return SENT
      kit = r.value.kit
      // The limits the machine key gave may be gone, and the kept windows are sealed under the new vault key now.
      const s = await sessions()
      s.retimeSessions((await unlockLength()).limits)
      await (await import('../../core/vault/session-store.js')).saveSessionsNow()
    }
    // A new vault key came with a new recovery code: the person must get the new kit now.
    return { ...(await st.vaultStatus()), ...(kit ? { recoveryKit: kit } : {}) }
  })
})

vaultV1Router.post('/vault/password', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const st = await store()
    const status = await st.vaultStatus()
    const body = (req.body ?? {}) as { oldPasswordKey?: string; oldPassword?: string; newPasswordKey?: string; newPassword?: string; kdf?: KdfParams; hint?: unknown }
    const kdf = body.kdf ?? st.defaultKdf()
    st.checkKdf(kdf)
    const r = await attempt(res, async () => {
      const oldPasswordKey = await passwordKeyOf(req, { passwordKey: body.oldPasswordKey, password: body.oldPassword }, status.kdf)
      const newPasswordKey = await passwordKeyOf(req, { passwordKey: body.newPasswordKey, password: body.newPassword }, kdf)
      const hint = await checkedHint(body.hint, body.newPassword, newPasswordKey, kdf)
      return st.changeMasterPassword({ oldPasswordKey, newPasswordKey, kdf, hint })
    })
    if (!r) return SENT
    const s = await sessions()
    // A new master password ends every agent grant too.
    const { endAllGrants } = await import('../../core/vault/agent.js')
    const { endAgentAccess } = await import('./vault-agent-v1.js')
    await endAgentAccess(endAllGrants())
    const otherWindowsLocked = s.endOtherSessions(header(req, s.SESSION_HEADER))
    await endSharing()
    return { ok: true, otherWindowsLocked, ...(r.value.kit ? { recoveryKit: r.value.kit } : {}), ...(await browserKeyFor(req)) }
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

/**
 * A forgotten master password: the recovery code opens the vault once, under the same brake as
 * the password, and sets a new one. Every window and every agent grant ends, as with Lock all.
 */
vaultV1Router.post('/vault/recover', async (req, res, next) => {
  if (!gate(req, res)) return
  await run(res, next, async () => {
    const st = await store()
    const body = (req.body ?? {}) as { recoveryCode?: unknown; secretKey?: unknown; newPasswordKey?: string; newPassword?: string; kdf?: KdfParams; hint?: unknown }
    const kdf = body.kdf ?? st.defaultKdf()
    st.checkKdf(kdf)
    if (typeof body.recoveryCode !== 'string' || !body.recoveryCode.trim()) throw new st.VaultError('recoveryCode (from your recovery kit) is required', 400, 'bad_recovery_code')
    // The code opens the vault by itself on this machine: it crosses only a link nobody else reads.
    if (!privateLink(req)) throw new st.VaultError('Open Walnut over https or Tailscale to use a recovery code from this device: plain http would send it readable on the network.', 400, 'insecure_link')
    const s = await sessions()
    const minutes = (await unlockLength()).limits
    const r = await attempt(res, async () => {
      const newPasswordKey = await passwordKeyOf(req, { passwordKey: body.newPasswordKey, password: body.newPassword }, kdf)
      const hint = await checkedHint(body.hint, body.newPassword, newPasswordKey, kdf)
      const kit = await st.recoverVault({
        recoveryCode: body.recoveryCode as string, newPasswordKey, kdf, hint,
        ...(typeof body.secretKey === 'string' && body.secretKey.trim() ? { secretKey: body.secretKey.trim() } : {}),
      })
      // Inside the attempt, as unlock does: closeIfNobody must not close the vault before this window holds its session.
      s.endAllSessions()
      // Nothing from before is shared; this unlock, the first with the new password, is.
      s.endJoinsBefore(Date.now() - 1)
      return { ...kit, session: s.createSession(clientName(req), minutes, deviceOf(req), unlockedHere(req)) }
    })
    if (!r) return SENT
    await endSharing({ epoch: false })
    const { endAllGrants } = await import('../../core/vault/agent.js')
    const { endAgentAccess } = await import('./vault-agent-v1.js')
    await endAgentAccess(endAllGrants())
    return { ...r.value, ...(await browserKeyFor(req)) }
  })
})

vaultV1Router.post('/vault/recovery-kit', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const st = await store()
    const status = await st.vaultStatus()
    const r = await attempt(res, async () => st.newRecoveryKit(await passwordKeyOf(req, req.body ?? {}, status.kdf)))
    return r ? r.value : SENT
  })
})

vaultV1Router.post('/vault/recovery-kit/confirm', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    await (await store()).confirmRecoveryKit()
    return { ok: true }
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

/** Change the master password hint (the master password again, so it can be checked against it), or remove it. */
vaultV1Router.put('/vault/hint', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const st = await store()
    const { readHint } = await import('../../core/vault/hint.js')
    const body = (req.body ?? {}) as { hint?: unknown; password?: unknown }
    const hint = readHint(body.hint)
    if (hint === undefined) throw new st.VaultError('hint is required ("" removes it)', 400, 'bad_hint')
    if (hint) {
      const status = await st.vaultStatus()
      const r = await attempt(res, async () => {
        const passwordKey = await passwordKeyOf(req, req.body ?? {}, status.kdf)
        await st.revealSecretKey(passwordKey)
        await st.setVaultHint((await checkedHint(hint, body.password, passwordKey, status.kdf!))!)
      })
      if (!r) return SENT
    } else await st.setVaultHint('')
    return { ok: true, ...(hint ? { hint } : {}) }
  })
})
