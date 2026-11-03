/**
 * The run-time watch of host_exec on a Mac (src/providers/host-exec-watch.ts): a job found idle
 * at a dialog that is its own is stopped, and a healthy job never is.
 *
 * 2026-11-03, on a user's Mac: `security show-keychain-info` sat at a SecurityAgent password
 * dialog, and `du -sk ~/Library/Caches` sat for 7 minutes at 0.01 s of CPU while tccd showed a
 * permission dialog on her screen. Two reviews of the watch found it could stop healthy jobs: any
 * SecurityAgent stopped any idle job (the owner unlocking a System Settings pane would stop
 * `python3 -m http.server`, `ssh -N`, `simctl bootstatus`), a tccd prompt of the daemon (every
 * local session is its child) stopped every idle job, `pid=412` matched `pid=4123`; and every job
 * ran `ps -A` and `log show` on its own every 20 s. Every probe here is injected: no `ps`, no
 * `log`, no tccd.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  IDLE_WINDOW_MS, createPromptWatcher, psDurationMs, readSnapshot, tccServiceFor,
  type ProcessRow, type ProcessTable, type PromptBlock, type PromptProbe,
} from '../../src/providers/host-exec-watch.js'

const W = IDLE_WINDOW_MS
const T0 = 1_000_000
const proc = (pid: number, pgid: number, cpuMs: number, comm: string): ProcessRow => ({ pid, pgid, cpuMs, comm })

/** A probe that plays back process tables and log answers, and counts its looks. */
function probe(tables: ProcessTable[], logs: Array<string[] | null | Error> = [[]]) {
  let i = 0
  let j = 0
  const calls = { snapshot: 0, pgids: [] as number[][], log: 0, since: [] as number[] }
  const p: PromptProbe = {
    snapshot: async (pgids) => { calls.snapshot++; calls.pgids.push(pgids); return tables[Math.min(i++, tables.length - 1)] },
    tccPrompts: async (since) => {
      calls.log++
      calls.since.push(since)
      const v = logs[Math.min(j++, logs.length - 1)]
      if (v instanceof Error) throw v
      return v
    },
  }
  return { p, calls }
}

const unwatchers: Array<() => void> = []
afterEach(() => { for (const u of unwatchers.splice(0)) u() })

/** A watcher on a hand-moved clock, with one job (pgid 501) started at T0 and watched since then. */
function setup(p: PromptProbe, jobs = [{ pgid: 501, startedAt: T0 }]) {
  const clock = { t: T0 }
  const watcher = createPromptWatcher(p, { now: () => clock.t })
  const blocked = new Map<number, PromptBlock>()
  for (const job of jobs) unwatchers.push(watcher.watch(job, (b) => blocked.set(job.pgid, b)))
  const look = async (after = W) => { clock.t += after; await watcher.check() }
  return { watcher, clock, blocked, look }
}

const table = (processes: ProcessRow[], agentAt: number | null = null): ProcessTable => ({ processes, securityAgentStartedAt: agentAt })
const keychainCall = (cpu: number) => [proc(501, 501, 5, '/bin/zsh'), proc(502, 501, cpu, '/usr/bin/security')]

describe('a job idle at its own dialog is stopped', () => {
  it('a keychain program idle while SecurityAgent came up after the job started: a password dialog', async () => {
    const { p, calls } = probe([table(keychainCall(10), T0 + 2_000)])
    const { blocked, look, watcher } = setup(p)
    await look()
    expect(blocked.get(501)).toEqual({ reason: 'password_prompt', service: 'SecurityAgent' })
    expect(calls.log).toBe(0)
    expect(watcher.watching()).toBe(0)
  })

  it('a tccd prompt whose accessing process is in the job: a permission dialog', async () => {
    const lines = [
      'tccd[180]: AUTHREQ_ATTRIBUTION: msgID=180.7, attribution={responsible={TCCDProcess: identifier=daemon, pid=412, binary_path=/opt/walnut/daemon}, accessing={TCCDProcess: identifier=du, pid=502, binary_path=/usr/bin/du}, requesting={TCCDProcess: identifier=tccd, pid=180}}',
      'tccd[180]: AUTHREQ_PROMPTING: msgID=180.7, service=kTCCServiceMediaLibrary, subject=/opt/walnut/daemon',
    ]
    const { p } = probe([table([proc(501, 501, 3, '/bin/bash'), proc(502, 501, 10, '/usr/bin/du')])], [lines])
    const { blocked, look } = setup(p)
    await look()
    expect(blocked.get(501)).toEqual({ reason: 'permission_prompt', service: 'kTCCServiceMediaLibrary' })
  })

  it('even a shell or a `cat` waits at one (the redirect or the open is the access)', async () => {
    const lines = [
      'tccd: AUTHREQ_ATTRIBUTION: msgID=4, attribution={responsible={TCCDProcess: pid=412}, accessing={TCCDProcess: identifier=cat, pid=503}}',
      'tccd: AUTHREQ_PROMPTING: msgID=4, service=kTCCServiceSystemPolicyDocumentsFolder, subject=/opt/walnut/daemon',
    ]
    const { p } = probe([table([proc(501, 501, 3, '/bin/bash'), proc(503, 501, 1, 'cat')])], [lines])
    const { blocked, look } = setup(p)
    await look()
    expect(blocked.get(501)?.service).toBe('kTCCServiceSystemPolicyDocumentsFolder')
  })

  it('reads the log at the first idle look, then every third one, each from where the last ended', async () => {
    const idle = (cpu: number) => table([proc(501, 501, 3, '/bin/bash'), proc(502, 501, cpu, 'python3')])
    const late = ['tccd: AUTHREQ_ATTRIBUTION: msgID=3, accessing={TCCDProcess: pid=502}', 'tccd: AUTHREQ_PROMPTING: msgID=3, service=kTCCServiceSystemPolicyDesktopFolder']
    const { p, calls } = probe([idle(10), idle(12), idle(13), idle(14)], [[], late])
    const { blocked, look } = setup(p)
    await look()
    await look()
    expect(calls.log).toBe(1)
    await look()
    expect(blocked.get(501)).toEqual({ reason: 'permission_prompt', service: 'kTCCServiceSystemPolicyDesktopFolder' })
    // The first read reaches back to the job's start (it is within three windows), the next from the first.
    expect(calls.since).toEqual([T0 - 2_000, T0 + W - 2_000])
  })
})

describe('a healthy job is never stopped', () => {
  it('idle servers and waits while the owner answers some other SecurityAgent dialog', async () => {
    const agent = T0 + 5_000
    for (const comm of ['/usr/bin/python3', '/usr/bin/ssh', '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl', '/opt/homebrew/bin/node']) {
      const { p, calls } = probe([table([proc(501, 501, 3, '/bin/zsh'), proc(502, 501, 1, comm)], agent)], [[]])
      const { blocked, look } = setup(p)
      await look()
      await look()
      expect(blocked.size).toBe(0)
      // The log is read once (the first idle look), and names nothing of the job.
      expect(calls.log).toBe(1)
    }
  })

  it('a busy job: the log is never read', async () => {
    const { p, calls } = probe([table(keychainCall(500), T0 + 5_000), table(keychainCall(1_200), T0 + 5_000)])
    const { blocked, look } = setup(p)
    await look()
    await look()
    expect(blocked.size).toBe(0)
    expect(calls.log).toBe(0)
  })

  it('a SecurityAgent from before the job started is not its dialog', async () => {
    const { p } = probe([table(keychainCall(10), T0 - 60_000)])
    const { blocked, look } = setup(p)
    await look()
    expect(blocked.size).toBe(0)
  })

  it('a tccd prompt for another process of this daemon (a local session), or with no accessor named, is not the job\'s', async () => {
    const other = [
      'tccd: AUTHREQ_ATTRIBUTION: msgID=5, attribution={responsible={TCCDProcess: pid=412}, accessing={TCCDProcess: identifier=claude, pid=7777}}',
      'tccd: AUTHREQ_PROMPTING: msgID=5, service=kTCCServiceSystemPolicyDocumentsFolder, subject=/opt/walnut/daemon',
    ]
    const bare = ['tccd: AUTHREQ_PROMPTING: msgID=9, service=kTCCServicePhotos, subject=/opt/walnut/daemon pid=502']
    for (const lines of [other, bare]) {
      const { p } = probe([table(keychainCall(10))], [lines])
      const { blocked, look } = setup(p)
      await look()
      expect(blocked.size).toBe(0)
    }
  })

  it('pid marks match whole numbers only', () => {
    const at = (pid: number) => [`AUTHREQ_ATTRIBUTION: msgID=1, accessing={TCCDProcess: pid=${pid}}`, 'AUTHREQ_PROMPTING: msgID=1, service=kTCCServicePhotos']
    expect(tccServiceFor(at(4123), [412])).toBeNull()
    expect(tccServiceFor(at(412), [412])).toBe('kTCCServicePhotos')
    expect(tccServiceFor(['AUTHREQ_ATTRIBUTION: msgID=1, accessing={TCCDProcess: pid=412}', 'AUTHREQ_RESULT: msgID=1, service=kTCCServicePhotos'], [412])).toBeNull()
  })

  it('processes that came or went did work: a loop of short commands is never idle', async () => {
    const a = table([proc(501, 501, 5, '/bin/bash'), proc(600, 501, 2, '/usr/bin/codesign')], T0 + 1_000)
    const b = table([proc(501, 501, 6, '/bin/bash'), proc(601, 501, 2, '/usr/bin/codesign')], T0 + 1_000)
    // The first look sees 7 ms since the start and no SecurityAgent; the next finds other processes: busy.
    const { p } = probe([{ ...a, securityAgentStartedAt: null }, b], [[]])
    const { blocked, look } = setup(p)
    await look()
    await look()
    expect(blocked.size).toBe(0)
  })

  it('a job watched for less than a window is not looked at yet', async () => {
    const { p, calls } = probe([table(keychainCall(0), T0 + 1)])
    const { blocked, look } = setup(p)
    await look(W / 2)
    expect(calls.snapshot).toBe(0)
    await look(W / 2)
    expect(blocked.get(501)?.reason).toBe('password_prompt')
  })

  it('a probe that fails or cannot see the job decides nothing', async () => {
    const failing: PromptProbe = { snapshot: async () => { throw new Error('ps failed') }, tccPrompts: async () => { throw new Error('no') } }
    for (const p of [failing, probe([table(null as never, T0 + 1)]).p, probe([table([], T0 + 1)]).p, probe([table(keychainCall(0))], [new Error('log show failed')]).p]) {
      const { blocked, look } = setup(p)
      await look()
      expect(blocked.size).toBe(0)
    }
  })
})

describe('one watcher per daemon', () => {
  it('one ps for every job and at most one log read per look, however many jobs run', async () => {
    const jobs = [501, 601, 701].map((pgid) => ({ pgid, startedAt: T0 }))
    const rows = jobs.flatMap(({ pgid }) => [proc(pgid, pgid, 3, '/bin/bash'), proc(pgid + 1, pgid, 1, '/usr/bin/python3')])
    const { p, calls } = probe([table(rows)], [[]])
    const { look, watcher } = setup(p, jobs)
    await look()
    expect(calls.snapshot).toBe(1)
    expect(calls.pgids[0]).toEqual([501, 601, 701])
    expect(calls.log).toBe(1)
    expect(watcher.watching()).toBe(3)
    for (const u of unwatchers.splice(0)) u()
    expect(watcher.watching()).toBe(0)
  })

  it('runs on its own timer while it watches, and stops it when the last job ends', async () => {
    const { p, calls } = probe([table(keychainCall(0), Date.now() + 60_000)])
    const watcher = createPromptWatcher(p, { everyMs: 40 })
    const blocked: PromptBlock[] = []
    const unwatch = watcher.watch({ pgid: 501, startedAt: Date.now() }, (b) => blocked.push(b))
    await new Promise((r) => setTimeout(r, 200))
    expect(blocked).toEqual([{ reason: 'password_prompt', service: 'SecurityAgent' }])
    unwatch()
    const seen = calls.snapshot
    await new Promise((r) => setTimeout(r, 150))
    expect(calls.snapshot).toBe(seen)
  })
})

describe('reading ps', () => {
  it('the watched groups\' processes with their CPU, and when SecurityAgent started', () => {
    const ps = [
      '  501   501     01:00   0:00.01 /bin/zsh',
      '  502   501     00:59   0:00.02 /usr/bin/du',
      '  602   601     00:59   0:00.03 /usr/bin/security',
      '    1     1  01:02:03   1:00.00 /sbin/launchd',
      '  777   777     00:05   0:00.20 /System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent',
      'garbage',
    ].join('\n')
    expect(readSnapshot(ps, [501, 601], 10_000_000)).toEqual({
      processes: [proc(501, 501, 10, '/bin/zsh'), proc(502, 501, 20, '/usr/bin/du'), proc(602, 601, 30, '/usr/bin/security')],
      securityAgentStartedAt: 10_000_000 - 5_000,
    })
    expect(readSnapshot(ps, [999], 10_000_000).processes).toEqual([])
    expect(psDurationMs('1-02:03:04')).toBe(((26 * 60 + 3) * 60 + 4) * 1000)
    expect(psDurationMs('0:00.01')).toBe(10)
    expect(psDurationMs('n/a')).toBeNull()
  })
})
