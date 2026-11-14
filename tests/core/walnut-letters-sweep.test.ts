/**
 * The sweep that settles Walnut's own letters nobody needs any more
 * (src/core/human-inbox/walnut-letters/sweep.ts), on the host grant asks it was written for
 * (2026-11-02: "Let ... use the Mac?" letters stayed open after tasks on the user's own hosts
 * stopped needing a grant, and were closed by hand).
 *
 * Real letter store, task store and grants file in an isolated WALNUT_HOME; where tasks run and
 * which hosts are the user's own are stubbed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import type { SessionRecord } from '../../src/core/types.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-letters-sweep'))
/** Where each task's latest session runs. */
const runsOn = new Map<string, string>()
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: async (id: string) => (runsOn.has(id)
    ? [{ claudeSessionId: `s-${id}`, taskId: id, host: runsOn.get(id), lastActiveAt: new Date().toISOString() } as unknown as SessionRecord]
    : []),
  // The asking session of an old ask is gone.
  getSessionByClaudeId: async () => null,
}))
vi.mock('../../src/core/hosts/host-exec.js', () => ({ isOwnHost: async (h: string) => h === '__local__' || h === 'devbox' }))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask, completeTask } from '../../src/core/task-manager.js'
import { answerLetter, getLetter, sendLetter } from '../../src/core/human-inbox/store.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { findGrant, grant, recordAsk, setExecGrantsFileForTest } from '../../src/core/hosts/exec-grants.js'
import { settleUnneededWalnutLetters } from '../../src/core/human-inbox/walnut-letters/sweep.js'
import { HOST_EXEC_ASK } from '../../src/core/human-inbox/walnut-letters/host-exec-ask.js'
import { letterOpKey } from '../../src/core/human-inbox/walnut-letters/kind.js'

const HOUR = 3_600_000
const OCT_31 = Date.parse('2026-10-31T22:05:58Z')

/** A grant letter as Walnut wrote it before the kind mark (English, no createdByOp). */
const oldAsk = (title: string, taskId: string, target = 'the Mac') => sendLetter({
  subject: `Let "${title}" use ${target}?`, type: 'action_required',
  markdown: `The task **${title}**, running on Dev box, wants to use **${target}**.`,
  actions: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
  taskRefs: [taskId], sender: { sessionId: 'external', host: 'local' },
}, { createdAt: OCT_31 })

/** One the new code writes: marked with its host and task. */
const newAsk = (title: string, taskId: string, host: string, createdAt = Date.now() - HOUR) => {
  const r = HOST_EXEC_ASK.render('en', { title, from: 'Stranger box', target: host === '__local__' ? null : host, preview: 'ls' })
  return sendLetter({
    subject: r.subject, type: 'action_required', markdown: r.markdown, actions: r.actions,
    taskRefs: [taskId], sender: { sessionId: 'external', host: 'local' },
  }, { opKey: letterOpKey(HOST_EXEC_ASK.id, host, taskId, createdAt.toString(36)), createdAt })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  setExecGrantsFileForTest(path.join(WALNUT_HOME, 'grants-test.json'))
})
afterAll(async () => {
  setExecGrantsFileForTest(null)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})
beforeEach(() => { runsOn.clear() })

describe('settling Walnut letters nobody needs', () => {
  it('an old English ask whose ask record lacks a from host is granted and settled; one still needed is kept; an answered one is untouched', async () => {
    const own = (await addTask({ title: 'Org page: a Threads tab' })).task
    const bare = (await addTask({ title: 'Fleet capabilities' })).task
    const stranger = (await addTask({ title: 'Run on the stranger box' })).task
    const answered = (await addTask({ title: 'Answered already' })).task
    runsOn.set(own.id, 'devbox').set(bare.id, 'devbox').set(stranger.id, 'strangerbox').set(answered.id, 'strangerbox')

    // Written before 2026-11-01: no fromHost, and the asking session's record is gone.
    const ownLetter = await oldAsk(own.title, own.id)
    await recordAsk({ taskId: own.id, host: '__local__', letterId: ownLetter.id, askedAt: OCT_31, sid: 'gone-sid', state: 'pending' })
    // Its ask record is gone (rewritten away, replaced): an Allow on it would grant nothing.
    const bareLetter = await oldAsk(bare.title, bare.id, 'Cloud')
    // Still asking: a task on a host the user did not register.
    const strangerLetter = await newAsk(stranger.title, stranger.id, '__local__')
    await recordAsk({ taskId: stranger.id, host: '__local__', letterId: strangerLetter.id, askedAt: Date.now() - HOUR, sid: 's-x', fromHost: 'strangerbox', state: 'pending' })
    const answeredLetter = await oldAsk(answered.title, answered.id)
    await answerLetter(answeredLetter.id, { actionId: 'allow' })
    // Not Walnut's: a session's own letter with the same subject shape.
    const sessions = await sendLetter({
      subject: `Let "${own.title}" use the Mac?`, type: 'action_required', markdown: 'mine',
      actions: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }], sender: { sessionId: 's-mine', host: 'local', taskId: own.id },
    }, { createdAt: OCT_31 })

    const settled = await settleUnneededWalnutLetters()
    expect(settled.map((s) => s.id).sort()).toEqual([bareLetter.id].sort())
    // The ask path's own rule ran for the old ask: granted, and the letter settled for the user.
    expect(findGrant(own.id, '__local__')).toMatchObject({ via: 'own-host', letterId: ownLetter.id })
    expect((await getLetter(ownLetter.id))!.settled!.reason).toMatch(/your own hosts/)
    expect((await getLetter(ownLetter.id))!.archivedReason).toBe('settled')
    expect((await getLetter(bareLetter.id))!.settled!.reason).toMatch(/own hosts/)
    expect((await getLetter(strangerLetter.id))!.settled).toBeUndefined()
    expect((await getLetter(strangerLetter.id))!.archived).toBe(false)
    expect((await getLetter(answeredLetter.id))!.settled).toBeUndefined()
    expect((await getLetter(answeredLetter.id))!.answered).toMatchObject({ actionId: 'allow' })
    expect((await getLetter(sessions.id))!.archived).toBe(false)

    // Nothing more to do on the next pass.
    expect(await settleUnneededWalnutLetters()).toEqual([])
  })

  it('a completed or deleted task, a grant made in Settings, and an ask Walnut no longer holds settle; a fresh letter waits for its record', async () => {
    const done = (await addTask({ title: 'Shipped' })).task
    const settings = (await addTask({ title: 'Allowed in Settings' })).task
    const orphan = (await addTask({ title: 'Nobody holds this' })).task
    const fresh = (await addTask({ title: 'Just asked' })).task
    for (const t of [done, settings, orphan, fresh]) runsOn.set(t.id, 'strangerbox')
    const doneLetter = await newAsk(done.title, done.id, 'devbox')
    await recordAsk({ taskId: done.id, host: 'devbox', letterId: doneLetter.id, askedAt: Date.now() - HOUR, sid: 's', fromHost: 'strangerbox', state: 'pending' })
    await completeTask(done.id)
    const settingsLetter = await newAsk(settings.title, settings.id, 'devbox')
    await recordAsk({ taskId: settings.id, host: 'devbox', letterId: settingsLetter.id, askedAt: Date.now() - HOUR, sid: 's', fromHost: 'strangerbox', state: 'pending' })
    const orphanLetter = await newAsk(orphan.title, orphan.id, 'devbox')
    const freshLetter = await newAsk(fresh.title, fresh.id, 'devbox', Date.now())

    // The user allows it in Settings: the letter still asking for it is answered for him at once.
    await grant(settings.id, 'devbox', 'settings')
    expect((await getLetter(settingsLetter.id))!.settled!.reason).toMatch(/Already allowed/)

    const settled = new Map((await settleUnneededWalnutLetters()).map((s) => [s.id, s.reason]))
    expect(settled.get(doneLetter.id)).toMatch(/its task is complete/)
    expect(settled.get(orphanLetter.id)).toMatch(/no longer waits on this answer/)
    expect(settled.has(freshLetter.id)).toBe(false)
    expect((await getLetter(freshLetter.id))!.archived).toBe(false)
  })

  it('an open letter of a kind Walnut sends no more settles; a session\'s letter with the same subject is kept', async () => {
    // Walnut wrote these until 2026-11-02; a failing trigger now tells its task or that task's lead.
    const subject = 'Trigger "New replies arrived in the ask threads..." stopped after 5 failed checks'
    const old = await sendLetter({ subject, type: 'review', markdown: 'Its check failed 5 times in a row.', sender: { sessionId: 'external', host: 'local' } }, { createdAt: OCT_31 })
    const t = (await addTask({ title: 'Watcher' })).task
    const mine = await sendLetter({ subject, type: 'review', markdown: 'mine', sender: { sessionId: 's-w', host: 'local', taskId: t.id } }, { createdAt: OCT_31 })
    const settled = new Map((await settleUnneededWalnutLetters()).map((s) => [s.id, s.reason]))
    expect(settled.get(old.id)).toMatch(/no longer writes letters about triggers/)
    expect((await getLetter(old.id))!.archivedReason).toBe('settled')
    expect(settled.has(mine.id)).toBe(false)
    expect((await getLetter(mine.id))!.archived).toBe(false)
  })

  it('settles in the user\'s letter language', async () => {
    await updateConfig({ session: { reply_language: 'Talk to the user in Chinese; code stays English' } } as never)
    try {
      const t = (await addTask({ title: 'Chinese user' })).task
      runsOn.set(t.id, 'devbox')
      const l = await oldAsk(t.title, t.id, 'Cloud')
      const [s] = await settleUnneededWalnutLetters()
      expect(s).toMatchObject({ id: l.id })
      // Simplified Chinese test data ("no longer needed"), written as escapes.
      expect(s.reason).toContain('\u4e0d\u518d\u9700\u8981')
    } finally {
      await updateConfig({ session: { reply_language: '' } } as never)
    }
  })
})
