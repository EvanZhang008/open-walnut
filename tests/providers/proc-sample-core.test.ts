/**
 * proc.sample (proc-sample-core.ts, shared by both daemon twins): one ps per
 * sample, processes attributed to the session whose CLI is nearest above them,
 * whose group they kept, or that was seen owning them before (a detached child
 * after its shell exits, and after the CLI itself is gone); a process is its pid
 * plus its start time; CPU is a delta of cumulative cpu time over a full window.
 * A fake execFile stands in for ps; the real table shape of macOS and procps is
 * pinned with recorded rows.
 */
import { describe, it, expect } from 'vitest'
import {
  createProcSampler, parsePsTable, parseCpuTime, attributeProcesses, PROC_SAMPLE_PS_ARGS,
  type ProcSampleExecFile, type ProcRow,
} from '../../src/providers/proc-sample-core.js'
import { foldLine, initialFoldState, assembleSnapshot } from '../../src/providers/daemon-fold.js'
import { getDaemonSource, validateFoldInjection } from '../../src/providers/daemon-source.js'

/** Where the fake clock starts, and when the processes of a table started by default (seconds). */
const T0 = 10_000_000
const OLD = 5_000

function etime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = `${pad(m)}:${pad(s % 60)}`
  if (d) return `${d}-${pad(h)}:${rest}`
  return h ? `${pad(h)}:${rest}` : rest
}

/**
 * `pid ppid pgid rssKB time comm [startS]` rows as ps prints them at `nowMs`
 * (padded columns; etime derived from the start, so a process keeps its
 * identity across samples the way a real one does).
 */
type Row = [number, number, number, number, string, string, number?]
function table(rows: Row[], nowMs = T0): string {
  return rows.map(([pid, ppid, pgid, rss, time, comm, start]) =>
    `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(pgid).padStart(5)} ${String(rss).padStart(7)} ${time.padStart(9)} ${etime(nowMs / 1000 - (start ?? OLD)).padStart(11)} ${comm}`,
  ).join('\n') + '\n'
}

interface Fake {
  execFile: ProcSampleExecFile
  calls: Array<{ args: string[]; env: Record<string, string | undefined> }>
  /** The next answers, in order. */
  answers: Array<{ stdout?: string; error?: Error; delayMs?: number }>
}

function fake(answers: Fake['answers']): Fake {
  const f: Fake = { calls: [], answers, execFile: undefined as unknown as ProcSampleExecFile }
  f.execFile = (_file, args, options, cb) => {
    f.calls.push({ args, env: options.env })
    const a = f.answers.shift() ?? { stdout: '' }
    const fire = () => cb(a.error ?? null, a.stdout ?? '')
    if (a.delayMs) setTimeout(fire, a.delayMs)
    else queueMicrotask(fire)
    return undefined
  }
  return f
}

const HOST = { platform: 'darwin', totalmem: () => 48 * 1024 ** 3, loadavg: () => [1.234, 1, 1], cpuCount: () => 14 }

describe('parseCpuTime', () => {
  it('reads macOS minutes:seconds.hundredths, with minutes past 60', () => {
    expect(parseCpuTime('0:00.12')).toBeCloseTo(0.12)
    expect(parseCpuTime('75:01.50')).toBeCloseTo(4501.5)
    expect(parseCpuTime('5573:35.00')).toBeCloseTo(5573 * 60 + 35)
  })
  it('reads procps HH:MM:SS and DD-HH:MM:SS', () => {
    expect(parseCpuTime('01:02:03')).toBe(3723)
    expect(parseCpuTime('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5)
  })
  it('refuses junk rather than guessing', () => {
    for (const bad of ['', 'abc', '1:2:3:4', '-1:00', 'x-00:00:01', '1']) expect(Number.isNaN(parseCpuTime(bad))).toBe(true)
  })
})

describe('parsePsTable', () => {
  it('takes the command as the rest of the line and keeps only its basename', () => {
    const rows = parsePsTable(table([
      [10, 1, 10, 2048, '75:01.50', '/Applications/Some App.app/Contents/MacOS/claude'],
      [11, 10, 10, 512, '0:00.10', 'node'],
      [12, 1, 12, 100, '0:00.00', '/usr/libexec/trailing/'],
    ]))
    expect(rows.map((r) => r.comm)).toEqual(['claude', 'node', '/usr/libexec/trailing/'])
    expect(rows[0]).toMatchObject({ pid: 10, ppid: 1, pgid: 10, rssBytes: 2048 * 1024, cpuSeconds: 4501.5, elapsedSeconds: T0 / 1000 - OLD })
  })
  it('reads both elapsed shapes (mm:ss and dd-hh:mm:ss)', () => {
    const rows = parsePsTable('  7  1  7  10  0:00.01      00:07 a\n  8  1  8  10  00:00:02 3-04:05:06 b\n')
    expect(rows.map((r) => r.elapsedSeconds)).toEqual([7, 3 * 86400 + 4 * 3600 + 5 * 60 + 6])
  })
  it('skips a line it cannot read and never throws', () => {
    const rows = parsePsTable('garbage\n  1  0  1  10  0:00.01 01:00 launchd\n 2 0 2 x 0:00.01 01:00 bad\n 3 0 3 10 0:00.01 launchd-no-etime\n\n')
    expect(rows.map((r) => r.pid)).toEqual([1])
    expect(parsePsTable('')).toEqual([])
  })
  it('asks ps for the BSD/procps-common columns', () => {
    expect(PROC_SAMPLE_PS_ARGS).toEqual(['-A', '-ww', '-o', 'pid=,ppid=,pgid=,rss=,time=,etime=,comm='])
  })
})

describe('attributeProcesses', () => {
  const rows: ProcRow[] = parsePsTable(table([
    [1, 0, 1, 10, '0:01.00', 'launchd'],
    [100, 1, 100, 500000, '1:00.00', 'claude'],        // session A root (group leader)
    [101, 100, 100, 300000, '0:10.00', 'node'],        // A's MCP server
    [102, 101, 100, 50000, '0:00.10', 'bash'],         // A's grandchild
    [103, 1, 100, 400000, '5:00.00', 'vitest'],        // A's orphan: re-parented to 1, group kept
    [200, 1, 200, 450000, '0:30.00', 'claude'],        // session B root
    [201, 200, 201, 20000, '0:00.00', 'bash'],         // B's child in its OWN group (detached)
    [300, 102, 300, 350000, '0:05.00', 'claude'],      // session C: a registered session spawned under A
    [301, 300, 300, 1000, '0:00.00', 'sh'],
    [999, 1, 999, 1000, '0:00.00', 'unrelated'],
  ]))
  const roots = [
    { sid: 'A', pid: 100, kind: 'cli' as const },
    { sid: 'B', pid: 200, kind: 'cli' as const },
    { sid: 'C', pid: 300, kind: 'acp' as const },
  ]
  it('claims descendants, keeps a re-parented child by its group, and gives a nested root its own tree', () => {
    const claimed = attributeProcesses(rows, roots)
    expect(claimed.get(100)).toBe(0)
    expect(claimed.get(101)).toBe(0)
    expect(claimed.get(102)).toBe(0)
    expect(claimed.get(103)).toBe(0)
    expect(claimed.get(200)).toBe(1)
    expect(claimed.get(201)).toBe(1)
    expect(claimed.get(300)).toBe(2)
    expect(claimed.get(301)).toBe(2)
    expect(claimed.has(1)).toBe(false)
    expect(claimed.has(999)).toBe(false)
  })
  it('a root that is gone still collects what its group left behind', () => {
    const left = rows.filter((r) => r.pid !== 100)
    const claimed = attributeProcesses(left, roots)
    // No parent chain reaches the root any more; the group it kept still names it.
    expect(claimed.get(103)).toBe(0)
    expect(claimed.get(101)).toBe(0)
    expect(claimed.get(102)).toBe(0)
    // B's child set its own group: with B gone nothing but an earlier claim ties it to B.
    expect(attributeProcesses(left.filter((r) => r.pid !== 200), roots).has(201)).toBe(false)
    expect(attributeProcesses(left.filter((r) => r.pid !== 200), roots, new Map([[201, 1]])).get(201)).toBe(1)
  })
  it('a sticky claim takes the unclaimed subtree, never a live root or another root\'s tree', () => {
    // 999 claimed earlier by B: it and nothing else moves; a sticky entry naming A's root is ignored.
    const claimed = attributeProcesses(rows, roots, new Map([[999, 1], [300, 0], [101, 1]]))
    expect(claimed.get(999)).toBe(1)
    expect(claimed.get(300)).toBe(2)
    expect(claimed.get(101)).toBe(0)
  })
  it('roots past liveCount are never walked from (their pid may belong to someone else now)', () => {
    const claimed = attributeProcesses(rows, [roots[1], { sid: 'gone', pid: 100, kind: 'cli' }], undefined, 1)
    expect(claimed.has(100)).toBe(false)
    expect(claimed.has(101)).toBe(false)
  })
})

describe('createProcSampler.sample', () => {
  function rowsAt(nowMs: number, cpuA: string, cpuChild: string) {
    return table([
      [1, 0, 1, 10, '0:01.00', 'launchd'],
      [100, 1, 100, 500000, cpuA, 'claude'],
      [101, 100, 100, 300000, cpuChild, 'node'],
      [103, 1, 100, 400000, '5:00.00', 'vitest'],
      [200, 1, 200, 450000, '0:30.00', 'claude'],
      [999, 1, 999, 1000, '0:00.00', 'unrelated'],
    ], nowMs)
  }
  const A = { sid: 'A', pid: 100, kind: 'cli' as const }

  it('sums RSS and process count per session; CPU needs a full window', async () => {
    let now = T0
    const f = fake([{ stdout: rowsAt(T0, '1:00.00', '0:10.00') }, { stdout: rowsAt(T0 + 10_000, '1:05.00', '0:10.00') }])
    const s = createProcSampler({ ...HOST, execFile: f.execFile, now: () => now })
    const roots = [A, { sid: 'B', pid: 200, kind: 'cli' as const }, { sid: 'dead', pid: 777, kind: 'cli' as const }]

    const first = await s.sample(roots)
    expect(first.error).toBeUndefined()
    expect(first.processCount).toBe(6)
    expect(first.host).toEqual({ platform: 'darwin', totalMemBytes: 48 * 1024 ** 3, loadavg1: 1.23, cpuCount: 14 })
    const a = first.sessions.find((x) => x.sid === 'A')!
    expect(a).toMatchObject({ rootPid: 100, alive: true, procCount: 3, rssBytes: (500000 + 300000 + 400000) * 1024, cpuPct: null })
    expect(a.top.map((t) => t.comm)).toEqual(['claude', 'vitest', 'node'])
    expect(first.sessions.find((x) => x.sid === 'dead')).toMatchObject({ alive: false, procCount: 0, rssBytes: 0, cpuPct: null })

    now = T0 + 10_000 // 10s later: claude burned 5s of cpu = 50%
    const second = await s.sample(roots)
    const a2 = second.sessions.find((x) => x.sid === 'A')!
    expect(a2.cpuPct).toBe(50)
    expect(a2.top.find((t) => t.pid === 100)?.cpuPct).toBe(50)
    expect(a2.top.find((t) => t.pid === 101)?.cpuPct).toBe(0)
    expect(f.calls).toHaveLength(2)
    expect(f.calls[0].args).toEqual(PROC_SAMPLE_PS_ARGS)
    expect(f.calls[0].env.LANG).toBe('C')
  })

  it('a sample inside the window repeats the last reading instead of dividing rounding by a short interval', async () => {
    let now = T0
    const cpu = ['0:10.00', '0:10.00', '0:15.00', '0:16.00', '0:25.00']
    const at = [T0, T0 + 1_600, T0 + 5_000, T0 + 6_600, T0 + 10_000]
    const f = fake(cpu.map((c, i) => ({ stdout: table([[100, 1, 100, 1000, c, 'claude']], at[i]) })))
    const s = createProcSampler({ ...HOST, execFile: f.execFile, now: () => now })
    const read = async (i: number) => { now = at[i]; return (await s.sample([A])).sessions[0].cpuPct }
    expect(await read(0)).toBeNull()
    expect(await read(1)).toBeNull() // 1.6s: no full window yet
    expect(await read(2)).toBe(100) // 5s window: 5s of cpu
    expect(await read(3)).toBe(100) // 1.6s after: repeats, even though 1s/1.6s would read 62.5
    expect(await read(4)).toBe(200) // 5s window from the 5s baseline: 10s of cpu
  })

  it('Linux (whole-second cpu time) waits for a longer window', async () => {
    let now = T0
    const f = fake([0, 5_000, 10_000].map((dt, i) => ({ stdout: table([[100, 1, 100, 1000, ['00:00:10', '00:00:15', '00:00:20'][i], 'claude']], T0 + dt) })))
    const s = createProcSampler({ ...HOST, platform: 'linux', execFile: f.execFile, now: () => now })
    await s.sample([A])
    now = T0 + 5_000
    expect((await s.sample([A])).sessions[0].cpuPct).toBeNull()
    now = T0 + 10_000
    expect((await s.sample([A])).sessions[0].cpuPct).toBe(100)
  })

  it('a process born inside the window counts from zero; one that was there all along but unseen does not', async () => {
    let now = T0
    const f = fake([
      { stdout: table([[100, 1, 100, 1000, '0:01.00', 'claude']], T0) },
      { stdout: table([
        [100, 1, 100, 1000, '0:01.00', 'claude'],
        [150, 100, 100, 1000, '0:04.00', 'tsc', T0 / 1000 + 2],   // started 2s after the baseline
      ], T0 + 10_000) },
    ])
    const s = createProcSampler({ ...HOST, execFile: f.execFile, now: () => now })
    await s.sample([A])
    now = T0 + 10_000
    const a = (await s.sample([A])).sessions[0]
    expect(a.top.find((t) => t.pid === 150)?.cpuPct).toBe(40)
    expect(a.cpuPct).toBe(40)
  })

  it('a process is its pid AND its start: a reused pid starts over, an exec keeps its baseline', async () => {
    let now = T0
    const f = fake([
      { stdout: table([[100, 1, 100, 1000, '1:00.00', 'claude'], [101, 100, 100, 100, '0:10.00', 'bash'], [102, 100, 100, 100, '0:50.00', 'node']], T0) },
      { stdout: table([
        [100, 1, 100, 1000, '0:30.00', 'claude'],                     // cpu went backwards: no reading
        [101, 100, 100, 100, '0:12.00', 'node'],                       // bash exec'd node: same process
        [102, 100, 100, 100, '0:01.00', 'node', T0 / 1000 + 5],        // pid reused by a new process
      ], T0 + 10_000) },
    ])
    const s = createProcSampler({ ...HOST, execFile: f.execFile, now: () => now })
    await s.sample([A])
    now = T0 + 10_000
    const a = (await s.sample([A])).sessions[0]
    const pct = (pid: number) => a.top.find((t) => t.pid === pid)?.cpuPct
    expect(pct(100)).toBeNull()
    expect(pct(101)).toBe(20)
    expect(pct(102)).toBe(10)
  })

  it('a detached child keeps its session after its shell exits, and outlives the CLI as a left-behind row', async () => {
    let now = T0
    const step = (dt: number, rows: Row[]) => ({ stdout: table(rows, T0 + dt) })
    const f = fake([
      // The Bash tool's shell (own group 150) runs a dev server.
      step(0, [[100, 1, 100, 1000, '0:01.00', 'claude'], [150, 100, 150, 100, '0:00.01', 'bash'], [151, 150, 150, 9000, '0:02.00', 'node']]),
      // The shell exited: the server is re-parented to 1 in a group no root leads.
      step(10_000, [[100, 1, 100, 1000, '0:01.00', 'claude'], [151, 1, 150, 9000, '0:03.00', 'node']]),
      // The CLI is gone and the daemon no longer lists the session.
      step(20_000, [[151, 1, 150, 9000, '0:04.00', 'node']]),
      // A new process took pid 151: not the session's.
      step(30_000, [[151, 1, 151, 9000, '0:00.10', 'node', T0 / 1000 + 25]]),
    ])
    const s = createProcSampler({ ...HOST, execFile: f.execFile, now: () => now })
    expect((await s.sample([A])).sessions[0].procCount).toBe(3)
    now = T0 + 10_000
    const kept = (await s.sample([A])).sessions[0]
    expect(kept).toMatchObject({ alive: true, procCount: 2, rssBytes: (1000 + 9000) * 1024 })
    now = T0 + 20_000
    const behind = (await s.sample([])).sessions
    expect(behind).toEqual([expect.objectContaining({ sid: 'A', kind: 'cli', rootPid: 100, alive: false, procCount: 1, rssBytes: 9000 * 1024, cpuPct: 10 })])
    now = T0 + 30_000
    expect((await s.sample([])).sessions).toEqual([])
  })

  it('two asks during one ps share it (one spawn), and the next ask spawns again', async () => {
    const f = fake([{ stdout: rowsAt(T0, '1:00.00', '0:10.00'), delayMs: 20 }, { stdout: rowsAt(T0, '1:00.00', '0:10.00') }])
    const s = createProcSampler({ ...HOST, execFile: f.execFile })
    const [r1, r2] = await Promise.all([s.sample([A]), s.sample([A])])
    expect(r1).toBe(r2)
    expect(f.calls).toHaveLength(1)
    await s.sample([A])
    expect(f.calls).toHaveLength(2)
  })

  it('ps exiting 1 with a table still answers; a killed or overflowing ps is an error even with output', async () => {
    const exit1 = Object.assign(new Error('Command failed: ps'), { code: 1 })
    const f = fake([
      { stdout: rowsAt(T0, '1:00.00', '0:10.00'), error: exit1 },
      { stdout: rowsAt(T0, '1:00.00', '0:10.00').slice(0, 80), error: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null }) },
      { stdout: rowsAt(T0, '1:00.00', '0:10.00'), error: Object.assign(new Error('maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) },
      { error: Object.assign(new Error('timed out'), { killed: true }) },
    ])
    const s = createProcSampler({ ...HOST, execFile: f.execFile })
    const ok = await s.sample([A])
    expect(ok.error).toBeUndefined()
    expect(ok.sessions[0].procCount).toBe(3)
    for (const want of [/ps failed: timed out/, /ps failed: maxBuffer/, /ps failed: timed out/]) {
      const bad = await s.sample([A])
      expect(bad.error).toMatch(want)
      expect(bad.sessions).toEqual([])
      expect(bad.processCount).toBe(0)
      expect(bad.host.cpuCount).toBe(14)
    }
  })

  it('roots with no usable pid are dropped, never asked about', async () => {
    const f = fake([{ stdout: rowsAt(T0, '1:00.00', '0:10.00') }])
    const s = createProcSampler({ ...HOST, execFile: f.execFile })
    const r = await s.sample([{ sid: 'x', pid: 0, kind: 'cli' }, { sid: 'y', pid: NaN, kind: 'cli' }, { sid: 'z', pid: 1, kind: 'cli' }])
    expect(r.sessions).toEqual([])
  })

  it('without an execFile it answers an error frame instead of throwing', async () => {
    const s = createProcSampler({ ...HOST })
    const r = await s.sample([A])
    expect(r.error).toMatch(/no execFile/)
  })
})

describe('source twin injection', () => {
  it('the template carries no residue, and the deploy-time smoke refuses a parser that lost the command path', () => {
    expect(getDaemonSource()).not.toContain('__CREATE_PROC_SAMPLER__')
    const fold: Array<[string, string]> = [
      ['__FOLD_LINE__', foldLine.toString()],
      ['__INITIAL_FOLD_STATE__', initialFoldState.toString()],
      ['__ASSEMBLE_SNAPSHOT__', assembleSnapshot.toString()],
    ]
    const good = createProcSampler.toString()
    expect(() => validateFoldInjection(fold.concat([['__CREATE_PROC_SAMPLER__', good]]))).not.toThrow()
    // A parser that matched only a single-word command would drop every macOS path row.
    const TAIL = /\(\.\*\\S\)/
    expect(good).toMatch(TAIL)
    const broken = good.replace(TAIL, '(\\S+)')
    expect(() => validateFoldInjection(fold.concat([['__CREATE_PROC_SAMPLER__', broken]]))).toThrow(/misread a ps row/)
  })

  it('the reconstructed factory behaves like the imported one, across samples', async () => {
    const copy = new Function('"use strict"; return ' + createProcSampler.toString())() as typeof createProcSampler
    const run = async (factory: typeof createProcSampler) => {
      let now = T0
      const f = fake([
        { stdout: table([[100, 1, 100, 1000, '1:00.00', 'claude'], [150, 100, 150, 10, '0:00.01', 'bash'], [151, 150, 150, 2000, '0:10.00', 'vitest']], T0) },
        { stdout: table([[100, 1, 100, 1000, '1:04.00', 'claude'], [151, 1, 150, 2000, '0:12.00', 'vitest']], T0 + 8_000) },
      ])
      const s = factory({ ...HOST, execFile: f.execFile, now: () => now })
      const roots = [{ sid: 'A', pid: 100, kind: 'cli' as const }]
      const first = await s.sample(roots)
      now = T0 + 8_000
      return [first, await s.sample(roots)]
    }
    expect(await run(copy)).toEqual(await run(createProcSampler))
  })
})
