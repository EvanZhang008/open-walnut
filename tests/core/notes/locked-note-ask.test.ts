/**
 * An agent's ask for a locked note (src/core/notes/locked-note-ask.ts): it always makes an approval,
 * gives the text only after a yes, lets the same ask read again inside its window, lets only an
 * "edit" ask save and only from the task that asked, keeps its asks across a restart, and Lock all
 * ends every one of them. The approvals and the note are fakes here; the routes are in
 * tests/e2e/locked-notes.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-locked-note-ask'))

import {
  askLockedNote, waitLockedNote, saveLockedNoteForAgent, cancelLockedNoteAsk, endAllLockedNoteAsks,
  resetLockedNoteAsksForTest, EDIT_MS, READ_MS, type AskDeps,
} from '../../../src/core/notes/locked-note-ask.js'
import { flushKept, forgetKeptForRestart } from '../../../src/core/kept-asks.js'

const TEXT = '# Private\nOnly mine.\n'
const TASK = { host: 'local', taskId: 't-1', taskTitle: 'Plan the week', sessionId: 's-1' }
const OTHER = { host: 'local', taskId: 't-2', sessionId: 's-2' }

function fake() {
  let clock = 1_000_000
  const status = new Map<string, 'pending' | 'approved' | 'denied' | 'expired' | 'canceled'>()
  const made: Array<{ what: string; detail: string }> = []
  const saves: string[] = []
  /** The id of the locked note at a path (a test swaps one in). */
  const ids = new Map<string, string>()
  let n = 0
  const deps: AskDeps = {
    async askPerson(input) {
      const id = `ap-${++n}`
      status.set(id, 'pending')
      made.push({ what: input.what, detail: input.detail })
      return { id, waitToken: `tok-${id}`, expiresAt: new Date(clock + 600_000).toISOString() }
    },
    async waitApproval(id) { return { status: status.get(id) ?? 'expired', answeredBy: 'Web console' } },
    async cancelApproval(id) { status.set(id, 'canceled') },
    async read(path) { return { path, content: TEXT, contentHash: 'h1', updatedAt: 'now' } },
    async save(path, content) { saves.push(String(content)); return { path, contentHash: 'h2', updatedAt: 'now' } },
    async lockedNoteId(path) { return path === 'plain.md' ? null : (ids.get(path) ?? `n_${path}`) },
    now: () => clock,
  }
  return { deps, status, made, saves, ids, tick: (ms: number) => { clock += ms } }
}

beforeEach(() => resetLockedNoteAsksForTest())

describe('an agent asking for a locked note', () => {
  it('always asks, says why and what a yes allows, and gives nothing before the yes', async () => {
    const f = fake()
    const r = await askLockedNote({ path: 'journal/Diary', purpose: 'summarise this week', requester: TASK }, f.deps)
    expect(r).toMatchObject({ status: 'pending', path: 'journal/Diary.md', access: 'read' })
    expect(f.made[0].what).toBe('Let the task "Plan the week" read your locked note "Diary"')
    expect(f.made[0].detail).toContain('Why: summarise this week')
    expect(f.made[0].detail).toContain('master password')
    const w = await waitLockedNote(r.requestId, r.waitToken, 0, TASK, f.deps)
    expect(w).toEqual({ status: 'pending', requestId: r.requestId })
    expect(JSON.stringify(w)).not.toContain('Only mine')
  })

  it('refuses a plain note, a missing purpose and a wrong token', async () => {
    const f = fake()
    await expect(askLockedNote({ path: 'plain.md', purpose: 'read it', requester: TASK }, f.deps)).rejects.toMatchObject({ code: 'not_locked' })
    await expect(askLockedNote({ path: 'a.md', purpose: '', requester: TASK }, f.deps)).rejects.toMatchObject({ code: 'purpose_required' })
    const r = await askLockedNote({ path: 'a.md', purpose: 'read it please', requester: TASK }, f.deps)
    await expect(waitLockedNote(r.requestId, 'tok-wrong', 0, TASK, f.deps)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a yes gives the text, the same ask reads it again inside its window, and never after', async () => {
    const f = fake()
    const r = await askLockedNote({ path: 'a.md', purpose: 'read it please', requester: TASK }, f.deps)
    f.status.set(r.requestId, 'approved')
    const w = await waitLockedNote(r.requestId, r.waitToken, 0, TASK, f.deps)
    expect(w).toMatchObject({ status: 'released', content: TEXT, contentHash: 'h1', approvedOn: 'Web console' })
    expect(w).not.toHaveProperty('editUntil')
    f.tick(READ_MS - 1_000)
    expect(await waitLockedNote(r.requestId, r.waitToken, 0, TASK, f.deps)).toMatchObject({ status: 'released', content: TEXT })
    f.tick(2_000)
    await expect(waitLockedNote(r.requestId, r.waitToken, 0, TASK, f.deps)).rejects.toMatchObject({ code: 'read_ended' })
    // A read ask never saves.
    const r2 = await askLockedNote({ path: 'a.md', purpose: 'read it again', requester: TASK }, f.deps)
    f.status.set(r2.requestId, 'approved')
    await waitLockedNote(r2.requestId, r2.waitToken, 0, TASK, f.deps)
    await expect(saveLockedNoteForAgent(r2.requestId, r2.waitToken, 'x', 'h1', TASK, f.deps)).rejects.toMatchObject({ code: 'not_approved' })
    expect(f.saves).toEqual([])
  })

  it('an edit ask saves only from the task that asked, and only inside its window', async () => {
    const f = fake()
    const r = await askLockedNote({ path: 'a.md', purpose: 'fix a typo', access: 'edit', requester: TASK }, f.deps)
    expect(f.made[0].what).toContain('read and change')
    await expect(saveLockedNoteForAgent(r.requestId, r.waitToken, 'x', 'h1', TASK, f.deps)).rejects.toMatchObject({ code: 'not_approved' })
    f.status.set(r.requestId, 'approved')
    expect(await waitLockedNote(r.requestId, r.waitToken, 0, TASK, f.deps)).toHaveProperty('editUntil')
    await expect(saveLockedNoteForAgent(r.requestId, r.waitToken, 'x', 'h1', OTHER, f.deps)).rejects.toMatchObject({ code: 'not_your_ask' })
    expect(await saveLockedNoteForAgent(r.requestId, r.waitToken, 'new text', 'h1', TASK, f.deps)).toMatchObject({ contentHash: 'h2' })
    f.tick(EDIT_MS + 1)
    await expect(saveLockedNoteForAgent(r.requestId, r.waitToken, 'later', 'h2', TASK, f.deps)).rejects.toMatchObject({ code: 'edit_ended' })
    expect(f.saves).toEqual(['new text'])
  })

  it('a no refuses, and three no in half an hour pause the asker', async () => {
    const f = fake()
    for (let i = 0; i < 3; i++) {
      const r = await askLockedNote({ path: 'a.md', purpose: `try number ${i}`, requester: TASK }, f.deps)
      f.status.set(r.requestId, 'denied')
      await expect(waitLockedNote(r.requestId, r.waitToken, 0, TASK, f.deps)).rejects.toMatchObject({ status: 403, code: 'denied' })
    }
    await expect(askLockedNote({ path: 'a.md', purpose: 'once more', requester: TASK }, f.deps)).rejects.toMatchObject({ code: 'agent_paused' })
    // Another task is not paused by this one's denials.
    expect(await askLockedNote({ path: 'a.md', purpose: 'mine to ask', requester: OTHER }, f.deps)).toMatchObject({ status: 'pending' })
  })

  it('at most two asks wait per task', async () => {
    const f = fake()
    await askLockedNote({ path: 'a.md', purpose: 'first ask', requester: TASK }, f.deps)
    await askLockedNote({ path: 'b.md', purpose: 'second ask', requester: TASK }, f.deps)
    await expect(askLockedNote({ path: 'c.md', purpose: 'third ask', requester: TASK }, f.deps)).rejects.toMatchObject({ code: 'too_many_asks' })
  })

  it('an ask survives a restart: the same id and token wait for the same yes', async () => {
    const f = fake()
    const r = await askLockedNote({ path: 'a.md', purpose: 'across a deploy', access: 'edit', requester: TASK }, f.deps)
    await flushKept()
    forgetKeptForRestart()
    f.status.set(r.requestId, 'approved')
    expect(await waitLockedNote(r.requestId, r.waitToken, 0, TASK, f.deps)).toMatchObject({ status: 'released', content: TEXT })
    await flushKept()
    forgetKeptForRestart()
    expect(await saveLockedNoteForAgent(r.requestId, r.waitToken, 'after restart', 'h1', TASK, f.deps)).toMatchObject({ contentHash: 'h2' })
  })

  it('Lock all ends every ask, waiting or approved, and a wait that began before it gives nothing', async () => {
    const f = fake()
    const a = await askLockedNote({ path: 'a.md', purpose: 'waiting one', requester: TASK }, f.deps)
    const b = await askLockedNote({ path: 'b.md', purpose: 'edit one', access: 'edit', requester: OTHER }, f.deps)
    f.status.set(b.requestId, 'approved')
    await waitLockedNote(b.requestId, b.waitToken, 0, OTHER, f.deps)
    // A wait in flight when Lock all comes: the approval answers yes, but nothing is given.
    let release!: () => void
    const slow: AskDeps = { ...f.deps, waitApproval: async () => { await new Promise<void>((r) => { release = r }); return { status: 'approved' } } }
    const inFlight = waitLockedNote(a.requestId, a.waitToken, 10_000, TASK, slow)
    await new Promise((r) => setTimeout(r, 0))
    expect(endAllLockedNoteAsks().sort()).toEqual([a.requestId, b.requestId].sort())
    release()
    await expect(inFlight).rejects.toMatchObject({ code: 'withdrawn' })
    await expect(saveLockedNoteForAgent(b.requestId, b.waitToken, 'x', 'h1', OTHER, f.deps)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('only the task that asked reads, and only the note it asked for', async () => {
    const f = fake()
    const r = await askLockedNote({ path: 'a.md', purpose: 'read it please', requester: TASK }, f.deps)
    f.status.set(r.requestId, 'approved')
    await expect(waitLockedNote(r.requestId, r.waitToken, 0, OTHER, f.deps)).rejects.toMatchObject({ code: 'not_your_ask' })
    expect(await waitLockedNote(r.requestId, r.waitToken, 0, TASK, f.deps)).toMatchObject({ status: 'released' })
    // Another locked note moved to the same path: the yes was not for it.
    f.ids.set('a.md', 'n_other')
    await expect(waitLockedNote(r.requestId, r.waitToken, 0, TASK, f.deps)).rejects.toMatchObject({ code: 'note_changed' })
    // And a swap before the yes is read gives nothing either.
    const r2 = await askLockedNote({ path: 'b.md', purpose: 'read it please', requester: TASK }, f.deps)
    f.status.set(r2.requestId, 'approved')
    f.ids.set('b.md', 'n_swapped')
    await expect(waitLockedNote(r2.requestId, r2.waitToken, 0, TASK, f.deps)).rejects.toMatchObject({ code: 'note_changed' })
  })

  it('cancel withdraws the approval', async () => {
    const f = fake()
    const r = await askLockedNote({ path: 'a.md', purpose: 'not needed now', requester: TASK }, f.deps)
    await cancelLockedNoteAsk(r.requestId, r.waitToken, f.deps)
    expect(f.status.get(r.requestId)).toBe('canceled')
    await expect(waitLockedNote(r.requestId, r.waitToken, 0, TASK, f.deps)).rejects.toMatchObject({ code: 'not_found' })
  })
})
