/**
 * Keeps the person's Passwords windows unlocked across a Walnut restart (docs/reference/passwords.md,
 * "Unlocking"). `sessions.json` (0600) beside vault.json holds each session a restart keeps (every
 * choice but "until restart"): the sha256 of its token (sessions.ts; the token itself is only in
 * the client), its client, device, limits and times, which boot of this computer wrote it, and an
 * HMAC under a key derived from the vault key, so a file written by anything that cannot open the
 * vault (or under a vault key a new master password replaced) restores nothing.
 *
 * Written on every create and end, and at most once a minute for use. At start (the first vault
 * route waits for it, `sessionsRestored`): sessions past their clock go; a file from another boot
 * (the computer restarted) restores nothing; if live ones remain, the vault reopens without the
 * person when it can (the machine key, or this Mac's keychain on the person's real Walnut,
 * keychain-unlock.ts), the HMAC is checked and they come back, else every one is dropped and the
 * windows show Unlock as before. An older Walnut never reads this file.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as S from './sessions.js'
import { dir, isOpen, openKey, readJson, writeAtomic, closeVault } from './state.js'

const FILE = 'sessions.json'
const FORMAT = 'walnut-vault-sessions'
/** Seconds two readings of the boot time may differ by (os.uptime is whole seconds, the clock may be stepped). */
const BOOT_SLACK_S = 60
const USE_WRITE_MS = 60_000

interface Boot { at: number; id?: string }
interface Stored { hash: string; client: string; createdAt: number; lastUsedAt: number; idleMs: number | null; maxMs: number | null; device?: string; choice?: string; here?: boolean; source?: string }
interface SelfLock { device: string; at: number }
/** `selfLocks`: when a device last locked only itself (sessions.ts joinSource); absent from an older Walnut's file. */
interface SessionsFile { format: typeof FORMAT; version: 1; vaultId?: string; boot?: Boot; savedAt: string; sessions: Stored[]; selfLocks?: SelfLock[]; mac?: string }

let enabled = false
let restoring: Promise<void> | null = null
let writing: Promise<void> = Promise.resolve()
let queued = false
let gen = 0
let useTimer: ReturnType<typeof setTimeout> | null = null
let lastWrite = 0
let bootOverride: Boot | null = null

let bootIdOnce: Promise<string | undefined> | null = null

/** The id the kernel gives this boot: Linux's boot_id, macOS's kern.bootsessionuuid (a child process, never a sync call). */
function bootId(): Promise<string | undefined> {
  bootIdOnce ??= (async () => {
    if (process.platform === 'darwin') {
      const { runVaultHelper } = await import('./child-run.js')
      const r = await runVaultHelper('sysctl', ['-n', 'kern.bootsessionuuid'], { timeoutMs: 5_000, maxBytes: 4096 })
      return r.code === 0 && /^[0-9A-F-]{36}$/i.test(r.stdout.trim()) ? r.stdout.trim() : undefined
    }
    return (await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || undefined
  })().catch(() => undefined)
  return bootIdOnce
}

/** This boot of the computer: its start time, and the kernel's id for it where there is one. */
async function bootNow(): Promise<Boot> {
  if (bootOverride) return bootOverride
  const at = Math.round(Date.now() / 1000 - os.uptime())
  const id = await bootId()
  return id ? { at, id } : { at }
}

function sameBoot(a: Boot, b: Boot): boolean {
  if (a.id || b.id) return a.id === b.id
  return typeof a.at === 'number' && Math.abs(a.at - b.at) <= BOOT_SLACK_S
}

function sign(key: Uint8Array, f: SessionsFile): string {
  const k = Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from(String(f.vaultId)), Buffer.from('walnut-vault-sessions-v1'), 32))
  // `selfLocks` joins the signed list only when present, so a file an older Walnut wrote (or reads) checks out as before.
  const signed = [f.format, f.version, f.vaultId, f.boot, f.savedAt, f.sessions, ...(f.selfLocks ? [f.selfLocks] : [])]
  return crypto.createHmac('sha256', k).update(JSON.stringify(signed)).digest('base64url')
}

function verify(key: Uint8Array, f: SessionsFile): boolean {
  if (typeof f.mac !== 'string') return false
  const want = Buffer.from(sign(key, f))
  const got = Buffer.from(f.mac)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

const toStored = (s: S.Session): Stored => ({
  hash: s.hash, client: s.client, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt,
  idleMs: Number.isFinite(s.idleMs) ? s.idleMs : null, maxMs: Number.isFinite(s.maxMs) ? s.maxMs : null,
  ...(s.device ? { device: s.device } : {}), ...(s.choice ? { choice: s.choice } : {}), ...(s.here ? { here: true } : {}),
  ...(s.source ? { source: s.source } : {}),
})

function fromStored(x: Stored): S.Session | null {
  if (!x || typeof x.hash !== 'string' || !/^[0-9a-f]{64}$/.test(x.hash) || typeof x.createdAt !== 'number' || typeof x.lastUsedAt !== 'number') return null
  const ms = (v: unknown) => (v === null ? Infinity : typeof v === 'number' && v > 0 ? v : NaN)
  const idleMs = ms(x.idleMs)
  const maxMs = ms(x.maxMs)
  if (Number.isNaN(idleMs) || Number.isNaN(maxMs)) return null
  return {
    hash: x.hash, client: String(x.client ?? '').slice(0, 80), createdAt: x.createdAt, lastUsedAt: x.lastUsedAt, idleMs, maxMs, keep: true,
    ...(typeof x.device === 'string' && x.device ? { device: x.device } : {}), ...(typeof x.choice === 'string' ? { choice: x.choice } : {}),
    ...(x.here === true ? { here: true } : {}),
    ...(typeof x.source === 'string' && /^[0-9a-f]{64}$/.test(x.source) ? { source: x.source } : {}),
  }
}

async function writeNow(): Promise<void> {
  const file = path.join(await dir(), FILE)
  const now = Date.now()
  const list = S.sessionList().filter((s) => s.keep !== false && S.live(s, now))
  let body: SessionsFile = { format: FORMAT, version: 1, savedAt: new Date(now).toISOString(), sessions: [] }
  if (list.length && isOpen()) {
    try {
      const { vaultId, key } = await openKey()
      // A device's own lock counts only against the unlocks it was made after: older records go.
      const oldest = Math.min(...list.map((s) => s.createdAt))
      const selfLocks = S.selfLockList().filter((l) => l.at >= oldest)
      body = { ...body, vaultId, boot: await bootNow(), sessions: list.map(toStored), ...(selfLocks.length ? { selfLocks } : {}) }
      body.mac = sign(key, body)
    } catch {
      body = { format: FORMAT, version: 1, savedAt: body.savedAt, sessions: [] }
    }
  }
  // Nothing to keep and no file yet (no vault, or nobody ever unlocked): write nothing.
  if (!body.sessions.length && !(await fsp.stat(file).then(() => true, () => false))) return
  await writeAtomic(file, body)
  lastWrite = Date.now()
}

function queueWrite(): void {
  if (queued) return // the queued write reads the newest sessions when it runs
  queued = true
  const g = gen
  writing = writing.then(async () => {
    queued = false
    if (g === gen) await writeNow()
  }).catch(async (err) => {
    const { log } = await import('../../logging/index.js')
    log.web.warn('passwords: could not keep the open windows for a restart', { error: (err as Error).message })
  })
}

function changed(kind: 'change' | 'use'): void {
  if (!enabled) return
  if (kind === 'change') { queueWrite(); return }
  if (useTimer) return
  useTimer = setTimeout(() => { useTimer = null; queueWrite() }, Math.max(0, lastWrite + USE_WRITE_MS - Date.now()))
  useTimer.unref?.()
}

/** Write the kept windows now (a Lock, a new vault key). A write that fails removes the file: what
 *  it still lists must not come back after a restart. */
export async function saveSessionsNow(): Promise<void> {
  if (!enabled) return
  if (useTimer) { clearTimeout(useTimer); useTimer = null }
  const g = gen
  const run = writing.then(async () => { if (g === gen) await writeNow() })
  writing = run.catch(() => undefined)
  try {
    await run
  } catch (err) {
    await fsp.rm(path.join(await dir(), FILE), { force: true }).catch(() => undefined)
    const { log } = await import('../../logging/index.js')
    log.web.warn('passwords: could not write the open windows, so none is kept for a restart', { error: (err as Error).message })
  }
}

/** The first start of this version keeps an older install's idle lock (unlock-migrate.ts). */
async function keepOldIdle(): Promise<void> {
  await (await import('./unlock-migrate.js')).keepOldIdleLock().catch(() => false)
}

/** Whether a restore may read this Mac's keychain: the person's real Walnut, or a test that stubs it. */
async function keychainAllowed(): Promise<boolean> {
  const kc = await import('./keychain-unlock.js')
  if (!kc.keychainAvailable()) return false
  if (kc.keychainForcedForTest()) return true
  return (await import('./background.js')).realVault()
}

/** What happened at start (for tests and the log). */
export type RestoreOutcome = 'none' | 'restored' | 'other_boot' | 'expired' | 'cannot_reopen' | 'bad_mac' | 'failed'
let lastOutcome: RestoreOutcome = 'none'

async function restore(): Promise<RestoreOutcome> {
  const f = await readJson<SessionsFile>(path.join(await dir(), FILE)).catch(() => null)
  if (!f || f.format !== FORMAT || f.version !== 1 || !Array.isArray(f.sessions) || !f.sessions.length) return 'none'
  if (!f.boot || !sameBoot(f.boot, await bootNow())) return 'other_boot'
  const now = Date.now()
  const list = f.sessions.map(fromStored).filter((s): s is S.Session => !!s && S.live(s, now))
  if (!list.length) return 'expired'
  let macBad = false
  const install = async (): Promise<boolean> => {
    const k = await openKey().catch(() => null)
    if (!k || k.vaultId !== f.vaultId || !verify(k.key, f)) { macBad = !!k; return false }
    // Before the sessions, so no status or join is answered without them (they are checked together).
    if (Array.isArray(f.selfLocks)) S.restoreSelfLocks(f.selfLocks.filter((l) => l && typeof l.device === 'string' && typeof l.at === 'number'))
    S.restoreSessions(list)
    return true
  }
  const st = await import('./store.js')
  const status = await st.vaultStatus() // opens the vault with the machine key when that is on
  if (!status.setUp) return 'cannot_reopen'
  let ok = false
  if (st.isOpen()) ok = await install()
  else if (await keychainAllowed()) {
    const kc = await import('./keychain-unlock.js')
    if (await kc.keychainItemPresent()) {
      const r = await kc.reopenFromKeychain(install)
      ok = r.ok && r.value
      // Opened for nothing (the file did not check out): close again, as the last window going would.
      if (r.ok && !ok && S.liveSessionCount() === 0 && !status.agentsWhileAway) closeVault()
    }
  }
  if (!ok) return macBad ? 'bad_mac' : 'cannot_reopen'
  // A choice changed while Walnut was down applies to the windows it kept.
  const { getConfig } = await import('../config-manager.js')
  const { unlockChoice } = await import('./unlock-length.js')
  S.retimeSessions(unlockChoice((await getConfig()).passwords, status.agentsWhileAway).limits)
  // A shorter choice may have ended every one: the vault this restore opened closes, as a Lock would.
  if (S.liveSessionCount() === 0) {
    if (!S.isAttemptRunning() && !status.agentsWhileAway && isOpen()) closeVault()
    return 'expired'
  }
  return 'restored'
}

/** The sessions a restart kept are back (or were dropped): every vault route waits for it before reading one. */
export function sessionsRestored(): Promise<void> {
  restoring ??= keepOldIdle().then(restore).catch(() => 'failed' as const).then(async (outcome) => {
    lastOutcome = outcome
    enabled = true
    queueWrite() // the file now says what is kept: expired, dropped and other-boot sessions go
    if (outcome !== 'none' && outcome !== 'restored') {
      const { log } = await import('../../logging/index.js').catch(() => ({ log: null }))
      log?.web.info('passwords: windows from before the restart stay locked', { outcome })
    }
  })
  return restoring
}

S.setSessionStoreHook({
  changed,
  // A test reset: memory is fresh, nothing to restore, nothing still to write.
  reset: () => { gen++; queued = false; if (useTimer) { clearTimeout(useTimer); useTimer = null }; restoring = Promise.resolve() },
})

// ── tests ──

/** Tests: what the last restore did. */
export function lastRestoreForTest(): RestoreOutcome {
  return lastOutcome
}

/** Tests: wait for the writes already asked for. */
export async function flushSessionStoreForTest(): Promise<void> {
  if (useTimer) { clearTimeout(useTimer); useTimer = null; queueWrite() }
  await writing
}

/** Tests: act as a Walnut restart (memory gone, the vault closed, the file kept); the next vault route restores. */
export async function simulateRestartForTest(): Promise<void> {
  await flushSessionStoreForTest()
  S.resetSessionsForTest()
  closeVault()
  enabled = false
  lastOutcome = 'none'
  restoring = null
}

/** Tests: act as another boot of the computer (null: the real one). */
export function setBootForTest(b: Boot | null): void {
  bootOverride = b
}
