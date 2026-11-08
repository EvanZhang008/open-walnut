import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SessionRecord } from '../../../src/core/types.js'

const state = vi.hoisted(() => ({ demo: false, demoDir: null as string | null }))

vi.mock('../../../src/constants.js', async () => {
  const { createMockConstants } = await import('../../helpers/mock-constants.js')
  const constants = createMockConstants('walnut-demo-spawn')
  return {
    ...constants,
    get IS_DEMO() { return state.demo },
    get DEMO_TERMINAL_DIR() { return state.demoDir },
  }
})
vi.mock('../../../src/lib/pty.js', () => ({ loadPty: vi.fn() }))
vi.mock('../../../src/web/terminal/dtach-provision.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/web/terminal/dtach-provision.js')>()),
  localDtachPath: vi.fn(),
  remoteDtachPath: vi.fn(),
}))
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/config-manager.js')>()),
  getConfig: vi.fn(),
}))
vi.mock('../../../src/lib/demo-terminal-dir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/demo-terminal-dir.js')>()),
  ensureDemoTerminalDir: vi.fn(),
}))

import { prewarmRemoteHost, resolveSpawnForSession } from '../../../src/web/terminal/spawn.js'
import { loadPty } from '../../../src/lib/pty.js'
import { localDtachPath, remoteDtachPath } from '../../../src/web/terminal/dtach-provision.js'
import { getConfig } from '../../../src/core/config-manager.js'
import { ensureDemoTerminalDir } from '../../../src/lib/demo-terminal-dir.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import {
  closeDemoAdmission, demoAdmissionClosed, DemoAdmissionClosedError, resetDemoAdmissionForTests,
} from '../../../src/core/sessions/demo-admission.js'

const LOCAL_DTACH = '/opt/fake/bin/walnut-dtach'
const REMOTE_DTACH = '/home/u/.local/bin/walnut-dtach'
const DEMO_DIR = '/tmp/walnut-demo-user-0123456789abcdef'
const HOSTS = { devbox: { hostname: 'dev.example.com', user: 'alice' } }

const ptySpawn = vi.fn(() => ({ fake: 'pty' }))
const mocked = {
  loadPty: loadPty as unknown as Mock,
  getConfig: getConfig as unknown as Mock,
  localDtachPath: localDtachPath as unknown as Mock,
  remoteDtachPath: remoteDtachPath as unknown as Mock,
  ensureDemoTerminalDir: ensureDemoTerminalDir as unknown as Mock,
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function hold<T>(fn: Mock, value: T) {
  const answer = deferred<T>()
  const entered = deferred<void>()
  fn.mockImplementationOnce(() => { entered.resolve(); return answer.promise })
  return { entered: entered.promise, release: () => answer.resolve(value) }
}

// The session's folder must exist: a local terminal whose folder is gone starts in home (localStartDir).
const PROJ = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'walnut-demo-proj-'))
afterAll(() => fs.rmSync(PROJ, { recursive: true, force: true }))
const record = (host?: string): SessionRecord =>
  ({ claudeSessionId: '7b370f7c-c1bd-4961-b7cf-2a69d34d5854', cwd: PROJ, ...(host ? { host } : {}) }) as unknown as SessionRecord

beforeEach(() => {
  resetDemoAdmissionForTests()
  state.demo = false
  state.demoDir = null
  ptySpawn.mockClear()
  mocked.loadPty.mockReset().mockResolvedValue({ spawn: ptySpawn })
  mocked.getConfig.mockReset().mockResolvedValue({ hosts: HOSTS })
  mocked.localDtachPath.mockReset().mockResolvedValue(LOCAL_DTACH)
  mocked.remoteDtachPath.mockReset().mockResolvedValue(REMOTE_DTACH)
  mocked.ensureDemoTerminalDir.mockReset()
})

afterEach(() => {
  resetDemoAdmissionForTests()
  state.demo = false
  state.demoDir = null
})

function enterDemo(): void {
  state.demo = true
  state.demoDir = DEMO_DIR
}

describe('Demo: a stop that closes the fence mid-open leaves no pty', () => {
  it('the gate closing while loadPty is pending refuses the spawn', async () => {
    enterDemo()
    const pty = hold(mocked.loadPty, { spawn: ptySpawn })
    const open = resolveSpawnForSession(record(), 80, 24)
    await pty.entered
    closeDemoAdmission()
    pty.release()
    await expect(open).rejects.toBeInstanceOf(DemoAdmissionClosedError)
    expect(ptySpawn).not.toHaveBeenCalled()
    expect(demoAdmissionClosed()).toBe(true)
  })

  it('the gate closing while localDtachPath is pending refuses the spawn', async () => {
    enterDemo()
    const dtach = hold(mocked.localDtachPath, LOCAL_DTACH)
    const open = resolveSpawnForSession(record(), 80, 24)
    await dtach.entered
    closeDemoAdmission()
    dtach.release()
    await expect(open).rejects.toBeInstanceOf(DemoAdmissionClosedError)
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('an open that starts after the gate closed loads nothing', async () => {
    enterDemo()
    closeDemoAdmission()
    await expect(resolveSpawnForSession(record(), 80, 24)).rejects.toBeInstanceOf(DemoAdmissionClosedError)
    expect(mocked.loadPty).not.toHaveBeenCalled()
    expect(mocked.localDtachPath).not.toHaveBeenCalled()
    expect(ptySpawn).not.toHaveBeenCalled()
  })
})

describe('Demo opens only a persistent local terminal', () => {
  const DEMO_REFUSED = /Demo needs a persistent local terminal/

  it.each([
    ['a plain local shell (no dtach record, so HUP-ignoring children could outlive reset)', undefined, false],
    ['a plain remote shell', 'devbox', false],
    ['a persistent remote terminal (a real Demo has no remote daemon)', 'devbox', true],
  ])('refuses %s before loading anything', async (_label, host, persistent) => {
    enterDemo()
    await expect(resolveSpawnForSession(record(host), 80, 24, { persistent })).rejects.toThrow(DEMO_REFUSED)
    expect(mocked.loadPty).not.toHaveBeenCalled()
    expect(mocked.getConfig).not.toHaveBeenCalled()
    expect(mocked.localDtachPath).not.toHaveBeenCalled()
    expect(mocked.remoteDtachPath).not.toHaveBeenCalled()
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('an open Demo spawns its persistent local terminal under dtach, in its own claimed dir', async () => {
    enterDemo()
    const res = await resolveSpawnForSession(record(), 100, 30)
    expect(mocked.ensureDemoTerminalDir).toHaveBeenCalledWith(DEMO_DIR, WALNUT_HOME)
    expect(ptySpawn).toHaveBeenCalledTimes(1)
    const [bin, args, opts] = ptySpawn.mock.calls[0] as unknown as [string, string[], { cols: number; rows: number; cwd: string }]
    expect(bin).toBe(LOCAL_DTACH)
    expect(args[0]).toBe('-A')
    expect(opts).toMatchObject({ cols: 100, rows: 30, cwd: PROJ })
    expect(res).toMatchObject({ cwd: PROJ })
    expect(res.host).toBeUndefined()
    expect(mocked.getConfig).not.toHaveBeenCalled()
  })

  it("a record whose host is '__local__' gets the same local dtach terminal", async () => {
    enterDemo()
    const res = await resolveSpawnForSession(record('__local__'), 80, 24)
    expect(res.host).toBeUndefined()
    expect(mocked.ensureDemoTerminalDir).toHaveBeenCalledWith(DEMO_DIR, WALNUT_HOME)
    expect(mocked.getConfig).not.toHaveBeenCalled()
    expect(mocked.remoteDtachPath).not.toHaveBeenCalled()
    expect(ptySpawn).toHaveBeenCalledTimes(1)
    expect((ptySpawn.mock.calls[0] as unknown as [string])[0]).toBe(LOCAL_DTACH)
  })
})

describe('prewarm does no SSH work for this machine or a Demo', () => {
  it.each([
    ['a Demo, even for a configured remote host', true, 'devbox'],
    ["'__local__'", false, '__local__'],
    ['no host', false, undefined],
  ])('skips %s', async (_label, demo, host) => {
    if (demo) enterDemo()
    await prewarmRemoteHost(host)
    expect(mocked.getConfig).not.toHaveBeenCalled()
    expect(mocked.remoteDtachPath).not.toHaveBeenCalled()
  })

  it('still warms a remote host outside a Demo', async () => {
    await prewarmRemoteHost('devbox')
    expect(mocked.remoteDtachPath).toHaveBeenCalledWith('devbox')
  })
})

describe('every spawn branch: a closed fence spawns nothing', () => {
  type Point = 'loadPty' | 'getConfig' | 'remoteDtachPath' | 'localDtachPath'
  const SHELL_BIN = process.env.SHELL || '/bin/bash'
  const BRANCHES: { name: string; host?: string; persistent: boolean; points: Point[]; bin: string; resHost?: string }[] = [
    { name: 'plain local', persistent: false, points: ['loadPty'], bin: SHELL_BIN },
    { name: "plain local ('__local__')", host: '__local__', persistent: false, points: ['loadPty'], bin: SHELL_BIN },
    { name: 'plain remote', host: 'devbox', persistent: false, points: ['loadPty', 'getConfig'], bin: 'ssh', resHost: 'devbox' },
    { name: 'persistent remote', host: 'devbox', persistent: true, points: ['loadPty', 'getConfig', 'remoteDtachPath'], bin: 'ssh', resHost: 'devbox' },
    { name: 'persistent local', persistent: true, points: ['loadPty', 'localDtachPath'], bin: LOCAL_DTACH },
    { name: "persistent local ('__local__')", host: '__local__', persistent: true, points: ['loadPty', 'localDtachPath'], bin: LOCAL_DTACH },
  ]
  const answer: Record<Point, () => unknown> = {
    loadPty: () => ({ spawn: ptySpawn }),
    getConfig: () => ({ hosts: HOSTS }),
    remoteDtachPath: () => REMOTE_DTACH,
    localDtachPath: () => LOCAL_DTACH,
  }

  for (const b of BRANCHES) {
    describe(b.name, () => {
      it('spawns once while the fence is open', async () => {
        const res = await resolveSpawnForSession(record(b.host), 80, 24, { persistent: b.persistent })
        expect(ptySpawn).toHaveBeenCalledTimes(1)
        expect((ptySpawn.mock.calls[0] as unknown as [string])[0]).toBe(b.bin)
        expect(res.host).toBe(b.resHost)
        if (!b.resHost) {
          expect(mocked.getConfig).not.toHaveBeenCalled()
          expect(mocked.remoteDtachPath).not.toHaveBeenCalled()
        }
      })

      it('refuses at the entry when the fence closed first', async () => {
        closeDemoAdmission()
        await expect(resolveSpawnForSession(record(b.host), 80, 24, { persistent: b.persistent }))
          .rejects.toBeInstanceOf(DemoAdmissionClosedError)
        expect(mocked.loadPty).not.toHaveBeenCalled()
        expect(ptySpawn).not.toHaveBeenCalled()
      })

      for (const point of b.points) {
        it(`refuses when the fence closes while ${point} is pending`, async () => {
          const held = hold(mocked[point], answer[point]())
          const open = resolveSpawnForSession(record(b.host), 80, 24, { persistent: b.persistent })
          await held.entered
          closeDemoAdmission()
          held.release()
          await expect(open).rejects.toBeInstanceOf(DemoAdmissionClosedError)
          expect(ptySpawn).not.toHaveBeenCalled()
        })
      }
    })
  }
})

// Every pty spawn, including future ones, asserts the fence with no await after it.
describe('ratchet: each pty spawn in spawn.ts asserts the fence after its last await', () => {
  const file = path.join(__dirname, '../../../src/web/terminal/spawn.ts')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l)
  const code = lines.map((l) => (isComment(l) ? '' : l))

  it('every loadPty() result is a named handle the scan can follow', () => {
    const uses = code.filter((l) => /\bloadPty\(/.test(l) && !/^\s*import\b/.test(l))
    const named = uses.filter((l) => /\bconst\s+\w+\s*=\s*await\s+loadPty\(\)/.test(l))
    expect(uses.length).toBeGreaterThan(0)
    // A destructured or passed-on loadPty() would hide its spawns from the scan below.
    expect(named).toEqual(uses)
  })

  it('no await sits between the last assertDemoAdmission() and any spawn', () => {
    const handles = new Set<string>()
    for (const l of code) {
      const m = /\bconst\s+(\w+)\s*=\s*await\s+loadPty\(\)/.exec(l)
      if (m) handles.add(m[1]!)
    }
    const spawnRe = new RegExp(`\\b(?:${[...handles].join('|')})\\.spawn\\(`)
    const spawns: number[] = []
    code.forEach((l, i) => { if (spawnRe.test(l)) spawns.push(i) })
    expect(spawns.length).toBeGreaterThanOrEqual(4)

    const offenders: string[] = []
    for (const at of spawns) {
      let guarded = false
      for (let i = at; i >= 0; i--) {
        const l = code[i]!
        const beforeSpawn = i === at ? l.slice(0, l.search(spawnRe)) : l
        if (beforeSpawn.includes('assertDemoAdmission()')) { guarded = true; break }
        if (/\bawait\b/.test(beforeSpawn) || /^\s*(export\s+)?(async\s+)?function\b/.test(l)) break
      }
      if (!guarded) offenders.push(`spawn.ts:${at + 1}: ${lines[at]!.trim()}`)
    }
    expect(offenders).toEqual([])
  })

  it('resolveSpawnForSession asserts the fence, and refuses Demo plain/remote, before its first await', () => {
    const start = code.findIndex((l) => /export async function resolveSpawnForSession\b/.test(l))
    expect(start).toBeGreaterThanOrEqual(0)
    const firstAwait = code.findIndex((l, i) => i > start && /\bawait\b/.test(l))
    const head = code.slice(start, firstAwait).join('\n')
    expect(head).toContain('assertDemoAdmission()')
    expect(head).toMatch(/if \(IS_DEMO\b/)
  })
})
