/**
 * The host-runs-sessions switch (src/core/session-channel/switch.ts) is read through two questions:
 * the leader's start decision for ONE host (hostRunsSessionsFor / hostSwitchNow), and "on for any
 * host" (hostRunsSessionsAny / hostRunsSessionsAnyNow) for every other reader. Every caller of each is
 * listed below with why it asks that one; a new caller fails here until it is listed, so nobody reads
 * the experiment as one global switch again (the old hostRunsSessions / hostRunsSessionsNow are gone),
 * and nobody reads the experiment id directly outside switch.ts.
 *
 * The semantics: per host true wins over the experiment off, per host false over the experiment on,
 * absent follows the experiment; a host replica reads "any" from the copy-only hosts_run_sessions row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { hostRunsSessionsAny, hostRunsSessionsFor, hostsTurnedOn } from '../../../src/core/session-channel/switch.js'
import { configCopyRows, configRowAdmissible } from '../../../src/core/replication/config-allowlist.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

/** Callers of the per-host start decision: file -> why. */
const PER_HOST: Record<string, string> = {
  'src/core/session-channel/leader-boot.ts': "the leader side's start probe (leader-side.ts hostJudges, judge-of.ts startGoesToHost): the one per-host decision",
}

/** Callers of "on for any host": file -> why. */
const ANY_HOST: Record<string, string> = {
  'src/core/session-channel/leader-boot.ts': 'the leader door /host-door open, the doors push to dialed hosts, the credential issuer: one door and one issuer for every host',
  'src/core/session-channel/host-boot.ts': "a host's session routes, its dialer to the leader's door and to the companion, and whether its session side starts at all (at boot, or when a copy turns it on): the leader's start decision says which starts come",
  'src/core/session-channel/listener-door.ts': "the companion's listener door, with the leader's heartbeat",
  'src/core/leader/primary-leader.ts': "the heartbeat's hostRunsSessions to the companion (its listener door)",
  'src/core/replication/config-allowlist.ts': 'derives the copy-only hosts_run_sessions row (hostsTurnedOn) a replica reads "any" from',
}

const QUESTIONS = {
  perHost: /\b(hostRunsSessionsFor|hostSwitchNow)\b/,
  anyHost: /\b(hostRunsSessionsAny|hostRunsSessionsAnyNow|hostsTurnedOn)\b/,
  // The old global predicate, gone: a new caller would read the experiment as one switch for all hosts.
  retired: /\bhostRunsSessions(Now)?\s*\(|\{\s*hostRunsSessionsNow\b|\bhostRunsSessionsNow\b/,
  // The experiment id read directly (experimentalEnabled(..., 'host_runs_sessions')).
  rawExperiment: /experimentalEnabled\([^)]*['"]host_runs_sessions['"]/,
}

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') sources(p, out) } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function callers(re: RegExp): string[] {
  const files: string[] = []
  for (const abs of [...sources(path.join(ROOT, 'src')), ...sources(path.join(ROOT, 'web', 'src'))]) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/')
    if (rel === 'src/core/session-channel/switch.ts') continue
    // Comments name the questions; only code asks them.
    const code = fs.readFileSync(abs, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    if (re.test(code)) files.push(rel)
  }
  return files.sort()
}

describe('switch readers ratchet', () => {
  it('every caller of the per-host start decision is listed', () => {
    expect(callers(QUESTIONS.perHost)).toEqual(Object.keys(PER_HOST).sort())
  })

  it('every caller of "on for any host" is listed', () => {
    expect(callers(QUESTIONS.anyHost)).toEqual(Object.keys(ANY_HOST).sort())
  })

  it('nobody calls the retired global predicate or reads the experiment id directly', () => {
    expect(callers(QUESTIONS.retired)).toEqual([])
    expect(callers(QUESTIONS.rawExperiment)).toEqual([])
  })
})

describe('the per-host switch', () => {
  let saved: string | undefined
  beforeEach(() => { saved = process.env.WALNUT_HOST_RUNS_SESSIONS; delete process.env.WALNUT_HOST_RUNS_SESSIONS })
  afterEach(() => { if (saved === undefined) delete process.env.WALNUT_HOST_RUNS_SESSIONS; else process.env.WALNUT_HOST_RUNS_SESSIONS = saved })

  const on = { host_runs_sessions: true }
  const host = (runs?: boolean) => ({ hostname: 'h', ...(runs === undefined ? {} : { runs_sessions: runs }) })

  it('off everywhere by default: no experiment, no host entry (today\'s behaviour)', () => {
    const c = { hosts: { 'devbox-a': host(), 'devbox-b': host() } }
    expect(hostRunsSessionsFor(c, 'devbox-a')).toBe(false)
    expect(hostRunsSessionsAny(c)).toBe(false)
    expect(hostRunsSessionsAny(null)).toBe(false)
  })

  it('the experiment alone turns every host on, as before', () => {
    const c = { experimental: on, hosts: { 'devbox-a': host() } }
    expect(hostRunsSessionsFor(c, 'devbox-a')).toBe(true)
    expect(hostRunsSessionsFor(c, 'not-configured')).toBe(true)
    expect(hostRunsSessionsAny(c)).toBe(true)
  })

  it('runs_sessions true turns one host on with the experiment off; the others stay off', () => {
    const c = { hosts: { 'devbox-a': host(true), 'devbox-b': host() } }
    expect(hostRunsSessionsFor(c, 'devbox-a')).toBe(true)
    expect(hostRunsSessionsFor(c, 'devbox-b')).toBe(false)
    expect(hostRunsSessionsAny(c)).toBe(true)
    expect(hostsTurnedOn(c.hosts)).toEqual(['devbox-a'])
  })

  it('runs_sessions false keeps one host off with the experiment on', () => {
    const c = { experimental: on, hosts: { 'devbox-a': host(false), 'devbox-b': host() } }
    expect(hostRunsSessionsFor(c, 'devbox-a')).toBe(false)
    expect(hostRunsSessionsFor(c, 'devbox-b')).toBe(true)
    expect(hostRunsSessionsAny(c)).toBe(true)
  })

  it('a host replica reads "any" from the copy-only row', () => {
    expect(hostRunsSessionsAny({ hosts_run_sessions: ['devbox-a'] })).toBe(true)
    expect(hostRunsSessionsAny({ hosts_run_sessions: [] })).toBe(false)
  })

  it('WALNUT_HOST_RUNS_SESSIONS decides both questions for its process', () => {
    process.env.WALNUT_HOST_RUNS_SESSIONS = '0'
    expect(hostRunsSessionsFor({ experimental: on, hosts: { 'devbox-a': host(true) } }, 'devbox-a')).toBe(false)
    expect(hostRunsSessionsAny({ experimental: on })).toBe(false)
    process.env.WALNUT_HOST_RUNS_SESSIONS = '1'
    expect(hostRunsSessionsFor({ hosts: { 'devbox-a': host(false) } }, 'devbox-a')).toBe(true)
  })
})

describe('the config copy carries the hosts turned on as a row of its own', () => {
  it('never in the hosts row (an older replica would refuse it whole); the derived row only when some host is on', () => {
    const { rows } = configCopyRows({ hosts: { 'devbox-a': { hostname: 'a', runs_sessions: true }, 'devbox-b': { hostname: 'b', runs_sessions: false } } })
    const hosts = rows.find((r) => r.key === 'hosts')!
    expect(JSON.stringify(hosts.value)).not.toContain('runs_sessions')
    const derived = rows.find((r) => r.key === 'hosts_run_sessions')!
    expect(derived.value).toEqual(['devbox-a'])
    expect(configRowAdmissible(derived)).toBe(true)
    expect(configRowAdmissible(hosts)).toBe(true)
    expect(configCopyRows({ hosts: { 'devbox-a': { hostname: 'a' } } }).rows.some((r) => r.key === 'hosts_run_sessions')).toBe(false)
  })

  it('a hosts_run_sessions key in config.yaml itself is never copied: only the hosts map decides it', () => {
    const { rows } = configCopyRows({ hosts_run_sessions: ['devbox-z'], hosts: { 'devbox-a': { hostname: 'a' } } })
    expect(rows.some((r) => r.key === 'hosts_run_sessions')).toBe(false)
  })
})
