// A Demo reset after the Demo sat idle on a loaded Mac (2026-11-11 review, finding F6): the old look gave up on a slow
// `lsof` and could not judge a periodic launchd agent's short command, so the reset kept the old generation. A fake Mac with
// a clock: every table is read at the time its command starts, and each command costs what it cost at load 170 to 210.
import { describe, it, expect } from 'vitest'
import { demoPaths } from '../../src/commands/demo-home.js'
import { resolveHidden, sweepDemoResidualProcesses, type DarwinVerdict, type PsRow, type ResidualDeps, type RunResult } from '../../src/commands/demo-residual-processes.js'

const paths = demoPaths('/Users/a b/.local/share/open-walnut-demo', 'gen-idle')
const UID = 501
const SELF = 9000
const T0 = Date.UTC(2026, 10, 11, 19, 0, 0)
/** The generation's HOME was made 35 minutes before the reset. */
const BORN = T0 - 35 * 60_000

interface Proc { pid: number; ppid: number; start: number; args: string; env: string | null; cwd: string; from?: number; to?: number }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => String(n).padStart(2, '0')
const lstart = (ms: number) => {
  const d = new Date(ms)
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

/** What each read cost at load 170 to 210 (measured): the account-wide `lsof -d cwd` alone took 11 s. */
function cost(file: string, args: string[]): number {
  const wide = args.includes('-u')
  if (file === '/bin/launchctl') return 300
  if (file === '/usr/sbin/lsof') return wide ? 11_000 : 1_500
  return wide ? (args.includes('-E') ? 5_000 : 4_000) : 1_000
}

function fakeMac(procs: Proc[], over: { unreadableFiles?: number[] } = {}) {
  let clock = T0
  const calls: string[] = []
  const alive = (at: number) => procs.filter(p => (p.from ?? -Infinity) <= at && at < (p.to ?? Infinity))
  const pick = (at: number, args: string[]) => {
    const p = args.indexOf('-p')
    const wanted = p >= 0 ? new Set(args[p + 1]!.split(',').map(Number)) : null
    return alive(at).filter(proc => !wanted || wanted.has(proc.pid))
  }
  const answer = (file: string, args: string[], at: number): RunResult => {
    const rows = pick(at, args)
    const empty = { code: 1, stdout: '' }
    if (file === '/bin/launchctl') return { code: 0, stdout: `PID\tStatus\tLabel\n${rows.filter(p => p.ppid === 1).map(p => `${p.pid}\t0\tcom.example.agent${p.pid}`).join('\n')}\n` }
    if (file === '/usr/sbin/lsof') {
      const shown = args.includes('pfn') ? rows.filter(p => !over.unreadableFiles?.includes(p.pid)) : rows
      if (!shown.length) return empty
      return { code: 0, stdout: shown.map(p => args.includes('pfn') ? `p${p.pid}\nfcwd\nn${p.cwd}\n` : `p${p.pid}\nn${p.cwd}\n`).join('') }
    }
    if (!rows.length) return empty
    const withEnv = args.includes('-E')
    return { code: 0, stdout: rows.map(p => `${p.pid} ${p.ppid} S ${lstart(p.start)}   ${p.args}${withEnv && p.env ? ` ${p.env}` : ''}`).join('\n') + '\n' }
  }
  const deps: ResidualDeps = {
    platform: 'darwin', uid: UID, selfPid: SELF,
    now: () => clock,
    sleep: async ms => { clock += ms },
    after: () => new Promise(() => {}),
    run: async (file, args, timeoutMs) => {
      calls.push(`${file} ${args.join(' ')}`)
      const at = clock
      const took = cost(file, args)
      // execFile kills a read past its timeout: the caller gets nothing.
      if (took > timeoutMs) { clock += timeoutMs; return null }
      clock += took
      return answer(file, args, at)
    },
    readdir: async () => [], readFile: async () => '', readlink: async () => '',
    realpath: async p => p, ownerUid: async () => UID, birthtime: async () => BORN,
  }
  return { deps, calls }
}

const self: Proc = { pid: SELF, ppid: 500, start: T0 - 5_000, args: 'walnut demo reset', env: 'HOME=/Users/a b TERM=x', cwd: '/' }
const shell: Proc = { pid: 500, ppid: 1, start: T0 - 3_600_000, args: '/bin/zsh', env: 'HOME=/Users/a b TERM=x', cwd: '/Users/a b' }
/** A periodic launchd agent's script: /bin/bash, whose environment macOS hides, started after the Demo's HOME. */
const agent: Proc = { pid: 700, ppid: 1, start: T0 - 60_000, args: '/bin/bash /Users/a b/bin/load-watchdog.sh', env: null, cwd: '/' }
/** Its short command: alive only around the first look's last table, so it was never read and is gone by the re-read. */
const shortCommand: Proc = { pid: 701, ppid: 700, start: T0 + 15_000, args: '/usr/sbin/sysctl -n hw.ncpu', env: null, cwd: '/', from: T0 + 15_000, to: T0 + 21_000 }

describe('a reset of a Demo left idle on a loaded Mac', () => {
  it('reads the whole account although one lsof takes 11 s, and clears a launchd agent\'s gone command', async () => {
    const { deps, calls } = fakeMac([self, shell, agent, shortCommand])
    const report = await sweepDemoResidualProcesses(paths, deps)
    expect(report).toMatchObject({ supported: true, complete: true, matched: 0, unknown: 0 })
    expect(report.incomplete).toBeUndefined()
    // One look decided it: the gone command was re-read once, and no second account-wide look was needed.
    expect(calls.filter(c => c.startsWith('/bin/launchctl'))).toHaveLength(1)
    expect(calls.some(c => c.includes(`-p ${shortCommand.pid}`))).toBe(true)
  })

  it('says why when even the longer budget runs out (a read that never answers)', async () => {
    const { deps } = fakeMac([self, shell, agent])
    const run = deps.run
    deps.run = async (file, args, timeoutMs) => file === '/usr/sbin/lsof' ? (deps.sleep(timeoutMs), null) : run(file, args, timeoutMs)
    const report = await sweepDemoResidualProcesses(paths, deps)
    expect(report).toMatchObject({ complete: false, incomplete: 'table' })
  })

  it('still keeps the data for a live process of the agent that is tied to the Demo', async () => {
    const demoChild: Proc = { pid: 702, ppid: 700, start: T0 - 30_000, args: '/usr/local/bin/node job.js', env: `HOME=${paths.home}`, cwd: '/' }
    const report = await sweepDemoResidualProcesses(paths, fakeMac([self, shell, agent, demoChild]).deps)
    expect(report.matched).toBe(1)
  })

  it('never lends the agent\'s clear to a live hidden child whose files cannot be read', async () => {
    const hiddenChild: Proc = { pid: 703, ppid: 700, start: T0 - 30_000, args: '/bin/sh -c sleep 600', env: null, cwd: '/' }
    const report = await sweepDemoResidualProcesses(paths, fakeMac([self, shell, agent, hiddenChild], { unreadableFiles: [703] }).deps)
    expect(report).toMatchObject({ complete: true, matched: 0 })
    expect(report.why.envHidden).toBe(1)
  })
})

describe('resolveHidden: a gone pid under a launchd job', () => {
  const READ_AT = T0
  const listed = { pids: new Set([700]), readAtMs: READ_AT }
  const row = (ppid: number, start: number, text = '/bin/bash'): PsRow => ({ ppid, stat: 'S', start: lstart(start), text })
  const judge = (parent: PsRow, parentVerdict: DarwinVerdict, childVerdict: DarwinVerdict, list = listed) => resolveHidden(
    701, new Map([[700, parentVerdict], [701, childVerdict]]), new Set(),
    new Map([[700, parent], [701, row(700, T0 - 2_000, 'sysctl')]]), BORN, list)

  it('is clear when its parent is a job launchd listed a second or more before its start', () => {
    expect(judge(row(1, T0 - 60_000), 'envHidden', 'goneUnread')).toBe('clear')
    expect(judge(row(1, T0 - 60_000, '/System/Library/Foo.xpc/Contents/MacOS/Foo'), 'envHidden', 'goneUnread', { pids: new Set(), readAtMs: READ_AT })).toBe('clear')
  })

  it('stays raced when the parent is no launchd job, or the listed pid may be a reused one', () => {
    expect(judge(row(500, T0 - 60_000), 'envHidden', 'goneUnread')).toBe('goneUnread')
    expect(judge(row(1, T0 - 60_000), 'envHidden', 'goneUnread', { pids: new Set(), readAtMs: READ_AT })).toBe('goneUnread')
    expect(judge(row(1, READ_AT - 500), 'envHidden', 'goneUnread')).toBe('goneUnread')
  })

  it('is matched when the job itself is the Demo\'s, and a live hidden child is never cleared by it', () => {
    expect(judge(row(1, T0 - 60_000), 'matched', 'goneUnread')).toBe('matched')
    expect(judge(row(1, T0 - 60_000), 'envHidden', 'envHidden')).toBe('envHidden')
  })
})
