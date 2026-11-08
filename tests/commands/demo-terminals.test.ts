/**
 * Demo reset stops the Demo's own terminals (src/commands/demo-terminals.ts) before any
 * data is cleared: each dtach socket is probed exactly, only a verified master and the
 * descendants it had at probe time are tracked (by pid AND start time), the master gets
 * TERM through stopDtachMaster, and the data is kept until none of those processes is
 * alive; a pid now holding another start time is another process, so it counts as gone.
 *
 * dtach-master is mocked as a LEAF (no importOriginal), so no shell runs and nothing is
 * signalled. The mocked runner plays the shell: it answers the start-time and liveness
 * scripts from a table of what is "running" now.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const m = vi.hoisted(() => ({
  homedir: '',
  run: vi.fn(),
  parse: vi.fn(),
  choose: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('../../src/lib/account.js', () => ({
  accountInfo: () => ({ username: 'demo-user', homedir: m.homedir, shell: '/bin/sh', uid: 501, gid: 20 }),
}))
vi.mock('../../src/web/terminal/dtach-master.js', () => ({
  localShellRunner: m.run,
  parseDtachProbe: m.parse,
  chooseDtachMaster: m.choose,
  stopDtachMaster: m.stop,
  dtachProbeScript: (socket: string, withTable?: boolean) => `PROBE ${socket} ${withTable === true}`,
  START_FN: 'STARTFN',
}))

import { stopDemoTerminals } from '../../src/commands/demo-terminals.js'
import { demoPaths, type DemoPaths } from '../../src/commands/demo-home.js'
import { ensureDemoTerminalDir, removeDemoTerminalDir } from '../../src/lib/demo-terminal-dir.js'

let base: string
let paths: DemoPaths
let termDir: string
let dataFile: string
/** pid -> start time of what runs "now" on the fake host. */
let live: Map<number, string>
let probeCode: number
let startsCode: number
let checkCode: number
let startsNoise: string
const scripts: string[] = []

function probe(over: Record<string, unknown> = {}) {
  return {
    recorded: null, ownerLookup: true, owners: [], procs: new Map(), socketExists: true,
    complete: true, table: [] as string[], ...over,
  }
}

function terminal(id: string, ...exts: string[]): string {
  for (const ext of exts.length ? exts : ['dsock']) fs.writeFileSync(path.join(termDir, `walnut-${id}.${ext}`), '')
  return path.join(termDir, `walnut-${id}.dsock`)
}

const checkScripts = () => scripts.filter(s => s.includes('CHECKED'))
const startScripts = () => scripts.filter(s => s.startsWith('STARTFN;') && !s.includes('CHECKED'))
const checkedPairs = (script: string) =>
  [...script.matchAll(/s=\$\(walnut_st (\d+)\); if \[ "\$s" = '([^']*)' \]/g)].map(([, pid, start]) => `${pid}=${start}`)

beforeEach(() => {
  for (const fn of [m.run, m.parse, m.choose, m.stop]) fn.mockReset()
  scripts.length = 0
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-term-')))
  m.homedir = path.join(base, 'account')
  paths = demoPaths(path.join(base, 'open-walnut-demo'), 'g')
  termDir = paths.terminals
  ensureDemoTerminalDir(termDir, paths.data)
  fs.mkdirSync(paths.data, { recursive: true })
  dataFile = path.join(paths.data, 'tasks.json')
  fs.writeFileSync(dataFile, 'keep')
  live = new Map()
  probeCode = 0
  startsCode = 0
  checkCode = 0
  startsNoise = ''
  m.parse.mockReturnValue(probe())
  m.choose.mockReturnValue({ targets: [], source: 'none' })
  m.stop.mockResolvedValue({ outcome: 'stopped', source: 'recorded', signalled: [] })
  m.run.mockImplementation(async (script: string) => {
    scripts.push(script)
    if (script.startsWith('PROBE ')) return { code: probeCode, stdout: 'PROBE-OUTPUT', stderr: '' }
    if (script.includes('CHECKED')) {
      const alive = [...script.matchAll(/s=\$\(walnut_st (\d+)\); if \[ "\$s" = '([^']*)' \]/g)]
        .some(([, pid, start]) => live.get(Number(pid)) === start)
      return { code: checkCode, stdout: `${alive ? 'ALIVE\n' : ''}CHECKED\n`, stderr: '' }
    }
    if (script.startsWith('STARTFN;')) {
      const pids = [...script.matchAll(/walnut_st (\d+)\)/g)].map(([, pid]) => Number(pid))
      const out = pids.map(pid => `${pid}:${live.get(pid) ?? 'GONE'}\n`).join('')
      return { code: startsCode, stdout: out + startsNoise, stderr: '' }
    }
    throw new Error(`unexpected script: ${script}`)
  })
})

afterEach(async () => {
  vi.useRealTimers()
  if (fs.existsSync(termDir)) fs.writeFileSync(path.join(termDir, '.owner'), `${paths.data}\n`)
  await removeDemoTerminalDir(termDir, paths.data)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('stopDemoTerminals with nothing to stop', () => {
  it('runs no shell when the terminal dir is missing', async () => {
    fs.rmSync(termDir, { recursive: true })
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    expect(m.run).not.toHaveBeenCalled()
    expect(m.stop).not.toHaveBeenCalled()
  })

  it('runs no shell for an empty dir or files that are not Demo terminals', async () => {
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    for (const name of ['other.txt', 'walnut-.dsock', 'walnut-a b.dsock', 'walnut-x.sock', 'xwalnut-y.dsock', 'walnut-$(id).dpid']) {
      fs.writeFileSync(path.join(termDir, name), '')
    }
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    expect(m.run).not.toHaveBeenCalled()
    expect(m.stop).not.toHaveBeenCalled()
  })

  it('probes a terminal once even with both its socket and pid file', async () => {
    const socket = terminal('t1', 'dsock', 'dpid')
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    expect(scripts.filter(s => s.startsWith('PROBE '))).toEqual([`PROBE ${socket} true`])
    expect(m.stop).toHaveBeenCalledTimes(1)
    expect(m.stop).toHaveBeenCalledWith(m.run, socket, { demo: true })
    expect(checkScripts()).toEqual([])
  })
})

describe('stopDemoTerminals refusals keep the data', () => {
  it('refuses another owner before probing or stopping any process', async () => {
    terminal('t1')
    fs.writeFileSync(path.join(termDir, '.owner'), '/other/data/g\n')
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/another Walnut/)
    expect(m.run).not.toHaveBeenCalled()
    expect(m.stop).not.toHaveBeenCalled()
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('refuses a probe that exited non-zero', async () => {
    terminal('t1')
    probeCode = 1
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/could not be checked; data was kept/)
    expect(m.stop).not.toHaveBeenCalled()
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('refuses a probe that did not run to its end', async () => {
    terminal('t1')
    m.parse.mockReturnValue(probe({ complete: false }))
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/could not be checked; data was kept/)
    expect(m.choose).not.toHaveBeenCalled()
    expect(m.stop).not.toHaveBeenCalled()
  })

  it('refuses when the master could not be proved and was left', async () => {
    terminal('t1')
    m.stop.mockResolvedValue({ outcome: 'left', source: 'none', signalled: [] })
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/ownership could not be confirmed/)
    expect(checkScripts()).toEqual([])
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('refuses when the start times of its children cannot be read, before any stop', async () => {
    terminal('t1')
    live.set(100, 'S100')
    m.choose.mockReturnValue({ targets: [{ pid: 100, start: 'S100' }], source: 'recorded' })
    startsCode = 1
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/children could not be checked/)
    expect(m.stop).not.toHaveBeenCalled()
  })

  it('refuses a child whose start time is missing before stopping the master', async () => {
    terminal('t1')
    live.set(100, 'S100')
    m.choose.mockReturnValue({ targets: [{ pid: 100, start: 'S100' }], source: 'recorded' })
    live.set(200, 'UNKNOWN')
    m.parse.mockReturnValue(probe({ table: ['100 1 dtach', '200 100 sh'] }))
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/did not all report their identity/)
    expect(m.stop).not.toHaveBeenCalled()
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('refuses an unreadable identity of a recorded process during the exit check', async () => {
    terminal('t1')
    live.set(100, 'S100')
    m.choose.mockReturnValue({ targets: [{ pid: 100, start: 'S100' }], source: 'recorded' })
    const run = m.run.getMockImplementation()!
    m.run.mockImplementation(async (script: string) => script.includes('CHECKED')
      ? { code: 0, stdout: 'UNKNOWN\nCHECKED\n', stderr: '' } : run(script))
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/exit could not be checked/)
    expect(fs.existsSync(path.join(paths.data, 'demo-terminal-stop.json'))).toBe(true)
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('refuses when the exit check fails', async () => {
    terminal('t1')
    live.set(100, 'S100')
    m.choose.mockReturnValue({ targets: [{ pid: 100, start: 'S100' }], source: 'recorded' })
    checkCode = 2
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/exit could not be checked/)
  })
})

describe('a pending terminal stop survives a retry without socket files', () => {
  it('keeps data until every recorded process has gone, even after the socket was removed', async () => {
    const file = path.join(paths.data, 'demo-terminal-stop.json')
    fs.writeFileSync(file, JSON.stringify({ home: paths.data, socket: path.join(termDir, 'walnut-t1.dsock'), processes: [{ pid: 300, start: 'S300' }] }))
    live.set(300, 'S300')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let reached!: () => void
    const entered = new Promise<void>(resolve => { reached = resolve })
    m.stop.mockImplementation(async () => { reached(); return { outcome: 'nothing', signalled: [] } })
    const stop = stopDemoTerminals(paths).then(() => null, error => error)
    await entered
    await vi.advanceTimersByTimeAsync(10_100)
    expect(await stop).toMatchObject({ message: expect.stringMatching(/still stopping; data was kept/) })
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
    vi.useRealTimers()
    live.delete(300)
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    expect(fs.existsSync(file)).toBe(false)
    expect(m.stop).toHaveBeenCalledTimes(2)
  })

  it('still checks recorded children when the terminal directory disappeared', async () => {
    const file = path.join(paths.data, 'demo-terminal-stop.json')
    fs.writeFileSync(file, JSON.stringify({ home: paths.data, socket: path.join(termDir, 'walnut-t1.dsock'), processes: [{ pid: 300, start: 'S300' }] }))
    fs.rmSync(termDir, { recursive: true })
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    expect(checkedPairs(checkScripts()[0]!)).toEqual(['300=S300'])
    expect(m.stop).not.toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('retries a master whose previous stop was never confirmed', async () => {
    const file = path.join(paths.data, 'demo-terminal-stop.json')
    const socket = path.join(termDir, 'walnut-t1.dsock')
    fs.writeFileSync(file, JSON.stringify({ home: paths.data, socket, processes: [{ pid: 100, start: 'S100' }] }))
    live.set(100, 'S100')
    m.stop.mockImplementation(async () => { live.delete(100); return { outcome: 'stopped', signalled: [100] } })
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    expect(m.stop).toHaveBeenCalledWith(m.run, socket, { demo: true })
    expect(fs.existsSync(file)).toBe(false)
  })

  it.each([
    null, { home: 'another-home', processes: [] },
    { processes: [{ pid: 0, start: 'unsafe' }] },
  ])('refuses a malformed pending identity without signalling %j', async value => {
    fs.writeFileSync(path.join(paths.data, 'demo-terminal-stop.json'), JSON.stringify(value))
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/invalid/)
    expect(m.stop).not.toHaveBeenCalled()
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })
})

describe('stopDemoTerminals with a verified master', () => {
  const table = [
    '  100     1 dtach',
    '  200   100 zsh',
    '  300   200 vim',
    '  400     1 other',
    '  500   400 bash',
    '  888     1 sh -c walnut_st 100; printf 100:x 200 300',
    'garbage 100 line',
  ]

  function verified(): string {
    const socket = terminal('t1')
    for (const [pid, start] of [[100, 'S100'], [200, 'S200'], [300, 'S300'], [400, 'S400'], [500, 'S500'], [888, 'S888']] as const) {
      live.set(pid, start)
    }
    m.parse.mockReturnValue(probe({ owners: [100, 400], table }))
    m.choose.mockReturnValue({ targets: [{ pid: 100, start: 'S100' }], source: 'recorded' })
    return socket
  }

  it('records the master and its descendants with their start times, and nothing else', async () => {
    const socket = verified()
    m.stop.mockImplementation(async () => {
      for (const pid of [100, 200, 300]) live.delete(pid)
      return { outcome: 'stopped', source: 'recorded', signalled: [100] }
    })
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()

    expect(m.parse).toHaveBeenCalledWith('PROBE-OUTPUT')
    expect(m.choose).toHaveBeenCalledWith(expect.objectContaining({ table }), socket)
    const asked = [...startScripts()[0]!.matchAll(/walnut_st (\d+)\)/g)].map(([, pid]) => Number(pid)).sort((a, b) => a - b)
    expect(asked).toEqual([100, 200, 300])
    expect(m.stop).toHaveBeenCalledWith(m.run, socket, { demo: true })
    const checks = checkScripts()
    expect(checks).toHaveLength(1)
    expect(checkedPairs(checks[0]!).sort()).toEqual(['100=S100', '200=S200', '300=S300'])
    expect(scripts.join('\n')).not.toMatch(/kill -(?:TERM|KILL|INT)/)
  })

  it('never makes a target of a pid the start-time answer did not ask for', async () => {
    verified()
    startsNoise = '400:S400\n888:S888\n'
    m.stop.mockImplementation(async () => {
      for (const pid of [100, 200, 300]) live.delete(pid)
      return { outcome: 'stopped', source: 'recorded', signalled: [100] }
    })
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    const pairs = checkScripts().flatMap(checkedPairs)
    expect(pairs.some(p => p.startsWith('400=') || p.startsWith('500=') || p.startsWith('888='))).toBe(false)
  })

  it('waits for the shell birth record before snapshotting children or stopping the master', async () => {
    verified()
    m.choose.mockReturnValueOnce({ targets: [{ pid: 100, start: 'S100' }], source: 'socket-owner' })
    m.stop.mockImplementation(async () => {
      expect(scripts.filter(s => s.startsWith('PROBE '))).toHaveLength(2)
      for (const pid of [100, 200, 300]) live.delete(pid)
      return { outcome: 'stopped', signalled: [100] }
    })
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    expect(startScripts()).toHaveLength(1)
  })

  it('refuses a different recorded master after the socket owner probe', async () => {
    verified()
    m.choose.mockReturnValueOnce({ targets: [{ pid: 101, start: 'S101' }], source: 'socket-owner' })
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/identity changed/)
    expect(m.stop).not.toHaveBeenCalled()
    expect(startScripts()).toEqual([])
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('keeps data and signals nothing if the shell birth record never arrives', async () => {
    verified()
    m.choose.mockReturnValue({ targets: [{ pid: 100, start: 'S100' }], source: 'socket-owner' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let reached!: () => void
    const entered = new Promise<void>(resolve => { reached = resolve })
    const choose = m.choose.getMockImplementation()!
    m.choose.mockImplementation((...args) => { reached(); return choose(...args) })
    const stop = stopDemoTerminals(paths).then(() => null, error => error)
    await entered
    await vi.advanceTimersByTimeAsync(5_100)
    expect(await stop).toMatchObject({ message: expect.stringMatching(/started shell; data was kept/) })
    expect(m.stop).not.toHaveBeenCalled()
    expect(startScripts()).toEqual([])
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('accepts a child that exited between the process table and its identity read', async () => {
    verified()
    live.delete(300)
    m.stop.mockImplementation(async () => {
      for (const pid of [100, 200]) live.delete(pid)
      return { outcome: 'stopped', source: 'recorded', signalled: [100] }
    })
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    expect(checkScripts().flatMap(checkedPairs)).not.toContain('300=GONE')
  })

  it('counts a pid now holding another start time as gone', async () => {
    verified()
    m.stop.mockImplementation(async () => {
      live.set(100, 'S100-reused')
      live.set(200, 'S200-reused')
      live.delete(300)
      return { outcome: 'stopped', source: 'recorded', signalled: [100] }
    })
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    expect(checkScripts()).toHaveLength(1)
  })

  /** Resolves once stopDtachMaster ran, so the real readdir is done before fake time moves. */
  function stopReached(kill: number[]): Promise<void> {
    return new Promise(resolve => {
      m.stop.mockImplementation(async () => {
        for (const pid of kill) live.delete(pid)
        resolve()
        return { outcome: 'stopped', source: 'recorded', signalled: [100] }
      })
    })
  }

  it('waits while a child lives on, and finishes once it exits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    verified()
    const reached = stopReached([100, 200])
    let settled = false
    const run = stopDemoTerminals(paths).finally(() => { settled = true })
    await reached
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(false)
    live.delete(300)
    await vi.advanceTimersByTimeAsync(200)
    await expect(run).resolves.toBeUndefined()
  })

  it('keeps the data until the deadline while a tracked process stays ALIVE', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    verified()
    const reached = stopReached([])
    let settled = false
    const run = stopDemoTerminals(paths).finally(() => { settled = true })
    const outcome = run.then(() => 'resolved', (error: Error) => error.message)
    await reached
    await vi.advanceTimersByTimeAsync(9_800)
    expect(settled).toBe(false)
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
    await vi.advanceTimersByTimeAsync(500)
    expect(await outcome).toMatch(/still stopping; data was kept/)
    expect(checkScripts().length).toBeGreaterThan(10)
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })
})
