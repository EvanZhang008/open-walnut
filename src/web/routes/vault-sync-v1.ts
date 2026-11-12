/**
 * Passwords: Bitwarden sync and the keychain unlock (core/vault/sources/bitwarden/sync.ts,
 * run.ts, keychain-unlock.ts; docs/reference/passwords.md). Mounted by vault-agent-v1.ts.
 *
 *   POST   /api/v1/vault/sync/bitwarden            { export, allowMassTrash? } → report   person, vault session
 *   POST   /api/v1/vault/sync/bitwarden/run        { allowMassTrash? } → report  any caller: Walnut runs bw itself
 *   GET    /api/v1/vault/sync/bitwarden            → { daily, last }         person, vault session
 *   GET    /api/v1/vault/keychain                  → { available, present }  person
 *   DELETE /api/v1/vault/keychain                  → { removed }             person, vault session
 *
 * The export rides the request body only: it is never written to disk and never logged (no
 * vault route is kept in the applied-ops ledger, middleware/op-id.ts SECRET_ROUTE_RE). Only a
 * person's unlocked window posts export text; an agent (a session caller, the CLI, or no vault
 * session) may only ask Walnut to run bw itself (`walnut pass sync-bitwarden`), unless agent
 * access is Off, and only while the vault is already open; every agent sync is in Agent Activity.
 * `allowMassTrash` counts only from a person's session. The keychain unlock has no route: Walnut
 * uses it itself (at start, and the daily sync). A test run and the companion are refused, as for
 * every vault route.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower } from '../../core/server-role.js'
import { ambientTestRun } from '../../core/test-run.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN } from '../../lib/caller-origin.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'

export const vaultSyncV1Router = Router()

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function here(res: Response): boolean {
  res.setHeader('Cache-Control', 'no-store')
  if (isFollower()) {
    res.status(503).json({ error: 'Passwords are kept on your Mac and open only from it, its own network or Tailscale.', code: 'vault_not_here' })
    return false
  }
  if (ambientTestRun()) {
    res.status(403).json({ error: 'A test run cannot use the vault: it is the person\'s real one.', code: 'test_run' })
    return false
  }
  return true
}

/** No session caller, no CLI automation mark, this machine or a paired device: the person's shape. */
function personShape(req: Request): boolean {
  const origin = requestOrigin(req)
  return !header(req, 'x-walnut-caller-sid') && !header(req, CALLER_KIND_HEADER) && (origin === LOCAL_ORIGIN || origin === REMOTE_HTTP_ORIGIN)
}

async function hasSession(req: Request): Promise<boolean> {
  // Right after a restart the kept sessions are still being restored: wait, never answer 401.
  await (await import('../../core/vault/session-store.js')).sessionsRestored()
  const s = await import('../../core/vault/sessions.js')
  const { deviceOf } = await import('./vault-v1.js')
  return !!s.useSession(header(req, s.SESSION_HEADER), true, deviceOf(req))
}

async function person(req: Request, res: Response, needSession: boolean): Promise<boolean> {
  if (!personShape(req)) {
    res.status(403).json({ error: 'Only a person does this in Passwords.', code: 'human_only' })
    return false
  }
  if (needSession && !(await hasSession(req))) {
    res.status(401).json({ error: 'The vault is locked in this window: unlock it with the master password.', code: 'vault_session_needed' })
    return false
  }
  return true
}

async function run(res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  try {
    const out = await work()
    if (!res.headersSent) res.json(out)
  } catch (err) {
    const { VaultError } = await import('../../core/vault/store.js')
    const { ImportError } = await import('../../core/vault/import.js')
    if (err instanceof VaultError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    if (err instanceof ImportError) { res.status(400).json({ error: err.message, code: 'bad_import' }); return }
    next(err)
  }
}

/** A person's own request, with this window's vault session: the only one that may hand Walnut export text or allow a mass trash. */
async function asPersonWithSession(req: Request): Promise<boolean> {
  return personShape(req) && await hasSession(req)
}

async function logAgentSync(req: Request, summary: string): Promise<void> {
  const { appendAgentLog } = await import('../../core/vault/agent-log.js')
  const { requesterOf } = await import('./approvals-v1.js')
  const r = await requesterOf(req, {})
  await appendAgentLog({
    kind: 'synced', summary: `Bitwarden sync: ${summary}`, host: r.host,
    ...(r.taskId ? { taskId: r.taskId } : {}), ...(r.taskTitle ? { taskTitle: r.taskTitle } : {}), ...(r.sessionId ? { sessionId: r.sessionId } : {}),
  })
}

const allowMassTrashOf = (req: Request): boolean => (req.body as { allowMassTrash?: unknown } | undefined)?.allowMassTrash === true

// Export text from the caller: a person's unlocked window only. An agent never hands Walnut the
// items to write (it could plant or trash anything); it asks Walnut to run bw itself (/run).
vaultSyncV1Router.post('/vault/sync/bitwarden', async (req, res, next) => {
  if (!here(res)) return
  if (!(await asPersonWithSession(req))) {
    res.status(403).json({
      error: 'Only a person\'s unlocked Passwords window may hand Walnut a Bitwarden export. An agent asks Walnut to run the sync itself: walnut pass sync-bitwarden (no stdin), or the op password_sync_bitwarden.',
      code: 'export_person_only',
    })
    return
  }
  await run(res, next, async () => {
    const body = (req.body ?? {}) as { export?: unknown; text?: unknown }
    const text = typeof body.export === 'string' ? body.export : typeof body.text === 'string' ? body.text : ''
    const { VaultError } = await import('../../core/vault/store.js')
    if (!text) throw new VaultError('export (the text of `bw export --format json --raw`) is required', 400, 'bad_import')
    const { syncFromBitwarden, syncSummary } = await import('../../core/vault/sources/bitwarden/sync.js')
    const report = await syncFromBitwarden(text, 'person', { allowMassTrash: allowMassTrashOf(req) })
    return { report, summary: syncSummary(report) }
  })
})

// Walnut runs bw itself. Any caller: a person ("Sync now"), or an agent unless agent access is
// Off. An agent's run needs the vault open already (never the keychain) and is in Agent Activity.
vaultSyncV1Router.post('/vault/sync/bitwarden/run', async (req, res, next) => {
  if (!here(res)) return
  await run(res, next, async () => {
    const asPerson = await asPersonWithSession(req)
    const { runBitwardenSync } = await import('../../core/vault/sources/bitwarden/run.js')
    const { syncSummary } = await import('../../core/vault/sources/bitwarden/sync.js')
    if (asPerson) {
      const report = await runBitwardenSync('person', { allowMassTrash: allowMassTrashOf(req) })
      return { report, summary: syncSummary(report) }
    }
    const { closeIfNobody } = await import('./vault-v1.js')
    await closeIfNobody()
    const { readPolicy } = await import('../../core/vault/policy.js')
    const { VaultError } = await import('../../core/vault/store.js')
    if ((await readPolicy()).agents === 'off') {
      throw new VaultError('Agent access to Passwords is Off: the person syncs from Settings, Passwords.', 403, 'agents_off')
    }
    const report = await runBitwardenSync(header(req, CALLER_KIND_HEADER) ? 'cli' : 'agent')
    await logAgentSync(req, syncSummary(report))
    return { report, summary: syncSummary(report) }
  })
})

vaultSyncV1Router.get('/vault/sync/bitwarden', async (req, res, next) => {
  if (!here(res) || !(await person(req, res, true))) return
  await run(res, next, async () => {
    const { getConfig } = await import('../../core/config-manager.js')
    const { lastSyncReport, syncSummary } = await import('../../core/vault/sources/bitwarden/sync.js')
    const { sourceAdded } = await import('../../core/vault/sources/index.js')
    const last = await lastSyncReport()
    const cfg = (await getConfig()).passwords
    // `added`: Settings shows this source only to a person who added it (or already synced from it).
    return { added: sourceAdded(cfg, 'bitwarden', last !== null), daily: cfg?.bitwarden_daily === true, last, ...(last ? { summary: syncSummary(last) } : {}) }
  })
})

vaultSyncV1Router.get('/vault/keychain', async (req, res, next) => {
  if (!here(res) || !(await person(req, res, false))) return
  await run(res, next, async () => {
    const kc = await import('../../core/vault/keychain-unlock.js')
    return { available: kc.keychainAvailable(), present: await kc.keychainItemPresent(), service: kc.KEYCHAIN_SERVICE }
  })
})

vaultSyncV1Router.delete('/vault/keychain', async (req, res, next) => {
  if (!here(res) || !(await person(req, res, true))) return
  await run(res, next, async () => {
    const kc = await import('../../core/vault/keychain-unlock.js')
    return { removed: await kc.removeKeychainItem() }
  })
})
