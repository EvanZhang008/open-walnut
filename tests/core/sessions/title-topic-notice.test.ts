/**
 * A title that gains a second topic is never renamed silently (src/core/sessions/title-topic-notice.ts,
 * called from applyTitleDirective in src/core/session-hooks/builtins.ts). The two real cases of
 * 2026-11-16, with neutral names: a code review's task became "<title> · Outage Poller Fix" after a
 * lead handed it an outage fix, and a logo redesign's task became "<title> · Website Launch" after a
 * website launch was merged into it. The task and the task that last sent it work each get
 * one quiet note (wake:false), with the task's deliverable quoted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { tasks, sends } = vi.hoisted(() => ({
  tasks: new Map<string, Record<string, unknown>>(),
  sends: [] as Array<Record<string, unknown>>,
}))
vi.mock('../../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => { const t = tasks.get(id); if (!t) throw new Error('missing'); return t },
  updateTask: async (id: string, patch: Record<string, unknown>) => ({ task: { ...tasks.get(id), ...patch } }),
}))
vi.mock('../../../src/core/sessions/session-send-core.js', () => ({
  performSessionSend: async (input: Record<string, unknown>) => { sends.push(input); return { delivery: 'held' } },
}))

import { noticeTitleTopic, TITLE_TOPIC_SOURCE, titleTopicNotes } from '../../../src/core/sessions/title-topic-notice.js'
import { _resetLeadTrafficForTesting, noteSent, notePeerNote } from '../../../src/core/org/lead-traffic.js'
import { applyTitleDirective } from '../../../src/core/session-hooks/builtins.js'

const LOGO = 'mlogo001-aaaa'
const LEAD = 'mlead001-aaaa'
const REVIEW = 'mrev00001-aaa'

beforeEach(() => {
  tasks.clear(); sends.length = 0; _resetLeadTrafficForTesting()
  tasks.set(LOGO, { id: LOGO, title: 'Logo redesign for the bakery', phase: 'IN_PROGRESS',
    note: '## User Request\nRedesign the bakery logo in two colours.' })
  tasks.set(LEAD, { id: LEAD, title: 'Design VP', phase: 'IN_PROGRESS', org_role: 'lead' })
  tasks.set(REVIEW, { id: REVIEW, title: 'CR: router poller ListBucket', phase: 'IN_PROGRESS',
    note: '## User Request\nCR 1 adds only s3:ListBucket; CR 2 adds alarm dimensions.' })
})

describe('a self-report that appends a topic tells the task and its latest sender', () => {
  it('the logo task that gained "Website Launch" after the lead\'s message', async () => {
    notePeerNote(LEAD, LOGO)
    tasks.get(LOGO)!.title = 'Logo redesign for the bakery'
    await applyTitleDirective(LOGO, 'topic: Website Launch', 'Logo redesign for the bakery')
    expect(sends).toHaveLength(2)
    const [toTask, toLead] = sends
    expect(toTask).toMatchObject({ to: LOGO, wake: false, source: TITLE_TOPIC_SOURCE })
    expect(toTask.text).toContain('Walnut added the topic "Website Launch" to your title: "Logo redesign for the bakery · Website Launch"')
    expect(toTask.text).toContain('Your deliverable: "Redesign the bakery logo in two colours."')
    expect(toTask.text).toContain(`"Design VP" (${LEAD}), which last sent you work`)
    expect(toLead).toMatchObject({ to: LEAD, wake: false, source: TITLE_TOPIC_SOURCE })
    expect(toLead.text).toContain('If you gave it a different deliverable, task_create that work')
  })

  it('the code review that gained "Outage Poller Fix"; with no known sender only the task hears', async () => {
    await applyTitleDirective(REVIEW, 'topic: Outage Poller Fix', 'CR: router poller ListBucket')
    expect(sends).toHaveLength(1)
    expect(sends[0].to).toBe(REVIEW)
    expect(sends[0].text).toContain('tell whoever handed it to you that it belongs in a task of its own')
  })

  it('a rewrite, an unchanged title and a covered topic tell nobody', async () => {
    notePeerNote(LEAD, REVIEW)
    await applyTitleDirective(REVIEW, 'rewrite: Router poller read access', 'CR: router poller ListBucket')
    await applyTitleDirective(REVIEW, 'unchanged', 'CR: router poller ListBucket')
    await applyTitleDirective(REVIEW, 'topic: Poller ListBucket', 'CR: router poller ListBucket')
    expect(sends).toHaveLength(0)
  })

  it('a sender older than the window, or complete, is not told', async () => {
    notePeerNote(LEAD, LOGO, Date.now() - 7 * 3600_000)
    await noticeTitleTopic({ taskId: LOGO, from: 'a', to: 'a · B', topic: 'B' })
    expect(sends.map((s) => s.to)).toEqual([LOGO])
    sends.length = 0
    notePeerNote(LEAD, LOGO)
    tasks.get(LEAD)!.phase = 'COMPLETE'
    await noticeTitleTopic({ taskId: LOGO, from: 'a', to: 'a · B', topic: 'B' })
    expect(sends.map((s) => s.to)).toEqual([LOGO])
  })
})

describe('only a peer note is a hand-off', () => {
  it('a reply from a reviewer to its leader does not make the reviewer the sender', async () => {
    noteSent(REVIEW, LOGO)
    await noticeTitleTopic({ taskId: LOGO, from: 'a', to: 'a · B', topic: 'B' })
    expect(sends.map((s) => s.to)).toEqual([LOGO])
  })
})

describe('titleTopicNotes', () => {
  it('reads without a deliverable too', () => {
    const n = titleTopicNotes({ taskId: 't', from: 'A', to: 'A · B', topic: 'B' }, '')
    expect(n.task).not.toContain('Your deliverable')
    expect(n.sender).toBeUndefined()
  })
})
