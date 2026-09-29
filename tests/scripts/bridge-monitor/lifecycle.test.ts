/**
 * Collector lifecycle rules, each on its own: a directory that cannot be made
 * waits before exiting, one collector at a time, state written on change at
 * most once a minute, and detached children that never outlive the collector.
 *
 * The orphan sweep may signal only a group it can PROVE the collector
 * spawned. Every sweep test below injects the kill function, except the one
 * that kills a process this test spawned itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireLock, prepareDirs, psCommand, releaseLock, StateWriter } from '../../../scripts/bridge-monitor/lib/lifecycle.mjs'
import {
  killAllChildren, leaderCommandLines, ORPHAN_MARGIN_MS, parsePsRows, planSweep, processIdentity, readProcesses, run,
  setChildRegistry, sweepOrphans, sweepRegistry,
} from '../../../scripts/bridge-monitor/lib/run.mjs'

type AnyRec = Record<string, any>
let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-life-')) })
afterEach(() => {
  setChildRegistry(null)
  killAllChildren()
  fs.rmSync(dir, { recursive: true, force: true })
})
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const waitFor = async (cond: () => boolean, ms = 15_000) => {
  for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms;) await new Promise((r) => setTimeout(r, 50))
  return cond()
}

describe('prepareDirs', () => {
  it('a directory that cannot be made waits 10 minutes before the process gives up', async () => {
    const blocker = path.join(dir, 'file')
    fs.writeFileSync(blocker, 'x')
    const waited: number[] = []
    const ok = await prepareDirs([path.join(blocker, 'logs')], { wait: async (ms: number) => { waited.push(ms) }, log: () => {} })
    expect(ok).toBe(false)
    expect(waited).toEqual([600_000])
    expect(await prepareDirs([path.join(dir, 'a', 'b')], { wait: async () => { throw new Error('must not wait') } })).toBe(true)
    expect(fs.statSync(path.join(dir, 'a', 'b')).mode & 0o777).toBe(0o700)
  })
})

describe('single-instance lock', () => {
  const leftovers = () => fs.readdirSync(dir).filter((n) => n !== 'collector.lock')

  it('a live collector holds it; a second one is refused', async () => {
    const file = path.join(dir, 'collector.lock')
    expect(await acquireLock(file, { pid: process.pid })).toEqual({ ok: true })
    const other = await acquireLock(file, { pid: 999_999, commandOf: async () => '/usr/local/bin/node /app/collector.mjs' })
    expect(other).toEqual({ ok: false, heldBy: process.pid })
    releaseLock(file, 999_999) // not the holder: nothing happens
    expect(fs.existsSync(file)).toBe(true)
    releaseLock(file, process.pid)
    expect(fs.existsSync(file)).toBe(false)
    expect(leftovers()).toEqual([]) // the temp file the lock was linked from is gone
  })

  it('a stale lock (dead pid, or a pid reused by another program) is taken over', async () => {
    const file = path.join(dir, 'collector.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: 2_147_483_600 }))
    expect(await acquireLock(file, { pid: 4242 })).toEqual({ ok: true })
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(4242)
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }))
    expect(await acquireLock(file, { pid: 4243, commandOf: async () => '/usr/bin/vim notes.txt' })).toEqual({ ok: true })
    fs.writeFileSync(file, '{torn')
    expect(await acquireLock(file, { pid: 4244 })).toEqual({ ok: true })
    expect(leftovers()).toEqual([])
  })

  it('fails closed: a live holder that ps cannot check counts as running, and its lock stays', async () => {
    const file = path.join(dir, 'collector.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, t: 'x' }))
    expect(await acquireLock(file, { pid: 4245, commandOf: async () => null })).toEqual({ ok: false, heldBy: process.pid, unknown: true })
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ pid: process.pid, t: 'x' })
  })

  it('psCommand says unknown (null) on a ps timeout or error, never "gone"', async () => {
    const res = (r: AnyRec) => async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, error: null, ...r })
    expect(await psCommand(1, { runImpl: res({ code: -1, timedOut: true, error: 'timeout' }) })).toBeNull()
    expect(await psCommand(1, { runImpl: res({ code: -1, error: 'spawn EAGAIN' }) })).toBeNull()
    expect(await psCommand(1, { runImpl: res({ code: 2, stdout: '' }) })).toBeNull()
    expect(await psCommand(1, { runImpl: res({ code: 1, stdout: '' }) })).toBe('') // ran, pid gone
    expect(await psCommand(1, { runImpl: res({ code: 0, stdout: '/usr/bin/node collector.mjs\n' }) })).toBe('/usr/bin/node collector.mjs')
    expect(await psCommand(process.pid)).toContain('node')
  })

  it('takeover is atomic: a taker that judged a lock stale never removes the fresh lock another taker wrote meanwhile', async () => {
    const file = path.join(dir, 'collector.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, t: 'old' })) // live pid, reused by another program
    let b: AnyRec | null = null
    // A judges the lock while B, starting at the same moment, takes it over and writes its own.
    const a = await acquireLock(file, {
      pid: 5001,
      commandOf: async () => {
        b = await acquireLock(file, { pid: 5002, commandOf: async () => '/usr/bin/vim' })
        return '/usr/bin/vim'
      },
    })
    expect(b).toEqual({ ok: true })
    expect(a).toEqual({ ok: false, error: 'lock contended' })
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(5002) // B's lock is still in place
    expect(leftovers()).toEqual([])
  })
})

describe('state writer', () => {
  it('writes only on change, at most once a minute, and always when forced', async () => {
    let now = 1_000_000
    const writes: string[] = []
    const w = new StateWriter('/unused', { now: () => now, write: async (_f: string, json: string) => { writes.push(json) } })
    expect(await w.save({ a: 1 })).toBe('written')
    now += 10_000
    expect(await w.save({ a: 2 })).toBe('deferred') // the 10 s tick changed it: wait
    now += 55_000
    expect(await w.save({ a: 2 })).toBe('written')
    now += 61_000
    expect(await w.save({ a: 2 })).toBe('unchanged')
    now += 1_000
    expect(await w.save({ a: 3 }, { force: true })).toBe('written') // shutdown
    w.requestWrite()
    now += 1_000
    expect(await w.save({ a: 4 })).toBe('written') // an alert was sent
    expect(writes).toEqual(['{"a":1}', '{"a":2}', '{"a":3}', '{"a":4}'])
    // Six ticks a minute for an hour: at most 60 writes, not 360.
    let n = 0
    const w2 = new StateWriter('/unused', { now: () => now, write: async () => { n++ } })
    for (let k = 0; k < 360; k++) { now += 10_000; await w2.save({ tick: k }) }
    expect(n).toBeLessThanOrEqual(60)
  })
})

describe('orphan sweep: signal only what the collector provably spawned', () => {
  const NOW = Date.parse('2026-09-28T20:00:00Z')
  const SELF = 7000
  const LSTART = 'Mon Sep 28 12:59:40 2026'
  const LOG_ARGV = ['/usr/bin/nice', '-n', '10', '/usr/bin/time', '-l', '/usr/bin/log', 'show', '--last', '20m', '--style', 'ndjson']
  const entry = (extra: AnyRec = {}) => ({ pid: 501, pgid: 501, lstart: LSTART, argv: LOG_ARGV, t: new Date(NOW - 60_000).toISOString(), timeoutMs: 300_000, ...extra })
  const row = (pid: number, pgid: number, lstart: string, command: string) => `${String(pid).padStart(5)} ${String(pgid).padStart(5)} ${lstart}     ${command}`
  const ps = (...rows: string[]) => parsePsRows([row(SELF, SELF, 'Mon Sep 28 12:00:00 2026', '/opt/homebrew/bin/node collector.mjs'), ...rows].join('\n'))
  const sweep = (entries: AnyRec[], procs: Map<number, AnyRec> | null) => {
    const kills: number[] = []
    const out = sweepOrphans(entries, procs, { nowMs: NOW, selfPid: SELF, kill: (g: number) => { kills.push(g) } })
    return { kills, ...out }
  }

  it('a genuine orphan (same pid, own group, same start second, same argv) is killed', () => {
    const r = sweep([entry()], ps(row(501, 501, LSTART, LOG_ARGV.join(' ')), row(502, 501, LSTART, '/usr/bin/log show --last 20m --style ndjson')))
    expect(r.kills).toEqual([501])
    expect(r.dropped).toEqual([])
    // nice execs /usr/bin/time in place: same pid and start time, argv without the nice prefix.
    const exec = sweep([entry()], ps(row(501, 501, LSTART, LOG_ARGV.slice(3).join(' '))))
    expect(exec.kills).toEqual([501])
    expect(leaderCommandLines(LOG_ARGV)).toEqual([LOG_ARGV.join(' '), LOG_ARGV.slice(3).join(' ')])
  })

  it('a pid reused by the SAME binary with a different start time is left alone', () => {
    const r = sweep([entry()], ps(row(501, 501, 'Mon Sep 28 13:27:02 2026', LOG_ARGV.join(' '))))
    expect(r.kills).toEqual([])
    expect(r.dropped).toEqual([{ pid: 501, reason: 'pid reused (start time differs)' }])
  })

  it('the login prefix case: "/usr/bin/login -fpl" contains "/usr/bin/log" and is never a match', () => {
    const login = '/usr/bin/login -fpl someone /Applications/Terminal.app/Contents/MacOS/ShellLauncher --launch_shell'
    const r = sweep([entry({ argv: ['/usr/bin/log'] })], ps(row(501, 501, LSTART, login)))
    expect(r.kills).toEqual([])
    expect(r.dropped).toEqual([{ pid: 501, reason: 'pid reused (command line differs)' }])
    // A longer argv that merely starts the same way does not match either.
    expect(sweep([entry()], ps(row(501, 501, LSTART, `${LOG_ARGV.join(' ')} --extra`))).kills).toEqual([])
  })

  it('a pid that is now a member of another group, not its leader, is left alone', () => {
    // The gate's case: a server's child runs pmset, and the recorded pid is reused as that group's member.
    const r = sweep([entry({ pid: 4222, pgid: 4222, argv: ['/usr/bin/pmset', '-g', 'batt'] })], ps(row(4222, 4100, LSTART, '/usr/bin/pmset -g batt')))
    expect(r.kills).toEqual([])
    expect(r.dropped).toEqual([{ pid: 4222, reason: 'pid is no longer a group leader' }])
  })

  it('a ps that times out or fails kills nothing, and the registry is cleared', async () => {
    const file = path.join(dir, 'children.json')
    const kills: number[] = []
    for (const res of [{ code: -1, timedOut: true, error: 'timeout', stdout: '' }, { code: -1, timedOut: false, error: 'spawn EAGAIN', stdout: '' }, { code: 0, timedOut: false, error: null, stdout: '' }]) {
      fs.writeFileSync(file, JSON.stringify([entry()]))
      const out = await sweepRegistry(file, { runImpl: async () => res, kill: (g: number) => { kills.push(g) }, nowMs: NOW, selfPid: SELF })
      expect(out).toEqual({ killed: [], dropped: [{ pid: 501, reason: 'ps unreadable' }] })
      expect(fs.existsSync(file)).toBe(false)
    }
    expect(kills).toEqual([])
  })

  it('an entry older than its own timeout plus the margin is dropped without a signal, even if everything matches', () => {
    const old = entry({ t: new Date(NOW - 300_000 - ORPHAN_MARGIN_MS - 1000).toISOString() })
    const r = sweep([old], ps(row(501, 501, LSTART, LOG_ARGV.join(' '))))
    expect(r.kills).toEqual([])
    expect(r.dropped).toEqual([{ pid: 501, reason: 'older than its timeout' }])
  })

  it('never pid 1, never its own group; old entries without an identity are dropped', () => {
    const procs = ps(row(1, 1, LSTART, LOG_ARGV.join(' ')))
    const r = sweep([
      entry({ pid: 1, pgid: 1 }),
      entry({ pid: SELF, pgid: SELF }),
      { pid: 501, cmd: '/usr/bin/log', t: new Date(NOW).toISOString() }, // the registry format before proof
      entry({ pgid: 777 }),
      entry({ lstart: undefined }),
    ], procs)
    expect(r.kills).toEqual([])
    expect(r.dropped.map((d: AnyRec) => d.reason)).toEqual([
      'never signal init or the collector itself', 'never signal init or the collector itself',
      'incomplete entry', 'incomplete entry', 'incomplete entry',
    ])
    // planSweep refuses the collector's own process group too, whatever its leader is.
    const own = parsePsRows([row(SELF, 6900, 'Mon Sep 28 12:00:00 2026', 'node collector.mjs'), row(6900, 6900, LSTART, LOG_ARGV.join(' '))].join('\n'))
    expect(planSweep([entry({ pid: 6900, pgid: 6900 })], own, { nowMs: NOW, selfPid: SELF })[0]).toMatchObject({ action: 'drop', reason: 'never signal init or the collector itself' })
  })

  it("this Mac's real ps output, every group leader's pid 'reused' with its exact start time, kills nothing", () => {
    const rows = parsePsRows(execFileSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,lstart=,command='], { encoding: 'utf-8', env: { ...process.env, LC_ALL: 'C' } }))
    const leaders = [...rows.values()].filter((p) => p.pid === p.pgid && p.pid > 1)
    expect(leaders.length).toBeGreaterThan(10)
    // What the old rule matched on: the tracked binaries alone.
    const entries = leaders.flatMap((p) => ['/usr/bin/log', '/usr/bin/pmset', '/usr/sbin/system_profiler', '/usr/bin/time'].map((bin) => (
      { pid: p.pid, pgid: p.pid, lstart: p.lstart, argv: [bin], t: new Date().toISOString(), timeoutMs: 300_000 })))
    const kills: number[] = []
    sweepOrphans(entries, rows, { kill: (g: number) => { kills.push(g) } })
    expect(kills).toEqual([])
  })
})

describe('detached children (real processes this test spawned)', () => {
  it('a tracked child is listed with its identity while it runs, and killed with the collector', async () => {
    const file = path.join(dir, 'children.json')
    setChildRegistry(file)
    const done = run('/bin/sleep', ['30'], { timeoutMs: 60_000, track: true })
    const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return [] } }
    expect(await waitFor(() => read().length === 1)).toBe(true)
    const [entry] = read()
    expect(entry).toMatchObject({ argv: ['/bin/sleep', '30'], timeoutMs: 60_000 })
    expect(entry.pgid).toBe(entry.pid)
    expect(entry.lstart).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/)
    expect(alive(entry.pid)).toBe(true)
    killAllChildren() // what every exit path runs
    const res = await done
    expect(res.code).not.toBe(0)
    expect(alive(entry.pid)).toBe(false)
    expect(read()).toEqual([])
  })

  it('the next start kills the group a SIGKILLed collector left behind, and not one whose start time differs', async () => {
    const orphan = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    const bystander = spawn('/bin/sleep', ['31'], { detached: true, stdio: 'ignore' })
    try {
      const idO = await processIdentity(orphan.pid!)
      const idB = await processIdentity(bystander.pid!)
      expect(idO?.pgid).toBe(orphan.pid)
      const t = new Date().toISOString()
      const file = path.join(dir, 'children.json')
      fs.writeFileSync(file, JSON.stringify([
        { pid: orphan.pid, pgid: idO!.pgid, lstart: idO!.lstart, argv: ['/bin/sleep', '30'], t, timeoutMs: 60_000 },
        // As if the recorded pid had been reused: same command, a start a year earlier.
        { pid: bystander.pid, pgid: idB!.pgid, lstart: idB!.lstart.replace(/\d{4}$/, (y) => String(Number(y) - 1)), argv: ['/bin/sleep', '31'], t, timeoutMs: 60_000 },
      ]))
      const out = await sweepRegistry(file)
      expect(out.killed).toEqual([{ pgid: orphan.pid, cmd: '/bin/sleep 30' }])
      expect(out.dropped).toEqual([{ pid: bystander.pid, reason: 'pid reused (start time differs)' }])
      expect(await waitFor(() => !alive(orphan.pid!), 5000)).toBe(true)
      expect(alive(bystander.pid!)).toBe(true)
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      // Only a child not yet reaped: libuv sets exitCode/signalCode in the same callback as
      // waitpid, so null means its pid (and group) cannot have been handed to anyone else.
      for (const p of [orphan, bystander]) {
        if (p.exitCode === null && p.signalCode === null) { try { process.kill(-p.pid!, 'SIGKILL') } catch { /* gone */ } }
      }
    }
  })

  it('readProcesses reads real rows, this process included', async () => {
    const rows = await readProcesses([process.pid])
    expect(rows?.get(process.pid)?.command).toContain('node')
  })

  it('the registry empties when a tracked child ends by itself', async () => {
    const file = path.join(dir, 'children.json')
    setChildRegistry(file)
    const res = await run('/bin/echo', ['hi'], { track: true })
    expect(res.stdout.trim()).toBe('hi')
    await new Promise((r) => setTimeout(r, 300)) // a late identity answer must not re-add it
    const left = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) as AnyRec[] : []
    expect(left).toEqual([])
  })
})

describe('shipped collector wiring', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'bridge-monitor', 'collector.mjs'), 'utf-8')
  it('prepares dirs and takes the lock before the crash-loop backoff writes anything', () => {
    const order = ['prepareDirs(', 'acquireLock(', 'sweepRegistry(', 'crashLoopBackoff()', 'scrubOnce('].map((k) => src.indexOf(k, src.indexOf('async function main')))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(src).toMatch(/process\.on\('exit', \(\) => \{ killAllChildren\(\); releaseLock/)
    expect(src).not.toMatch(/^ensureDir\(/m)
  })
})
