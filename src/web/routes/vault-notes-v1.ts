/**
 * Locked notes (docs/reference/locked-notes.md): a person reads, saves, locks and unlocks a note
 * whose text is sealed with the locked-notes key kept in Passwords.
 *
 *   POST /api/v1/vault/notes/read         { path }                          → { content, contentHash, updatedAt, path }
 *   POST /api/v1/vault/notes/save         { path, content, expectedHash? }  → { contentHash, updatedAt, path }
 *   POST /api/v1/vault/notes/lock         { path, expectedHash? }           → { contentHash, updatedAt, path }
 *   POST /api/v1/vault/notes/remove-lock  { path, expectedHash? }           → { content, contentHash, updatedAt, path }
 *
 * Who: exactly the vault's own rule (gate in vault-v1.ts: a person, no session caller, no CLI
 * automation mark, no test run, the leader only) plus a live vault session in this window, which
 * only the master password buys. Under /vault on purpose: the cloud companion never carries a
 * /vault route (v1-forward/policy.ts), so it never sees a locked note's text in the clear, and no
 * answer is kept in the applied-ops ledger (op-id.ts SECRET_ROUTE_RE). An agent reaches a locked
 * note only through an ask the person approves (the agent routes below, core/notes/locked-note-ask.ts).
 *
 * Every answer here, whatever it says, is marked never kept (lib/answer-not-kept.ts): no op call that
 * reached one (a named op, `api`, a nested op) holds it for a resend or an op_result read, and no
 * cache stores it.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { SENT, attempt, gate, needSession, passwordKeyOf, run } from './vault-v1.js'
import { isFollower } from '../../core/server-role.js'
import { isPersonNotAutomation } from './person-caller.js'
import { markAnswerNotKept } from '../../lib/answer-not-kept.js'
import { sendVaultRefusal } from './vault-answer.js'

export const vaultNotesV1Router = Router()

// Before every route below (tests/core/notes/locked-note-writers-guard.test.ts checks each one is behind it).
vaultNotesV1Router.use('/vault/notes', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store')
  markAnswerNotKept(res, 'a locked note route, which checks its window on every call')
  next()
})

async function store() {
  return import('../../core/notes/locked-note-store.js')
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>
}

async function answer(res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await work())
  } catch (err) {
    const known = (await store()).lockedNoteErrorBody(err)
    if (known) { sendVaultRefusal(res, known.status, known.body); return }
    next(err)
  }
}

async function person(req: Request, res: Response): Promise<boolean> {
  if (!gate(req, res)) return false
  // A browser under automation on the person's own install (Playwright, headless Chromium) is not them.
  if (!isPersonNotAutomation(req)) {
    res.status(403).json({ error: 'Only a person opens a locked note: an agent, a session or a script cannot.', code: 'human_only' })
    return false
  }
  return needSession(req, res)
}

vaultNotesV1Router.post('/vault/notes/read', async (req, res, next) => {
  if (!(await person(req, res))) return
  await answer(res, next, async () => (await store()).readLockedNote(body(req).path))
})

vaultNotesV1Router.post('/vault/notes/save', async (req, res, next) => {
  if (!(await person(req, res))) return
  const b = body(req)
  await answer(res, next, async () => (await store()).writeLockedNote(b.path, b.content, b.expectedHash))
})

vaultNotesV1Router.post('/vault/notes/lock', async (req, res, next) => {
  if (!(await person(req, res))) return
  const b = body(req)
  await answer(res, next, async () => (await store()).lockNote(b.path, b.expectedHash))
})

vaultNotesV1Router.post('/vault/notes/remove-lock', async (req, res, next) => {
  if (!(await person(req, res))) return
  const b = body(req)
  await answer(res, next, async () => (await store()).removeNoteLock(b.path, b.expectedHash))
})

// ── The key's backup in the data folder (core/vault/locked-notes-key-backup.ts) ──
//
//   GET  /api/v1/vault/notes/key-backup?path=  → { entry, vaultId, kdf, hint?, keys, inVault, holdsNoteKey?, earlier: [the same] } | 404 no_key_backup
//   POST /api/v1/vault/notes/restore-key       { passwordKey | password, secretKey, entry? | vaultId? } → { added }
//
// The restore takes the master password of the vault that wrote the backup (which may be another
// computer's) and its Secret Key, under the wrong-password brake, into this window's open vault.
// `path`: the locked note being opened, so the backup holding its key is marked.

/** The text of the note at `p` (a notes path), or null. */
async function noteText(p: unknown): Promise<string | null> {
  if (typeof p !== 'string' || !p) return null
  const [fsp, { resolveNotePath }] = await Promise.all([import('node:fs/promises'), import('../../core/notes/note-paths.js')])
  const full = resolveNotePath(p)
  if (!full) return null
  try { return await fsp.readFile(full.endsWith('.md') ? full : `${full}.md`, 'utf-8') } catch { return null }
}

vaultNotesV1Router.get('/vault/notes/key-backup', async (req, res, next) => {
  if (!(await person(req, res))) return
  await run(res, next, async () => {
    const text = await noteText(req.query.path)
    const noteKey = text === null ? undefined : (await import('../../core/notes/locked-note.js')).parseLockedNote(text)?.envelope?.key
    const info = await (await import('../../core/vault/locked-notes-key-backup.js')).keyBackupInfo(noteKey)
    if (!info) { res.status(404).json({ error: 'There is no backup of the locked notes key in this Walnut\'s data folder', code: 'no_key_backup' }); return SENT }
    return info
  })
})

vaultNotesV1Router.post('/vault/notes/restore-key', async (req, res, next) => {
  if (!(await person(req, res))) return
  await run(res, next, async () => {
    const backup = await import('../../core/vault/locked-notes-key-backup.js')
    if (!(await backup.readKeyBackup())) { res.status(404).json({ error: 'There is no backup of the locked notes key in this Walnut\'s data folder', code: 'no_key_backup' }); return SENT }
    const b = body(req) as { passwordKey?: unknown; password?: unknown; secretKey?: unknown; vaultId?: unknown; entry?: unknown }
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    const pick = { ...(str(b.entry) ? { entry: str(b.entry) } : {}), ...(str(b.vaultId) ? { vaultId: str(b.vaultId) } : {}) }
    const kdf = await backup.keyBackupKdf(pick)
    if (!kdf) { res.status(404).json({ error: 'No such backup is in this Walnut\'s data folder', code: 'no_key_backup' }); return SENT }
    const r = await attempt(res, async () => backup.restoreLockedNotesKey({
      ...pick,
      passwordKey: await passwordKeyOf(req, b, kdf),
      secretKey: typeof b.secretKey === 'string' ? b.secretKey : '',
    }))
    return r ? r.value : SENT
  })
})

// ── An agent's ask (core/notes/locked-note-ask.ts) ──
//
//   POST /api/v1/vault/notes/agent/ask              { path, purpose, access?: read | edit } → { status: 'pending', requestId, waitToken }
//   POST /api/v1/vault/notes/agent/ask/:id/wait     { token, wait_ms? } → pending | released { content, contentHash, editUntil? } (403 denied)
//   POST /api/v1/vault/notes/agent/ask/:id/save     { token, content, expectedHash } → { contentHash, updatedAt, path } (edit only)
//   POST /api/v1/vault/notes/agent/ask/:id/cancel   { token }
//
// Any caller may ask; the person approves on a card that always asks (approvals off or not), and
// only from a window with Passwords unlocked (approvals-v1.ts checks `needsPasswords`).

function agentHere(res: Response): boolean {
  if (isFollower()) {
    sendVaultRefusal(res, 503, { error: 'Locked notes open only on your Mac, which keeps Passwords.', code: 'vault_not_here' })
    return false
  }
  return true
}

async function askDeps() {
  const [{ createApproval, waitApproval, cancelInternal }, lockedStore, { isHiddenNoteText, parseLockedNote }] = await Promise.all([
    import('../../core/approvals/store.js'), store(), import('../../core/notes/locked-note.js'),
  ])
  const deps: import('../../core/notes/locked-note-ask.js').AskDeps = {
    async askPerson(input) {
      // Always asked: the person locked this note so no agent reads it unasked (ask-me-gates-guard).
      const { approval, waitToken } = await createApproval({ ...input, untilBack: input.untilBack === true, detailRole: 'summary', outsideSwitch: true, needsPasswords: true })
      return { id: approval.id, waitToken, expiresAt: approval.expiresAt }
    },
    async waitApproval(id, token, waitMs) {
      const r = await waitApproval(id, token, waitMs)
      const by = r.approval.answer?.device.name
      const at = r.approval.answer?.at
      return { status: r.approval.status, ...(by ? { answeredBy: by } : {}), ...(at ? { answeredAt: at } : {}) }
    },
    cancelApproval: (id) => cancelInternal(id, 'the agent withdrew its ask').then(() => undefined),
    read: (p) => lockedStore.readLockedNote(p),
    save: (p, content, expectedHash) => lockedStore.writeLockedNote(p, content, expectedHash),
    async lockedNoteId(p) {
      const text = await noteText(p)
      const parsed = text === null ? null : parseLockedNote(text)
      return parsed ? parsed.id ?? '' : null
    },
    hiddenNote: async (p) => isHiddenNoteText(await noteText(p)),
    approvalStatus: async (id) => (await import('../../core/approvals/store.js')).getApproval(id).then((a) => a?.status),
  }
  return deps
}

async function askAnswer(res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await work())
  } catch (err) {
    const { ApprovalError } = await import('../../core/approvals/store.js')
    if (err instanceof ApprovalError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    const known = (await store()).lockedNoteErrorBody(err)
    if (known) { sendVaultRefusal(res, known.status, known.body); return }
    next(err)
  }
}

function idOf(req: Request): string {
  const v = req.params.id
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
}

vaultNotesV1Router.post('/vault/notes/agent/ask', async (req, res, next) => {
  if (!agentHere(res)) return
  await askAnswer(res, next, async () => {
    const b = body(req)
    const { askLockedNote } = await import('../../core/notes/locked-note-ask.js')
    const { requesterOf } = await import('./approvals-v1.js')
    const { ambientTestRun } = await import('../../core/test-run.js')
    const testRun = ambientTestRun()
    return askLockedNote({ path: b.path, purpose: b.purpose, access: b.access, requester: await requesterOf(req, b), ...(testRun ? { testRun } : {}) }, await askDeps())
  })
})

vaultNotesV1Router.post('/vault/notes/agent/ask/:id/wait', async (req, res, next) => {
  if (!agentHere(res)) return
  await askAnswer(res, next, async () => {
    const b = body(req)
    const { waitLockedNote } = await import('../../core/notes/locked-note-ask.js')
    const { APPROVAL_WAIT_MAX_MS } = await import('../../core/approvals/types.js')
    const waitMs = typeof b.wait_ms === 'number' && b.wait_ms >= 0 ? Math.min(APPROVAL_WAIT_MAX_MS, b.wait_ms) : APPROVAL_WAIT_MAX_MS
    const { requesterOf } = await import('./approvals-v1.js')
    return waitLockedNote(idOf(req), b.token, waitMs, await requesterOf(req, b), await askDeps())
  })
})

vaultNotesV1Router.post('/vault/notes/agent/ask/:id/save', async (req, res, next) => {
  if (!agentHere(res)) return
  await askAnswer(res, next, async () => {
    const b = body(req)
    const { saveLockedNoteForAgent } = await import('../../core/notes/locked-note-ask.js')
    const { requesterOf } = await import('./approvals-v1.js')
    return saveLockedNoteForAgent(idOf(req), b.token, b.content, b.expectedHash, await requesterOf(req, b), await askDeps())
  })
})

vaultNotesV1Router.post('/vault/notes/agent/ask/:id/cancel', async (req, res, next) => {
  if (!agentHere(res)) return
  await askAnswer(res, next, async () => {
    const { cancelLockedNoteAsk } = await import('../../core/notes/locked-note-ask.js')
    await cancelLockedNoteAsk(idOf(req), body(req).token, await askDeps())
    return { ok: true }
  })
})
