/**
 * Locked notes end to end (docs/reference/locked-notes.md): a person locks a note with the Passwords
 * master password; the file then holds only its id, the mark, the stub and ciphertext; every
 * ordinary read answers the stub and every ordinary write refuses it; only the person, with a vault
 * session, reads and saves its text; the key survives a lock, a restart and a new master password;
 * removing the lock gives the text back. An agent reads it only from inside the session that asked,
 * after the person's yes, and no answer is kept for a resend whichever op reached it. Fake data only;
 * the vault and notes are the test's own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-locked-notes-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'
import { notesRoot } from '../../src/core/notes/note-paths.js'
import { LOCKED_NOTES_KEY_FIELD } from '../../src/core/vault/locked-notes-key.js'
import { ANSWER_NOT_KEPT_HEADER } from '../../src/lib/answer-not-kept.js'
import { vaultNotesV1Router } from '../../src/web/routes/vault-notes-v1.js'

let base = ''
let session = ''
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const MASTER = 'correct horse locked battery'
const AGENT = { 'x-walnut-caller-sid': 'sess-agent-1' }
const NOTE = 'journal/Diary.md'
// A diary-like note: frontmatter, a heading, Unicode (escaped), a long body.
const SECRET_WORD = 'zebraquokkasecret'
const TEXT = [
  '---', 'tags: [journal]', '---',
  '# Monday',
  `Felt good today. ${SECRET_WORD} is the word I keep.`,
  'Caf\u00e9 with \u4f60\u597d and \u{1F331}.',
  ...Array.from({ length: 200 }, (_, i) => `- line ${i} of a long entry`),
  '',
].join('\n')

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { 'x-walnut-vault-session': session } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed: Record<string, any> = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed, headers: res.headers }
}
const v1 = (method: string, p: string, body?: unknown, headers?: Record<string, string>) => http(method, `/api/v1${p}`, body, headers)
const file = () => fsp.readFile(path.join(notesRoot(), NOTE), 'utf8')

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v) || Date.now() > until) return v
    await new Promise((r) => setTimeout(r, 150))
  }
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  resetSessionsForTest()
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
})

describe('locked notes', () => {
  let hash = ''

  it('every locked-note route answers marked never kept and not to be cached, whatever it answers', async () => {
    const routes = (vaultNotesV1Router as unknown as { stack: Array<{ route?: { path: string } }> }).stack.flatMap((l) => l.route ? [l.route.path] : [])
    expect(routes.length).toBeGreaterThanOrEqual(8)
    for (const route of routes) {
      const r = await http('POST', `/api/v1${route.replace(/:[A-Za-z_]+/g, 'x')}`, {}, AGENT)
      expect(r.headers.get(ANSWER_NOT_KEPT_HEADER), route).toBeTruthy()
      expect(r.headers.get('cache-control'), route).toBe('no-store')
    }
  })

  it('needs a person with Passwords unlocked to lock a note', async () => {
    const put = await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: TEXT })
    expect(put.status).toBe(200)
    expect((await v1('POST', '/vault/notes/lock', { path: NOTE })).body.code).toBe('vault_session_needed')
    const setup = await v1('POST', '/vault/setup', { passwordKey: toB64(await derivePasswordKey(MASTER, kdf)), kdf, agentsWhileAway: false, client: 'test' })
    expect(setup.status).toBe(200)
    session = setup.body.session.token
    // An agent never locks, reads or saves one, whatever headers it copies.
    expect((await v1('POST', '/vault/notes/lock', { path: NOTE }, AGENT)).body.code).toBe('human_only')
    expect((await v1('POST', '/vault/notes/lock', { path: 'global-notes.md' })).body.code).toBe('not_lockable')
  })

  it('locks it: the file keeps its id, the mark and the stub, and holds the text only as ciphertext', async () => {
    const before = await file()
    const id = /^id: (\S+)$/m.exec(before)?.[1]
    expect(id).toMatch(/^n_/)
    const r = await v1('POST', '/vault/notes/lock', { path: NOTE })
    expect(r.status).toBe(200)
    hash = r.body.contentHash
    const disk = await file()
    for (const plain of [SECRET_WORD, 'Monday', 'journal', '\u4f60\u597d', 'line 199']) expect(disk).not.toContain(plain)
    expect(disk).toContain(`id: ${id}`)
    expect(disk).toContain('walnut_locked: 1')
    expect(disk).toMatch(/^<!-- walnut-locked-note v1 \{.*\} -->$/m)
    expect((await v1('POST', '/vault/notes/lock', { path: NOTE })).body.code).toBe('already_locked')
    // The key is an item in Passwords that agents never get.
    const items = (await v1('GET', '/vault/items')).body.items as Array<{ id: string; title: string; agentAccess: string; sensitive?: boolean }>
    const keyItem = items.find((i) => i.title === 'Walnut locked notes key')
    expect(keyItem).toMatchObject({ agentAccess: 'never', sensitive: true })
    const full = (await v1('GET', `/vault/items/${keyItem!.id}`)).body.item
    expect(full.fields.map((f: { name: string }) => f.name)).toEqual([LOCKED_NOTES_KEY_FIELD])
  })

  it('every ordinary read answers the stub, never the text or the ciphertext', async () => {
    for (const r of [
      await http('GET', `/api/notes-v2/content/${NOTE}`),
      await v1('GET', `/notes/content/${NOTE}`),
      await v1('GET', `/notes/content/${NOTE}`, undefined, AGENT),
    ]) {
      expect(r.status).toBe(200)
      expect(r.body.locked).toBe(true)
      expect(r.body.contentHash).toBe(hash)
      expect(r.body.content).toContain('Locked note')
      expect(r.body.content).not.toContain(SECRET_WORD)
      expect(r.body.content).not.toContain('walnut-locked-note v1')
    }
  })

  it('only the person with a vault session reads the text', async () => {
    const r = await v1('POST', '/vault/notes/read', { path: NOTE })
    expect(r.status).toBe(200)
    expect(r.body.content).toContain(SECRET_WORD)
    expect(r.body.content).toContain('Caf\u00e9 with \u4f60\u597d and \u{1F331}.')
    expect(r.body.content).toContain('tags: [journal]')
    expect(r.body.contentHash).toBe(hash)
    expect((await v1('POST', '/vault/notes/read', { path: NOTE }, AGENT)).body.code).toBe('human_only')
    expect((await v1('POST', '/vault/notes/read', { path: NOTE }, { 'x-walnut-caller-kind': 'automation' })).body.code).toBe('human_only')
    const keep = session
    session = ''
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.code).toBe('vault_session_needed')
    session = keep
  })

  it('every ordinary write and an agent\'s delete leave it as it is', async () => {
    const disk = await file()
    const tries = [
      await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: 'overwritten' }),
      await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: 'overwritten', expectedHash: hash }),
      await v1('PUT', `/notes/content/${NOTE}`, { content: 'overwritten' }, AGENT),
      await http('PUT', '/api/file-content', { path: path.join(notesRoot(), NOTE), content: 'overwritten', expectedHash: hash }),
      await http('DELETE', `/api/notes-v2/content/${NOTE}`, undefined, AGENT),
      await v1('DELETE', `/notes/${NOTE}`, undefined, AGENT),
      await v1('DELETE', '/notes/folder/journal', undefined, AGENT),
    ]
    for (const t of tries) {
      expect(t.status).toBe(423)
      expect(JSON.stringify(t.body)).toContain('note_locked')
    }
    expect(await file()).toBe(disk)
  })

  it('saves new text sealed again, and refuses a save made on older text', async () => {
    const cur = (await v1('POST', '/vault/notes/read', { path: NOTE })).body
    const next = `${cur.content}\nTuesday: another private line.\n`
    const r = await v1('POST', '/vault/notes/save', { path: NOTE, content: next, expectedHash: cur.contentHash })
    expect(r.status).toBe(200)
    expect(r.body.contentHash).not.toBe(cur.contentHash)
    expect(await file()).not.toContain('another private line')
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.content).toBe(next)
    const stale = await v1('POST', '/vault/notes/save', { path: NOTE, content: 'stale', expectedHash: cur.contentHash })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('conflict')
    hash = r.body.contentHash
  })

  it('search, the list and the tags see the stub only', async () => {
    const list = await waitFor(() => http('GET', '/api/notes-v2/list'), (r) => (r.body.notes ?? []).some((n: { path: string; locked?: boolean }) => n.path === NOTE && n.locked))
    expect(list.body.notes.find((n: { path: string }) => n.path === NOTE)).toMatchObject({ locked: true })
    const s = await http('GET', `/api/notes-v2/search?q=${SECRET_WORD}&mode=string`)
    expect(JSON.stringify(s.body)).not.toContain(NOTE)
    const tagged = await http('GET', '/api/notes-v2/tags/journal/notes')
    expect(JSON.stringify(tagged.body)).not.toContain(NOTE)
    expect((await http('POST', '/api/notes-v2/tags/rename', { from: 'journal', to: 'diary' })).status).toBe(200)
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.content).toContain('tags: [journal]')
  })

  it('the key cannot be changed, trashed or deleted in Passwords', async () => {
    const items = (await v1('GET', '/vault/items')).body.items as Array<{ id: string; title: string }>
    const id = items.find((i) => i.title === 'Walnut locked notes key')!.id
    expect((await v1('POST', `/vault/items/${id}/trash`)).body.code).toBe('locked_notes_key')
    expect((await v1('DELETE', `/vault/items/${id}`)).body.code).toBe('locked_notes_key')
    expect((await v1('PUT', `/vault/items/${id}`, { item: { type: 'note', title: 'x' } })).body.code).toBe('locked_notes_key')
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).status).toBe(200)
  })

  it('an agent reads it only after the person approves with Passwords unlocked, and only within its window', async () => {
    const ask = await v1('POST', '/vault/notes/agent/ask', { path: NOTE, purpose: 'summarise this week' }, AGENT)
    expect(ask.status).toBe(200)
    expect(ask.body).toMatchObject({ status: 'pending', access: 'read', path: NOTE })
    const wait = () => v1('POST', `/vault/notes/agent/ask/${ask.body.requestId}/wait`, { token: ask.body.waitToken, wait_ms: 0 }, AGENT)
    expect((await wait()).body).toEqual({ status: 'pending', requestId: ask.body.requestId })
    const card = (await http('GET', '/api/v1/approvals')).body.approvals.find((a: { id: string }) => a.id === ask.body.requestId)
    expect(card).toMatchObject({ needsPasswords: true, outsideSwitch: true })
    expect(card.what).toContain('read your locked note "Diary"')
    expect(card.detail).toContain('Why: summarise this week')
    expect(JSON.stringify(card)).not.toContain(SECRET_WORD)
    const answer = (decision: 'approve' | 'deny', id = ask.body.requestId, digest = card.digest) =>
      v1('POST', `/approvals/${id}/answer`, { decision, digest, device: { name: 'Web console', kind: 'web' } })
    // The agent cannot answer it, and the person's yes needs Passwords unlocked in that window.
    expect((await v1('POST', `/approvals/${ask.body.requestId}/answer`, { decision: 'approve', digest: card.digest }, AGENT)).body.code).toBe('human_only')
    const keep = session
    session = ''
    const noSession = await answer('approve')
    expect(noSession.status).toBe(401)
    expect(noSession.body.code).toBe('master_password_needed')
    // Passwords unlocked three minutes ago is not the master password typed for this yes.
    const realNow = Date.now
    const earlier = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 3 * 60_000)
    try {
      session = (await v1('POST', '/vault/unlock', { password: MASTER })).body.session.token
    } finally {
      earlier.mockRestore()
    }
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).status).toBe(200)
    const stale = await answer('approve')
    expect(stale.status).toBe(401)
    expect(stale.body.code).toBe('master_password_needed')
    expect((await wait()).body.status).toBe('pending')
    session = keep
    // The master password typed for this yes: a fresh unlock right before it.
    session = (await v1('POST', '/vault/unlock', { password: MASTER })).body.session.token
    expect((await answer('approve')).status).toBe(200)
    const got = await wait()
    expect(got.body).toMatchObject({ status: 'released', path: NOTE, contentHash: hash })
    expect(got.body.content).toContain(SECRET_WORD)
    // The same ask reads it again (a long note's next page), and never saves.
    expect((await wait()).body.content).toContain(SECRET_WORD)
    const save = await v1('POST', `/vault/notes/agent/ask/${ask.body.requestId}/save`, { token: ask.body.waitToken, content: 'x', expectedHash: hash }, AGENT)
    expect(save.body.code).toBe('not_approved')
    // A no gives nothing.
    const no = (await v1('POST', '/vault/notes/agent/ask', { path: NOTE, purpose: 'read it again' }, AGENT)).body
    const noCard = (await http('GET', '/api/v1/approvals')).body.approvals.find((a: { id: string }) => a.id === no.requestId)
    expect((await answer('deny', no.requestId, noCard.digest)).status).toBe(200)
    const denied = await v1('POST', `/vault/notes/agent/ask/${no.requestId}/wait`, { token: no.waitToken, wait_ms: 0 }, AGENT)
    expect(denied.status).toBe(403)
    expect(denied.body.code).toBe('denied')
    // A plain note is not asked for.
    expect((await v1('POST', '/vault/notes/agent/ask', { path: 'global-notes.md', purpose: 'read the notes' }, AGENT)).body.code).toBe('not_locked')
  })

  it('an agent saves it sealed under an approved edit ask, and Lock all ends that ask', async () => {
    const ask = (await v1('POST', '/vault/notes/agent/ask', { path: NOTE, purpose: 'fix a typo', access: 'edit' }, AGENT)).body
    const card = (await http('GET', '/api/v1/approvals')).body.approvals.find((a: { id: string }) => a.id === ask.requestId)
    expect(card.what).toContain('read and change')
    session = (await v1('POST', '/vault/unlock', { password: MASTER })).body.session.token
    // An unlock older than two minutes is not the master password typed for this yes.
    const realNow = Date.now
    const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 3 * 60_000)
    try {
      const stale = await v1('POST', `/approvals/${ask.requestId}/answer`, { decision: 'approve', digest: card.digest, device: { name: 'Web console', kind: 'web' } })
      expect(stale.status).toBe(401)
      expect(stale.body.code).toBe('master_password_needed')
    } finally {
      later.mockRestore()
    }
    expect((await v1('POST', `/approvals/${ask.requestId}/answer`, { decision: 'approve', digest: card.digest, device: { name: 'Web console', kind: 'web' } })).status).toBe(200)
    const got = (await v1('POST', `/vault/notes/agent/ask/${ask.requestId}/wait`, { token: ask.waitToken, wait_ms: 0 }, AGENT)).body
    expect(got.editUntil).toBeTruthy()
    const next = `${got.content}\nWednesday: an agent fixed this.\n`
    const saved = await v1('POST', `/vault/notes/agent/ask/${ask.requestId}/save`, { token: ask.waitToken, content: next, expectedHash: got.contentHash }, AGENT)
    expect(saved.status).toBe(200)
    hash = saved.body.contentHash
    expect(await file()).not.toContain('an agent fixed this')
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.content).toBe(next)
    // A save on older text is a conflict, never an overwrite.
    const stale = await v1('POST', `/vault/notes/agent/ask/${ask.requestId}/save`, { token: ask.waitToken, content: 'stale', expectedHash: got.contentHash }, AGENT)
    expect(stale.body.code).toBe('conflict')
    await v1('POST', '/vault/lock', { all: true })
    const after = await v1('POST', `/vault/notes/agent/ask/${ask.requestId}/save`, { token: ask.waitToken, content: 'after lock', expectedHash: hash }, AGENT)
    expect(after.status).toBe(404)
    session = (await v1('POST', '/vault/unlock', { password: MASTER })).body.session.token
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.content).toBe(next)
  })

  it('through a session\'s own Walnut tools: only from inside it, and no answer kept for a resend, `api` included', async () => {
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { addTask } = await import('../../src/core/task-manager.js')
    const { handleGatewayCapability } = await import('../../src/core/peers/capability-router.js')
    const { newCallId } = await import('../../src/lib/op-call-id.js')
    const { task } = await addTask({ title: 'Plan the week', project: 'Locked note tests' })
    const sid = crypto.randomUUID()
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME, { host: 'devbox', initialProcessStatus: 'idle' })
    // The real relay: a host's daemon passes the call on with its word on the process on its socket
    // (caller-proof-v1), and the server runs the op itself (capability-router.ts).
    const tool = (name: string, args: Record<string, unknown>, opts: { callId?: string; inside?: boolean } = {}) =>
      handleGatewayCapability('tools.call', sid, {
        name, args, client: 'mcp', callerProof: { v: 1, verified: opts.inside !== false, pid: 4242 }, ...(opts.callId ? { callId: opts.callId } : {}),
      }, 'devbox')
    const refusal = (r: Awaited<ReturnType<typeof tool>>) => (r.ok ? 'ok' : (r.error as { api?: { code?: string } }).api?.code)
    // Another process naming this session (a lead that read its history) is refused before the person is asked.
    expect(refusal(await tool('locked_note_ask', { path: NOTE, purpose: 'plan the week' }, { inside: false }))).toBe('unverified_session')
    const asked = await tool('locked_note_ask', { path: NOTE, purpose: 'plan the week' })
    expect(asked.ok, JSON.stringify(asked)).toBe(true)
    const { requestId, waitToken } = (asked.ok ? asked.result : {}) as { requestId: string; waitToken: string }
    const card = (await http('GET', '/api/v1/approvals')).body.approvals.find((a: { id: string }) => a.id === requestId)
    expect(card.what).toBe('Let the task "Plan the week" read your locked note "Diary"')
    session = (await v1('POST', '/vault/unlock', { password: MASTER })).body.session.token
    expect((await v1('POST', `/approvals/${requestId}/answer`, { decision: 'approve', digest: card.digest, device: { name: 'Web console', kind: 'web' } })).status).toBe(200)
    expect(refusal(await tool('locked_note_wait', { id: requestId, token: waitToken, wait_ms: 0 }, { inside: false }))).toBe('unverified_session')
    // The text, through `api` and through the named op, each under a call id: op_result holds neither.
    const viaApi = { method: 'POST', path: `/api/v1/vault/notes/agent/ask/${requestId}/wait`, body: { token: waitToken, wait_ms: 0 } }
    const calls: Array<[string, Record<string, unknown>, string]> = [
      ['api', viaApi, newCallId()],
      ['locked_note_wait', { id: requestId, token: waitToken, wait_ms: 0 }, newCallId()],
    ]
    for (const [name, args, callId] of calls) {
      const r = await tool(name, args, { callId })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(JSON.stringify(r), name).toContain(SECRET_WORD)
      const read = await v1('GET', `/op-calls/${callId}`, undefined, { 'x-walnut-caller-sid': sid })
      expect(read.body, name).toMatchObject({ state: 'done', not_kept: expect.stringContaining('never lets its answer be kept') })
      expect(JSON.stringify(read.body), name).not.toContain(SECRET_WORD)
    }
    // After Lock all a resend under the same id runs again, and its route gives nothing.
    await v1('POST', '/vault/lock', { all: true })
    for (const [name, args, callId] of calls) {
      const again = await tool(name, args, { callId })
      expect(again.ok, name).toBe(false)
      expect(JSON.stringify(again), name).not.toContain(SECRET_WORD)
    }
    session = (await v1('POST', '/vault/unlock', { password: MASTER })).body.session.token
  })

  it('opens again after Lock all, a restart and a new master password', async () => {
    await v1('POST', '/vault/lock', { all: true })
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).status).toBe(401)
    session = (await v1('POST', '/vault/unlock', { password: MASTER })).body.session.token
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.content).toContain(SECRET_WORD)
    resetVaultForTest(null)
    resetSessionsForTest()
    session = (await v1('POST', '/vault/unlock', { password: MASTER })).body.session.token
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.content).toContain(SECRET_WORD)
    const changed = await v1('POST', '/vault/password', { oldPassword: MASTER, newPassword: 'a whole new locked phrase' })
    expect(changed.status).toBe(200)
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.content).toContain(SECRET_WORD)
    resetVaultForTest(null)
    resetSessionsForTest()
    session = ''
    expect((await v1('POST', '/vault/unlock', { password: MASTER })).body.code).toBe('wrong_password')
    session = (await v1('POST', '/vault/unlock', { password: 'a whole new locked phrase' })).body.session.token
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.content).toContain(SECRET_WORD)
  })

  it('removing the lock puts the text back in the file, which reads as a plain note again', async () => {
    const cur = (await v1('POST', '/vault/notes/read', { path: NOTE })).body
    const r = await v1('POST', '/vault/notes/remove-lock', { path: NOTE, expectedHash: cur.contentHash })
    expect(r.status).toBe(200)
    expect(await file()).toBe(cur.content)
    const plain = await http('GET', `/api/notes-v2/content/${NOTE}`)
    expect(plain.body.locked).toBeUndefined()
    expect(plain.body.content).toContain(SECRET_WORD)
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.code).toBe('not_locked')
    // A plain note is written as before.
    expect((await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: `${cur.content}more\n` })).status).toBe(200)
  })
})
