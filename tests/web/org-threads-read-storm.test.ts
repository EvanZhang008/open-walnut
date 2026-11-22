/**
 * A node's Threads are read at most once at a time, whatever asks for it and however many
 * surfaces show the node (2026-11-21, live: one Mac app window on /org read a VP's Threads 2 to 4
 * at a time about every 1.5 s, 1604 reads in an hour; each task listed on a thread that changed
 * started one read per surface, in parallel. The page's connection pool filled, every other
 * request waited 20 to 60 s and was rejected: "GET unknown request rejected in the page").
 *
 * The class: every way a read of a node's threads starts. They are enumerated from the hook's
 * source (each `load('<why>')` and each event it listens to), and every one is driven here while
 * a read is on its way; a new way that calls the fetch past the scheduler fails the source check.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act, useEffect, useRef } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { OrgThread } from '../../web/src/api/org-threads'

const api = vi.hoisted(() => ({
  inFlight: 0, maxInFlight: 0, calls: 0,
  pending: [] as Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>,
  auto: null as null | (() => unknown),
}))
vi.mock('@/api/org-threads', () => ({
  fetchOrgThreads: () => {
    api.calls++
    api.inFlight++
    api.maxInFlight = Math.max(api.maxInFlight, api.inFlight)
    const done = <T,>(p: Promise<T>) => p.finally(() => { api.inFlight-- })
    if (api.auto) return done(Promise.resolve(api.auto()))
    return done(new Promise((resolve, reject) => { api.pending.push({ resolve, reject }) }))
  },
  patchOrgThread: async () => null,
  splitOrgThread: async () => undefined,
}))
const bus = vi.hoisted(() => new Map<string, Set<(d: unknown) => void>>())
vi.mock('@/hooks/useWebSocket', () => ({
  useEvent: (name: string, fn: (d: unknown) => void) => {
    const ref = useRef(fn)
    ref.current = fn
    useEffect(() => {
      const h = (d: unknown) => ref.current(d)
      if (!bus.has(name)) bus.set(name, new Set())
      bus.get(name)!.add(h)
      return () => { bus.get(name)!.delete(h) }
    }, [name])
  },
}))
vi.mock('@/contexts/TasksContext', () => ({ useTaskStoreActions: () => null }))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }))

const { useOrgThreads, resetOrgThreadsForTest, OWNER_READ_GAP_MS } = await import('../../web/src/components/org/useOrgThreads')

const NODE = 'vp-node-1'
const thread = (title: string): OrgThread => ({
  id: 'th-a1b2c3', title, state: 'working', messages: [], tasks: ['team-task-1'],
  createdAt: '2026-11-21T00:00:00.000Z', updatedAt: '2026-11-21T00:00:00.000Z',
} as unknown as OrgThread)

let root: ReturnType<typeof createRoot> | undefined
let surfaces: Array<ReturnType<typeof useOrgThreads>> = []
function Surface({ i }: { i: number }) { surfaces[i] = useOrgThreads(NODE, true); return null }
/** The Org page's node, its chat's Threads pane and its top thread: three surfaces of one node. */
async function mount(n = 3) {
  await act(async () => { root!.render(createElement('div', null, ...Array.from({ length: n }, (_, i) => createElement(Surface, { key: i, i })))) })
}
const emit = async (name: string, data: unknown) => { await act(async () => { for (const h of bus.get(name) ?? []) h(data) }) }
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const answer = async (list: OrgThread[]) => { await act(async () => { api.pending.shift()!.resolve(list); await vi.advanceTimersByTimeAsync(0) }) }

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })
})
beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(api, { inFlight: 0, maxInFlight: 0, calls: 0, pending: [], auto: null })
  bus.clear()
  resetOrgThreadsForTest()
  surfaces = []
  root = createRoot(document.createElement('div'))
})
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  vi.useRealTimers()
})

describe('a node is never read twice at once', () => {
  it('three surfaces opening the node read it once', async () => {
    await mount()
    expect(api.calls).toBe(1)
    await answer([thread('one')])
    expect(surfaces.every((s) => s.threads?.[0]?.title === 'one')).toBe(true)
  })

  it('every ask while a read is out, from every surface and reason, becomes one read after it', async () => {
    await mount()
    await answer([thread('one')])
    api.calls = 0
    // A read on its way (a thread changed), then every other way a read starts, several times.
    await emit('org-threads:changed', { taskId: NODE })
    for (let i = 0; i < 4; i++) {
      await emit('org-threads:changed', { taskId: NODE })
      await emit('_ws:reconnected', {})
      await emit('task:updated', { task: { id: 'team-task-1' } })
      await tick(OWNER_READ_GAP_MS)
    }
    await act(async () => { surfaces[0].heard('th-a1b2c3', undefined, 'go on') })
    await act(async () => { await surfaces[1].update('th-a1b2c3', { pin: true }) })
    expect(api.maxInFlight).toBe(1)
    expect(api.calls).toBe(1)
    await answer([thread('old')])
    // The read after them all, and nothing after that.
    expect(api.calls).toBe(2)
    await answer([thread('two')])
    await tick(OWNER_READ_GAP_MS * 2)
    expect(api.calls).toBe(2)
    expect(api.maxInFlight).toBe(1)
    expect(surfaces[2].threads?.[0]?.title).toBe('two')
  })

  it('an answer that left before his write is not drawn over it', async () => {
    await mount()
    await answer([thread('one')])
    await emit('org-threads:changed', { taskId: NODE })
    await act(async () => { await surfaces[0].update('th-a1b2c3', { title: 'renamed' } as never) })
    await answer([thread('before the write')])
    expect(surfaces[0].threads?.[0]?.title).not.toBe('before the write')
    await answer([thread('after the write')])
    expect(surfaces[0].threads?.[0]?.title).toBe('after the write')
  })

  it('a read that fails still lets the read asked meanwhile go', async () => {
    await mount()
    await answer([thread('one')])
    await emit('org-threads:changed', { taskId: NODE })
    await emit('org-threads:changed', { taskId: NODE })
    await act(async () => { api.pending.shift()!.reject(new Error('offline')); await vi.advanceTimersByTimeAsync(0) })
    expect(api.calls).toBe(3)
    await answer([thread('back')])
    expect(surfaces[0].threads?.[0]?.title).toBe('back')
    expect(api.maxInFlight).toBe(1)
  })

  it('a failed read shows on every surface until any later read succeeds, a listed task\'s change included', async () => {
    await mount()
    await answer([thread('one')])
    await emit('org-threads:changed', { taskId: NODE })
    await act(async () => { api.pending.shift()!.reject(new Error('timed out')); await vi.advanceTimersByTimeAsync(0) })
    expect(surfaces.map((x) => !!x.error)).toEqual([true, true, true])
    await emit('task:updated', { task: { id: 'team-task-1' } })
    await tick(OWNER_READ_GAP_MS)
    await answer([thread('fresh')])
    expect(surfaces.map((x) => x.error)).toEqual([null, null, null])
    expect(surfaces[0].threads?.[0]?.title).toBe('fresh')
  })

  it('a node nobody shows any more is not read for a listed task\'s change', async () => {
    await mount()
    await answer([thread('one')])
    await emit('task:updated', { task: { id: 'team-task-1' } })
    await act(async () => { root!.render(createElement('div')) })
    await tick(OWNER_READ_GAP_MS * 2)
    expect(api.calls).toBe(1)
  })

  it('a busy team (a listed task changing every 100 ms for a minute) reads the node once per gap, for all surfaces', async () => {
    api.auto = () => [thread('busy')]
    await mount()
    await tick(0)
    api.calls = 0
    for (let t = 0; t < 60_000; t += 100) {
      await emit('task:updated', { task: { id: 'team-task-1' } })
      await tick(100)
    }
    expect(api.calls).toBeLessThanOrEqual(60_000 / OWNER_READ_GAP_MS + 1)
    expect(api.calls).toBeGreaterThanOrEqual(60_000 / OWNER_READ_GAP_MS - 1)
    // A task no thread lists starts no read (the busy stream's last read has gone first).
    await tick(OWNER_READ_GAP_MS * 2)
    api.calls = 0
    for (let i = 0; i < 20; i++) await emit('task:updated', { task: { id: 'someone-else' } })
    await tick(OWNER_READ_GAP_MS * 2)
    expect(api.calls).toBe(0)
  })
})

describe('every read of a node goes through the one scheduler', () => {
  const file = path.join(__dirname, '../../web/src/components/org/useOrgThreads.ts')
  const src = fs.readFileSync(file, 'utf8')
  it('the fetch is called in one place, the read that keeps one in flight', () => {
    const webSrc = path.join(__dirname, '../../web/src')
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
          const n = (fs.readFileSync(p, 'utf8').match(/\bfetchOrgThreads\(/g) ?? []).length
          for (let i = 0; i < n; i++) callers.push(path.relative(webSrc, p))
        }
      }
    }
    walk(webSrc)
    // The definition in api/org-threads.ts, and the one call in startRead.
    expect(callers.sort()).toEqual(['api/org-threads.ts', 'components/org/useOrgThreads.ts'])
    expect(src).toMatch(/function startRead\([^)]*\)[^{]*\{[\s\S]*?fetchOrgThreads\(taskId\)/)
  })
  it('every reason a surface reads for is one this test drives', () => {
    const reasons = new Set([...src.matchAll(/\bload\('([a-z-]+)'\)/g)].map((m) => m[1]))
    const events = new Set([...src.matchAll(/useEvent\('([^']+)'/g)].map((m) => m[1]))
    // Driven above: open (mount), changed, reconnect, owner-changed (task:updated), write (update, heard).
    // failed and split go the way write does (DROPS_IN_FLIGHT); snooze-ended is a timer of its own read.
    expect([...reasons].sort()).toEqual(['changed', 'failed', 'open', 'reconnect', 'snooze-ended', 'split', 'write'])
    expect([...events].sort()).toEqual(['_ws:reconnected', 'org-threads:changed', 'task:completed', 'task:deleted', 'task:updated'])
    // An owner change never reads by itself: it goes through the node-wide, throttled timer.
    expect(src).not.toMatch(/load\('owner-changed'\)/)
  })
})
