// The process sweep Demo reset runs before removing anything, on fake ps/lsof tables and a fake /proc: nothing reads the real process table, starts a process or sends a signal.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { demoPaths } from '../../src/commands/demo-home.js'
import {
  assertNoDemoResidualProcesses, cwdInDemo, darwinRow, environVerdict, lstartMs, openFilesVerdict, parseLaunchctlList, parseLsofCwd, parseLsofFiles, parsePs,
  psEnvVerdict, resolveHidden,
  sweepDemoResidualProcesses, type DarwinVerdict, type PsRow, type ResidualDeps, type RunResult, type Targets,
} from '../../src/commands/demo-residual-processes.js'

const ROOT = '/Users/a b/.local/share/open-walnut-demo'
const paths = demoPaths(ROOT, 'gen-1')
const SELF = 9000
const UID = 501
const START = 'Sat Nov  7 10:00:00 2026'
const LATER = 'Sat Nov  7 10:00:05 2026'
const LATEST = 'Sat Nov  7 10:00:09 2026'
/** The generation's HOME was made at 10:00:03.5 UTC: START predates it, LATER and LATEST do not. */
const BORN = Date.UTC(2026, 10, 7, 10, 0, 3) + 500
const targets: Targets = {
  env: [['HOME', paths.home], ['CLAUDE_CONFIG_DIR', `${paths.home}/.claude`]],
  demo: { root: paths.root, generation: 'gen-1' },
  dirs: [paths.home, paths.data, paths.daemon, `${paths.daemon}-streams`, `${ROOT}/task-dirs/gen-1`, paths.terminals, `/private${paths.terminals}`],
}
const enoent = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
const errno = (code: string) => Object.assign(new Error(code), { code })
const never = <T>() => new Promise<T>(() => {})

describe('path and environment boundaries', () => {
  it('a cwd counts only inside a removed dir, never a sibling with the same prefix', () => {
    expect(cwdInDemo(paths.home, targets.dirs)).toBe(true)
    expect(cwdInDemo(`${paths.home}/src/a b`, targets.dirs)).toBe(true)
    expect(cwdInDemo(`${ROOT}/task-dirs/gen-1/t1`, targets.dirs)).toBe(true)
    expect(cwdInDemo(`${ROOT}/d/gen-1`, targets.dirs)).toBe(true)
    expect(cwdInDemo(`${paths.daemon}-streams/x`, targets.dirs)).toBe(true)
    expect(cwdInDemo(`${paths.home} (deleted)`, targets.dirs)).toBe(true)
    for (const outside of [`${paths.home}-old`, `${paths.home}x`, `${ROOT}/homes/gen-2`, `${ROOT}/runtime/b`, ROOT, `${paths.daemon}x`, `${ROOT}/d/gen-2`, `${ROOT}/task-dirs/gen-2/t`, `${ROOT}/task-dirs`, '/Users/a b']) {
      expect(cwdInDemo(outside, targets.dirs), outside).toBe(false)
    }
  })

  it('/proc environ matches exact KEY=VALUE only, and the Demo root only paired with this generation', () => {
    const env = (...kv: string[]) => kv.join('\0') + '\0'
    expect(environVerdict(env('PATH=/bin', `HOME=${paths.home}`), targets)).toBe('match')
    expect(environVerdict(env(`HOME=${paths.home}/`), targets)).toBe('match')
    expect(environVerdict(env(`CLAUDE_CONFIG_DIR=${paths.home}/.claude`), targets)).toBe('match')
    expect(environVerdict(env(`WALNUT_DEMO_ROOT=${ROOT}`, 'WALNUT_DEMO_GENERATION=gen-1'), targets)).toBe('match')
    expect(environVerdict(env('WALNUT_DEMO_GENERATION=gen-1', `WALNUT_DEMO_ROOT=${ROOT}/`), targets)).toBe('match')
    // A kept older generation shares the root: its jobs never block this one.
    expect(environVerdict(env(`WALNUT_DEMO_ROOT=${ROOT}`, 'WALNUT_DEMO_GENERATION=gen-2'), targets)).toBe('none')
    expect(environVerdict(env(`WALNUT_DEMO_ROOT=${ROOT}`, 'WALNUT_DEMO_GENERATION=gen-10'), targets)).toBe('none')
    expect(environVerdict(env(`WALNUT_DEMO_ROOT=${ROOT}`, 'WALNUT_DEMO_GENERATION=gen-2', `HOME=${paths.home}`), targets)).toBe('match')
    // The root with no generation may be this one: not cleared.
    expect(environVerdict(env(`WALNUT_DEMO_ROOT=${ROOT}`), targets)).toBe('ambiguous')
    for (const miss of [`HOME=${paths.home}/sub`, `HOME=${paths.home}2`, `XHOME=${paths.home}`, `WALNUT_DEMO_ROOT=${ROOT}/x`, `CLAUDE_CONFIG_DIR=${paths.home}`, `HOME=/Users/a b`, 'WALNUT_DEMO_GENERATION=gen-1']) {
      expect(environVerdict(env(miss), targets), miss).toBe('none')
    }
  })

  it('ps -E text finds a whole value with spaces, bounded by a space or the end, the root only with this generation', () => {
    expect(psEnvVerdict(`PATH=/bin HOME=${paths.home} TERM=x`, targets)).toBe('match')
    expect(psEnvVerdict(`HOME=${paths.home}`, targets)).toBe('match')
    expect(psEnvVerdict(`TERM=x WALNUT_DEMO_ROOT=${ROOT} WALNUT_DEMO_GENERATION=gen-1`, targets)).toBe('match')
    expect(psEnvVerdict(`WALNUT_DEMO_GENERATION=gen-1 WALNUT_DEMO_ROOT=${ROOT}/`, targets)).toBe('match')
    expect(psEnvVerdict(`TERM=x WALNUT_DEMO_ROOT=${ROOT} WALNUT_DEMO_GENERATION=gen-2`, targets)).toBe('none')
    expect(psEnvVerdict(`WALNUT_DEMO_ROOT=${ROOT} WALNUT_DEMO_GENERATION=gen-10 TERM=x`, targets)).toBe('none')
    expect(psEnvVerdict(`TERM=x WALNUT_DEMO_ROOT=${ROOT}`, targets)).toBe('ambiguous')
    expect(psEnvVerdict(`WALNUT_DEMO_ROOT=${ROOT}x WALNUT_DEMO_GENERATION=gen-1`, targets)).toBe('none')
    for (const miss of [`HOME=${paths.home}2`, `MYHOME=${paths.home}`, `HOME=${paths.home}/x`, `HOME=/Users/a`, `HOME=/Users/a b`, 'WALNUT_DEMO_GENERATION=gen-1']) {
      expect(psEnvVerdict(`PATH=/bin ${miss} TERM=x`, targets), miss).toBe('none')
    }
  })
})

describe('parsers', () => {
  it('reads ps rows with a padded day, padded args, empty args and an argv newline', () => {
    const rows = parsePs(`  12     1 S    ${START}    /bin/zsh -l\n13 12 Ss   ${LATER}\n  14   13 R+   ${START} node -e x\nsecond line\n`)!
    expect(rows.get(12)).toEqual({ ppid: 1, stat: 'S', start: START, text: '   /bin/zsh -l' })
    expect(rows.get(13)).toEqual({ ppid: 12, stat: 'Ss', start: LATER, text: '' })
    expect(rows.get(14)!.text).toBe('node -e x\nsecond line')
    expect(rows.get(14)!.ppid).toBe(13)
  })

  it('an unreadable table is null, not empty', () => {
    expect(parsePs('garbage\n')).toBeNull()
    expect(parsePs(`1 0 S ${START} a\n1 0 S ${START} b\n`)).toBeNull()
    // The old table shape, with no ppid column, is not taken for rows.
    expect(parsePs(`12 S ${START} a\n`)).toBeNull()
  })

  it('reads a UTC lstart to the second, and nothing else', () => {
    expect(lstartMs(START)).toBe(Date.UTC(2026, 10, 7, 10, 0, 0))
    expect(lstartMs('Mon Dec 31 23:59:59 2029')).toBe(Date.UTC(2029, 11, 31, 23, 59, 59))
    for (const bad of ['Sat Foo  7 10:00:00 2026', 'Sat Nov  7 10:00 2026', '', 'yesterday']) expect(lstartMs(bad), bad).toBeNaN()
  })

  it('reads lsof cwd names with spaces, skipping fd lines', () => {
    const cwd = parseLsofCwd(`p12\nfcwd\nn${paths.home}/a b\np13\nfcwd\nn/\n`)
    expect(cwd.get(12)).toBe(`${paths.home}/a b`)
    expect(cwd.get(13)).toBe('/')
  })

  it('reads every open file name of each listed pid; a pid with no names is listed empty, one lsof skipped is absent', () => {
    // The shape a real `lsof -w -p <pid> -F pfn` prints on macOS: `p`, then an `f` before each `n`.
    const files = parseLsofFiles(`nstray before any pid\np12\nfcwd\nn${paths.home}/a b\nftxt\nn/usr/lib/dyld\nf0\nn/dev/null\nf11\nn->0x826b57843677f883\np13\np14\nf255\nn/Users/a b/x y.sh\n`)
    expect([...files.keys()]).toEqual([12, 13, 14])
    expect(files.get(12)).toEqual({ names: [`${paths.home}/a b`, '/usr/lib/dyld', '/dev/null', '->0x826b57843677f883'], partial: false })
    expect(files.get(13)).toEqual({ names: [], partial: false })
    expect(files.get(14)).toEqual({ names: ['/Users/a b/x y.sh'], partial: false })
    expect(files.has(15)).toBe(false)
    expect(parseLsofFiles('').size).toBe(0)
    expect(parseLsofFiles('garbage\n').size).toBe(0)
  })

  it('marks a pid read only partly: an fNOFD entry, its name, or a name that is lsof error text; the next pid starts clean', () => {
    const files = parseLsofFiles([
      'p20', 'fcwd', 'n/Users/a b', 'fNOFD', 'n/proc/20/fd (opendir: Permission denied)', 'ftxt', 'n/bin/bash',
      'p21', 'fNOFD',
      'p22', 'fcwd', 'n(readlink: Permission denied)', 'ftxt', 'n/usr/bin/perl',
      'p23', 'ftxt', 'n(stat: No such file or directory)',
      'p24', 'fcwd', 'n(Permission denied)',
      'p25', 'fcwd', 'n/Users/a b (old)', 'f3', 'n/dev/null',
    ].join('\n') + '\n')
    expect(files.get(20)).toEqual({ names: ['/Users/a b', '/bin/bash'], partial: true })
    expect(files.get(21)).toEqual({ names: [], partial: true })
    expect(files.get(22)).toEqual({ names: ['/usr/bin/perl'], partial: true })
    expect(files.get(23)).toEqual({ names: [], partial: true })
    expect(files.get(24)).toEqual({ names: [], partial: true })
    // A parenthesis inside a real name is no error text.
    expect(files.get(25)).toEqual({ names: ['/Users/a b (old)', '/dev/null'], partial: false })
  })

  it('openFilesVerdict: matched on a file in the generation, clear on none in a full read, undecided otherwise', () => {
    const row = (start = LATER): PsRow => ({ ppid: 1, stat: 'S', start, text: '/bin/bash' })
    const full = (names: string[]) => ({ names, partial: false })
    const partly = (names: string[]) => ({ names, partial: true })
    const outside = ['/Users/a b', '/usr/lib/dyld', '/dev/null', `${paths.home}-old/x`, `${ROOT}/homes/gen-2/x`]
    expect(openFilesVerdict(full(outside), row(), row(), targets.dirs)).toBe('clear')
    for (const inside of [`${paths.daemon}-streams/x.jsonl`, `/private${paths.terminals}/agent-gateway.sock`, `${paths.home}/.claude/a b.json`, `${paths.data} (deleted)`]) {
      expect(openFilesVerdict(full([...outside, inside]), row(), row(), targets.dirs), inside).toBe('matched')
      // A Demo file is the Demo even when the rest could not be read.
      expect(openFilesVerdict(partly([...outside, inside]), row(), row(), targets.dirs), inside).toBe('matched')
    }
    // A partial read with nothing in the Demo may have missed the one that is.
    expect(openFilesVerdict(partly(outside), row(), row(), targets.dirs)).toBeUndefined()
    expect(openFilesVerdict(partly([]), row(), row(), targets.dirs)).toBeUndefined()
    expect(openFilesVerdict(undefined, row(), row(), targets.dirs)).toBeUndefined()
    expect(openFilesVerdict(full([]), row(), row(), targets.dirs)).toBeUndefined()
    expect(openFilesVerdict(full(outside), undefined, row(), targets.dirs)).toBeUndefined()
    expect(openFilesVerdict(full(outside), row(), undefined, targets.dirs)).toBeUndefined()
    // A reused pid: the files are another process's.
    expect(openFilesVerdict(full([`${paths.home}/x`]), row(), row(LATEST), targets.dirs)).toBeUndefined()
  })
})

// --- macOS: fake ps / lsof ------------------------------------------------------------

interface MacProc { pid: number; ppid?: number; stat?: string; start?: string; args?: string; env?: string | null; cwd?: string | null }
/**
 * `launchctl`: the answer to `launchctl list` (default: only its header).
 * The open-files step of still-hidden rows: `files` is what `lsof -w -p <pids> -F pfn` lists per pid (a pid absent is one lsof
 * could not read; default none): a name gets an fd of its own, a `[fd, name?]` pair is printed as given (`['NOFD']`);
 * `filesAfter` the table of the `ps -p` right after it (default `after`, then `before`); `filesLsof` / `filesPs` replace either answer whole.
 */
type FileEntry = string | [fd: string, name?: string]
type Tables = {
  before: MacProc[]; env?: MacProc[]; after?: MacProc[]; lsof?: MacProc[]; launchctl?: RunResult | null; again?: Tables
  files?: Record<number, FileEntry[]>; filesAfter?: MacProc[]; filesLsof?: RunResult | null; filesPs?: RunResult | null
}
const OPEN_FILES_LSOF = (pids: number[]) => ['/usr/sbin/lsof', ['-w', '-p', pids.join(','), '-F', 'pfn']] as [string, string[]]
const OPEN_FILES_PS = (pids: number[]) => ['/bin/ps', ['-ww', '-p', pids.join(','), '-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'args=']] as [string, string[]]
const isOpenFilesCall = ([file, args]: [string, string[]]) => file === '/usr/sbin/lsof' && !args.includes('-d')

const self: MacProc = { pid: SELF, args: 'walnut demo reset', env: `HOME=${paths.home}`, cwd: '/' }
const other = (pid: number, extra: Partial<MacProc> = {}): MacProc => ({ pid, args: '/bin/zsh', env: 'HOME=/Users/a b TERM=x', cwd: '/Users/a b', ...extra })

function macDeps(attempts: Tables[], over: Partial<ResidualDeps> = {}) {
  const calls: Array<[string, string[]]> = []
  let attempt = 0, step = 0, probe = 7000
  const psText = (procs: MacProc[], withEnv: boolean) => procs.map(p => {
    const args = p.args ?? 'proc'
    return `${p.pid} ${p.ppid ?? 1} ${p.stat ?? 'S'} ${p.start ?? START}   ${withEnv && p.env ? `${args} ${p.env}` : args}`
  }).join('\n') + '\n'
  const answer = (t: Tables, which: number, keep: (p: MacProc) => boolean, pid: number, withSelf: boolean): RunResult => {
    // Each ps lists itself, as the real one does; the sweep must drop exactly that pid.
    const me: MacProc[] = which === 2 ? [] : [{ pid, ppid: SELF, args: '/bin/ps -ww', env: 'PATH=/usr/bin LC_ALL=C TZ=UTC', cwd: '/' }]
    const own = withSelf ? [self] : []
    const pick = (list: MacProc[]) => [...own, ...list.filter(keep), ...me]
    if (which === 0) return { code: 0, stdout: psText(pick(t.before), false), pid }
    if (which === 1) return { code: 0, stdout: psText(pick(t.env ?? t.before), true), pid }
    if (which === 2) return { code: 0, stdout: pick(t.lsof ?? t.env ?? t.before).filter(p => p.cwd).map(p => `p${p.pid}\nfcwd\nn${p.cwd}`).join('\n') + '\n', pid }
    return { code: 0, stdout: psText(pick(t.after ?? t.before), false), pid }
  }
  let againStep = 0, started = false, filesPsNext = false
  const deps: ResidualDeps = {
    platform: 'darwin', uid: UID, selfPid: SELF, now: () => 0, sleep: async () => {}, after: () => never(),
    run: async (file, args): Promise<RunResult | null> => {
      calls.push([file, args])
      if (file === '/bin/launchctl') {
        const t = attempts[Math.min(attempt, attempts.length - 1)]!
        return t.launchctl === undefined ? { code: 0, stdout: 'PID\tStatus\tLabel\n', pid: probe++ } : t.launchctl
      }
      // The open-files step: an lsof by pid with no `-d`, then the ps by pid right after it; neither moves the re-read steps.
      const filesPs = filesPsNext && file === '/bin/ps' && args.includes('-p')
      filesPsNext = false
      if (isOpenFilesCall([file, args]) || filesPs) {
        const t = attempts[Math.min(attempt, attempts.length - 1)]!
        const wanted = new Set(args[args.indexOf('-p') + 1]!.split(',').map(Number))
        if (!filesPs) {
          filesPsNext = true
          if (t.filesLsof !== undefined) return t.filesLsof
          const listed = Object.entries(t.files ?? {}).filter(([pid]) => wanted.has(Number(pid)))
          // As the real lsof (checked on a Mac): `p`, then an `f` line before each `n`; the exit is 1 when a pid it was given lists nothing.
          const lines = (e: FileEntry, i: number) => typeof e === 'string' ? [`f${i ? i + 2 : 'cwd'}`, `n${e}`] : [`f${e[0]}`, ...(e[1] === undefined ? [] : [`n${e[1]}`])]
          const stdout = listed.map(([pid, entries]) => [`p${pid}`, ...entries.flatMap(lines)].join('\n')).join('\n') + '\n'
          return { code: listed.length === wanted.size ? 0 : 1, stdout: listed.length ? stdout : '', pid: probe++ }
        }
        if (t.filesPs !== undefined) return t.filesPs
        const rows = (t.filesAfter ?? t.after ?? t.before).filter(proc => wanted.has(proc.pid))
        return { code: rows.length === wanted.size ? 0 : 1, stdout: rows.length ? psText(rows, false) : '', pid: probe++ }
      }
      const p = args.indexOf('-p')
      if (p < 0 && step === 0 && started) attempt++
      const t = attempts[Math.min(attempt, attempts.length - 1)]!
      const which = file.endsWith('lsof') ? 2 : args.includes('-E') ? 1 : (p < 0 ? step : againStep) === 0 ? 0 : 3
      if (p >= 0) {
        if (file.endsWith('ps')) againStep = (againStep + 1) % 3
        const wanted = new Set(args[p + 1]!.split(',').map(Number))
        return answer(t.again ?? { before: t.after ?? t.before }, which, proc => wanted.has(proc.pid), probe++, false)
      }
      started = true
      step = (step + 1) % 4
      return answer(t, which, () => true, probe++, true)
    },
    readdir: async () => [], readFile: async () => '', readlink: async () => '', ownerUid: async () => UID,
    realpath: async (p: string) => {
      if (p === '/tmp') return '/private/tmp'
      if (p === '/') return '/'
      throw enoent(p)
    },
    ...over,
  }
  return { deps, calls }
}

describe('macOS sweep', () => {
  it('passes with only unrelated processes, drops its own probes, and runs ps and lsof with fixed argv', async () => {
    const { deps, calls } = macDeps([{ before: [other(100), other(101, { env: `HOME=${paths.home}2` })] }])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ supported: true, complete: true, matched: 0, unknown: 0 })
    expect(calls).toEqual([
      ['/bin/ps', ['-ww', '-u', '501', '-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'args=']],
      ['/bin/ps', ['-E', '-ww', '-u', '501', '-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'args=']],
      ['/usr/sbin/lsof', ['-w', '-a', '-u', '501', '-d', 'cwd', '-F', 'pn']],
      ['/bin/launchctl', ['list']],
      ['/bin/ps', ['-ww', '-u', '501', '-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'args=']],
    ])
  })

  it('counts a detached job by HOME, CLAUDE_CONFIG_DIR, WALNUT_DEMO_ROOT with this generation, or cwd, and says how many', async () => {
    const { deps } = macDeps([{ before: [
      other(200, { env: `TERM=x HOME=${paths.home} SECRET_TOKEN=abc` }),
      other(201, { env: `CLAUDE_CONFIG_DIR=${paths.home}/.claude` }),
      other(202, { env: `WALNUT_DEMO_ROOT=${ROOT} WALNUT_DEMO_GENERATION=gen-1` }),
      other(203, { cwd: `${ROOT}/task-dirs/gen-1/t 1` }),
      other(204, { cwd: `/private${paths.terminals}` }),
      other(205),
    ] }])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 5, unknown: 0 })
    const error = await assertNoDemoResidualProcesses(paths, macDeps([{ before: [other(200, { env: `HOME=${paths.home} SECRET_TOKEN=abc` })] }]).deps).then(() => new Error('no error'), (e: unknown) => e as Error)
    expect(error.message).toMatch(/^1 process started in the Demo is still running/)
    expect(error.message).not.toMatch(/SECRET|abc|zsh|Users/)
  })

  it('a kept older generation sharing the root never blocks; the root alone stays unknown', async () => {
    const { deps } = macDeps([{ before: [
      other(310, { env: `WALNUT_DEMO_ROOT=${ROOT} WALNUT_DEMO_GENERATION=gen-2`, cwd: `${ROOT}/homes/gen-2` }),
      other(311, { env: `WALNUT_DEMO_ROOT=${ROOT} WALNUT_DEMO_GENERATION=gen-2`, cwd: `${paths.home}/x` }),
      other(312, { env: `WALNUT_DEMO_ROOT=${ROOT}` }),
    ] }])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 1, unknown: 1, why: { rootNoGeneration: 1 } })
  })

  it('never blocks on a zombie, the caller itself, or pid 1', async () => {
    const { deps } = macDeps([{ before: [other(300, { stat: 'Z', env: `HOME=${paths.home}` }), other(1, { env: `HOME=${paths.home}` })] }])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
  })

  it('a stable process macOS shows no environment for stays unknown, and so does a cwd lsof cannot read', async () => {
    const { deps, calls } = macDeps([{ before: [other(400, { env: null }), other(401, { cwd: null })] }])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({
      complete: true, matched: 0, unknown: 2, why: { envHidden: 1, cwdUnreadable: 1, unreadable: 0, raced: 0 },
    })
    // The missing cwd was asked for again, by pid, before it counted; then what both still-hidden rows hold open.
    expect(calls.slice(5, 9).map(([, args]) => args.slice(args.indexOf('-p'), args.indexOf('-p') + 2))).toEqual(Array(4).fill(['-p', '401']))
    expect(calls.slice(9, 11)).toEqual([OPEN_FILES_LSOF([400, 401]), OPEN_FILES_PS([400, 401])])
    // Still unknown on every look, so the whole look ran its 6 times before it counted.
    expect(calls.filter(([file]) => file === '/bin/launchctl')).toHaveLength(6)
    await expect(assertNoDemoResidualProcesses(paths, macDeps([{ before: [other(400, { env: null })] }]).deps)).rejects.toThrow(/^1 process of this account could not be checked/)
  })

  it('a pid born after the env read is identified itself, never assumed from its parent', async () => {
    const late = { before: [other(700)], env: [], after: [other(701, { env: `HOME=${paths.home}` })] }
    expect(await sweepDemoResidualProcesses(paths, macDeps([late]).deps)).toMatchObject({ complete: true, matched: 1 })
    const plain = { before: [], after: [other(702)] }
    expect(await sweepDemoResidualProcesses(paths, macDeps([plain]).deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
  })

  it('a late pid gone before it could be identified is read again, and stays unknown while that lasts', async () => {
    const vanishes: Tables = { before: [], after: [other(710)], again: { before: [] } }
    expect(await sweepDemoResidualProcesses(paths, macDeps([vanishes]).deps)).toMatchObject({ complete: true, unknown: 1, why: { raced: 1 } })
    expect(await sweepDemoResidualProcesses(paths, macDeps([vanishes, { before: [] }]).deps)).toMatchObject({ unknown: 0 })
  })

  it('a pid in the first and last table but not the env table is read again by pid', async () => {
    const { deps, calls } = macDeps([{ before: [other(720)], env: [] }])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
    // The by-pid look asks launchctl nothing.
    expect(calls).toHaveLength(9)
  })

  it('a reused pid is read again by pid and judged as the process now there', async () => {
    const reused: Tables = { before: [other(500, { env: `HOME=${paths.home}` })], after: [other(500, { start: LATER })] }
    expect(await sweepDemoResidualProcesses(paths, macDeps([reused]).deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
    // Alive at the end with another start in the env table: read again by pid, and the race stays while every read shows one.
    const inconsistent: Tables = { before: [other(501)], env: [other(501, { start: LATER })] }
    const persists: Tables = { ...inconsistent, again: { ...inconsistent } }
    expect(await sweepDemoResidualProcesses(paths, macDeps([persists]).deps)).toMatchObject({ complete: true, unknown: 1, why: { raced: 1 } })
  })

  it('a Demo process exiting during the look is read again, finding the child it double forked', async () => {
    const parent = other(600, { env: `HOME=${paths.home}` })
    const exiting: Tables = { before: [parent], env: [parent], after: [] }
    const child: Tables = { before: [other(601, { env: `HOME=${paths.home}`, cwd: '/' })] }
    expect(await sweepDemoResidualProcesses(paths, macDeps([exiting, child]).deps)).toMatchObject({ matched: 1, unknown: 0 })
  })

  it('a process whose args changed between reads (exec) is read again', () => {
    const a = { ppid: 1, stat: 'S', start: START, text: 'sh -c x' }
    const e = { ppid: 1, stat: 'S', start: START, text: 'node y HOME=/Users/a b' }
    expect(darwinRow(a, e, a, '/', targets)).toBe('raced')
  })

  it.each([
    ['ps fails', (n: number) => n === 0 ? null : undefined],
    ['ps exits non-zero', (n: number) => n === 1 ? { code: 1, stdout: '' } : undefined],
    ['lsof cannot see the caller', (n: number) => n === 2 ? { code: 1, stdout: 'p1\nn/\n' } : undefined],
    ['lsof fails', (n: number) => n === 2 ? null : undefined],
    ['the last ps fails', (n: number) => n === 4 ? null : undefined],
  ])('%s: incomplete, and the data is kept', async (_name, fault) => {
    const faulty = (): ResidualDeps => {
      const base = macDeps([{ before: [other(800)] }]).deps
      let n = 0
      return { ...base, run: async (file, args, t) => { const f = fault(n++); return f === undefined ? base.run(file, args, t) : f } }
    }
    expect(await sweepDemoResidualProcesses(paths, faulty())).toMatchObject({ complete: false })
    await expect(assertNoDemoResidualProcesses(paths, faulty())).rejects.toThrow(/could not read this account's processes/)
  })

  it('a Demo path ps or lsof might print escaped is not checked by guess', async () => {
    const odd = demoPaths('/Users/José/.local/share/open-walnut-demo', 'gen-1')
    expect(await sweepDemoResidualProcesses(odd, macDeps([{ before: [] }]).deps)).toMatchObject({ complete: false })
  })

  it('stops at the deadline instead of hanging, on a clock or on a probe that never answers', async () => {
    let t = 0
    expect(await sweepDemoResidualProcesses(paths, macDeps([{ before: [] }], { now: () => (t += 30_000) }).deps)).toMatchObject({ complete: false })
    for (const over of [{ run: () => never<RunResult | null>() }, { realpath: () => never<string>() }]) {
      const deps = macDeps([{ before: [] }], { ...over, after: async () => {} }).deps
      expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: false })
    }
  })
})

describe('macOS: processes whose environment macOS hides', () => {
  const born = { birthtime: async () => BORN }
  const hiddenEnv = (pid: number, extra: Partial<MacProc> = {}) => other(pid, { env: null, start: LATER, ...extra })

  it('one that started before the generation existed is clear, and so is an unreadable cwd of that age', async () => {
    const { deps } = macDeps([{ before: [hiddenEnv(400, { start: START }), other(401, { cwd: null, start: START })] }], born)
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
  })

  it('with no birth time known the start time clears nothing', async () => {
    const procs = [hiddenEnv(400, { start: START }), other(401, { cwd: null, start: START })]
    for (const over of [{}, { birthtime: async () => null }, { birthtime: async () => 0 }, { birthtime: async () => NaN }, { birthtime: async () => { throw errno('EIO') } }]) {
      expect(await sweepDemoResidualProcesses(paths, macDeps([{ before: procs }], over).deps)).toMatchObject({
        complete: true, unknown: 2, why: { envHidden: 1, cwdUnreadable: 1 },
      })
    }
  })

  it('the birth time is read only on macOS, of the generation HOME', async () => {
    const asked: string[] = []
    const birthtime = async (file: string) => { asked.push(file); return BORN }
    await sweepDemoResidualProcesses(paths, macDeps([{ before: [] }], { birthtime }).deps)
    expect(asked).toEqual([paths.home])
    await sweepDemoResidualProcesses(paths, linuxDeps([[{ pid: 10 }]], { birthtime }).deps)
    expect(asked).toEqual([paths.home])
  })

  it('a later one is clear through a parent whose environment ps printed and holds no Demo variable', async () => {
    const { deps } = macDeps([{ before: [other(410), hiddenEnv(411, { ppid: 410 }), hiddenEnv(412, { ppid: 411 })] }], born)
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
  })

  it('a later child of a Demo process is the Demo, and blocks the reset', async () => {
    const procs = [other(420, { env: `HOME=${paths.home}`, start: LATER }), hiddenEnv(421, { ppid: 420 })]
    expect(await sweepDemoResidualProcesses(paths, macDeps([{ before: procs }], born).deps)).toMatchObject({ complete: true, matched: 2, unknown: 0 })
    // A Demo cwd marks the parent even when it started before the generation.
    const byCwd = [other(422, { env: null, start: START, cwd: `${paths.home}/x` }), hiddenEnv(423, { ppid: 422 })]
    expect(await sweepDemoResidualProcesses(paths, macDeps([{ before: byCwd }], born).deps)).toMatchObject({ matched: 2, unknown: 0 })
    await expect(assertNoDemoResidualProcesses(paths, macDeps([{ before: procs }], born).deps)).rejects.toThrow(/^2 processes started in the Demo are still running/)
  })

  it('a later orphan (ppid 1) stays unknown, and so does a child of the caller', async () => {
    const { deps } = macDeps([{ before: [hiddenEnv(430), hiddenEnv(431, { ppid: SELF })] }], born)
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 2, why: { envHidden: 2 } })
    await expect(assertNoDemoResidualProcesses(paths, macDeps([{ before: [hiddenEnv(430)] }], born).deps)).rejects.toThrow(/could not be checked/)
  })

  it('a parent younger than its child is a reused pid and proves nothing', async () => {
    const { deps } = macDeps([{ before: [other(440, { start: LATEST }), hiddenEnv(441, { ppid: 440 })] }], born)
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, unknown: 1, why: { envHidden: 1 } })
  })

  it('a parent that is no row, or holds only the Demo root, proves nothing', async () => {
    const procs = [
      hiddenEnv(450, { ppid: 9999 }),
      other(451, { env: `WALNUT_DEMO_ROOT=${ROOT}`, start: LATER }), hiddenEnv(452, { ppid: 451 }),
    ]
    expect(await sweepDemoResidualProcesses(paths, macDeps([{ before: procs }], born).deps)).toMatchObject({
      complete: true, matched: 0, unknown: 3, why: { envHidden: 2, rootNoGeneration: 1 },
    })
  })

  it('hundreds of system programs from before the generation no longer keep the old files', async () => {
    const system = Array.from({ length: 360 }, (_, i) => hiddenEnv(1000 + i, { start: START, ppid: i % 3 ? 1 : 1000 }))
    const unreadableCwd = Array.from({ length: 5 }, (_, i) => other(2000 + i, { cwd: null, start: START }))
    const shell = other(3000, { start: START })
    const shortLived = Array.from({ length: 30 }, (_, i) => hiddenEnv(3001 + i, { ppid: 3000 }))
    const busy = [...system, ...unreadableCwd, shell, ...shortLived]
    expect(await sweepDemoResidualProcesses(paths, macDeps([{ before: busy }], born).deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
    await expect(assertNoDemoResidualProcesses(paths, macDeps([{ before: busy }], born).deps)).resolves.toBeUndefined()
    // With no birth time only the parent rule applies: the system programs stay unknown, as on the reported Mac.
    expect(await sweepDemoResidualProcesses(paths, macDeps([{ before: busy }]).deps)).toMatchObject({ unknown: 365, why: { envHidden: 360, cwdUnreadable: 5 } })
    // A Demo job among them is still found.
    const withJob = [...busy, other(4000, { env: `HOME=${paths.home}`, start: LATER }), hiddenEnv(4001, { ppid: 4000 })]
    expect(await sweepDemoResidualProcesses(paths, macDeps([{ before: withJob }], born).deps)).toMatchObject({ matched: 2, unknown: 0 })
  })

  it('resolveHidden walks hidden ancestors, stops at their bounds, and keeps the verdict it cannot resolve', () => {
    const row = (ppid: number, start = LATER): PsRow => ({ ppid, stat: 'S', start, text: 'x' })
    const run = (rows: Array<[number, PsRow, DarwinVerdict]>, readable: number[] = [], bornAt: number | null = BORN) => {
      const after = new Map(rows.map(([pid, r]) => [pid, r]))
      const verdicts = new Map(rows.map(([pid, , v]) => [pid, v]))
      return resolveHidden(rows[0]![0], verdicts, new Set(readable), after, bornAt ?? undefined)
    }
    // A start in the second the HOME was made is not before it.
    expect(run([[10, row(1, 'Sat Nov  7 10:00:03 2026'), 'envHidden']])).toBe('envHidden')
    expect(run([[10, row(1, 'Sat Nov  7 10:00:02 2026'), 'envHidden']])).toBe('clear')
    // Hidden ancestors are walked: the first one that predates the generation clears the chain.
    expect(run([[10, row(11), 'envHidden'], [11, row(12), 'cwdUnreadable'], [12, row(1, START), 'envHidden']])).toBe('clear')
    expect(run([[10, row(11), 'envHidden'], [11, row(12), 'cwdUnreadable'], [12, row(1, START), 'envHidden']], [], null)).toBe('envHidden')
    // A clear parent lends its clear only when ps printed its environment (a zombie's was never read).
    expect(run([[10, row(11), 'cwdUnreadable'], [11, row(1), 'clear']], [11])).toBe('clear')
    expect(run([[10, row(11), 'cwdUnreadable'], [11, row(1), 'clear']])).toBe('cwdUnreadable')
    expect(run([[10, row(11), 'envHidden'], [11, row(1), 'matched']])).toBe('matched')
    expect(run([[10, row(11), 'envHidden'], [11, row(1), 'raced']])).toBe('envHidden')
    // A cycle of hidden rows ends at the hop limit.
    expect(run([[10, row(11), 'envHidden'], [11, row(10), 'envHidden']])).toBe('envHidden')
  })
})

describe('macOS: services launchd started', () => {
  /** The launchctl list is read at 10:00:20 UTC; LATER and LATEST started seconds before it. */
  const READ_AT = Date.UTC(2026, 10, 7, 10, 0, 20)
  const at = (ms: number) => ({ now: () => ms })
  const listed = (...pids: number[]): RunResult => ({ code: 0, stdout: `PID\tStatus\tLabel\n${pids.map(pid => `${pid}\t0\tcom.apple.job${pid}`).join('\n')}\n-\t0\tcom.apple.idle\n` })
  const hiddenEnv = (pid: number, extra: Partial<MacProc> = {}) => other(pid, { env: null, start: LATER, args: '/usr/libexec/appleaccountd', ...extra })
  const XPC = '/System/Library/Frameworks/AudioToolbox.framework/XPCServices/com.apple.audio.SandboxHelper.xpc/Contents/MacOS/com.apple.audio.SandboxHelper'
  const sweepOf = (t: Tables, now = READ_AT, over: Partial<ResidualDeps> = {}) => sweepDemoResidualProcesses(paths, macDeps([t], { ...at(now), birthtime: async () => BORN, ...over }).deps)

  it('reads only the PID column: digits, never a `-` or a line of another shape', () => {
    expect([...parseLaunchctlList('PID\tStatus\tLabel\n4083\t0\tcom.apple.rcd\n-\t0\tcom.x\n77\t-9\tcom.y\n12 0 com.spaces\nx1\t0\tz\n\n55\t0\t\n')]).toEqual([4083, 77])
    for (const garbage of ['', 'garbage\n', 'Could not find service', '\0\0']) expect(parseLaunchctlList(garbage).size, garbage).toBe(0)
  })

  it('a hidden orphan launchd lists is clear when it started in a second before the list was read', async () => {
    expect(await sweepOf({ before: [hiddenEnv(500)], launchctl: listed(500) })).toMatchObject({ complete: true, matched: 0, unknown: 0 })
    // The same with no birth time known, and for an unreadable cwd.
    expect(await sweepOf({ before: [hiddenEnv(500), other(501, { cwd: null, start: LATER })], launchctl: listed(500, 501) }, READ_AT, { birthtime: async () => null })).toMatchObject({ complete: true, unknown: 0 })
    // A start one whole second before the read is enough; the same second, or later, may be a reused pid.
    expect(await sweepOf({ before: [hiddenEnv(500, { start: 'Sat Nov  7 10:00:19 2026' })], launchctl: listed(500) })).toMatchObject({ unknown: 0 })
    for (const start of ['Sat Nov  7 10:00:20 2026', 'Sat Nov  7 10:00:21 2026']) {
      expect(await sweepOf({ before: [hiddenEnv(500, { start })], launchctl: listed(500) }, READ_AT + 500), start).toMatchObject({ complete: true, unknown: 1, why: { envHidden: 1 } })
    }
  })

  it('an orphan launchd does not list stays unknown, and so does a listed pid whose parent is not launchd', async () => {
    expect(await sweepOf({ before: [hiddenEnv(500), hiddenEnv(501)], launchctl: listed(501) })).toMatchObject({ complete: true, unknown: 1, why: { envHidden: 1 } })
    expect(await sweepOf({ before: [hiddenEnv(502, { ppid: SELF })], launchctl: listed(502) })).toMatchObject({ complete: true, unknown: 1, why: { envHidden: 1 } })
  })

  it.each([
    ['launchctl cannot run', null],
    ['launchctl exits non-zero', { code: 1, stdout: '4083\t0\tcom.apple.rcd\n' }],
    ['launchctl prints garbage', { code: 0, stdout: 'garbage 500\n' }],
  ])('%s: nothing is cleared by it, and the look is still complete', async (_name, answer) => {
    expect(await sweepOf({ before: [hiddenEnv(500)], launchctl: answer })).toMatchObject({ complete: true, matched: 0, unknown: 1, why: { envHidden: 1 } })
  })

  it('a system XPC service bundle with launchd as its parent is clear; a lookalike is not', async () => {
    const xpc = hiddenEnv(510, { args: XPC })
    expect(await sweepOf({ before: [xpc] })).toMatchObject({ complete: true, unknown: 0 })
    const lookalikes = [
      hiddenEnv(511, { args: XPC.replace('/System/', '/Users/a b/') }),
      hiddenEnv(512, { args: `/tmp${XPC}` }),
      hiddenEnv(513, { args: '/System/Library/CoreServices/rcd.app/Contents/MacOS/rcd' }),
      hiddenEnv(514, { args: XPC, ppid: SELF }),
    ]
    expect(await sweepOf({ before: lookalikes })).toMatchObject({ complete: true, unknown: 4, why: { envHidden: 4 } })
  })

  it('launchd listing a pid never clears what the row itself shows: a Demo cwd or env, the root alone, a reused pid', async () => {
    const procs = [
      hiddenEnv(520, { cwd: `${paths.home}/x` }),
      hiddenEnv(521, { args: XPC, cwd: `${ROOT}/task-dirs/gen-1/t` }),
      other(522, { env: `HOME=${paths.home}`, start: LATER }),
      other(523, { env: `WALNUT_DEMO_ROOT=${ROOT}`, start: LATER }),
    ]
    expect(await sweepOf({ before: procs, launchctl: listed(520, 521, 522, 523) })).toMatchObject({ complete: true, matched: 3, unknown: 1, why: { rootNoGeneration: 1 } })
    // A race the by-pid re-read still shows.
    const race = { before: [other(524)], env: [other(524, { start: LATER })] }
    const reused: Tables = { ...race, launchctl: listed(524), again: race }
    expect(await sweepOf(reused)).toMatchObject({ complete: true, unknown: 1, why: { raced: 1 } })
  })

  it('resolveHidden takes the launchd list only for a hidden row whose parent is launchd', () => {
    const row = (ppid: number, start = LATER, text = '/usr/libexec/appleaccountd'): PsRow => ({ ppid, stat: 'S', start, text })
    const launchd = { pids: new Set([10]), readAtMs: READ_AT }
    const one = (r: PsRow, verdict: DarwinVerdict, list = launchd) => resolveHidden(10, new Map([[10, verdict]]), new Set(), new Map([[10, r]]), undefined, list)
    expect(one(row(1), 'envHidden')).toBe('clear')
    expect(one(row(1), 'cwdUnreadable')).toBe('clear')
    expect(one(row(1), 'envHidden', { pids: new Set(), readAtMs: READ_AT })).toBe('envHidden')
    expect(one(row(1), 'envHidden', { pids: new Set([10]), readAtMs: lstartMs(LATER) + 999 })).toBe('envHidden')
    expect(one(row(1, 'garbage'), 'envHidden')).toBe('envHidden')
    expect(one(row(0), 'envHidden')).toBe('envHidden')
    expect(one(row(1, LATER, `   ${XPC}`), 'envHidden', { pids: new Set(), readAtMs: 0 })).toBe('clear')
    expect(resolveHidden(10, new Map([[10, 'envHidden']]), new Set(), new Map([[10, row(1)]]))).toBe('envHidden')
  })

  it('a busy Mac like the reported one: launchd services and XPC services clear, the orphaned tools stay unknown', async () => {
    const services = [
      '/System/Library/CoreServices/rcd.app/Contents/MacOS/rcd',
      '/usr/libexec/appleaccountd',
      '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared -s mdworker -c MDSImporterWorker',
    ]
    const listedServices = Array.from({ length: 37 }, (_, i) => hiddenEnv(6000 + i, { args: services[i % services.length], start: i % 2 ? LATER : LATEST }))
    const xpcs = [
      hiddenEnv(6100, { args: XPC }),
      hiddenEnv(6101, { args: '/System/Library/Frameworks/ExtensionFoundation.framework/Versions/A/XPCServices/extensionkitservice.xpc/Contents/MacOS/extensionkitservice' }),
    ]
    const orphans = [
      hiddenEnv(6200, { args: 'sleep 600' }),
      hiddenEnv(6201, { args: 'ssh -o ControlMaster=auto -o ControlPersist=600 -fN devbox' }),
      hiddenEnv(6202, { args: '/usr/bin/log stream --style compact' }),
    ]
    const shell = other(6300, { start: LATER })
    const busy = [...listedServices, ...xpcs, ...orphans, shell, hiddenEnv(6301, { ppid: 6300 })]
    // launchd also lists jobs of other accounts and pids no longer there.
    const t: Tables = { before: busy, launchctl: listed(...listedServices.map(p => p.pid), 88, 89, 90) }
    expect(await sweepOf(t)).toMatchObject({ complete: true, matched: 0, unknown: 3, why: { envHidden: 3, cwdUnreadable: 0, unreadable: 0, raced: 0, rootNoGeneration: 0 } })
    await expect(assertNoDemoResidualProcesses(paths, macDeps([t], { ...at(READ_AT), birthtime: async () => BORN }).deps)).rejects.toThrow(/^3 processes of this account could not be checked/)
    // A Demo job among them is still found.
    const withJob: Tables = { ...t, before: [...busy, other(6400, { env: `HOME=${paths.home}`, start: LATER }), hiddenEnv(6401, { ppid: 6400 })] }
    expect(await sweepOf(withJob)).toMatchObject({ matched: 2, unknown: 3 })
  })

  it('a service in a private framework with launchd as its parent is clear, with no open-files look', async () => {
    const services = [
      hiddenEnv(530, { args: '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/SimRenderingServices --flag' }),
      hiddenEnv(531, { args: '/System/Library/PrivateFrameworks/X.framework/x' }),
    ]
    const { deps, calls } = macDeps([{ before: services }], { ...at(READ_AT), birthtime: async () => BORN })
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
    expect(calls.filter(isOpenFilesCall)).toEqual([])
    expect(calls).toHaveLength(5)
  })

  it('a public framework, a shell or a tool with launchd as its parent, and a private framework service of another parent, are left to the open-files look', async () => {
    const left = [
      hiddenEnv(540, { args: '/System/Library/Frameworks/Python.framework/Versions/3.9/bin/python3 -m http.server' }),
      hiddenEnv(541, { args: '/bin/bash' }),
      hiddenEnv(542, { args: '/usr/bin/perl -e 1' }),
      hiddenEnv(543, { args: '/System/Library/PrivateFrameworks/X.framework/x', ppid: SELF }),
    ]
    const { deps, calls } = macDeps([{ before: left }], { ...at(READ_AT), birthtime: async () => BORN })
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 4, why: { envHidden: 4 } })
    // The first look's open-files reads (rows still unknown are looked at again after it).
    expect(calls.slice(5, 7)).toEqual([OPEN_FILES_LSOF([540, 541, 542, 543]), OPEN_FILES_PS([540, 541, 542, 543])])
  })
})

describe('macOS: what a still-hidden row holds open', () => {
  const born = { birthtime: async () => BORN }
  /** An orphan of this account started after the generation, environment hidden, cwd outside the Demo. */
  const orphan = (pid = 430, extra: Partial<MacProc> = {}) => other(pid, { env: null, start: LATER, args: '/bin/bash', ...extra })
  const outsideFiles = ['/Users/a b', '/bin/bash', '/usr/lib/dyld', '/dev/null', '/Users/a b/run x.sh']
  const sweep = (t: Tables) => sweepDemoResidualProcesses(paths, macDeps([t], born).deps)

  it('an orphan holding only files outside the Demo, the same process before and after, is clear', async () => {
    const { deps, calls } = macDeps([{ before: [orphan()], files: { 430: outsideFiles } }], born)
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0, why: { envHidden: 0 } })
    expect(calls.slice(5)).toEqual([OPEN_FILES_LSOF([430]), OPEN_FILES_PS([430])])
    await expect(assertNoDemoResidualProcesses(paths, macDeps([{ before: [orphan()], files: { 430: outsideFiles } }], born).deps)).resolves.toBeUndefined()
  })

  it.each([
    ['a daemon stream', `${paths.daemon}-streams/x.jsonl`],
    ['a terminal socket by its real path', `/private${paths.terminals}/agent-gateway.sock`],
  ])('an orphan holding %s of the generation is the Demo, and blocks the reset', async (_name, file) => {
    const t: Tables = { before: [orphan()], files: { 430: [...outsideFiles, file] } }
    expect(await sweep(t)).toMatchObject({ complete: true, matched: 1, unknown: 0 })
    await expect(assertNoDemoResidualProcesses(paths, macDeps([t], born).deps)).rejects.toThrow(/^1 process started in the Demo is still running/)
  })

  it('an orphan lsof does not list stays unknown', async () => {
    expect(await sweep({ before: [orphan()], files: {} })).toMatchObject({ complete: true, unknown: 1, why: { envHidden: 1 } })
    // Listed with no file names proves nothing either.
    expect(await sweep({ before: [orphan()], files: { 430: [] } })).toMatchObject({ complete: true, unknown: 1, why: { envHidden: 1 } })
    // An unreadable cwd row is resolved the same way.
    expect(await sweep({ before: [orphan(431, { env: 'TERM=x', cwd: null })], files: {} })).toMatchObject({ complete: true, unknown: 1, why: { cwdUnreadable: 1 } })
    expect(await sweep({ before: [orphan(431, { env: 'TERM=x', cwd: null })], files: { 431: outsideFiles } })).toMatchObject({ complete: true, unknown: 0 })
  })

  it('an orphan lsof read only partly stays unknown, unless what it did read is in the Demo', async () => {
    const noFd: FileEntry[] = [...outsideFiles, ['NOFD']]
    expect(await sweep({ before: [orphan()], files: { 430: noFd } })).toMatchObject({ complete: true, matched: 0, unknown: 1, why: { envHidden: 1 } })
    // NOFD with its error text as the name.
    expect(await sweep({ before: [orphan()], files: { 430: [...outsideFiles, ['NOFD', '/proc/430/fd (opendir: Permission denied)']] } })).toMatchObject({ unknown: 1, why: { envHidden: 1 } })
    // A name that is lsof error text, with every other name outside the Demo.
    expect(await sweep({ before: [orphan()], files: { 430: ['(readlink: Permission denied)', '/bin/bash', '/dev/null'] } })).toMatchObject({ complete: true, matched: 0, unknown: 1, why: { envHidden: 1 } })
    expect(await sweep({ before: [orphan()], files: { 430: [['txt', '(stat: Permission denied)']] } })).toMatchObject({ unknown: 1, why: { envHidden: 1 } })
    // A Demo file listed beside the NOFD entry is the Demo.
    const t: Tables = { before: [orphan()], files: { 430: [...noFd, `${paths.daemon}-streams/x.jsonl`] } }
    expect(await sweep(t)).toMatchObject({ complete: true, matched: 1, unknown: 0 })
    await expect(assertNoDemoResidualProcesses(paths, macDeps([t], born).deps)).rejects.toThrow(/^1 process started in the Demo is still running/)
    // A full read of the same names is still clear.
    expect(await sweep({ before: [orphan()], files: { 430: outsideFiles } })).toMatchObject({ complete: true, matched: 0, unknown: 0 })
  })

  it('a pid the follow-up ps shows with another start (reused) or not at all stays unknown', async () => {
    for (const filesAfter of [[orphan(430, { start: LATEST })], [], [orphan(431)]]) {
      expect(await sweep({ before: [orphan()], files: { 430: outsideFiles }, filesAfter })).toMatchObject({ complete: true, unknown: 1, why: { envHidden: 1 } })
      expect(await sweep({ before: [orphan()], files: { 430: [`${paths.home}/x`] }, filesAfter })).toMatchObject({ complete: true, matched: 0, unknown: 1 })
    }
  })

  it('lsof or ps exiting 1 for a pid gone still decides the ones they did list', async () => {
    // lsof lists 430 only (exit 1 for 432); ps shows 430 and 433 only (exit 1 for 432).
    const t: Tables = { before: [orphan(430), orphan(432), orphan(433)], files: { 430: outsideFiles, 433: [`${paths.home}/x`] }, filesAfter: [orphan(430), orphan(433)] }
    const { deps, calls } = macDeps([t], born)
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 1, unknown: 1, why: { envHidden: 1 } })
    expect(calls.slice(5)).toEqual([OPEN_FILES_LSOF([430, 432, 433]), OPEN_FILES_PS([430, 432, 433])])
  })

  it.each([
    ['lsof cannot run', { filesLsof: null }],
    ['lsof exits 2', { filesLsof: { code: 2, stdout: 'p430\nfcwd\nn/Users/a b\n' } }],
    ['ps cannot run', { filesPs: null }],
    ['ps exits 2', { filesPs: { code: 2, stdout: '' } }],
    ['ps prints garbage', { filesPs: { code: 0, stdout: 'garbage\n' } }],
  ] as Array<[string, Partial<Tables>]>)('%s: the row stays unknown, and the look is still complete', async (_name, fault) => {
    const { deps, calls } = macDeps([{ before: [orphan()], files: { 430: outsideFiles }, ...fault }], born)
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 1, why: { envHidden: 1 } })
    // A failed lsof is not followed by the ps.
    expect(calls.slice(5, 'filesLsof' in fault ? 6 : 7)).toEqual('filesLsof' in fault ? [OPEN_FILES_LSOF([430])] : [OPEN_FILES_LSOF([430]), OPEN_FILES_PS([430])])
  })

  it('rows the earlier rules decided are not asked about', async () => {
    const decided = [other(440), other(441, { env: `HOME=${paths.home}` }), orphan(442, { start: START })]
    const { deps, calls } = macDeps([{ before: [...decided, orphan()], files: { 430: outsideFiles } }], born)
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 1, unknown: 0 })
    expect(calls.filter(isOpenFilesCall)).toEqual([OPEN_FILES_LSOF([430])])
  })
})

describe('macOS: races read again in the same attempt', () => {
  /** In the first and last table with one start, in the env table with another: alive at the end. */
  const race = (pid: number) => ({ before: [other(pid)], env: [other(pid, { start: LATER })] })
  const attemptsOf = (calls: Array<[string, string[]]>) => calls.filter(([file]) => file === '/bin/launchctl').length

  it('a raced pid alive at the end is read again by pid and resolved in the same attempt', async () => {
    const { deps, calls } = macDeps([race(730)])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
    expect(attemptsOf(calls)).toBe(1)
    expect(calls.slice(5).map(([file, args]) => [file, args.slice(args.indexOf('-p'), args.indexOf('-p') + 2)])).toEqual([
      ['/bin/ps', ['-p', '730']], ['/bin/ps', ['-p', '730']], ['/usr/sbin/lsof', ['-p', '730']], ['/bin/ps', ['-p', '730']],
    ])
    // The same pid holding Demo env now is found.
    const demo: Tables = { ...race(731), again: { before: [other(731, { env: `HOME=${paths.home}` })] } }
    expect(await sweepDemoResidualProcesses(paths, macDeps([demo]).deps)).toMatchObject({ complete: true, matched: 1 })
  })

  it('a raced pid gone by the re-read stays raced', async () => {
    const { deps } = macDeps([{ ...race(732), again: { before: [] } }])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, unknown: 1, why: { raced: 1 } })
  })

  it('a re-read whose ps exits 1 with no rows (every pid gone) counts them raced, not incomplete', async () => {
    // Every by-pid re-read (ps and lsof) answers as the real ones do when no pid it was given is left.
    const reReadExits1 = (attempts: Tables[], stdout = '') => {
      const base = macDeps(attempts)
      const run: ResidualDeps['run'] = async (file, args, t) => args.includes('-p') && !isOpenFilesCall([file, args]) ? { code: 1, stdout } : base.deps.run(file, args, t)
      return { ...base.deps, run }
    }
    const late: Tables = { before: [], after: [other(740)] }
    expect(await sweepDemoResidualProcesses(paths, reReadExits1([late]))).toMatchObject({ complete: true, unknown: 1, why: { raced: 1 } })
    // The next attempt, with the pid gone from the account table too, passes.
    expect(await sweepDemoResidualProcesses(paths, reReadExits1([late, { before: [] }]))).toMatchObject({ complete: true, unknown: 0 })
    // An exit 1 whose output is no table is still incomplete.
    expect(await sweepDemoResidualProcesses(paths, reReadExits1([late], 'garbage\n'))).toMatchObject({ complete: false })
  })

  it('the sweep reads again at most 6 times while a race lasts', async () => {
    const { deps, calls } = macDeps([{ before: [], after: [other(750)], again: { before: [] } }])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, unknown: 1, why: { raced: 1 } })
    expect(attemptsOf(calls)).toBe(6)
    // A race that ends on the 6th attempt still passes.
    const ends = macDeps([...Array(5).fill({ before: [], after: [other(750)], again: { before: [] } }), { before: [] }])
    expect(await sweepDemoResidualProcesses(paths, ends.deps)).toMatchObject({ complete: true, unknown: 0 })
    expect(attemptsOf(ends.calls)).toBe(6)
  })

  it('a row it could not judge is looked at again too: a short-lived program gone by the next look passes', async () => {
    // A shell of the account that macOS shows no environment for, born after the Demo, there for one look only.
    const once = macDeps([{ before: [other(760, { env: null, start: LATER })] }, { before: [] }])
    expect(await sweepDemoResidualProcesses(paths, once.deps)).toMatchObject({ complete: true, unknown: 0 })
    expect(attemptsOf(once.calls)).toBe(2)
    const stays = macDeps([{ before: [other(760, { env: null, start: LATER })] }])
    expect(await sweepDemoResidualProcesses(paths, stays.deps)).toMatchObject({ complete: true, unknown: 1, why: { envHidden: 1 } })
    expect(attemptsOf(stays.calls)).toBe(6)
  })
})

describe('macOS: a busy Mac still lets a reset clear its old homes', () => {
  // 2026-11-10 review: every `walnut demo reset` on a Mac with anything else running printed "Kept for
  // now: a background process could not be checked", and old homes piled up (4 after 4 resets). Each
  // look saw short-lived programs of the account (a hook's shell, a `cat`) born after the env read and
  // gone before the re-read; each counted as unknown, and the next look had new ones. These tables
  // repeat on every look, as on a busy Mac; the sweep must still answer clean in ONE look.
  const attemptsOf = (calls: Array<[string, string[]]>) => calls.filter(([file]) => file === '/bin/launchctl').length
  const gone = { before: [] as MacProc[] }

  it('a short-lived child of a shell whose environment ps printed is that shell\'s, so the look is clean', async () => {
    const shell = other(800)
    const child = other(801, { ppid: 800, start: LATER })
    const { deps, calls } = macDeps([{ before: [shell], after: [shell, child], again: gone }])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
    expect(attemptsOf(calls)).toBe(1)
  })

  it('a chain under a zombie, and under a script only its open files cleared, resolves to the readable ancestor', async () => {
    const shell = other(810)
    const zombie = other(811, { ppid: 810, stat: 'Z', start: LATER })
    const underZombie = other(812, { ppid: 811, start: LATEST })
    const underThat = other(813, { ppid: 812, start: LATEST })
    // A script macOS shows no environment for, whose open files lsof reads in full, none in the Demo.
    const script = other(820, { env: null, start: LATER })
    const underScript = other(821, { ppid: 820, start: LATEST })
    const t: Tables = {
      before: [shell, zombie, script], after: [shell, zombie, script, underZombie, underThat, underScript], again: gone,
      files: { 820: ['/Users/a b', '/usr/lib/dyld'] },
    }
    const { deps, calls } = macDeps([t])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
    expect(attemptsOf(calls)).toBe(1)
  })

  it('never on a guess: a gone child of a Demo process is the Demo, and one with no parent to judge stays unknown', async () => {
    const demo = other(830, { env: `HOME=${paths.home}` })
    const demoChild = other(831, { ppid: 830, start: LATER })
    expect(await sweepDemoResidualProcesses(paths, macDeps([{ before: [demo], after: [demo, demoChild], again: gone }]).deps))
      .toMatchObject({ complete: true, matched: 2 })
    // Its parent already gone (re-parented to launchd): nothing vouches for it, so the look keeps reading.
    const orphan = other(840, { ppid: 1, start: LATER })
    expect(await sweepDemoResidualProcesses(paths, macDeps([{ before: [], after: [orphan], again: gone }]).deps))
      .toMatchObject({ complete: true, unknown: 1, why: { raced: 1 } })
    // Under a script whose open files lsof could not read in full: still unknown.
    const script = other(850, { env: null, start: LATER })
    const child = other(851, { ppid: 850, start: LATEST })
    const partial: Tables = { before: [script], after: [script, child], again: gone, files: { 850: [['NOFD']] } }
    expect(await sweepDemoResidualProcesses(paths, macDeps([partial]).deps)).toMatchObject({ complete: true, unknown: 2 })
  })
})

// --- Linux: fake /proc ----------------------------------------------------------------

interface LinuxProc {
  pid: number
  uid?: number
  states?: string[]
  starts?: string[]
  environ?: string | Error
  cwd?: string | Error
  tasks?: number
  /** hidepid: stat and status refused, the /proc dir owned by this uid. */
  hiddenOwner?: number
}

function linuxDeps(rounds: LinuxProc[][], over: Partial<ResidualDeps> = {}) {
  const reads: string[] = []
  let listing = 0
  const statCount = new Map<number, number>()
  const find = (pid: number) => {
    for (let i = Math.min(listing - 1, rounds.length - 1); i >= 0; i--) {
      const hit = rounds[i]!.find(p => p.pid === pid)
      if (hit) return hit
    }
    return undefined
  }
  const selfProc: LinuxProc = { pid: SELF, environ: `HOME=${paths.home}\0`, cwd: '/' }
  const deps: ResidualDeps = {
    platform: 'linux', uid: UID, selfPid: SELF, now: () => 0, sleep: async () => {}, after: () => never(),
    run: async () => { throw new Error('no programs on Linux') },
    readdir: async dir => {
      if (dir === '/proc') {
        const round = rounds[Math.min(listing++, rounds.length - 1)]!
        return ['self', 'net', String(SELF), ...round.map(p => String(p.pid))]
      }
      const m = /^\/proc\/(\d+)\/task$/.exec(dir)
      const p = m && find(Number(m[1]))
      if (!p) throw enoent(dir)
      return Array.from({ length: p.tasks ?? 1 }, (_, i) => String(i + 1))
    },
    readFile: async file => {
      reads.push(file)
      if (file === '/proc/sys/kernel/random/boot_id') return 'boot-1\n'
      const m = /^\/proc\/(\d+)\/(stat|status|environ)$/.exec(file)
      if (!m) throw enoent(file)
      const pid = Number(m[1])
      const p = pid === SELF ? selfProc : find(pid)
      if (!p) throw enoent(file)
      if (p.hiddenOwner !== undefined && m[2] !== 'environ') throw errno('EACCES')
      if (m[2] === 'stat') {
        const i = statCount.get(pid) ?? 0
        statCount.set(pid, i + 1)
        const starts = p.starts ?? ['111']
        const start = starts[Math.min(i, starts.length - 1)]!
        if (start === 'gone') throw enoent(file)
        const states = p.states ?? ['S']
        return `${pid} (a (b) c) ${states[Math.min(i, states.length - 1)]} ${Array(18).fill('0').join(' ')} ${start} 0 0`
      }
      if (m[2] === 'status') return `Name:\ta\nUid:\t${p.uid ?? UID}\t${p.uid ?? UID}\t${p.uid ?? UID}\t${p.uid ?? UID}\n`
      if (p.environ instanceof Error) throw p.environ
      return p.environ ?? 'HOME=/home/a\0PATH=/bin\0'
    },
    readlink: async file => {
      const p = find(Number(/^\/proc\/(\d+)\/cwd$/.exec(file)?.[1]))
      if (!p) throw enoent(file)
      if (p.cwd instanceof Error) throw p.cwd
      return p.cwd ?? '/home/a'
    },
    ownerUid: async file => {
      const p = find(Number(/^\/proc\/(\d+)$/.exec(file)?.[1]))
      if (!p) throw enoent(file)
      return p.hiddenOwner ?? p.uid ?? UID
    },
    realpath: async p => { if (p === '/tmp' || p === '/') return p; throw enoent(p) },
    ...over,
  }
  return { deps, reads }
}

describe('Linux sweep', () => {
  it('passes with unrelated processes and counts each Demo tie once', async () => {
    expect(await sweepDemoResidualProcesses(paths, linuxDeps([[{ pid: 10 }, { pid: 11 }]]).deps))
      .toMatchObject({ supported: true, complete: true, matched: 0, unknown: 0 })
    const { deps } = linuxDeps([[
      { pid: 20, environ: `PATH=/bin\0HOME=${paths.home}\0` },
      { pid: 21, environ: `HOME=/home/a\0WALNUT_DEMO_ROOT=${ROOT}\0`, cwd: `${paths.home}/x` },
      { pid: 22, cwd: `${paths.data} (deleted)` },
      { pid: 23, cwd: `${paths.home}-old` },
    ]])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 3, unknown: 0 })
  })

  it('a kept older generation sharing the root never blocks; the root alone stays unknown', async () => {
    const { deps } = linuxDeps([[
      { pid: 24, environ: `WALNUT_DEMO_ROOT=${ROOT}\u0000WALNUT_DEMO_GENERATION=gen-2\u0000`, cwd: `${ROOT}/task-dirs/gen-2/t` },
      { pid: 25, environ: `WALNUT_DEMO_ROOT=${ROOT}\u0000WALNUT_DEMO_GENERATION=gen-1\u0000` },
      { pid: 26, environ: `WALNUT_DEMO_ROOT=${ROOT}\u0000` },
    ]])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 1, unknown: 1, why: { rootNoGeneration: 1 } })
  })

  it('never reads the environment of another uid', async () => {
    const { deps, reads } = linuxDeps([[{ pid: 30, uid: 0, environ: errno('EACCES') }, { pid: 31, uid: 1002, environ: `HOME=${paths.home}\0` }]])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
    expect(reads.filter(r => /\/proc\/3[01]\/environ/.test(r))).toEqual([])
  })

  it('under hidepid another account is skipped by the /proc dir owner, and one of ours still counts', async () => {
    const { deps, reads } = linuxDeps([[{ pid: 32, hiddenOwner: 0 }, { pid: 33, hiddenOwner: UID }]])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, unknown: 1, why: { unreadable: 1 } })
    expect(reads.filter(r => /environ/.test(r) && !r.includes(String(SELF)))).toEqual([])
  })

  it.each(['EACCES', 'EPERM', 'EIO'])('an own process whose environment fails with %s is unknown', async code => {
    const { deps } = linuxDeps([[{ pid: 40, environ: errno(code) }]])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, unknown: 1, why: { unreadable: 1 } })
  })

  it('an empty environment holds no Demo variable; an unreadable cwd is unknown', async () => {
    const { deps } = linuxDeps([[{ pid: 41, environ: '' }, { pid: 42, cwd: errno('EACCES') }, { pid: 43, environ: '', cwd: paths.home }]])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ matched: 1, unknown: 1 })
  })

  it('a process that exited while read (ENOENT, then gone) never blocks', async () => {
    const { deps } = linuxDeps([[{ pid: 50, environ: enoent('environ'), starts: ['111', 'gone'] }, { pid: 51, starts: ['gone'] }]])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
  })

  it('a pid reused between the two stat reads is read again, not taken for gone', async () => {
    // A new start on each of the two reads of every one of the 6 attempts.
    const lasting = linuxDeps([[{ pid: 60, starts: Array.from({ length: 12 }, (_, i) => String(111 * (i + 1))) }]]).deps
    expect(await sweepDemoResidualProcesses(paths, lasting)).toMatchObject({ complete: true, unknown: 1, why: { raced: 1 } })
    const settles = linuxDeps([[{ pid: 61, starts: ['111', '222', '222'] }]]).deps
    expect(await sweepDemoResidualProcesses(paths, settles)).toMatchObject({ complete: true, matched: 0, unknown: 0 })
  })

  it('a zombie never blocks, but a zombie leader with live threads is unknown', async () => {
    const { deps } = linuxDeps([[{ pid: 70, states: ['Z'], environ: `HOME=${paths.home}\0` }, { pid: 71, states: ['Z'], tasks: 3 }]])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 0, unknown: 1 })
  })

  it('a Demo process that exits while read is read again; a child forked after the listing is found', async () => {
    const { deps } = linuxDeps([
      [{ pid: 80, environ: `HOME=${paths.home}\0`, starts: ['111', 'gone'] }],
      [{ pid: 81, environ: `HOME=${paths.home}\0` }],
    ])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 1 })
  })

  it('a double fork whose parent exited before it was read is found in the next listing', async () => {
    const { deps } = linuxDeps([[{ pid: 90, starts: ['gone'] }], [{ pid: 91, cwd: `${ROOT}/task-dirs/gen-1/t` }]])
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: true, matched: 1, unknown: 0 })
  })

  it('an unreadable /proc, a missing caller or a changed boot is incomplete', async () => {
    const noProc = linuxDeps([[]], { readdir: async () => { throw errno('EACCES') } }).deps
    expect(await sweepDemoResidualProcesses(paths, noProc)).toMatchObject({ complete: false })
    const noSelf = linuxDeps([[]], { readdir: async () => ['10'] }).deps
    expect(await sweepDemoResidualProcesses(paths, noSelf)).toMatchObject({ complete: false })
    let boots = 0
    const base = linuxDeps([[{ pid: 10 }]]).deps
    const reboot = { ...base, readFile: async (f: string) => f.endsWith('boot_id') ? `boot-${boots++}` : base.readFile(f) }
    expect(await sweepDemoResidualProcesses(paths, reboot)).toMatchObject({ complete: false })
  })

  it.each(['readdir', 'readFile', 'readlink', 'realpath'] as const)('a %s that never answers ends the look as incomplete', async name => {
    const deps = linuxDeps([[{ pid: 10 }]], { [name]: () => never(), after: async () => {} } as Partial<ResidualDeps>).deps
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ complete: false })
    await expect(assertNoDemoResidualProcesses(paths, deps)).rejects.toThrow(/could not read this account's processes/)
  })
})

describe('unsupported systems', () => {
  it.each([['win32', UID], ['freebsd', UID], ['darwin', null]] as const)('%s (uid %s) clears nothing', async (platform, uid) => {
    const deps = { ...macDeps([{ before: [] }]).deps, platform: platform as NodeJS.Platform, uid }
    expect(await sweepDemoResidualProcesses(paths, deps)).toMatchObject({ supported: false })
    await expect(assertNoDemoResidualProcesses(paths, deps)).rejects.toThrow(/cannot check for Demo processes on this system/)
  })
})

describe('source guards', () => {
  const src = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../../src/commands', file), 'utf8')

  it('every function in demo-home.ts that removes anything runs the sweep first', () => {
    const fns = src('demo-home.ts').split(/\n(?=export (?:async )?function |(?:async )?function )/)
    const removal = /\b(?:fs\.rm|fs\.rmdir|fs\.unlink|rmSync|unlinkSync|rmdirSync|removeDemoTerminalDir)\(/
    const removers = fns.filter(fn => removal.test(fn))
    expect(removers.map(fn => /function (\w+)/.exec(fn)?.[1])).toEqual(['clearDemoHome'])
    for (const fn of removers) {
      const sweep = fn.indexOf('await assertNoDemoResidualProcesses(paths)')
      expect(sweep).toBeGreaterThan(0)
      expect(fn.search(removal)).toBeGreaterThan(sweep)
    }
  })

  it('the sweep never signals, runs a shell, logs or passes on the caller env', () => {
    const text = src('demo-residual-processes.ts').replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const unsafe = /\bkill\s*\(|\bspawn\b|\bexecSync\b|(?<![\w.])exec\s*\(|shell\s*:|console\.|\blog\.\w+\s*\(|process\.env/
    for (const allowed of ['PS_ROW.exec(line)', '/Uid/.exec(text)', 'server.log']) expect(allowed).not.toMatch(unsafe)
    for (const denied of ['exec(command)', 'spawn(command)', 'process.kill(pid)', 'log.info(message)', 'console.log(message)', 'env: process.env', 'shell: true']) expect(denied).toMatch(unsafe)
    expect(text).not.toMatch(unsafe)
    expect([...text.matchAll(/deps\.run\('([^']+)'/g)].map(m => m[1])).toEqual(['/bin/ps', '/usr/sbin/lsof', '/bin/launchctl', '/usr/sbin/lsof', '/bin/ps'])
  })
})
