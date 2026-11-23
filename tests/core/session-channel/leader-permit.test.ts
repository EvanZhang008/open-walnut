/**
 * The one read of the write permission's number for the session channel
 * (src/core/session-channel/leader-permit.ts): 0 for a Walnut that never told a host a number, the
 * record's number while a permit runs, and the last number told (kept in leader data) once the permit
 * is off again or waits for its record; and no other file of the session channel reads a permit
 * record's number itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PermitRuntime } from '../../../src/core/leader/switch/runtime.js'
import { classifyHomePath } from '../../../src/core/home-manifest/index.js'

import {
  _setKeptPermitHomeForTesting, keptPermitNumberFile, leaderPermitNumberForHosts, setLeaderPermitReader,
} from '../../../src/core/session-channel/leader-permit.js'

let permit: { runtime: PermitRuntime; machine: string; trial: boolean } | null = null
const setCurrentLeaderPermit = (p: typeof permit): void => { permit = p }

const DIR = path.resolve(__dirname, '../../../src/core/session-channel')

let home = ''
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-permit-'))
  _setKeptPermitHomeForTesting(home)
  setLeaderPermitReader(() => permit)
})
afterEach(() => {
  setCurrentLeaderPermit(null)
  setLeaderPermitReader(null)
  _setKeptPermitHomeForTesting(null)
  fs.rmSync(home, { recursive: true, force: true })
})

const running = (n: number | null) => ({
  runtime: { status: () => ({ record: n === null ? null : { number: n, holder: 'm1' } }) } as unknown as PermitRuntime,
  machine: 'm1', trial: false,
})

describe('leaderPermitNumberForHosts', () => {
  it('is 0 for a Walnut that never told a host a number, and the record\'s number while a permit runs', () => {
    expect(leaderPermitNumberForHosts()).toBe(0)
    // A permit waiting for its record, and no reader handed (the leader side not on): still 0.
    setCurrentLeaderPermit(running(null))
    expect(leaderPermitNumberForHosts()).toBe(0)
    setLeaderPermitReader(null)
    setCurrentLeaderPermit(running(7))
    expect(leaderPermitNumberForHosts()).toBe(0)
    expect(fs.existsSync(keptPermitNumberFile(home))).toBe(false)
    setLeaderPermitReader(() => permit)
    expect(leaderPermitNumberForHosts()).toBe(7)
  })

  it('with the permit off after it was on, tells the last number kept in leader data, never 0', () => {
    setCurrentLeaderPermit(running(4))
    expect(leaderPermitNumberForHosts()).toBe(4)
    setCurrentLeaderPermit(running(9))
    expect(leaderPermitNumberForHosts()).toBe(9)
    // Off (no reader handed, as a server with switchable_leader off), and a permit waiting for its record.
    setLeaderPermitReader(null)
    expect(leaderPermitNumberForHosts()).toBe(9)
    setLeaderPermitReader(() => permit)
    setCurrentLeaderPermit(running(null))
    expect(leaderPermitNumberForHosts()).toBe(9)
    // Kept on disk, in leader data (the standby copy carries it): a new process of the same home, or
    // the home a switch promoted from that copy, reads it back.
    const file = keptPermitNumberFile(home)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).number).toBe(9)
    expect(classifyHomePath(path.relative(home, file))?.class).toBe('leader-data')
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-permit-copy-'))
    try {
      fs.mkdirSync(path.join(copy, 'cache'), { recursive: true })
      fs.copyFileSync(file, keptPermitNumberFile(copy))
      _setKeptPermitHomeForTesting(copy)
      setCurrentLeaderPermit(null)
      expect(leaderPermitNumberForHosts()).toBe(9)
      // The new leader's own higher number replaces it there.
      setCurrentLeaderPermit(running(10))
      expect(leaderPermitNumberForHosts()).toBe(10)
      setCurrentLeaderPermit(null)
      expect(leaderPermitNumberForHosts()).toBe(10)
      expect(JSON.parse(fs.readFileSync(keptPermitNumberFile(copy), 'utf8')).number).toBe(10)
    } finally { fs.rmSync(copy, { recursive: true, force: true }) }
  })

  it('a switch\'s trial start tells its number and writes nothing into the home it tries', () => {
    setCurrentLeaderPermit({ ...running(12), trial: true })
    expect(leaderPermitNumberForHosts()).toBe(12)
    expect(fs.existsSync(keptPermitNumberFile(home))).toBe(false)
  })

  it('a lower running number is told as it is and never lowers the kept one; a torn file reads as none', () => {
    setCurrentLeaderPermit(running(5))
    leaderPermitNumberForHosts()
    setCurrentLeaderPermit(running(3))
    expect(leaderPermitNumberForHosts()).toBe(3)
    setCurrentLeaderPermit(null)
    expect(leaderPermitNumberForHosts()).toBe(5)
    fs.writeFileSync(keptPermitNumberFile(home), '{"number": "nine"')
    _setKeptPermitHomeForTesting(home)
    expect(leaderPermitNumberForHosts()).toBe(0)
  })

  it('is the only read of a permit record\'s number in the session channel', () => {
    const readers = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && f !== 'leader-permit.ts')
      .filter((f) => /\brecord\??\.number\b/.test(fs.readFileSync(path.join(DIR, f), 'utf8')))
    expect(readers).toEqual([])
  })

  it('no file of the session channel imports the leader switch, so a leader with no permit running loads none of it', () => {
    // The switch rehearsal's no-witness check (scripts/leader-switch/rehearsal.ts rehearseNoWitnesses):
    // with switchable_leader on and no witnesses, booting the leader loads no switch module. The
    // permit reader comes from web/server.ts once a permit booted.
    // doors.ts is the one switch module every leader loads (its outward-door gate), as before.
    const spec = /(?:from\s+|import\()\s*['"]([^'"]*leader\/switch\/[^'"]+)['"]/g
    const importers = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts')).flatMap((f) => {
      const text = fs.readFileSync(path.join(DIR, f), 'utf8').replace(/^\s*import type .*$/gm, '')
      return [...text.matchAll(spec)].map((m) => m[1]).filter((m) => !m.endsWith('/doors.js')).map((m) => `${f}: ${m}`)
    })
    expect(importers).toEqual([])
  })
})
