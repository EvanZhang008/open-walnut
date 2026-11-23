/**
 * A member never loses a topic post (2026-11-23, the user: no message is ever lost, and an error
 * keeps retrying). src/core/topics/topic-delivery.ts folds a post that does not wake a member into
 * a held notice for its next message and moves its readUpto at once, so:
 *  - the fold is `whole`: no age limit (HOLD_MAX_MS) or fold cap (FOLD_PARTS_MAX) drops it;
 *  - a member session gone with none going on gives its folds back to the topic before the sweep
 *    drops them (returnFoldsUnread): readUpto goes back, each message says why, and the member's
 *    next fold carries them again;
 *  - while that cannot be written the fold is kept, and the next lap tries again, while every other
 *    notice held for that session goes now (a note's fate says so);
 *  - a delivery that read the topic before the return never moves readUpto forward past it;
 *  - readUpto moves only once the fold is on disk;
 *  - once the member reads them, the messages' FOLD_GONE_WHY marks go.
 * Real topic, task and session stores in a temp WALNUT_HOME; the session send is replaced.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-topic-fold-never-lost'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import {
  FOLD_PARTS_MAX, HOLD_MAX_MS, _clearHeldNotices, heldNoteState, heldNoticeKeys, holdFoldedNotice, pendingHeldNotices,
} from '../../../src/core/sessions/held-notices.js'
import { held as heldStore } from '../../../src/core/sessions/held-notices-store.js'
import { startHeldNotices, stopHeldNotices, sweepHeldNotices } from '../../../src/core/sessions/held-notices-sweep.js'
import { _setTopicSendForTesting, returnFoldsUnread } from '../../../src/core/topics/topic-delivery.js'
import { FOLD_GONE_WHY } from '../../../src/core/topics/topic-reasons.js'
import { _resetTopicRepliesForTesting } from '../../../src/core/topics/topic-replies.js'
import { createTopic, postMessage } from '../../../src/core/topics/topic-post.js'
import { readTopic } from '../../../src/core/topics/topics-store.js'
import type { Topic, TopicMember } from '../../../src/core/topics/topics-model.js'

const ids: Record<string, string> = {}
let topic: Topic
const byName = (t: Topic, name: string): TopicMember => t.members.find((m) => m.name === name)!

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await updateConfig({ experimental: { topics: true }, user: { name: 'Robin' } } as never)
  for (const title of ['Marina', 'Orchard']) ids[title] = (await addTask({ title, project: 'Acme' })).task.id
  for (const title of ['Marina', 'Orchard']) {
    await createSessionRecord(`s-${title.toLowerCase()}`, ids[title], 'Acme', undefined, { initialProcessStatus: 'idle' })
  }
  _setTopicSendForTesting(async () => {})
  _resetTopicRepliesForTesting()
  _clearHeldNotices()
  await startHeldNotices()
  topic = (await createTopic({
    title: 'Launch plan', members: ['Marina', 'Orchard'].map((t) => ({ kind: 'task' as const, taskId: ids[t] })), by: 'human',
  })).topic
})

afterAll(async () => {
  _setTopicSendForTesting(null)
  await stopHeldNotices()
  _clearHeldNotices()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

/** Marina posts `n` lines with no @mention: each folds into Orchard's next message. */
async function marinaPosts(n: number, label: string): Promise<string[]> {
  const marina = byName((await readTopic(topic.id))!, 'Marina')
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push((await postMessage(topic.id, { author: marina.id, text: `${label} ${i}`, via: 'agent' })).message.id)
  }
  return out
}

describe('a topic post folded for a member is never lost', () => {
  it('no age limit or fold cap drops it: every post rides the member\'s next message', async () => {
    const n = FOLD_PARTS_MAX + 3
    const posted = await marinaPosts(n, 'Fold line')
    const late = Date.now() + 2 * HOLD_MAX_MS
    // Orchard's session is there: nothing moves or goes, however old.
    await sweepHeldNotices(late)
    const held = (await pendingHeldNotices('s-orchard', late))!
    for (let i = 0; i < n; i++) expect(held.text).toContain(`Fold line ${i}<`)
    expect(held.text).not.toMatch(/older lines? not shown/)
    held.markTold()
    expect(byName((await readTopic(topic.id))!, 'Orchard').readUpto).toBe(posted.at(-1))
  })

  it('its session gone with none going on: the posts go back to the topic unread, say why, and ride the next fold', async () => {
    const before = byName((await readTopic(topic.id))!, 'Orchard').readUpto
    const posted = await marinaPosts(3, 'Gone line')
    expect(byName((await readTopic(topic.id))!, 'Orchard').readUpto).toBe(posted.at(-1))
    // A task's note waits for the same session.
    await holdFoldedNotice('s-orchard', 'quiet-note:sender', { at: Date.now(), mid: 'qm-gone', from: 'sid-sender', task: ids.Orchard, title: 'Side note', whole: true, text: 'hi' },
      (parts) => parts.map((p) => p.text).join('\n'))
    await updateSessionRecord('s-orchard', { archived: true } as never)

    // While the topic cannot be written, the fold stays and the lap after tries again; the note goes now.
    const dir = path.join(WALNUT_HOME, 'topics')
    await sweepHeldNotices()
    await fs.chmod(dir, 0o500)
    try {
      await sweepHeldNotices()
      expect(heldNoticeKeys('s-orchard')).toEqual([`topic:${topic.id}`])
      expect(await heldNoteState('qm-gone')).toMatchObject({ state: 'dropped', session_id: 's-orchard' })
    } finally {
      await fs.chmod(dir, 0o700)
    }
    expect(byName((await readTopic(topic.id))!, 'Orchard').readUpto).toBe(posted.at(-1))

    await sweepHeldNotices()
    expect(heldNoticeKeys('s-orchard')).toEqual([])
    const t = (await readTopic(topic.id))!
    const orchard = byName(t, 'Orchard')
    expect(orchard.readUpto).toBe(before)
    for (const id of posted) {
      expect(t.messages.find((m) => m.id === id)!.refused).toEqual([{ member: orchard.id, why: FOLD_GONE_WHY }])
    }

    // Orchard's task has a session again: the next fold carries the returned posts with the new one.
    await updateSessionRecord('s-orchard', { archived: false } as never)
    const next = await marinaPosts(1, 'After line')
    const held = (await pendingHeldNotices('s-orchard'))!
    for (let i = 0; i < 3; i++) expect(held.text).toContain(`Gone line ${i}<`)
    expect(held.text).toContain('After line 0<')
    held.markTold()
    const after = (await readTopic(topic.id))!
    expect(byName(after, 'Orchard').readUpto).toBe(next[0])
    // Read now: the marks are gone.
    for (const id of posted) expect(after.messages.find((m) => m.id === id)!.refused).toBeUndefined()
  })

  it('a delivery that read the topic before its folds went back never moves readUpto past them', async () => {
    const race = await marinaPosts(3, 'Race line')
    const parts = heldStore.get('s-orchard')!.get(`topic:${topic.id}`)!.parts!
    // The sweep gives the folds back while the user's message is being delivered (it read the topic first).
    let returned = false
    _setTopicSendForTesting(async (sid) => {
      if (sid === 's-orchard' && !returned) { returned = true; expect(await returnFoldsUnread(parts)).toEqual(new Set()) }
    })
    try {
      await postMessage(topic.id, { author: 'human', text: 'Wake all', via: 'ui' })
    } finally {
      _setTopicSendForTesting(async () => {})
    }
    expect(returned).toBe(true)
    let t = (await readTopic(topic.id))!
    const beforeRace = t.messages[t.messages.findIndex((m) => m.id === race[0]) - 1].id
    expect(byName(t, 'Orchard').readUpto).toBe(beforeRace)
    ;(await pendingHeldNotices('s-orchard'))!.markTold()

    // The next fold carries every race line again, and readUpto moves on.
    const last = await marinaPosts(1, 'Catch up')
    const held = (await pendingHeldNotices('s-orchard'))!
    for (let i = 0; i < 3; i++) expect(held.text).toContain(`Race line ${i}<`)
    expect(held.text).toContain('Wake all<')
    held.markTold()
    t = (await readTopic(topic.id))!
    expect(byName(t, 'Orchard').readUpto).toBe(last[0])
    for (const id of race) expect(t.messages.find((m) => m.id === id)!.refused).toBeUndefined()
  })

  it('a fold that could not be saved leaves readUpto where it was', async () => {
    const start = byName((await readTopic(topic.id))!, 'Orchard').readUpto
    const cache = path.join(WALNUT_HOME, 'cache')
    await fs.chmod(cache, 0o500)
    let unsaved: string[]
    try {
      unsaved = await marinaPosts(1, 'Unsaved line')
    } finally {
      await fs.chmod(cache, 0o700)
    }
    expect(byName((await readTopic(topic.id))!, 'Orchard').readUpto).toBe(start)
    const saved = await marinaPosts(1, 'Saved line')
    expect(byName((await readTopic(topic.id))!, 'Orchard').readUpto).toBe(saved[0])
    const held = (await pendingHeldNotices('s-orchard'))!
    expect(held.text).toContain('Unsaved line 0<')
    expect(held.text).toContain('Saved line 0<')
    held.markTold()
    expect(unsaved.length).toBe(1)
  })
})
