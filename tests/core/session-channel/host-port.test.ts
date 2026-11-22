/**
 * The host's session port (src/core/session-channel/host-port.ts): a row this host makes is its
 * own; leader reads answer from the start bundle first, then this host's copies; the task side of
 * its sessions (links, phase, activity) is the leader's and answers unchanged, never tried; any
 * other task field goes to this service's own API as the session's own call, so the route table
 * decides (the leader's refusal or the away write port's answer comes back as it is).
 */
import { describe, expect, it } from 'vitest'
import { createHostSessionPort, StartBundles, type OwnApi } from '../../../src/core/session-channel/host-port.js'
import { isNeedsLeaderError } from '../../../src/core/replication/needs-leader.js'
import type { SessionPort } from '../../../src/core/sessions/session-port.js'
import type { SessionRecord, Task } from '../../../src/core/types.js'

const HOST = 'marina-box'

function fakeBase() {
  const rows = new Map<string, SessionRecord>()
  const calls: string[] = []
  const tracker = {
    getSessionByClaudeId: async (sid: string) => rows.get(sid) ?? null,
    createSessionRecord: async (sid: string, taskId: string, project: string, cwd?: string, extra?: Record<string, unknown>) => {
      calls.push(`create:${sid}`)
      // As the store does (session-tracker.ts createSessionRecord): a row made with this host's own key is born judge 'host'.
      const r = rows.get(sid) ?? ({ claudeSessionId: sid, taskId, project, ...(cwd ? { cwd } : {}), ...(extra?.host ? { host: extra.host } : {}), ...(extra?.host === HOST || extra?.judge === 'host' ? { judge: 'host' } : {}) } as SessionRecord)
      rows.set(sid, r)
      return r
    },
    updateSessionRecord: async (sid: string, patch: Record<string, unknown>) => {
      const r = { ...rows.get(sid)!, ...patch } as SessionRecord
      rows.set(sid, r)
      return r
    },
    renameSessionId: async (from: string, to: string) => {
      const r = rows.get(from)
      if (!r) return null
      rows.delete(from)
      rows.set(to, { ...r, claudeSessionId: to })
      return rows.get(to)!
    },
    deleteSessionRecords: async (ids: Set<string>) => { let n = 0; for (const id of ids) if (rows.delete(id)) n++; return n },
  }
  const copyTask = { id: 'task-copy-1', title: 'From the copy', project: 'Marina' } as Task
  const base = {
    records: { tracker, loadTracker: async () => tracker },
    tasks: {
      loadTaskManager: async () => ({
        getTask: async (id: string) => { if (id === copyTask.id) return copyTask; throw new Error(`Task not found: ${id}`) },
        getProjectMetadata: async (p: string) => (p === 'Marina' ? { default_cwd: '/home/marina/copy' } : null),
      }),
      loadPhase: async () => ({ isChatSendSource: () => false, isPersonSendSource: () => true, sendSourceReopensTerminal: () => false, applySessionPhase: async () => ({ changed: true }) }),
    },
    config: { loadConfigManager: async () => ({ getConfig: async () => ({}) }) },
    launch: {
      loadSessionContext: async () => ({ buildSessionContext: async () => ({ systemPrompt: 'from the copy' }) }),
    },
    messages: { queue: {}, loadMessageQueue: async () => ({}), loadHintSend: async () => ({ prepareStartHints: async (data: unknown) => ({ data: { ...(data as object), hinted: true }, commit: async () => {} }) }) },
    recovery: {},
  } as unknown as SessionPort
  return { base, rows, calls, copyTask }
}

function fakeApi(answer: (method: string, path: string, body: unknown, sid: string | null) => { status: number; body: unknown }) {
  const seen: Array<{ method: string; path: string; body: unknown; sid: string | null }> = []
  const api: OwnApi = { request: async (method, path, body, opts) => { seen.push({ method, path, body, sid: opts.sid }); return answer(method, path, body, opts.sid) } }
  return { api, seen }
}

function port(over: { api?: OwnApi | null; sessionOfTask?: (t: string) => string | null; bundles?: StartBundles } = {}) {
  const f = fakeBase()
  const renames: string[] = []
  const drops: string[][] = []
  const bundles = over.bundles ?? new StartBundles()
  const p = createHostSessionPort({
    hostKey: HOST, bundles, api: async () => over.api ?? null, base: f.base,
    sessionOfTask: over.sessionOfTask ?? (() => 'sid-run-1'),
    onRename: (a, b) => renames.push(`${a}>${b}`), onDrop: (s) => drops.push(s),
  })
  return { p, f, renames, drops, bundles }
}

async function refusedWhy(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (err) { if (isNeedsLeaderError(err)) return err.why; throw err }
  throw new Error('not refused')
}

describe('records', () => {
  it('a row this host makes is its own: judge host, this host\'s key', async () => {
    const { p } = port()
    const r = await p.records.tracker.createSessionRecord('sid-new-1', 'task-1', 'Marina', '/home/marina', { host: 'elsewhere' })
    expect(r).toMatchObject({ claudeSessionId: 'sid-new-1', judge: 'host', host: HOST })
  })

  it('a copy of a leader\'s row is written as it was, never claimed', async () => {
    const { p, f } = port()
    f.rows.set('sid-copy-1', { claudeSessionId: 'sid-copy-1', taskId: 't', project: 'P', host: 'another-box' } as SessionRecord)
    const r = await p.records.tracker.createSessionRecord('sid-copy-1', 't', 'P')
    expect(r.judge).toBeUndefined()
    expect(r.host).toBe('another-box')
  })

  it('tells the emitter of a rename and of a removal', async () => {
    const { p, renames, drops } = port()
    await p.records.tracker.createSessionRecord('sid-a', 'task-1', 'Marina')
    await p.records.tracker.renameSessionId('sid-a', 'sid-b')
    await p.records.tracker.deleteSessionRecords(new Set(['sid-b']), 'test')
    await p.records.tracker.deleteSessionRecords(new Set(['sid-none']), 'test')
    expect(renames).toEqual(['sid-a>sid-b'])
    expect(drops).toEqual([['sid-b']])
  })
})

describe('tasks', () => {
  it('reads the start\'s bundle first, then this host\'s copies', async () => {
    const { p, bundles, f } = port()
    const leaderTask = { id: 'task-leader-1', title: 'Only the leader has it', project: 'Acme' } as Task
    bundles.put('task-leader-1', { task: leaderTask, projectMetadata: { default_cwd: '/home/acme/leader' } })
    const tm = await p.tasks.loadTaskManager()
    expect((await tm.getTask('task-leader-1')).title).toBe('Only the leader has it')
    expect((await tm.getTask('task-copy-1')).title).toBe(f.copyTask.title)
    expect(await tm.getProjectMetadata('Acme')).toEqual({ default_cwd: '/home/acme/leader' })
    expect(await tm.getProjectMetadata('Marina')).toEqual({ default_cwd: '/home/marina/copy' })
    bundles.clear('task-leader-1')
    await expect(tm.getTask('task-leader-1')).rejects.toThrow(/not found/)
  })

  it('a task write goes to this service\'s own API as the session\'s own call; the route\'s refusal comes back as needs_leader', async () => {
    const { api, seen } = fakeApi(() => ({ status: 503, body: { error: { code: 'needs_leader', why: 'leader_answers', message: 'the Mac answers' } } }))
    const { p } = port({ api })
    const tm = await p.tasks.loadTaskManager()
    expect(await refusedWhy(tm.updateTask('task-copy-1', { title: 'Named here' }))).toBe('leader_answers')
    expect(seen).toEqual([{ method: 'PATCH', path: '/api/tasks/task-copy-1', body: { title: 'Named here' }, sid: 'sid-run-1' }])
  })

  it('the phase a start moves is the leader\'s: not sent, the task answers as it is; the rest of the write still goes', async () => {
    const { api, seen } = fakeApi(() => ({ status: 200, body: { task: { id: 'task-copy-1', title: 'Named here' } } }))
    const { p, f } = port({ api })
    const tm = await p.tasks.loadTaskManager()
    expect((await tm.updateTask('task-copy-1', { phase: 'IN_PROGRESS' })).task).toBe(f.copyTask)
    expect(seen).toEqual([])
    await tm.updateTask('task-copy-1', { phase: 'IN_PROGRESS', title: 'Named here' })
    expect(seen).toEqual([{ method: 'PATCH', path: '/api/tasks/task-copy-1', body: { title: 'Named here' }, sid: 'sid-run-1' }])
  })

  it('an away write the write port took answers as the route answered', async () => {
    const { api } = fakeApi(() => ({ status: 200, body: { task: { id: 'task-copy-1', title: 'Named away' } } }))
    const { p } = port({ api })
    const tm = await p.tasks.loadTaskManager()
    expect((await tm.updateTask('task-copy-1', { title: 'Named away' })).task).toMatchObject({ title: 'Named away' })
  })

  it('no session of this host runs the task, or no own API yet: refused, nothing sent', async () => {
    const { api, seen } = fakeApi(() => ({ status: 200, body: {} }))
    const a = port({ api, sessionOfTask: () => null })
    expect(await refusedWhy((await a.p.tasks.loadTaskManager()).updateTask('task-copy-1', { title: 'x' }))).toBe('no_caller_session')
    const b = port({ api: null })
    expect(await refusedWhy((await b.p.tasks.loadTaskManager()).updateTask('task-copy-1', { title: 'x' }))).toBe('no_self_api')
    expect(seen).toEqual([])
  })

  it('a start in flight names its session for a write made before the row is known', async () => {
    const { api, seen } = fakeApi(() => ({ status: 200, body: {} }))
    const bundles = new StartBundles()
    bundles.put('task-copy-1', {}, 'sid-preassigned-1')
    const { p } = port({ api, bundles, sessionOfTask: () => null })
    await (await p.tasks.loadTaskManager()).updateTask('task-copy-1', { title: 'Named at the start' })
    expect(seen[0]!.sid).toBe('sid-preassigned-1')
  })

  it('the session links are the leader\'s: answered with the task as it is, never tried; the phase a turn moves answers unchanged; the activity touch does nothing', async () => {
    const { api, seen } = fakeApi(() => ({ status: 500, body: {} }))
    const { p, f } = port({ api })
    const tm = await p.tasks.loadTaskManager()
    for (const write of [
      tm.linkSession('task-copy-1', 'sid-1'), tm.linkSessionSlot('task-copy-1', 'sid-1', 'exec'), tm.clearSession('task-copy-1', 'sid-1'),
      tm.clearSessionSlot('task-copy-1', 'sid-1'), tm.addSessionToHistory('task-copy-1', 'sid-1'), tm.replaceSessionIdLinks('task-copy-1', 'a', 'b'),
    ]) expect((await write).task).toBe(f.copyTask)
    expect(seen).toEqual([])
    await expect(tm.touchLastSessionUpdate('task-copy-1')).resolves.toBeUndefined()
    const ph = await p.tasks.loadPhase()
    expect(await ph.applySessionPhase('task-copy-1', 'session:result' as never, 'test')).toEqual({ changed: false })
    expect(ph.isPersonSendSource('x')).toBe(true)
  })
})

describe('launch and messages', () => {
  it('the session context and the hints of a bundled start are the leader\'s', async () => {
    const { p, bundles } = port()
    bundles.put('task-b', { sessionContext: { systemPrompt: 'from the leader' }, hintsApplied: true })
    const ctx = await p.launch.loadSessionContext()
    expect(await ctx.buildSessionContext('task-b')).toEqual({ systemPrompt: 'from the leader' })
    expect(await ctx.buildSessionContext('task-other')).toEqual({ systemPrompt: 'from the copy' })
    const hints = await p.messages.loadHintSend()
    const data = { taskId: 'task-b', message: 'm' }
    expect((await hints.prepareStartHints(data)).data).toBe(data)
    expect((await hints.prepareStartHints({ taskId: 'task-other', message: 'm' })).data).toMatchObject({ hinted: true })
  })

  it('a bundle expires', async () => {
    let now = 1000
    const bundles = new StartBundles(() => now)
    bundles.put('task-x', { hintsApplied: true }, 'sid-x', 100)
    expect(bundles.get('task-x')).not.toBeNull()
    now = 1200
    expect(bundles.get('task-x')).toBeNull()
    expect(bundles.sidOf('task-x')).toBeNull()
  })
})
