/**
 * The change watcher (src/core/changes/watch.ts + cadence.ts) over many reads: when each change is
 * read again, what it stores and when it writes, which news wakes the task's session and which
 * waits do not, links the task dropped, and the experiment switched off. Tasks and sessions are
 * in-memory stand-ins; the provider is a neutral review service registered the way a plugin's is,
 * and the last test registers one through the real plugin API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-change-watch'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import type { ChangeSnapshot, ChangeStage } from '../../../src/core/changes/model.js'
import { taskChangeLinks } from '../../../src/core/changes/model.js'
import { _resetChangeProvidersForTesting, changeProviderFor, registerChangeProvider, type ChangeReadResult } from '../../../src/core/changes/registry.js'
import { _changeWatchMemoryForTesting, _resetChangeWatchForTesting, _setChangeDeadlinesForTesting, changeWatchTick, refreshTaskChanges, startChangeWatch, taskChangeView, type ChangeWatchDeps } from '../../../src/core/changes/watch.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { CHANGE_FOLLOW_MAX_MS } from '../../../src/core/changes/cadence.js'
import { PluginContext, type PluginLogger } from '../../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../../src/core/plugins/server-api.js'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import { createTestPluginApi } from '../plugin-test-utils.js'

const CR1 = 'https://review.acme.dev/r/1001'
const CR2 = 'https://review.acme.dev/r/1002'
const MIN = 60_000
const T0 = Date.parse('2026-11-17T10:00:00Z')

type Answer = Extract<ChangeReadResult, { ok: true }>['snapshot']
let answers: Map<string, ChangeReadResult>
let reads: string[][]
let tasks: Map<string, Task>
let writes: number
let sent: Array<{ sessionId: string; text: string; messageId: string }>
let sendFails: boolean
let enabled: boolean
let clock: number
let wakeConfig: { wake_agent?: boolean } | undefined
/** Links whose read hangs until its deadline aborts it. */
let hang: Set<string>

const open = (extra: Partial<NonNullable<Answer['review']>> = {}): ChangeReadResult => ({ ok: true, snapshot: { label: 'CR-1001', review: { state: 'open', ...extra } } })
const deploying = (stages: ChangeStage[], done = false): ChangeReadResult => ({
  ok: true, snapshot: { label: 'CR-1001', review: { state: 'merged' }, deploy: { pipeline: 'app', stages, done } },
})

function task(id: string, tags: string[], extra: Partial<Task> = {}): Task {
  const t = { id, title: id, phase: 'IN_PROGRESS', tags, project: 'Local', source: 'local', note: '', created_at: '', updated_at: '', ...extra } as unknown as Task
  tasks.set(id, t)
  return t
}

const deps: ChangeWatchDeps = {
  openTasks: async () => [...tasks.values()],
  writeTask: async (id, patch) => {
    const cur = tasks.get(id)!
    const p = patch(cur)
    if (!p) return
    writes++
    const next = { ...cur, ...p }
    if (p.change_status === undefined && 'change_status' in p) delete next.change_status
    tasks.set(id, next)
  },
  deliveryTarget: async () => ({ sessionId: 'sess-1', running: false }),
  send: async (sessionId, text, _taskId, messageId) => {
    if (sendFails) throw new Error('queue down')
    sent.push({ sessionId, text, messageId })
  },
  enabled: async () => enabled,
  config: async () => wakeConfig,
  now: () => clock,
}

const snap = (id = 't1', url = CR1): ChangeSnapshot | undefined => tasks.get(id)!.change_status?.[url]
const tick = (opts = {}) => changeWatchTick(deps, opts)

async function freshHome(): Promise<void> {
  if (!WALNUT_HOME.includes('walnut-change-watch')) throw new Error(`refusing to run against ${WALNUT_HOME}`)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

beforeEach(async () => {
  await freshHome()
  _resetChangeProvidersForTesting()
  _resetChangeWatchForTesting()
  answers = new Map()
  reads = []
  tasks = new Map()
  writes = 0
  sent = []
  sendFails = false
  enabled = true
  clock = T0
  wakeConfig = undefined
  hang = new Set()
  registerChangeProvider('acme', {
    id: 'acme:reviews',
    handles: (link) => link.url.startsWith('https://review.acme.dev/'),
    read: async (links, ctx) => {
      reads.push(links.map((l) => l.url))
      if (links.some((l) => hang.has(l.url))) await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve))
      return new Map(links.filter((l) => answers.has(l.url)).map((l) => [l.url, answers.get(l.url)!]))
    },
  })
})
afterEach(freshHome)

describe('which links are change links', () => {
  it('takes pr, mr, cr, commit, code-review and change link tags in tag order, once each', () => {
    expect(taskChangeLinks([
      'notes:/home/u/a.md', `cr:${CR1}`, 'issue:https://github.com/acme/app/issues/3', 'pr:https://github.com/acme/app/pull/7',
      `change:${CR1}`, 'commit:https://github.com/acme/app/commit/1a2b3c4', 'code-review:https://review.acme.dev/r/9', 'status:open',
    ])).toEqual([
      { key: 'cr', url: CR1 },
      { key: 'pr', url: 'https://github.com/acme/app/pull/7' },
      { key: 'commit', url: 'https://github.com/acme/app/commit/1a2b3c4' },
      { key: 'code-review', url: 'https://review.acme.dev/r/9' },
    ])
    expect(taskChangeLinks(undefined)).toEqual([])
  })
})

describe('the experiment', () => {
  it('off: nothing is read and nothing written', async () => {
    enabled = false
    task('t1', [`cr:${CR1}`])
    answers.set(CR1, open())
    expect(await tick({ force: true })).toEqual({ tasks: 0, read: 0, written: 0, woken: 0 })
    expect(reads).toEqual([])
    expect(writes).toBe(0)
    expect((await taskChangeView(tasks.get('t1')!, { enabled: async () => false })).enabled).toBe(false)
  })
})

describe('cadence and storing', () => {
  it('reads a review every 10 minutes and writes only when it changed', async () => {
    task('t1', [`cr:${CR1}`])
    answers.set(CR1, open({ approvals: { got: 0, need: 2 } }))
    await tick()
    expect(reads).toEqual([[CR1]])
    expect(snap()).toMatchObject({ provider: 'acme:reviews', url: CR1, label: 'CR-1001', checkedAt: new Date(T0).toISOString(), nextAt: new Date(T0 + 10 * MIN).toISOString() })
    expect(writes).toBe(1)

    clock = T0 + 5 * MIN
    await tick()
    expect(reads).toHaveLength(1)

    clock = T0 + 10 * MIN
    await tick()
    expect(reads).toHaveLength(2)
    expect(writes).toBe(1) // the same answer: no write, though its next read moved
    const view = await taskChangeView(tasks.get('t1')!, { enabled: async () => true })
    expect(view.changes[0]).toMatchObject({ checkedAt: new Date(clock).toISOString(), nextAt: new Date(clock + 10 * MIN).toISOString() })

    answers.set(CR1, open({ approvals: { got: 1, need: 2 } }))
    clock = T0 + 20 * MIN
    await tick()
    expect(writes).toBe(2)
    expect(snap()!.review!.approvals).toEqual({ got: 1, need: 2 })
  })

  it('a stage on a bake is read at its end plus a minute, capped at 6 hours; a deploy every 15 minutes', async () => {
    task('t1', [`cr:${CR1}`])
    const until = new Date(T0 + 2 * 60 * MIN).toISOString()
    answers.set(CR1, deploying([{ name: 'beta', status: 'done' }, { name: 'prod', status: 'waiting', blocker: { kind: 'bake', text: 'Bake: 2 hours left', until } }]))
    await tick()
    expect(snap()!.nextAt).toBe(new Date(T0 + 2 * 60 * MIN + MIN).toISOString())

    answers.set(CR1, deploying([{ name: 'prod', status: 'waiting', blocker: { kind: 'window', text: 'Opens tomorrow', until: new Date(T0 + 20 * 60 * MIN).toISOString() } }]))
    await tick({ force: true })
    expect(snap()!.nextAt).toBe(new Date(T0 + 6 * 60 * MIN).toISOString())

    answers.set(CR1, deploying([{ name: 'beta', status: 'running' }, { name: 'prod', status: 'waiting', blocker: { kind: 'bake', text: 'bake', until } }]))
    await tick({ force: true })
    expect(snap()!.nextAt).toBe(new Date(T0 + 15 * MIN).toISOString())
    expect(sent).toEqual([]) // a bake or a window is no news
  })

  it('a provider\'s nextInMs wins; a failed read keeps what was found and comes back in 15 minutes', async () => {
    task('t1', [`cr:${CR1}`])
    answers.set(CR1, { ...open(), nextInMs: 3 * MIN } as ChangeReadResult)
    await tick()
    expect(snap()!.nextAt).toBe(new Date(T0 + 3 * MIN).toISOString())

    answers.set(CR1, { ok: false, code: 'signed-out', message: 'sign in again' })
    clock = T0 + 3 * MIN
    await tick()
    expect(snap()).toMatchObject({ review: { state: 'open' }, error: { code: 'signed-out' }, nextAt: new Date(clock + 15 * MIN).toISOString() })
  })

  it('a settled change, and one followed for more than 21 days, is read no more', async () => {
    task('t1', [`cr:${CR1}`, `cr:${CR2}`])
    answers.set(CR1, deploying([{ name: 'prod', status: 'done' }], true))
    answers.set(CR2, open())
    await tick()
    expect(snap('t1', CR1)!.nextAt).toBeUndefined()
    expect(snap('t1', CR2)!.followedSince).toBe(new Date(T0).toISOString())

    clock = T0 + CHANGE_FOLLOW_MAX_MS + MIN
    await tick()
    expect(reads.at(-1)).toEqual([CR2])
    expect(snap('t1', CR2)!.nextAt).toBeUndefined()

    clock += 24 * 60 * MIN
    await tick()
    expect(reads).toHaveLength(3)
    // A forced read (the card's Refresh) still reads them.
    await tick({ force: true })
    expect(reads.slice(-2).flat().sort()).toEqual([CR1, CR2])
  })

  it('drops the snapshot of a link the task no longer holds, and keeps links no provider reads unread', async () => {
    task('t1', [`cr:${CR1}`, `cr:${CR2}`, 'cr:https://elsewhere.example/r/5'])
    answers.set(CR1, open())
    answers.set(CR2, open())
    await tick()
    expect(Object.keys(tasks.get('t1')!.change_status!)).toEqual([CR1, CR2])
    expect(reads).toEqual([[CR1], [CR2]])

    tasks.set('t1', { ...tasks.get('t1')!, tags: [`cr:${CR2}`] })
    await tick()
    expect(Object.keys(tasks.get('t1')!.change_status!)).toEqual([CR2])
    tasks.set('t1', { ...tasks.get('t1')!, tags: [] })
    await tick()
    expect(tasks.get('t1')!.change_status).toBeUndefined()
  })

  it('reads a URL once however many tasks link it, and answers an unread link with an empty read time', async () => {
    task('t1', [`cr:${CR1}`])
    task('t2', [`cr:${CR1}`])
    const before = (await taskChangeView(tasks.get('t1')!, { enabled: async () => true })).changes
    expect(before).toEqual([{ provider: 'acme:reviews', url: CR1, label: expect.any(String), checkedAt: '' }])
    answers.set(CR1, open())
    await tick()
    expect(reads).toEqual([[CR1]])
    expect(snap('t2')!.review!.state).toBe('open')
  })
})

describe('waking the session', () => {
  const news: Array<[string, ChangeReadResult, RegExp]> = [
    ['approved', open({ state: 'approved' }), /CR-1001 approved: https:\/\/review\.acme\.dev\/r\/1001/],
    ['changes asked', open({ state: 'changes_requested' }), /changes requested/],
    ['merged', { ok: true, snapshot: { label: 'CR-1001', review: { state: 'merged' } } }, /merged/],
    ['closed', { ok: true, snapshot: { label: 'CR-1001', review: { state: 'closed' } } }, /closed without merging[\s\S]*give its place/],
    ['checks failed', open({ checks: { passed: 3, failed: 2, pending: 0 } }), /2 checks failed/],
    ['a stage failed', deploying([{ name: 'beta', status: 'failed', note: 'Integration Test: 2 failed' }]), /beta failed \(Integration Test: 2 failed\)/],
    ['a stage blocked on an approval', deploying([{ name: 'prod', status: 'blocked', blocker: { kind: 'approval', text: 'needs a manual approval' } }]), /prod blocked \(needs a manual approval\)/],
    ['deployed to the end', deploying([{ name: 'prod', status: 'done' }], true), /deployed to the last stage[\s\S]*at most 3 links/],
  ]

  it.each(news)('wakes on %s, once, with one short line and the URL', async (_name, answer, line) => {
    task('t1', [`cr:${CR1}`])
    answers.set(CR1, open())
    await tick()
    expect(sent).toEqual([]) // the first read is no news
    answers.set(CR1, answer)
    await tick({ force: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toMatch(line)
    expect(sent[0]!.messageId).toMatch(/^change-watch-[0-9a-f]{16}$/)
    await tick({ force: true })
    expect(sent).toHaveLength(1)
  })

  it('stays quiet for a bake or a window block, for Main and a lead, and leaves a followed pull request\'s review to its own watch', async () => {
    task('t1', [`cr:${CR1}`])
    answers.set(CR1, deploying([{ name: 'beta', status: 'running' }]))
    await tick()
    answers.set(CR1, deploying([{ name: 'beta', status: 'blocked', blocker: { kind: 'window', text: 'outside the deploy window' } }]))
    await tick({ force: true })
    expect(sent).toEqual([])

    task('lead', [`cr:${CR2}`], { org_role: 'lead' })
    answers.set(CR2, open())
    await tick({ taskIds: ['lead'] })
    answers.set(CR2, open({ state: 'approved' }))
    await tick({ taskIds: ['lead'], force: true })
    expect(sent).toEqual([])

    task('t3', [`cr:${CR2}`], { pr_status: { [CR2]: {} } } as never)
    answers.set(CR2, open())
    await tick({ taskIds: ['t3'], force: true })
    answers.set(CR2, open({ state: 'approved' }))
    await tick({ taskIds: ['t3'], force: true })
    expect(sent).toEqual([])
  })

  it('a wake that failed is told again on a later read', async () => {
    task('t1', [`cr:${CR1}`])
    answers.set(CR1, open())
    await tick()
    answers.set(CR1, open({ state: 'approved' }))
    sendFails = true
    await tick({ force: true })
    expect(snap()!.review!.state).toBe('open')
    sendFails = false
    clock = T0 + 2 * MIN
    await tick()
    expect(sent).toHaveLength(1)
    expect(snap()!.review!.state).toBe('approved')
  })
})

describe('a plugin\'s provider', () => {
  it('registers through walnut.registry.changeProvider under its namespaced id and goes with the plugin', async () => {
    _resetChangeProvidersForTesting()
    const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() } as unknown as PluginLogger
    const context = new PluginContext({ id: 'acme', dataDir: path.join(WALNUT_HOME, 'plugin-data', 'acme'), logger })
    const { api: legacyApi, collected } = createTestPluginApi({ id: 'acme', name: 'acme' })
    const api = createServerPluginApi({ context, pluginName: 'acme', legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
    api.registry.changeProvider!({
      id: 'reviews',
      handles: (link) => link.url.startsWith('https://review.acme.dev/'),
      read: async (links) => new Map(links.map((l) => [l.url, { ok: true, snapshot: { label: 'CR-1001', review: { state: 'approved' } } }])),
    })
    expect(changeProviderFor({ key: 'cr', url: CR1 })).toMatchObject({ id: 'acme:reviews', owner: 'acme' })
    task('t1', [`cr:${CR1}`])
    await tick()
    expect(snap()).toMatchObject({ provider: 'acme:reviews', review: { state: 'approved' } })
    expect(() => api.registry.changeProvider!({ id: 'reviews', handles: () => true, read: async () => new Map() })).toThrow(/already registered/)
    await context.dispose()
    expect(changeProviderFor({ key: 'cr', url: CR1 })).toBeUndefined()
  })
})

describe('review fixes', () => {
  it('a URL another task settled is read at once for a task that has no snapshot of it', async () => {
    task('a', [`cr:${CR1}`])
    answers.set(CR1, deploying([{ name: 'prod', status: 'done' }], true))
    await tick()
    task('b', [`cr:${CR1}`])
    clock = T0 + MIN
    await tick()
    expect(reads).toEqual([[CR1], [CR1]])
    expect(snap('b')!.deploy!.done).toBe(true)
  })

  it('a new link on a task update is read through the bus, settled elsewhere or not', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const watch = await startChangeWatch(deps)
    try {
      task('a', [`cr:${CR1}`])
      answers.set(CR1, deploying([{ name: 'prod', status: 'done' }], true))
      await tick()
      const b = task('b', [`cr:${CR1}`])
      bus.emit(EventNames.TASK_UPDATED, { task: b }, ['web-ui'], { source: 'api' })
      await vi.advanceTimersByTimeAsync(3_100)
      await tick({ taskIds: [] })
      expect(snap('b')!.deploy!.done).toBe(true)
    } finally {
      watch.stop()
      vi.useRealTimers()
    }
  })

  it('each link has its own deadline: a slow one fails alone and the rest are kept', async () => {
    _setChangeDeadlinesForTesting({ readMs: 100 })
    task('t1', [`cr:${CR1}`, `cr:${CR2}`])
    answers.set(CR1, open())
    answers.set(CR2, open())
    hang.add(CR2)
    await tick()
    expect(snap('t1', CR1)!.review!.state).toBe('open')
    expect(snap('t1', CR2)).toMatchObject({ checkedAt: '', error: { code: 'unreachable' }, nextAt: new Date(T0 + 15 * MIN).toISOString() })
    hang.clear()
    clock = T0 + 15 * MIN
    await tick()
    expect(snap('t1', CR2)!.error).toBeUndefined()
  })

  it('a link the provider left out is asked again with the failed reads, not on every look', async () => {
    task('t1', [`cr:${CR1}`])
    await tick()
    clock = T0 + MIN
    await tick()
    expect(reads).toHaveLength(1)
    answers.set(CR1, open())
    clock = T0 + 15 * MIN
    await tick()
    expect(reads).toHaveLength(2)
    expect(snap()!.review!.state).toBe('open')
  })

  it('wakes nobody with pr_wake off on the task or wake_agent off in the settings', async () => {
    task('t1', [`cr:${CR1}`], { pr_wake: false })
    task('t2', [`cr:${CR2}`])
    answers.set(CR1, open())
    answers.set(CR2, open())
    await tick()
    wakeConfig = { wake_agent: false }
    answers.set(CR1, open({ state: 'approved' }))
    answers.set(CR2, open({ state: 'approved' }))
    await tick({ force: true })
    expect(sent).toEqual([])
    expect(snap('t2', CR2)!.review!.state).toBe('approved')
  })

  it('forgets in memory the URLs no open task links any more', async () => {
    task('t1', [`cr:${CR1}`, `cr:${CR2}`])
    answers.set(CR1, open())
    await tick()
    expect(_changeWatchMemoryForTesting()).toEqual({ lastGood: [CR1], nextDue: [CR1], retryAt: [CR2] })
    tasks.delete('t1')
    await tick()
    expect(_changeWatchMemoryForTesting()).toEqual({ lastGood: [], nextDue: [], retryAt: [] })
  })

  it('after a restart, stored reads already due are spread over the first two minutes', async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://review.acme.dev/r/${2000 + i}`)
    for (const [i, url] of urls.entries()) {
      task(`t${i}`, [`cr:${url}`], { change_status: { [url]: { provider: 'acme:reviews', url, label: 'x', checkedAt: '2026-11-17T08:00:00Z', nextAt: '2026-11-17T09:00:00Z', review: { state: 'open' } } } })
      answers.set(url, open())
    }
    const watch = await startChangeWatch(deps)
    try {
      await tick()
      const first = reads.length
      expect(first).toBeLessThan(10)
      clock = T0 + 2 * MIN
      await tick()
      expect(reads.length).toBe(20)
    } finally {
      watch.stop()
    }
  })

  it('a Refresh while another for the same task waits its turn joins it', async () => {
    const watch = await startChangeWatch(deps)
    try {
      task('t1', [`cr:${CR1}`])
      answers.set(CR1, open())
      // A pass already queued: both Refreshes wait behind it, the second joins the first.
      const busy = tick({ force: true })
      const a = refreshTaskChanges('t1')
      const b = refreshTaskChanges('t1')
      expect(b).toBe(a)
      await Promise.all([busy, a, b])
      expect(reads).toHaveLength(2)
    } finally {
      watch.stop()
    }
  })
})
