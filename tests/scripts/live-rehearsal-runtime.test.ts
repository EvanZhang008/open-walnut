/**
 * The live-update rehearsal's check of the session runtime (scripts/release-rehearsal/live.mjs).
 * Since 0f5d35bca6 (in_process_daemon on by default) a serving install runs its runtime inside the
 * server's process and writes no daemon.pid: the stage read "daemon null" and then failed with
 * "the daemon changed: null -> null". Offline: the judges are pure, and daemonOf reads a temp dir.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { judgeRuntimeKept, judgeRuntimeServing } from '../../scripts/release-rehearsal/live.mjs'
import { daemonOf } from '../../scripts/release-rehearsal/live-proc.mjs'

const ROOT = path.resolve(__dirname, '../..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-rehearsal-runtime-')))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const alive = (pids: number[]) => (pid: number) => pids.includes(pid)

describe('daemonOf: the runtime a daemon dir names', () => {
  const dir = (name: string, files: Record<string, string>) => {
    const d = path.join(tmp, name)
    fs.mkdirSync(d, { recursive: true })
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(d, f), text)
    return d
  }

  it('reads a daemon program by its daemon.pid, and the in-process runtime by its instance id', () => {
    expect(daemonOf(dir('program', { 'daemon.pid': '4242\n', 'daemon.version': 'walnut-daemon-a', 'daemon.instance': 'd-4242-ab12' }))).toEqual({ version: 'walnut-daemon-a', pid: 4242 })
    expect(daemonOf(dir('in-process', { 'daemon.version': 'walnut-daemon-a', 'daemon.instance': 'd-3780-10f6ed16' }))).toEqual({ version: 'walnut-daemon-a', pid: 3780, inProcess: true })
    expect(daemonOf(dir('none', {}))).toEqual({ version: null, pid: null })
  })
})

describe('judgeRuntimeServing (live-serve)', () => {
  it('needs a runtime: none is a failure, never "daemon null"', () => {
    expect(() => judgeRuntimeServing({ daemon: { pid: null }, server: 10 })).toThrow(/no session runtime/)
  })

  it('takes the server\'s own runtime only when it names the server on the port', () => {
    expect(judgeRuntimeServing({ daemon: { pid: 10, inProcess: true }, server: 10 })).toMatch(/in the server's process \(pid 10\)/)
    expect(() => judgeRuntimeServing({ daemon: { pid: 11, inProcess: true }, server: 10 })).toThrow(/names pid 11, not the server 10/)
  })

  it('takes a daemon program only while it runs', () => {
    expect(judgeRuntimeServing({ daemon: { pid: 20 }, server: 10, isAlive: alive([20]) })).toBe('daemon 20')
    expect(() => judgeRuntimeServing({ daemon: { pid: 20 }, server: 10, isAlive: alive([]) })).toThrow(/not alive/)
  })
})

describe('judgeRuntimeKept (live-update, live-again)', () => {
  it('a daemon program is the same process, alive, after the restart', () => {
    expect(judgeRuntimeKept({ before: { pid: 20 }, now: { pid: 20 }, server: 11, isAlive: alive([20]) })).toBe('daemon 20 same')
    expect(() => judgeRuntimeKept({ before: { pid: 20 }, now: { pid: 21 }, server: 11, isAlive: alive([21]) })).toThrow(/the daemon changed: 20 -> 21/)
    expect(() => judgeRuntimeKept({ before: { pid: 20 }, now: { pid: 20 }, server: 11, isAlive: alive([]) })).toThrow(/alive false/)
  })

  it('the runtime in the server\'s process is the new server\'s, and the old one is gone', () => {
    const before = { pid: 10, inProcess: true }
    expect(judgeRuntimeKept({ before, now: { pid: 11, inProcess: true }, server: 11, isAlive: alive([11]) })).toMatch(/pid 10 -> 11/)
    // A stale instance id of the old server, or one that names another process.
    expect(() => judgeRuntimeKept({ before, now: { pid: 10, inProcess: true }, server: 11, isAlive: alive([11]) })).toThrow(/names pid 10, not the new server 11/)
    expect(() => judgeRuntimeKept({ before, now: { pid: 11, inProcess: true }, server: 11, isAlive: alive([10, 11]) })).toThrow(/old server's runtime \(pid 10\) still runs/)
  })

  it('no runtime after the restart, or one that moved between the two kinds, fails', () => {
    expect(() => judgeRuntimeKept({ before: { pid: 10, inProcess: true }, now: { pid: null }, server: 11 })).toThrow(/no session runtime after the restart/)
    expect(() => judgeRuntimeKept({ before: { pid: 20 }, now: { pid: 11, inProcess: true }, server: 11, isAlive: alive([11]) })).toThrow(/moved into the server's process/)
    expect(() => judgeRuntimeKept({ before: { pid: 10, inProcess: true }, now: { pid: 20 }, server: 11, isAlive: alive([20]) })).toThrow(/moved out of the server's process/)
  })
})

/**
 * The class: a rehearsal stage that reads a serving install's runtime from daemon.pid alone sees
 * none once the server holds it in its process. Every reader of daemon.pid under
 * scripts/release-rehearsal/ goes through daemonOf (live-proc.mjs), or is named here with why it
 * reads a daemon program only. A new file that reads daemon.pid itself fails here.
 */
describe('every rehearsal reads a serving install\'s runtime through daemonOf', () => {
  const PROGRAM_ONLY: Record<string, string> = {
    'live-proc.mjs': 'daemonOf itself',
    'own-daemon.mjs': 'stops the daemon program a rehearsal started (the in-process runtime ends with its server)',
    'mixed-leader-host.mjs': 'pins WALNUT_IN_PROCESS_DAEMON=0: its leaders run a daemon program by design',
    'host-judged-old-host.mjs': 'a host\'s own daemon program, which never runs inside a server',
  }

  it('names no other reader of daemon.pid', () => {
    const dir = path.join(ROOT, 'scripts/release-rehearsal')
    const readers = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))
      .filter((f) => /['"`/]daemon\.pid['"`]/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(readers.filter((f) => !(f in PROGRAM_ONLY)), 'read the runtime with daemonOf (live-proc.mjs), or name the file in PROGRAM_ONLY with why').toEqual([])
    // A file that stopped reading it leaves the list.
    expect(Object.keys(PROGRAM_ONLY).filter((f) => !readers.includes(f))).toEqual([])
  })
})
