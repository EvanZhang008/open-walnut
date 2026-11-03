/**
 * src/core/login-session.ts: a process that lives on in a login session macOS
 * ended, or in a working directory that was deleted (2026-11-03: ssh said "No
 * user exists for uid 503", names did not resolve, and the voice model's Python
 * died with FileNotFoundError, all in one server a deploy started during a
 * logout). The outputs below are the ones that server's children printed.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  LOGIN_SESSION_PROBLEMS, LOGIN_SESSION_PROBE_SCRIPT, judgeLoginSession, loginSessionSummary,
} from '../../src/core/login-session.js'

const UID = 503
/** The child runs the TypeScript module directly, which bun does. */
const BUN = process.versions.bun ? process.execPath : 'bun'
const ok = '--walnut-id--\nevan\n--walnut-dns--\nDNS configuration\n\nresolver #1\n'
const ended = '--walnut-id--\n503\n--walnut-dns--\nNo DNS configuration available\n'

describe('judgeLoginSession', () => {
  it('reads a working session as no problem', () => {
    expect(judgeLoginSession({ uid: UID, probeOutput: ok, cwdExists: true })).toEqual([])
  })

  it('reads an ended session: the user lookup and the DNS configuration both fail', () => {
    expect(judgeLoginSession({ uid: UID, probeOutput: ended, cwdExists: true })).toEqual(['user_lookup', 'dns_config'])
  })

  it('reads each signal on its own', () => {
    expect(judgeLoginSession({ uid: UID, probeOutput: '--walnut-id--\n503\n--walnut-dns--\nDNS configuration\n', cwdExists: true })).toEqual(['user_lookup'])
    expect(judgeLoginSession({ uid: UID, probeOutput: '--walnut-id--\nid: 503: no such user\n--walnut-dns--\n', cwdExists: true })).toEqual(['user_lookup'])
    expect(judgeLoginSession({ uid: UID, probeOutput: '--walnut-id--\nevan\n--walnut-dns--\nNo DNS configuration available\n', cwdExists: true })).toEqual(['dns_config'])
    expect(judgeLoginSession({ uid: UID, probeOutput: ok, cwdExists: false })).toEqual(['cwd_gone'])
  })

  it('reads only what follows its marks: a login shell may print the uid first', () => {
    const noisy = `503\nwelcome\n${ok}`
    expect(judgeLoginSession({ uid: UID, probeOutput: noisy, cwdExists: true })).toEqual([])
  })

  it('takes an unknown answer as no problem (no output, no marks, a probe that never ran)', () => {
    for (const probeOutput of [null, '', '503\n', 'garbage']) {
      expect(judgeLoginSession({ uid: UID, probeOutput, cwdExists: true })).toEqual([])
    }
  })

  it('every signal has words for the user, and a session signal names the way out', () => {
    for (const p of LOGIN_SESSION_PROBLEMS) expect(loginSessionSummary([p])?.length).toBeGreaterThan(20)
    expect(loginSessionSummary(['user_lookup'])).toMatch(/login session that has ended.*Walnut app/)
    expect(loginSessionSummary([])).toBeUndefined()
  })

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('the probe script runs in this shell and reads as a working session', () => {
    const out = execFileSync('/bin/sh', ['-c', LOGIN_SESSION_PROBE_SCRIPT], { encoding: 'utf8' })
    expect(judgeLoginSession({ uid: process.getuid!(), probeOutput: out, cwdExists: true })).toEqual([])
  })
})

describe('healCwd', () => {
  it('moves a process out of a deleted directory, so its children start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cwd-gone-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cwd-home-'))
    const mod = path.resolve(__dirname, '../../src/core/login-session.ts')
    const script = `
      import fs from 'node:fs'
      import { spawnSync } from 'node:child_process'
      fs.rmSync(process.cwd(), { recursive: true })
      const { healCwd, cwdStillExists } = await import(${JSON.stringify(mod)})
      const before = cwdStillExists()
      const moved = healCwd()
      const child = spawnSync('/bin/pwd', ['-P'], { encoding: 'utf8' })
      console.log(JSON.stringify({ before, moved, after: cwdStillExists(), child: child.status, childCwd: child.stdout.trim(), again: healCwd() }))
    `
    const file = path.join(home, 'heal.mts')
    fs.writeFileSync(file, script)
    try {
      const out = execFileSync(BUN, [file], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: home } })
      const r = JSON.parse(out.trim().split('\n').pop()!)
      expect(r.before).toBe(false)
      expect(r.moved).toBe(home)
      expect(r.after).toBe(true)
      expect(r.child).toBe(0)
      expect(fs.realpathSync(r.childCwd)).toBe(fs.realpathSync(home))
      expect(r.again).toBeNull()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('checkLoginSession', () => {
  it('reports a session problem only once two probes in a row see it, and clears when one does not', async () => {
    const { checkLoginSession, resetLoginSessionForTest, loginSessionSeen } = await import('../../src/core/login-session.js')
    resetLoginSessionForTest()
    const uid = process.getuid!()
    const endedOut = `--walnut-id--\n${uid}\n--walnut-dns--\nNo DNS configuration available\n`
    const okOut = '--walnut-id--\nsomeone\n--walnut-dns--\nDNS configuration\n'
    let out = endedOut
    const probe = async () => out
    expect((await checkLoginSession({ probe })).problems).toEqual([])
    expect(loginSessionSeen()).toEqual(['user_lookup', 'dns_config'])
    const second = await checkLoginSession({ probe })
    expect(second.problems).toEqual(['user_lookup', 'dns_config'])
    expect(second.ok).toBe(false)
    expect(second.summary).toMatch(/login session that has ended/)
    out = okOut
    expect((await checkLoginSession({ probe })).ok).toBe(true)
    // One failed lookup between good ones never counts.
    out = endedOut
    expect((await checkLoginSession({ probe })).ok).toBe(true)
    out = okOut
    expect((await checkLoginSession({ probe })).ok).toBe(true)
    resetLoginSessionForTest()
  })

  it('runs a fresh pass every time it is asked, also where no probe awaits (Linux)', async () => {
    const { checkLoginSession, resetLoginSessionForTest } = await import('../../src/core/login-session.js')
    resetLoginSessionForTest()
    const a = await checkLoginSession({ probe: async () => null })
    await new Promise((r) => setTimeout(r, 5))
    const b = await checkLoginSession({ probe: async () => null })
    expect(b.checkedAt).not.toBe(a.checkedAt)
    // A pass with no await at all (the Linux path) still clears for the next one.
    const c = await checkLoginSession({ timeoutMs: 1 })
    await new Promise((r) => setTimeout(r, 5))
    const d = await checkLoginSession({ timeoutMs: 1 })
    expect(d.checkedAt).not.toBe(c.checkedAt)
    resetLoginSessionForTest()
  })
})

describe('confirmedProblems', () => {
  it('counts only what two probes agree on', async () => {
    const { confirmedProblems } = await import('../../src/core/login-session.js')
    const outs = [`--walnut-id--\n${UID}\n--walnut-dns--\nNo DNS configuration available\n`, `--walnut-id--\n${UID}\n--walnut-dns--\nDNS configuration\n`]
    let i = 0
    expect(await confirmedProblems(async () => outs[i++], UID, 1)).toEqual(['user_lookup'])
    expect(await confirmedProblems(async () => '--walnut-id--\nevan\n--walnut-dns--\n', UID, 1)).toEqual([])
    expect(await confirmedProblems(async () => null, UID, 1)).toEqual([])
  })
})

describe('ended-session CLIs', () => {
  it('a marked CLI is one until its session runs another process', async () => {
    const m = await import('../../src/core/sessions/ended-session-clis.js')
    m.clearEndedSessionClisForTest()
    expect(m.markEndedSessionClis([{ claudeSessionId: 's1', pid: 4242 }, { claudeSessionId: 's2', pid: null }, { claudeSessionId: 's3', pid: 1 }])).toBe(1)
    expect(m.isEndedSessionCli({ claudeSessionId: 's1', pid: 4242 })).toBe(true)
    expect(m.isEndedSessionCli({ claudeSessionId: 's2', pid: 99 })).toBe(false)
    // Resumed under the new daemon: a new pid, no longer one, and forgotten.
    expect(m.isEndedSessionCli({ claudeSessionId: 's1', pid: 5151 })).toBe(false)
    expect(m.isEndedSessionCli({ claudeSessionId: 's1', pid: 4242 })).toBe(false)
    expect(m.ENDED_SESSION_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60_000)
    m.clearEndedSessionClisForTest()
  })
})
