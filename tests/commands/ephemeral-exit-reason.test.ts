/**
 * Every ending of an ephemeral server leaves its reason in the machine's exit log
 * (src/commands/ephemeral-exit-record.ts). 2026-11-09: a server held for an iOS recording ended
 * after 97 minutes and its own logs went with its dirs, so the task could not tell why.
 *
 * The guard half reads runEphemeralChild's source: every exit in it goes through exitChild (which
 * names a rule) or through cleanup (which takes one), and every cleanup call names a rule. A new
 * exit path that names none fails here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ephemeralExitLine, recordEphemeralExit, exitLineRecorded, ephemeralExitLogFile } from '../../src/commands/ephemeral-exit-record.js'
import { reapStaleEphemeralDirs } from '../../src/commands/ephemeral-registry.js'

const DEAD_PID = 2 ** 22
let root: string
let log: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-eph-exit-'))
  log = path.join(root, 'exit.log')
  process.env.WALNUT_EPHEMERAL_EXIT_LOG = log
})
afterEach(() => {
  delete process.env.WALNUT_EPHEMERAL_EXIT_LOG
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ephemeral exit line', () => {
  it('names the rule, the owner and the idle minutes', () => {
    const line = ephemeralExitLine({ rule: 'idle', detail: 'no HTTP request for 10.2 min', pid: 42, port: 5555, ownerPid: null, idleMinutes: 10.2, idleLimitMinutes: 10, uptimeSec: 900.4, code: 0 }, new Date('2026-11-09T06:01:00Z'))
    expect(line).toBe('[2026-11-09T06:01:00.000Z] EPHEMERAL EXIT: no HTTP request for 10.2 min (rule=idle pid=42 port=5555 owner=none idle=10.2min idleLimit=10min uptime=900s code=0)')
  })

  it('appends to the named log and finds its own line by pid', () => {
    expect(ephemeralExitLogFile()).toBe(log)
    recordEphemeralExit({ rule: 'owner-gone', detail: 'owner pid 7 is gone', pid: 1234, ownerPid: 7 })
    expect(fs.readFileSync(log, 'utf-8')).toContain('rule=owner-gone pid=1234 owner=7')
    expect(exitLineRecorded(1234)).toBe(true)
    expect(exitLineRecorded(123)).toBe(false)
  })

  it('a test run never writes into the real exit log', () => {
    delete process.env.WALNUT_EPHEMERAL_EXIT_LOG
    expect(ephemeralExitLogFile().startsWith(os.tmpdir())).toBe(true)
  })
})

describe('the reaper writes the line a killed server could not', () => {
  function snapshot(name: string, pid: number): string {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'ephemeral.json'), JSON.stringify({ pid, port: 4321, tmpDir: dir, heartbeat: true }))
    return dir
  }

  it('a dead server that left its dirs gets a died-unrecorded line', () => {
    const home = path.join(root, 'home'); fs.mkdirSync(home)
    const dir = snapshot('open-walnut-999-abcdef', DEAD_PID)
    reapStaleEphemeralDirs(home, { tmpBase: root })
    expect(fs.existsSync(dir)).toBe(false)
    const text = fs.readFileSync(log, 'utf-8')
    expect(text).toContain(`rule=died-unrecorded pid=${DEAD_PID} port=4321`)
    expect(text).toContain('its last heartbeat was 20')
  })

  it('a server that wrote its own line gets no second one', () => {
    const home = path.join(root, 'home'); fs.mkdirSync(home)
    recordEphemeralExit({ rule: 'signal', detail: 'SIGTERM from another process', pid: DEAD_PID })
    snapshot('open-walnut-998-abcdef', DEAD_PID)
    reapStaleEphemeralDirs(home, { tmpBase: root })
    expect(fs.readFileSync(log, 'utf-8').match(/EPHEMERAL EXIT/g)).toHaveLength(1)
  })
})

describe('guard: every exit of the ephemeral child names its reason', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/commands/web-ephemeral.ts'), 'utf-8')
  const start = src.indexOf('export async function runEphemeralChild')
  const body = src.slice(start)

  it('process.exit appears only in exitChild and in cleanup', () => {
    const cleanupAt = body.indexOf('async function cleanup(')
    const exitChildAt = body.indexOf('const exitChild = ')
    expect(cleanupAt).toBeGreaterThan(0)
    expect(exitChildAt).toBeGreaterThan(0)
    const exitChildEnd = body.indexOf('\n  }\n', exitChildAt)
    const lines = body.split('\n')
    let offset = 0
    const bad: string[] = []
    for (const line of lines) {
      if (/process\.exit\(/.test(line)) {
        const inExitChild = offset > exitChildAt && offset < exitChildEnd
        const inCleanup = offset > cleanupAt
        if (!inExitChild && !inCleanup) bad.push(line.trim())
      }
      offset += line.length + 1
    }
    expect(bad).toEqual([])
    // Inside cleanup the reason is set on entry, and the forced exit names its own.
    expect(body.slice(cleanupAt, cleanupAt + 400)).toMatch(/exitWhy = \{ rule, detail: reason \}/)
    expect(body).toMatch(/exitWhy = \{ rule: 'forced'/)
  })

  it('every cleanup call names a rule', () => {
    // Call sites only (`void cleanup(…)`, `=> cleanup(…)`), not the definition or a comment naming it.
    const calls = [...body.matchAll(/(?:void |=> )cleanup\(([^)]*)\)/g)].map((m) => m[1]!.trim())
    expect(calls.length).toBeGreaterThanOrEqual(4)
    // And no call of another shape slips past that match.
    const other = body.split('\n').filter((l) => /cleanup\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)
      && !/async function cleanup\(/.test(l) && !/(?:void |=> )cleanup\(/.test(l))
    expect(other).toEqual([])
    for (const args of calls) expect(args, args).toMatch(/^'(idle|idle-contended|owner-gone|signal)',/)
  })
})
