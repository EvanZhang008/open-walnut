/**
 * Where a clicked path lives (src/web/routes/files-locate.ts).
 *
 * The 2026-11-01 report: a session on a Linux host wrote a Mac path (a video in
 * the Mac's task directory); the click opened Files on the Linux host and healed
 * to `/`. The lookup asks every host for the exact path, prefers the session's,
 * then the host the path's shape points at, and says plainly when none has it.
 * Host existence is stubbed (linkPathsExist): what is under test is the order
 * and the answer, not the daemon RPC (files-list-self-heal.test.ts covers that).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const state = vi.hoisted(() => ({
  hosts: {} as Record<string, { hostname: string; label?: string; enabled?: boolean }>,
  /** host key ('' = this machine) → path → exists (absent = cannot say) */
  disk: {} as Record<string, Record<string, boolean>>,
  asked: [] as string[],
  /** hosts whose answer never comes (down, dialing) */
  hang: [] as string[],
  /** hosts whose answer comes after this many ms */
  slow: {} as Record<string, number>,
  resolve: null as null | ((rel: string, cwd: string, host?: string) => { path: string; resolved: boolean; via?: string }),
  /** task id → its session ids, newest last; session id → its host (absent = this machine) */
  tasks: {} as Record<string, string[]>,
  sessionHosts: {} as Record<string, string | undefined>,
}))

vi.mock('../../../src/core/task-manager.js', () => ({
  // As the real one, a unique prefix answers the task it names.
  getTask: async (ref: string) => {
    const id = ref in state.tasks ? ref : Object.keys(state.tasks).find((k) => k.startsWith(ref))
    if (!id) throw new Error(`No task ${ref}`)
    const sids = state.tasks[id]!
    return { id, session_id: sids[sids.length - 1], session_ids: sids }
  },
}))

vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (sid: string) => (sid in state.sessionHosts ? { claudeSessionId: sid, host: state.sessionHosts[sid] } : null),
}))

vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<object>()),
  getConfig: async () => ({ hosts: state.hosts }),
}))

vi.mock('../../../src/web/routes/files.js', async (orig) => {
  const real = await orig<typeof import('../../../src/web/routes/files.js')>()
  return {
    ...real,
    linkPathsExist: async (paths: string[], host?: string) => {
      state.asked.push(host ?? '')
      if (state.hang.includes(host ?? '')) return new Promise<Record<string, boolean>>(() => {})
      const delay = state.slow[host ?? '']
      if (delay) await new Promise((r) => setTimeout(r, delay))
      const out: Record<string, boolean> = {}
      for (const p of paths) {
        const v = state.disk[host ?? '']?.[p]
        if (v !== undefined) out[p] = v
      }
      return out
    },
    resolveSessionPath: async (rel: string, cwd: string, host?: string) => {
      if (!state.resolve) throw new Error('resolver not expected')
      return state.resolve(rel, cwd, host)
    },
  }
})

const { locateClickedPath, locateRequestOf, locateBodyOf, taskIdOfTaskDirPath } = await import('../../../src/web/routes/files-locate.js')

const MAC_VIDEO = '/Users/someone/.local/state/open-walnut/tasks/t1/video/fix.mp4'
const LINUX_FILE = '/home/someone/work/repo/src/a.ts'

beforeEach(() => {
  state.hosts = { devbox: { hostname: 'devbox.example.test', label: 'Dev box' }, spare: { hostname: 'spare.example.test' } }
  state.disk = { '': {}, devbox: {}, spare: {} }
  state.asked = []
  state.hang = []
  state.slow = {}
  state.resolve = null
  state.tasks = {}
  state.sessionHosts = {}
})

describe('locateClickedPath', () => {
  it('opens a path the session host has from the session host', async () => {
    state.disk.devbox[LINUX_FILE] = true
    state.disk[''][LINUX_FILE] = true
    const r = await locateClickedPath({ ref: LINUX_FILE, host: 'devbox', cwd: '/home/someone/work' })
    expect(r).toMatchObject({ path: LINUX_FILE, host: 'devbox', found: true, via: 'exact' })
    expect(r.elsewhere).toBeUndefined()
  })

  it('a source-bound reference never probes another host for a missing file', async () => {
    for (const host of ['devbox', undefined]) {
      state.asked = []
      state.disk.devbox[LINUX_FILE] = host !== 'devbox'
      state.disk[''][LINUX_FILE] = host === 'devbox'
      state.disk.spare[LINUX_FILE] = true
      const r = await locateClickedPath({ ref: `${LINUX_FILE}:3`, host, sourceOnly: true })
      expect(r).toMatchObject({ path: LINUX_FILE, found: false, missing: true, line: 3 })
      expect(r.host).toBe(host)
      expect(r.elsewhere).toBeUndefined()
      expect(state.asked).toEqual([host ?? ''])
      expect(r.checked).toEqual([host ? 'Dev box' : 'Local'])
    }
  })

  it('the HTTP edge carries the source boundary to the actual lookup', async () => {
    state.disk.devbox[LINUX_FILE] = false
    state.disk[''][LINUX_FILE] = true
    const { filesRouter } = await import('../../../src/web/routes/files.js')
    const app = express().use('/api/files', filesRouter)
    const r = await request(app).get('/api/files/locate').query({ ref: LINUX_FILE, host: 'devbox', sourceOnly: '1' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ path: LINUX_FILE, host: 'devbox', found: false, missing: true })
    expect(state.asked).toEqual(['devbox'])
    const { filesV1Router } = await import('../../../src/web/routes/files-v1.js')
    const phone = express().use('/api/v1', filesV1Router)
    state.asked = []
    const mobile = await request(phone).get('/api/v1/files/locate').query({ ref: LINUX_FILE, host: 'devbox', sourceOnly: '1' })
    expect(mobile.status).toBe(200)
    expect(mobile.body).toMatchObject({ path: LINUX_FILE, host: 'devbox', found: false, missing: true })
    expect(state.asked).toEqual(['devbox'])
  })

  it('a source-bound reference keeps an unavailable host without probing other disks', async () => {
    state.disk[''][LINUX_FILE] = true
    const r = await locateClickedPath({ ref: LINUX_FILE, host: 'devbox', sourceOnly: true })
    expect(r).toMatchObject({ path: LINUX_FILE, host: 'devbox', found: false })
    expect(r.missing).toBeUndefined()
    expect(state.asked).toEqual(['devbox'])
  })

  it('opens a Mac path a Linux session wrote from this machine (the report)', async () => {
    state.disk.devbox[MAC_VIDEO] = false
    state.disk.spare[MAC_VIDEO] = false
    state.disk[''][MAC_VIDEO] = true
    const r = await locateClickedPath({ ref: MAC_VIDEO, host: 'devbox', cwd: '/home/someone/work', sessionId: 's1' })
    expect(r).toMatchObject({ path: MAC_VIDEO, found: true, elsewhere: true, via: 'other-host' })
    expect(r.host).toBeUndefined()
  })

  it('carries the position the reference asked for', async () => {
    state.disk.devbox[LINUX_FILE] = false
    state.disk.spare[LINUX_FILE] = true
    const r = await locateClickedPath({ ref: `${LINUX_FILE}:42`, cwd: '/Users/someone' })
    expect(r).toMatchObject({ path: LINUX_FILE, host: 'spare', found: true, elsewhere: true, line: 42 })
  })

  it('breaks a tie by the path shape: /Users/ asks the Mac first, /home/ the Linux hosts', async () => {
    const mac = process.platform === 'darwin'
    state.disk[''][MAC_VIDEO] = true
    state.disk.spare[MAC_VIDEO] = true
    state.disk.devbox[MAC_VIDEO] = false
    const a = await locateClickedPath({ ref: MAC_VIDEO, host: 'devbox' })
    expect(a.host).toBe(mac ? undefined : 'spare')
    state.disk[''][LINUX_FILE] = true
    state.disk.spare[LINUX_FILE] = true
    state.disk.devbox[LINUX_FILE] = false
    const b = await locateClickedPath({ ref: LINUX_FILE, host: 'devbox' })
    expect(b.host).toBe(mac ? 'spare' : undefined)
  })

  it('says plainly when no host has it, naming every host asked, session host first', async () => {
    state.disk[''][MAC_VIDEO] = false
    state.disk.devbox[MAC_VIDEO] = false
    state.disk.spare[MAC_VIDEO] = false
    state.resolve = (rel) => ({ path: '/', resolved: false, via: 'none' })
    const r = await locateClickedPath({ ref: MAC_VIDEO, host: 'devbox', cwd: '/home/someone/work' })
    expect(r).toMatchObject({ path: MAC_VIDEO, host: 'devbox', found: false, missing: true })
    expect(r.checked?.[0]).toBe('Dev box')
    expect(r.checked).toEqual(expect.arrayContaining(['Local', 'spare']))
    expect(r.path).not.toBe('/')
  })

  it('takes the resolver when the exact path is nowhere but the session host has the file under another prefix', async () => {
    const written = '/Users/someone/work/repo/src/a.ts'
    state.disk.devbox[written] = false
    state.disk[''][written] = false
    state.disk.spare[written] = false
    state.resolve = (_rel, _cwd, host) => ({ path: host === 'devbox' ? LINUX_FILE : '/', resolved: host === 'devbox', via: 'git' })
    const r = await locateClickedPath({ ref: written, host: 'devbox', cwd: '/home/someone/work' })
    expect(r).toMatchObject({ path: LINUX_FILE, host: 'devbox', found: true, via: 'git' })
  })

  it('opens on the session host as before when that host cannot answer and nobody else has it', async () => {
    state.disk[''][MAC_VIDEO] = false
    state.disk.spare[MAC_VIDEO] = false
    const r = await locateClickedPath({ ref: MAC_VIDEO, host: 'devbox' })
    expect(r).toMatchObject({ path: MAC_VIDEO, host: 'devbox', found: false })
    expect(r.missing).toBeUndefined()
  })

  it('does not hold the click for a host that never answers once another has the file', async () => {
    state.hang = ['']
    state.disk.devbox[MAC_VIDEO] = false
    state.disk.spare[MAC_VIDEO] = true
    const t0 = Date.now()
    const r = await locateClickedPath({ ref: MAC_VIDEO, host: 'devbox' })
    expect(r).toMatchObject({ host: 'spare', found: true, elsewhere: true })
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('waits for the session host past the grace: its copy of a path both have is the one meant', async () => {
    const shared = '/tmp/open-walnut/x.log'
    state.slow.devbox = 700
    state.disk.devbox[shared] = true
    state.disk[''][shared] = true
    const r = await locateClickedPath({ ref: shared, host: 'devbox' })
    expect(r).toMatchObject({ host: 'devbox', found: true, via: 'exact' })
  })

  it('never asks a host the user turned off', async () => {
    state.hosts.spare.enabled = false
    state.disk.spare[LINUX_FILE] = true
    state.disk[''][LINUX_FILE] = false
    state.disk.devbox[LINUX_FILE] = false
    const r = await locateClickedPath({ ref: LINUX_FILE })
    expect(state.asked).not.toContain('spare')
    expect(r.missing).toBe(true)
  })

  it('asks each host once, all at once', async () => {
    state.disk[''][LINUX_FILE] = false
    state.disk.devbox[LINUX_FILE] = true
    await locateClickedPath({ ref: LINUX_FILE })
    expect(state.asked.sort()).toEqual(['', 'devbox', 'spare'])
  })

  it('resolves a relative ref on the session host only', async () => {
    state.resolve = (rel, cwd, host) => ({ path: `${cwd}/deep/${rel}`, resolved: true, via: 'git' })
    const r = await locateClickedPath({ ref: 'src/a.ts', host: 'devbox', cwd: '/home/someone/work' })
    expect(r).toMatchObject({ path: '/home/someone/work/deep/src/a.ts', host: 'devbox', found: true })
    expect(state.asked).toEqual([])
  })

  it('reports a relative ref the session host lacks as missing, never its stand-in folder', async () => {
    state.resolve = () => ({ path: '/', resolved: false, via: 'none' })
    const r = await locateClickedPath({ ref: 'src/gone.ts:9', host: 'devbox', cwd: '/home/someone/work' })
    expect(r).toMatchObject({ path: '/home/someone/work/src/gone.ts', host: 'devbox', found: false, missing: true, checked: ['Dev box'], line: 9 })
  })

  it('a relative ref on a host that could not search opens there as before, not as missing', async () => {
    state.resolve = () => ({ path: '/home/someone/work/src/a.ts', resolved: false })
    const r = await locateClickedPath({ ref: 'src/a.ts', host: 'devbox', cwd: '/home/someone/work' })
    expect(r).toMatchObject({ path: '/home/someone/work/src/a.ts', host: 'devbox', found: false })
    expect(r.missing).toBeUndefined()
  })

  it('refuses traversal and a relative ref with no cwd', async () => {
    await expect(locateClickedPath({ ref: '/Users/someone/../etc/passwd' })).rejects.toThrow(/Invalid path/)
    await expect(locateClickedPath({ ref: 'src/a.ts' })).rejects.toThrow(/needs cwd/)
    await expect(locateClickedPath({ ref: '' })).rejects.toThrow(/Missing/)
  })
})

describe('locateClickedPath anywhere: a path whose writer is unknown', () => {
  const SHARED = '/srv/shared/report.html'

  it('asks every machine and opens it from the one that has it; the person is never asked', async () => {
    state.disk.spare[SHARED] = true
    const r = await locateClickedPath({ ref: SHARED, anywhere: true })
    expect(r).toMatchObject({ path: SHARED, host: 'spare', hostName: 'spare', found: true, elsewhere: true, via: 'anywhere' })
    expect(state.asked.sort()).toEqual(['', 'devbox', 'spare'])
  })

  it("a task's machine is asked first and wins a path several machines have", async () => {
    state.disk[''][SHARED] = true
    state.disk.devbox[SHARED] = true
    state.tasks = { 'task-a': ['s-old', 's-new'] }
    state.sessionHosts = { 's-old': undefined, 's-new': 'devbox' }
    const r = await locateClickedPath({ ref: SHARED, anywhere: true, taskId: 'task-a' })
    expect(r).toMatchObject({ host: 'devbox', found: true, via: 'anywhere' })
    // With no task named, this machine comes first for a path of no particular shape.
    expect(await locateClickedPath({ ref: SHARED, anywhere: true })).toMatchObject({ found: true, via: 'anywhere' })
    expect((await locateClickedPath({ ref: SHARED, anywhere: true })).host).toBeUndefined()
  })

  it("the task a task-directory path names is its own hint, and an unknown task id adds none", async () => {
    const inDir = '/home/someone/.local/state/open-walnut/tasks/task-b/proof/page.html'
    expect(taskIdOfTaskDirPath(inDir)).toBe('task-b')
    expect(taskIdOfTaskDirPath('/home/someone/.local/state/open-walnut/tasks/task-b')).toBeUndefined()
    state.disk.devbox[inDir] = true
    state.disk.spare[inDir] = true
    state.tasks = { 'task-b': ['s1'] }
    state.sessionHosts = { s1: 'spare' }
    expect(await locateClickedPath({ ref: inDir, anywhere: true })).toMatchObject({ host: 'spare', found: true })
    expect(await locateClickedPath({ ref: inDir, anywhere: true, taskId: 'no-such-task' })).toMatchObject({ host: 'spare', found: true })
  })

  it('a hinted machine that is down does not stop the others from answering, and none having it says which were asked', async () => {
    state.tasks = { 'task-c': ['s1'] }
    state.sessionHosts = { s1: 'devbox' }
    state.disk[''][SHARED] = false
    state.disk.spare[SHARED] = false
    state.disk.devbox = {}
    const r = await locateClickedPath({ ref: SHARED, anywhere: true, taskId: 'task-c' })
    expect(r).toMatchObject({ path: SHARED, found: false, missing: true, unreachable: ['Dev box'] })
    expect(r.host).toBeUndefined()
    expect(r.checked!.sort()).toEqual(['Local', 'spare'])
  })

  it('a hinted machine that never answers holds a found file only for the short grace', async () => {
    state.tasks = { 'task-d': ['s1'] }
    state.sessionHosts = { s1: 'devbox' }
    state.hang = ['devbox']
    state.disk.spare[SHARED] = true
    const t0 = Date.now()
    const r = await locateClickedPath({ ref: SHARED, anywhere: true, taskId: 'task-d' })
    expect(r).toMatchObject({ host: 'spare', found: true, via: 'anywhere' })
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it("the writing sessions' machines come first of all, the person's words naming this machine", async () => {
    state.disk[''][SHARED] = true
    state.disk.devbox[SHARED] = true
    state.disk.spare[SHARED] = true
    state.sessionHosts = { w1: 'spare', w2: 'devbox' }
    state.tasks = { 'task-e': ['w2'] }
    expect(await locateClickedPath({ ref: SHARED, anywhere: true, taskId: 'task-e', hintSessions: ['w1'] })).toMatchObject({ host: 'spare' })
    expect((await locateClickedPath({ ref: SHARED, anywhere: true, taskId: 'task-e', hintSessions: ['__local__', 'w1'] })).host).toBeUndefined()
    // An unknown session adds no hint: the task's machine is next.
    expect(await locateClickedPath({ ref: SHARED, anywhere: true, taskId: 'task-e', hintSessions: ['gone'] })).toMatchObject({ host: 'devbox' })
  })

  it('a task id counts only as an exact id, never as a prefix of another task', async () => {
    state.disk[''][SHARED] = true
    state.disk.spare[SHARED] = true
    state.sessionHosts = { s1: 'spare' }
    state.tasks = { 'task-long-id': ['s1'] }
    expect(await locateClickedPath({ ref: SHARED, anywhere: true, taskId: 'task-long-id' })).toMatchObject({ host: 'spare' })
    // A prefix of it names that task to getTask, but is not its id: no hint, this machine first.
    expect((await locateClickedPath({ ref: SHARED, anywhere: true, taskId: 'task-lo' })).host).toBeUndefined()
  })

  it('a relative path with no writer is missing at once, with no machine asked', async () => {
    const r = await locateClickedPath({ ref: 'src/a.ts:3', anywhere: true })
    expect(r).toMatchObject({ path: 'src/a.ts', found: false, missing: true, checked: [], line: 3 })
    expect(state.asked).toEqual([])
  })

  it('a named host or sourceOnly is not unknown: anywhere is ignored', async () => {
    state.disk.spare[SHARED] = true
    state.disk.devbox[SHARED] = false
    expect(await locateClickedPath({ ref: SHARED, anywhere: true, host: 'devbox', sourceOnly: true })).toMatchObject({ missing: true, checked: ['Dev box'] })
  })

  it('the routes and the relay read and pass the same fields', () => {
    const r = locateRequestOf({ ref: SHARED, anywhere: '1', taskId: 'task-a', sourceOnly: '0', host: '', hintSessions: 'w1, w2,,w1' })
    expect(r).toEqual({ ref: SHARED, cwd: undefined, host: undefined, sessionId: undefined, sourceOnly: false, anywhere: true, taskId: 'task-a', hintSessions: ['w1', 'w2'] })
    expect(locateBodyOf(r)).toEqual({ ref: SHARED, taskId: 'task-a', anywhere: true, hintSessions: ['w1', 'w2'] })
    expect(locateRequestOf(locateBodyOf(r))).toEqual(r)
    expect(locateRequestOf({ ref: SHARED, sourceOnly: true })).toMatchObject({ sourceOnly: true })
    expect(locateRequestOf({ ref: SHARED }).anywhere).toBeUndefined()
  })
})
