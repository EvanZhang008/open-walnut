/**
 * Walnut running the Bitwarden CLI itself (bitwarden-sync.ts does the sync): "Sync now" in
 * Settings, and the daily sync at 04:00 local on the primary while `passwords.bitwarden_daily`
 * is on (off by default; the person turns it on).
 *
 * `bw sync`, then `bw export --format json --raw`, each a child process with a deadline
 * (child-run.ts): the export stays in memory, is never written to disk and never logged.
 * BW_SESSION comes from the server's environment, else on macOS from the keychain
 * (`security find-generic-password -a $USER -s BW_SESSION -w`). The vault must be open; when it
 * is locked, the daily run (and only it) unlocks it from this Mac's keychain if the person keeps
 * the master password there (keychain-unlock.ts), and locks it again after. Otherwise the sync is skipped and the
 * reason shows in Settings ("Last sync: not synced, Passwords is locked"); no letter is sent.
 */
import { runVaultHelper } from './child-run.js'
import { readKeychainSecret } from './keychain-secret.js'
import { noteSyncSkipped, syncFromBitwarden, type SyncOptions, type SyncReport, type SyncTrigger } from './bitwarden-sync.js'

const SYNC_TIMEOUT_MS = 120_000
const EXPORT_TIMEOUT_MS = 180_000
const BW_PATHS = ['bw', '/opt/homebrew/bin/bw', '/usr/local/bin/bw']

let running: Promise<SyncReport> | null = null

async function bwSession(): Promise<string | null> {
  const env = process.env.BW_SESSION?.trim()
  if (env) return env
  return readKeychainSecret('BW_SESSION')
}

/** Run bw with the first path that exists. */
async function bw(args: string[], session: string, timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const env = { ...process.env, BW_SESSION: session, BW_NOINTERACTION: 'true' }
  const paths = process.env.WALNUT_BW_PATH ? [process.env.WALNUT_BW_PATH] : BW_PATHS
  let last = 'the Bitwarden CLI (bw) is not installed'
  for (const p of paths) {
    const r = await runVaultHelper(p, args, { timeoutMs, env })
    if (r.error && /ENOENT/.test(r.error)) continue
    if (r.timedOut) return { ok: false, error: `bw ${args[0]} took longer than ${Math.round(timeoutMs / 1000)} s` }
    if (r.code !== 0) {
      // bw's own message, never the export (stdout is not read on a failure).
      const why = r.stderr.replace(/\s+/g, ' ').trim().slice(0, 200)
      return { ok: false, error: `bw ${args[0]} failed${why ? `: ${why}` : ''}` }
    }
    return { ok: true, stdout: r.stdout }
  }
  return { ok: false, error: last }
}

/** One run of bw plus the sync; one at a time (a second call joins the running one). */
export function runBitwardenSync(trigger: SyncTrigger, opts: SyncOptions = {}): Promise<SyncReport> {
  if (!running) running = runOnce(trigger, opts).finally(() => { running = null })
  return running
}

async function runOnce(trigger: SyncTrigger, opts: SyncOptions): Promise<SyncReport> {
  const st = await import('./store.js')
  const status = await st.vaultStatus()
  if (!status.setUp) return noteSyncSkipped(trigger, 'no vault yet')
  let keychainToken: string | null = null
  // Only the daily run opens a locked vault from the keychain; an agent's run needs it open already.
  if (!st.isOpen() && trigger !== 'daily') return noteSyncSkipped(trigger, 'Passwords is locked')
  if (!st.isOpen()) {
    const { keychainItemPresent, unlockFromKeychain } = await import('./keychain-unlock.js')
    if (await keychainItemPresent()) {
      const u = await unlockFromKeychain({ client: 'This Mac (Bitwarden sync)' })
      if (u.ok) keychainToken = u.session.token
    }
    if (!st.isOpen()) return noteSyncSkipped(trigger, 'Passwords is locked')
  }
  try {
    const session = await bwSession()
    if (!session) return await noteSyncSkipped(trigger, 'no BW_SESSION (run bw unlock and keep its session in the keychain as BW_SESSION)')
    const synced = await bw(['sync'], session, SYNC_TIMEOUT_MS)
    if (!synced.ok) return await noteSyncSkipped(trigger, synced.error)
    const exported = await bw(['export', '--format', 'json', '--raw'], session, EXPORT_TIMEOUT_MS)
    if (!exported.ok) return await noteSyncSkipped(trigger, exported.error)
    try {
      return await syncFromBitwarden(exported.stdout, trigger, opts)
    } catch (err) {
      const r = await noteSyncSkipped(trigger, (err as Error).message.slice(0, 300))
      // A person's "Sync now" hears the mass-trash refusal as such, so Settings can ask to allow it.
      if (trigger === 'person' && (err as { code?: string }).code === 'sync_mass_trash') throw err
      return r
    }
  } finally {
    if (keychainToken) {
      // Unlocked only for this sync: lock again (the person's own windows keep theirs).
      const s = await import('./sessions.js')
      s.endSession(keychainToken)
      const { closeIfNobody } = await import('../../web/routes/vault-v1.js')
      await closeIfNobody().catch(() => undefined)
    }
  }
}

/** Milliseconds from `now` to the next 04:00 local time. */
export function msUntilNextRun(now = new Date(), hour = 4): number {
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

/** The daily timer (primary only). It reads the setting when it fires, so turning it on needs no restart. */
export function startDailyBitwardenSync(): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const arm = () => {
    if (stopped) return
    timer = setTimeout(() => { void fire().finally(arm) }, Math.min(msUntilNextRun(), 2 ** 31 - 1))
    timer.unref?.()
  }
  const fire = async () => {
    try {
      const { getConfig } = await import('../config-manager.js')
      if ((await getConfig()).passwords?.bitwarden_daily !== true) return
      await runBitwardenSync('daily')
    } catch { /* the report holds the reason; the next day tries again */ }
  }
  arm()
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer) } }
}
