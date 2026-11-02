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

const { locateClickedPath } = await import('../../../src/web/routes/files-locate.js')

const MAC_VIDEO = '/Users/someone/.local/state/open-walnut/tasks/t1/video/fix.mp4'
const LINUX_FILE = '/home/someone/work/repo/src/a.ts'

beforeEach(() => {
  state.hosts = { devbox: { hostname: 'devbox.example.test', label: 'Dev box' }, spare: { hostname: 'spare.example.test' } }
  state.disk = { '': {}, devbox: {}, spare: {} }
  state.asked = []
  state.hang = []
  state.slow = {}
  state.resolve = null
})

describe('locateClickedPath', () => {
  it('opens a path the session host has from the session host', async () => {
    state.disk.devbox[LINUX_FILE] = true
    state.disk[''][LINUX_FILE] = true
    const r = await locateClickedPath({ ref: LINUX_FILE, host: 'devbox', cwd: '/home/someone/work' })
    expect(r).toMatchObject({ path: LINUX_FILE, host: 'devbox', found: true, via: 'exact' })
    expect(r.elsewhere).toBeUndefined()
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

  it('refuses traversal and a relative ref with no cwd', async () => {
    await expect(locateClickedPath({ ref: '/Users/someone/../etc/passwd' })).rejects.toThrow(/Invalid path/)
    await expect(locateClickedPath({ ref: 'src/a.ts' })).rejects.toThrow(/needs cwd/)
    await expect(locateClickedPath({ ref: '' })).rejects.toThrow(/Missing/)
  })
})
