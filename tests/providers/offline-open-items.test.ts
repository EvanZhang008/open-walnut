/**
 * `open_items` answered by a host from its copy while the Walnut server is away
 * (offline-host-core.ts). A compaction then still puts the list of what is open
 * back into the session's context: the compact hook gets the SessionStart JSON,
 * worded by the SAME formatter the server uses (open-items-text.ts), so a session
 * cannot tell which side answered. The last block rebuilds the formatter from its
 * text the way the source twin runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createOfflineHost, type HostSlice } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { createBoardOffline } from '../../src/providers/offline-board-core.js'
import { createOpenItemsText } from '../../src/core/sessions/open-items-text.js'
import { formatOpenItems } from '../../src/core/sessions/open-items.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const HOME = '/fixture/walnut-home'
const LEAD = 'aaaaaaaa-1111-4111-8111-111111111111'
const W1 = 'bbbbbbbb-2222-4222-8222-222222222222'
const NOW = Date.parse('2026-10-06T12:00:00Z')

function slice(): HostSlice {
  return {
    v: 1, home: HOME, hash: 'h1', asOf: NOW - 60_000, host: 'devbox',
    sessions: [
      { sid: LEAD, taskId: 'mlead000-0001', title: 'Leader: ship the release' },
      { sid: W1, taskId: 'mwork111-0002', title: 'Worker: fix the build' },
    ],
    tasks: [
      { id: 'mlead000-0001', title: 'Leader: ship the release', phase: 'IN_PROGRESS', updated_at: '2026-10-06T09:00:00Z' },
      { id: 'mwork111-0002', title: 'Worker: fix the build', phase: 'IN_PROGRESS', parent_task_id: 'mlead000-0001', updated_at: '2026-10-06T11:00:00Z' },
      { id: 'mwork222-0003', title: 'Worker: write the notes', phase: 'COMPLETE', parent_task_id: 'mlead000-0001', updated_at: '2026-10-06T11:30:00Z' },
      // A legacy short parent id still names the leader (a CJK title: escapes keep the source ASCII).
      { id: 'mwork333-0004', title: 'Worker: \u53d1\u5e03 checklist', phase: 'TODO', parent_task_id: 'mlead000', updated_at: '2026-10-06T10:00:00Z' },
      { id: 'mother00-0005', title: 'Someone else', phase: 'TODO' },
    ],
    requests: [
      { id: 'rq-aaa111', fromSessionId: LEAD, toSessionId: W1, toTaskId: 'mwork111-0002', preview: 'Is the build green?', status: 'pending', createdAt: '2026-10-06T11:00:00Z', deadlineAt: NOW + 3_600_000 },
      { id: 'rq-bbb222', fromSessionId: W1, toSessionId: LEAD, toTaskId: 'mlead000-0001', preview: 'May I merge?', status: 'pending', createdAt: '2026-10-06T11:50:00Z', deadlineAt: NOW + 3_600_000 },
    ],
    boards: [{
      taskId: 'mlead000-0001', html: '<h1>Release</h1>', version: 4, updated_at: '2026-10-06T11:40:00Z',
      threads: { plan: [{ id: 'm1', author: 'user', text: 'ship it', ts: 'x' }, { id: 'm2', author: 'task:mlead000-0001', text: 'ok', ts: 'y' }] },
      marks: { build: { state: 'open' } },
    }],
    boardOf: { 'mlead000-0001': 'mlead000-0001', 'mwork111-0002': 'mlead000-0001' },
  }
}

let dir = ''
function make(withFormatter = true) {
  return createOfflineHost({
    fs, path, dir, now: () => NOW,
    randomHex: (n) => randomBytes(n).toString('hex'),
    keyOf: (v) => createHash('sha1').update(v).digest('hex').slice(0, 12),
    kit: createEnvelopeKit(), boards: createBoardOffline(), log: () => {},
    isLive: () => true, turnActive: () => false, streamOffset: () => 0,
    deliver: async () => ({ ok: true }),
    ...(withFormatter ? { openItems: createOpenItemsText() } : {}),
  })
}

const call = (h: ReturnType<typeof make>, sid: string, args: Record<string, unknown> = {}) =>
  h.handle(HOME, sid, 'tools.call', { name: 'open_items', args })

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woi-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('open_items from the copy', () => {
  it('lists the unfinished subtasks, both kinds of pending request and the Board, worded as the server words them', async () => {
    const h = make()
    h.configure(slice())
    const r = await call(h, LEAD)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const res = r.result as Record<string, any>
    expect(res.task).toEqual({ id: 'mlead000-0001', title: 'Leader: ship the release' })
    // Newest first, the completed one left out, the legacy parent id counted.
    expect(res.subtasks.map((t: { id: string }) => t.id)).toEqual(['mwork111-0002', 'mwork333-0004'])
    expect(res.waitingOn).toEqual([{ id: 'rq-aaa111', to: 'mwork111-0002', preview: 'Is the build green?', createdAt: '2026-10-06T11:00:00Z' }])
    expect(res.askedOfYou).toEqual([{ id: 'rq-bbb222', from: 'mwork111-0002', preview: 'May I merge?', createdAt: '2026-10-06T11:50:00Z' }])
    expect(res.board).toEqual({ version: 4, updatedAt: '2026-10-06T11:40:00Z', threads: 1, userMessages: 1, marks: 1 })
    expect(res).toMatchObject({ offline: true })
    // Byte for byte the server's block for the same items.
    expect(res.text).toBe(formatOpenItems(res as Parameters<typeof formatOpenItems>[0], NOW))
    expect(res.text).toContain('- mwork333-0004 [TODO] Worker: \u53d1\u5e03 checklist')
    expect(res.text).toContain('- rq-bbb222 from mwork111-0002, 10m ago: "May I merge?"')
  })

  it('the compact hook gets the SessionStart JSON, and {} when nothing is open', async () => {
    const h = make()
    h.configure(slice())
    const r = await call(h, LEAD, { hook: 'compact' })
    expect(r).toMatchObject({ ok: true, result: { hookSpecificOutput: { hookEventName: 'SessionStart' } } })
    const text = r.ok ? String((r.result.hookSpecificOutput as { additionalContext: string }).additionalContext) : ''
    expect(text).toMatch(/^Walnut: still open for your task "Leader: ship the release" \(mlead000-0001\)/)
    // The worker owes nothing, waits on nothing it has not been answered, has no children or Board of its own.
    const quiet = slice()
    quiet.requests = []
    h.configure({ ...quiet, hash: 'h2' })
    expect(await call(h, W1, { hook: 'compact' })).toEqual({ ok: true, result: {} })
  })

  it('follows what this host did since the copy: a queued completion, a request it settled, one it owns', async () => {
    const h = make()
    h.configure(slice())
    // The worker completes; the leader answers the worker's question; the leader asks again.
    expect(await h.handle(HOME, W1, 'tools.call', { name: 'task_complete', args: { id: 'mwork111-0002' } })).toMatchObject({ ok: true })
    expect(await h.handle(HOME, LEAD, 'tools.call', { name: 'task_send', args: { in_reply_to: 'rq-bbb222', text: 'Yes, merge.' } })).toMatchObject({ ok: true })
    const asked = await h.handle(HOME, LEAD, 'tools.call', { name: 'task_send', args: { to: 'mwork111-0002', text: 'Tag the release too?' } })
    expect(asked.ok).toBe(true)
    const r = await call(h, LEAD)
    const res = (r.ok ? r.result : {}) as Record<string, any>
    expect(res.subtasks.map((t: { id: string }) => t.id)).toEqual(['mwork333-0004'])
    expect(res.askedOfYou).toEqual([])
    expect(res.waitingOn.map((w: { id: string }) => w.id).sort()).toEqual([asked.ok ? String(asked.result.requestId) : '', 'rq-aaa111'].sort())
  })

  it('a caller with no task, and a daemon without the formatter, say so plainly', async () => {
    const h = make()
    h.configure({ ...slice(), sessions: [...slice().sessions, { sid: 'cccccccc-3333-4333-8333-333333333333' }] })
    expect(await call(h, 'cccccccc-3333-4333-8333-333333333333', { hook: 'compact' })).toEqual({ ok: true, result: {} })
    const old = make(false)
    old.configure(slice())
    expect(await call(old, LEAD)).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    expect(old.answersRead('open_items', HOME)).toBe(false)
    expect(h.answersRead('open_items', HOME)).toBe(true)
    const list = await h.handle(HOME, LEAD, 'tools.list', {})
    expect(list.ok && (list.result.ops as Array<{ name: string }>).map((o) => o.name)).toContain('open_items')
  })
})

describe('the source twin', () => {
  it('inlines the formatter', () => {
    const rendered = getDaemonSource()
    expect(rendered).not.toContain('__CREATE_OPEN_ITEMS_TEXT__')
    expect(rendered).toContain(createOpenItemsText.toString())
    expect(rendered).toMatch(/openItems: \(function createOpenItemsText\(\)/)
  })

  it('a formatter rebuilt from its text words the block the same', () => {
    // eslint-disable-next-line no-new-func
    const rebuilt = new Function(`return (${createOpenItemsText.toString()})`)() as typeof createOpenItemsText
    const items = {
      task: { id: 'mlead000-0001', title: 'Leader \ud83d\ude80 '.repeat(20) },
      subtasks: [{ id: 'mwork111-0002', title: 'Worker', phase: 'IN_PROGRESS' }], moreSubtasks: 3,
      waitingOn: [{ id: 'rq-aaa111', to: 'mwork111-0002', preview: 'x'.repeat(200), createdAt: '2026-10-04T12:00:00Z' }],
      askedOfYou: [], board: { version: 2, updatedAt: '', threads: 0, userMessages: 0, marks: 1 },
    }
    expect(rebuilt().format(items, NOW)).toBe(formatOpenItems(items, NOW))
    // A cut never leaves half of an astral character (the rocket is a surrogate pair).
    expect(rebuilt().format(items, NOW)).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})
