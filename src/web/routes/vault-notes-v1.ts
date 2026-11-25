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
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { gate, needSession } from './vault-v1.js'
import { isFollower } from '../../core/server-role.js'
import { isPersonNotAutomation } from './person-caller.js'

export const vaultNotesV1Router = Router()

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
    if (known) { res.status(known.status).json(known.body); return }
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
  res.setHeader('Cache-Control', 'no-store')
  if (isFollower()) {
    res.status(503).json({ error: 'Locked notes open only on your Mac, which keeps Passwords.', code: 'vault_not_here' })
    return false
  }
  return true
}

async function askDeps() {
  const [{ createApproval, waitApproval, cancelInternal }, lockedStore, { parseLockedNote }, fsp, { resolveNotePath }] = await Promise.all([
    import('../../core/approvals/store.js'), store(), import('../../core/notes/locked-note.js'), import('node:fs/promises'), import('../../core/notes/note-paths.js'),
  ])
  const deps: import('../../core/notes/locked-note-ask.js').AskDeps = {
    async askPerson(input) {
      // Always asked: the person locked this note so no agent reads it unasked (ask-me-gates-guard).
      const { approval, waitToken } = await createApproval({ ...input, detailRole: 'summary', outsideSwitch: true, needsPasswords: true })
      return { id: approval.id, waitToken, expiresAt: approval.expiresAt }
    },
    async waitApproval(id, token, waitMs) {
      const r = await waitApproval(id, token, waitMs)
      const by = r.approval.answer?.device.name
      return { status: r.approval.status, ...(by ? { answeredBy: by } : {}) }
    },
    cancelApproval: (id) => cancelInternal(id, 'the agent withdrew its ask').then(() => undefined),
    read: (p) => lockedStore.readLockedNote(p),
    save: (p, content, expectedHash) => lockedStore.writeLockedNote(p, content, expectedHash),
    async lockedNoteId(p) {
      const full = resolveNotePath(p)
      if (!full) return null
      let text: string
      try { text = await fsp.readFile(full.endsWith('.md') ? full : `${full}.md`, 'utf-8') } catch { return null }
      const parsed = parseLockedNote(text)
      return parsed ? parsed.id ?? '' : null
    },
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
    if (known) { res.status(known.status).json(known.body); return }
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
