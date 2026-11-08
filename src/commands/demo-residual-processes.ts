// Before Demo reset removes anything: a read-only look for live processes of this account still tied to the generation (detached jobs leave every session and terminal record).
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { DemoPaths } from './demo-home.js'
import { cwdInDemo, lstartMs, parseLaunchctlList, parseLsofCwd, parseLsofFiles, parsePs, psEnvVerdict, environVerdict,
  type LaunchdList, type OpenFiles, type PsRow, type Targets } from './demo-residual-parse.js'

export { cwdInDemo, environVerdict, lstartMs, parseLaunchctlList, parseLsofCwd, parseLsofFiles, parsePs, psEnvVerdict } from './demo-residual-parse.js'
export type { EnvVerdict, LaunchdList, OpenFiles, PsRow, Targets } from './demo-residual-parse.js'

/** `pid` is the probe's own process, which its own table lists. */
export interface RunResult { code: number; stdout: string; pid?: number }

export interface ResidualDeps {
  platform: NodeJS.Platform
  uid: number | null
  selfPid: number
  now(): number
  sleep(ms: number): Promise<void>
  /** Resolves when the whole look must give up. */
  after(ms: number): Promise<void>
  /** No shell; null when the program could not run, timed out or overflowed its buffer. */
  run(file: string, args: string[], timeoutMs: number): Promise<RunResult | null>
  readdir(dir: string): Promise<string[]>
  readFile(file: string): Promise<string>
  readlink(file: string): Promise<string>
  realpath(file: string): Promise<string>
  ownerUid(file: string): Promise<number>
  /** Birth time in ms; null when the file system does not keep one or the stat fails. */
  birthtime?(file: string): Promise<number | null>
}

/** Counts only: why each unknown process could not be cleared. */
export interface UnknownWhy { envHidden: number; cwdUnreadable: number; unreadable: number; raced: number; rootNoGeneration: number }

/** Why a look ended without reading the whole table: each keeps the data, since nothing about the processes is known. */
export type IncompleteWhy = 'targets' | 'paths' | 'table' | 'reread' | 'proc' | 'boot' | 'deadline'

export interface ResidualReport {
  supported: boolean; complete: boolean; matched: number; unknown: number; why: UnknownWhy
  /** Set when `complete` is false on a supported system. */
  incomplete?: IncompleteWhy
}

// At load 170 to 210 one account-wide `lsof -d cwd` took 11 s and a whole look 10 to 25 s (2026-11-11), so a 10 s cap per
// read and 20 s per look ended every reset there as "could not be checked". A look returns at its first clean answer (a
// second or two on a quiet machine); these bound only how long a slow machine may take before the data is kept.
const DEADLINE_MS = 90_000
const RUN_TIMEOUT_MS = 45_000
const ATTEMPTS = 6

export function defaultResidualDeps(): ResidualDeps {
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    selfPid: process.pid,
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    after: ms => new Promise(resolve => { setTimeout(resolve, ms).unref() }),
    run: (file, args, timeoutMs) => new Promise(resolve => {
      const child = execFile(file, args, {
        timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC' },
      }, (error, stdout) => {
        if (!error) { resolve({ code: 0, stdout, pid: child.pid }); return }
        const code = (error as { code?: unknown }).code
        resolve(typeof code === 'number' && !(error as { killed?: boolean }).killed ? { code, stdout, pid: child.pid } : null)
      })
    }),
    readdir: dir => fs.readdir(dir),
    readFile: file => fs.readFile(file, 'utf8'),
    readlink: file => fs.readlink(file),
    realpath: file => fs.realpath(file),
    ownerUid: async file => (await fs.lstat(file)).uid,
    birthtime: async file => {
      try {
        const ms = (await fs.stat(file)).birthtimeMs
        return Number.isFinite(ms) && ms > 0 ? ms : null
      } catch { return null }
    },
  }
}

const errCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const gone = (error: unknown) => errCode(error) === 'ENOENT' || errCode(error) === 'ESRCH'

/** Each dir as named and through the real path of its nearest existing ancestor (/tmp is /private/tmp on macOS). */
async function spellings(dir: string, deps: ResidualDeps): Promise<string[]> {
  const out = new Set([dir])
  let head = dir
  const tail: string[] = []
  for (;;) {
    try { out.add(path.posix.join(await deps.realpath(head), ...tail)); break }
    catch (error) {
      if (errCode(error) !== 'ENOENT' && errCode(error) !== 'ENOTDIR') throw error
      const parent = path.posix.dirname(head)
      if (parent === head) break
      tail.unshift(path.posix.basename(head))
      head = parent
    }
  }
  return [...out]
}

async function demoTargets(paths: DemoPaths, deps: ResidualDeps): Promise<Targets> {
  const dirs: string[] = []
  for (const dir of [paths.home, paths.data, paths.daemon, `${paths.daemon}-streams`, path.posix.join(paths.root, 'task-dirs', path.posix.basename(paths.home)), paths.terminals]) {
    dirs.push(...await spellings(dir, deps))
  }
  const born = deps.platform === 'darwin' && deps.birthtime ? await deps.birthtime(paths.home).catch(() => null) : null
  return {
    env: [['HOME', paths.home], ['CLAUDE_CONFIG_DIR', path.posix.join(paths.home, '.claude')]],
    demo: { root: paths.root, generation: path.posix.basename(paths.home) }, dirs,
    ...(typeof born === 'number' && born > 0 ? { bornAtMs: born } : {}),
  }
}

/**
 * A hidden row lsof could read, the same process before and after (start time): matched when it holds a file in the
 * generation's dirs, clear when a full read shows none, since removing those dirs then takes nothing from under it; else undecided.
 */
export function openFilesVerdict(files: OpenFiles | undefined, before: PsRow | undefined, after: PsRow | undefined, dirs: string[]): DarwinVerdict | undefined {
  if (!files || !before || !after || before.start !== after.start) return undefined
  if (files.names.some(name => cwdInDemo(name, dirs))) return 'matched'
  return files.partial || !files.names.length ? undefined : 'clear'
}

type Attempt = { complete: boolean; matched: number; why: UnknownWhy; incomplete?: IncompleteWhy }
const none = (): UnknownWhy => ({ envHidden: 0, cwdUnreadable: 0, unreadable: 0, raced: 0, rootNoGeneration: 0 })
const INCOMPLETE = (incomplete: IncompleteWhy): Attempt => ({ complete: false, matched: 0, why: none(), incomplete })

/** Bytes ps and lsof print as they are under LC_ALL=C; any other path could be escaped, so it is not matched by guess. */
const PLAIN = /^[\x20-\x5b\x5d-\x7e]*$/

/**
 * `goneUnread`: a pid the look could not read before it exited (born after the env read, or with no cwd yet). Judged by its
 * ancestors like a hidden row; one nothing resolves counts as `raced`.
 */
export type DarwinVerdict = 'matched' | 'clear' | 'pending' | 'raced' | 'envHidden' | 'cwdUnreadable' | 'rootNoGeneration' | 'goneUnread'

/** One pid across ps (a), ps -E (e), lsof (cwd) and a last ps (z); a pid alive at the end must be identified, never assumed by its parent. */
export function darwinRow(a: PsRow | undefined, e: PsRow | undefined, z: PsRow | undefined, cwd: string | undefined, targets: Targets): DarwinVerdict {
  const demoCwd = cwd !== undefined && cwdInDemo(cwd, targets.dirs)
  if (!z) {
    // Gone by the last read: what it forked before the env read is in a later table, so only a Demo one is read again.
    if (!e) return 'clear'
    const prefix = a && a.start === e.start && e.text.startsWith(a.text) ? a.text.length : 0
    return demoCwd || psEnvVerdict(e.text.slice(prefix), targets) !== 'none' ? 'raced' : 'clear'
  }
  if (z.stat.includes('Z')) return 'clear'
  if (a && e && a.start === z.start && e.start !== z.start) return 'raced'
  if (!e || e.start !== z.start) return 'pending'
  const base = [a, z].filter((r): r is PsRow => !!r && r.start === e.start && e.text.startsWith(r.text)).sort((x, y) => y.text.length - x.text.length)[0]
  if (!base) return 'raced'
  const envText = e.text.slice(base.text.length)
  const env = psEnvVerdict(envText, targets)
  if (demoCwd || env === 'match') return 'matched'
  if (cwd === undefined) return 'pending'
  if (env === 'ambiguous') return 'rootNoGeneration'
  // macOS gives no environment of system programs to their own user, and ps prints that like an empty one.
  return envText.length ? 'clear' : 'envHidden'
}

/** One -o per blank-headed column (tests/scripts/ps-one-column-per-flag-ratchet.test.ts says why). */
const PS_COLUMNS = ['-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'args=']

async function darwinTables(deps: ResidualDeps, select: string[], left: () => number, needSelf: boolean) {
  const table = async (env: boolean) => {
    if (left() <= 0) return null
    const r = await deps.run('/bin/ps', [...(env ? ['-E'] : []), '-ww', ...select, ...PS_COLUMNS], Math.min(RUN_TIMEOUT_MS, left()))
    // A re-read by pid exits 1 when every pid is gone: an empty table, so each counts as raced (data kept), never a full look.
    const rows = r && (r.code === 0 || !needSelf && r.code === 1) ? parsePs(r.stdout) : null
    if (!rows || needSelf && !rows.has(deps.selfPid)) return null
    // The probe itself, and only that execution's pid.
    if (r!.pid) rows.delete(r!.pid)
    return rows
  }
  const before = await table(false)
  const withEnv = before && await table(true)
  if (!before || !withEnv || left() <= 0) return null
  const lsofSelect = select[0] === '-u' ? ['-u', select[1]!] : ['-p', select[1]!]
  const lsof = await deps.run('/usr/sbin/lsof', ['-w', '-a', ...lsofSelect, '-d', 'cwd', '-F', 'pn'], Math.min(RUN_TIMEOUT_MS, left()))
  const cwds = lsof && (lsof.code === 0 || lsof.code === 1) ? parseLsofCwd(lsof.stdout) : null
  if (!cwds || needSelf && !cwds.has(deps.selfPid)) return null
  // Only the account-wide look resolves hidden rows; a failed list clears nothing and leaves the look complete.
  let launchd: LaunchdList = { pids: new Set(), readAtMs: deps.now() }
  if (needSelf && left() > 0) {
    const readAtMs = deps.now()
    const list = await deps.run('/bin/launchctl', ['list'], Math.min(RUN_TIMEOUT_MS, left()))
    if (list && list.code === 0) launchd = { pids: parseLaunchctlList(list.stdout), readAtMs }
  }
  const after = await table(false)
  return after && { before, withEnv, cwds, after, launchd }
}

const MAX_HOPS = 64
const SYSTEM_SERVICE = /^\/(?:System\/\S*\.xpc\/Contents\/MacOS\/|System\/Library\/PrivateFrameworks\/|Library\/Developer\/PrivateFrameworks\/)/
const hidden = (v: DarwinVerdict | undefined) => v === 'envHidden' || v === 'cwdUnreadable'
/** Rows an ancestor may decide: the hidden ones, and a pid gone before it was read. */
const lendable = (v: DarwinVerdict | undefined) => hidden(v) || v === 'goneUnread'

/** A process only launchd starts: a job it listed, started a second or more before the list was read (so the listed pid is this process, not a reused one), or a system service. */
function launchdJob(pid: number, row: PsRow, launchd?: LaunchdList): boolean {
  if (row.ppid !== 1) return false
  if (launchd?.pids.has(pid) && lstartMs(row.start) + 1000 <= launchd.readAtMs) return true
  // An XPC service of the system, or a service in a private framework (the simulator's).
  return SYSTEM_SERVICE.test(row.text.trimStart())
}

/**
 * An envHidden or cwdUnreadable row, judged by its start time and its ancestors in the last table; unresolved keeps its verdict.
 * A process started before the generation's HOME existed cannot carry its environment (a later move into a Demo dir is the cwd check's).
 */
export function resolveHidden(pid: number, verdicts: Map<number, DarwinVerdict>, readable: Set<number>, after: Map<number, PsRow>, bornAtMs?: number, launchd?: LaunchdList): DarwinVerdict {
  const verdict = verdicts.get(pid)!
  const born = bornAtMs === undefined ? NaN : Math.floor(bornAtMs / 1000) * 1000
  const predates = (row: PsRow) => lstartMs(row.start) < born
  let row = after.get(pid)
  if (!row) return verdict
  if (predates(row)) return 'clear'
  if (launchdJob(pid, row, launchd)) return 'clear'
  for (let hop = 0; hop < MAX_HOPS && row.ppid > 1; hop++) {
    const parent = after.get(row.ppid)
    const parentVerdict = verdicts.get(row.ppid)
    // A parent younger than its child is a reused pid, not the parent.
    if (!parent || !parentVerdict || !(lstartMs(parent.start) <= lstartMs(row.start))) break
    if (parentVerdict === 'matched') return 'matched'
    if (parentVerdict === 'clear' && readable.has(row.ppid)) return 'clear'
    // A gone pid a launchd job started (a periodic agent's short command, born after HOME once a Demo has sat a while, so
    // `predates` no longer lends; 2026-11-11 review: an idle Demo's reset kept its data on one, look after look). Its
    // environment is the job's, which the rule above clears as launchd's, and gone it holds no folder. A live child is never lent this.
    if (hop === 0 && verdict === 'goneUnread' && (hidden(parentVerdict) || parentVerdict === 'clear') && launchdJob(row.ppid, parent, launchd)) return 'clear'
    // A parent cleared some other way (a zombie, its own ancestors) lends only what its own ancestors lend.
    if (!lendable(parentVerdict) && parentVerdict !== 'clear') break
    if (predates(parent)) return 'clear'
    row = parent
  }
  return verdict
}

async function darwinAttempt(targets: Targets, deps: ResidualDeps, uid: number, left: () => number): Promise<Attempt> {
  if (![...targets.dirs, ...targets.env.map(([, v]) => v), targets.demo.root].every(p => PLAIN.test(p))) return INCOMPLETE('paths')
  const t = await darwinTables(deps, ['-u', String(uid)], left, true)
  if (!t) return INCOMPLETE(left() <= 0 ? 'deadline' : 'table')
  const verdicts = new Map<number, DarwinVerdict>()
  // Cleared by an environment ps printed, the only clear an ancestor lends its children.
  const readable = new Set<number>()
  const judge = (pid: number, verdict: DarwinVerdict, z: PsRow | undefined) => {
    verdicts.set(pid, verdict)
    if (verdict === 'clear' && z && !z.stat.includes('Z')) readable.add(pid)
  }
  const pending: number[] = []
  for (const pid of new Set([...t.before.keys(), ...t.withEnv.keys(), ...t.after.keys()])) {
    if (pid <= 1 || pid === deps.selfPid) continue
    const z = t.after.get(pid)
    const verdict = darwinRow(t.before.get(pid), t.withEnv.get(pid), z, t.cwds.get(pid), targets)
    // A pid alive at the end that changed between the reads (a fork that then exec'd) is read again too.
    if (verdict === 'pending' || verdict === 'raced' && z) pending.push(pid)
    judge(pid, verdict, z)
  }
  if (pending.length) {
    // Born after the env read, no cwd yet, or changed between reads: read those pids again, matched to the last table by start time.
    const again = await darwinTables(deps, ['-p', pending.join(',')], left, false)
    if (!again) return INCOMPLETE(left() <= 0 ? 'deadline' : 'reread')
    for (const pid of pending) {
      const z = t.after.get(pid)!
      const z2 = again.after.get(pid)
      // Exited before it was read. On a Mac with anything else running, every look sees a few such short-lived programs
      // (a hook's shell, a `cat`), so counting each as unknown kept every Demo home forever (2026-11-10 review: 4 homes
      // after 4 resets). Its parent in the last table decides it, as for a hidden row; with none that does, it stays raced.
      if (!z2 || z2.start !== z.start) { judge(pid, 'goneUnread', undefined); continue }
      const verdict = darwinRow(again.before.get(pid), again.withEnv.get(pid), z2, again.cwds.get(pid), targets)
      if (verdict !== 'pending') judge(pid, verdict, z2)
      else judge(pid, again.withEnv.get(pid)?.start === z.start ? 'cwdUnreadable' : 'raced', undefined)
    }
  }
  const final = new Map<number, DarwinVerdict>()
  for (const [pid, first] of verdicts) {
    final.set(pid, lendable(first) ? resolveHidden(pid, verdicts, readable, t.after, targets.bornAtMs, t.launchd) : first)
  }
  const still = [...final].filter(([, v]) => hidden(v)).map(([pid]) => pid)
  if (still.length && left() > 0) {
    // Only for rows nothing else decided: what they hold open, then the same pids again, so a reused pid lends nothing.
    const lsof = await deps.run('/usr/sbin/lsof', ['-w', '-p', still.join(','), '-F', 'pfn'], Math.min(RUN_TIMEOUT_MS, left()))
    const files = lsof && (lsof.code === 0 || lsof.code === 1) ? parseLsofFiles(lsof.stdout) : null
    const ps = files && left() > 0 ? await deps.run('/bin/ps', ['-ww', '-p', still.join(','), ...PS_COLUMNS], Math.min(RUN_TIMEOUT_MS, left())) : null
    const rows = ps && (ps.code === 0 || ps.code === 1) ? parsePs(ps.stdout) : null
    if (files && rows) {
      const cleared = new Set(readable)
      for (const pid of still) {
        const verdict = openFilesVerdict(files.get(pid), t.after.get(pid), rows.get(pid), targets.dirs)
        if (verdict) final.set(pid, verdict)
        if (verdict === 'clear') cleared.add(pid)
      }
      // A gone pid whose parent only its open files cleared (a script macOS hides the environment of) is that parent's.
      for (const [pid, v] of final) if (v === 'goneUnread') final.set(pid, resolveHidden(pid, final, cleared, t.after, targets.bornAtMs, t.launchd))
    }
  }
  const out: Attempt = { complete: true, matched: 0, why: none() }
  for (const verdict of final.values()) {
    if (verdict === 'matched') out.matched++
    else if (verdict !== 'clear' && verdict !== 'pending') out.why[verdict === 'goneUnread' ? 'raced' : verdict]++
  }
  return out
}

type ProcStat = { state: string; start: string } | 'gone' | 'denied' | 'unknown'

async function procStat(pid: number, deps: ResidualDeps): Promise<ProcStat> {
  try {
    const stat = await deps.readFile(`/proc/${pid}/stat`)
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return /^\S$/.test(fields[0] ?? '') && /^\d+$/.test(fields[19] ?? '') ? { state: fields[0]!, start: fields[19]! } : 'unknown'
  } catch (error) {
    return gone(error) ? 'gone' : errCode(error) === 'EACCES' || errCode(error) === 'EPERM' ? 'denied' : 'unknown'
  }
}

/** Real or effective uid from status; when hidepid refuses it, the /proc dir's owner (an own non-dumpable process then reads as root's). */
async function procOwner(pid: number, deps: ResidualDeps, uid: number): Promise<'ours' | 'other' | 'gone' | 'unknown'> {
  try {
    const ids = /^Uid:\s+(\d+)\s+(\d+)/m.exec(await deps.readFile(`/proc/${pid}/status`))
    if (!ids) return 'unknown'
    return Number(ids[1]) === uid || Number(ids[2]) === uid ? 'ours' : 'other'
  } catch (error) {
    if (gone(error)) return 'gone'
    if (errCode(error) !== 'EACCES' && errCode(error) !== 'EPERM') return 'unknown'
  }
  try { return await deps.ownerUid(`/proc/${pid}`) === uid ? 'ours' : 'other' }
  catch (error) { return gone(error) ? 'gone' : 'unknown' }
}

type LinuxVerdict = 'skip' | 'match' | 'clear' | 'unreadable' | 'raced' | 'rootNoGeneration'

async function linuxRow(pid: number, targets: Targets, deps: ResidualDeps, uid: number): Promise<LinuxVerdict> {
  const first = await procStat(pid, deps)
  if (first === 'gone') return 'skip'
  const owner = await procOwner(pid, deps, uid)
  if (owner === 'gone' || owner === 'other') return 'skip'
  if (owner === 'unknown' || typeof first === 'string') return 'unreadable'
  if (first.state === 'Z' || first.state === 'X') {
    // A zombie leader may still have live threads running with the same environment.
    const tasks = await deps.readdir(`/proc/${pid}/task`).catch(error => gone(error) ? [] : null)
    return tasks && tasks.length <= 1 ? 'skip' : 'unreadable'
  }
  const environ = await deps.readFile(`/proc/${pid}/environ`).catch(() => null)
  const cwd = await deps.readlink(`/proc/${pid}/cwd`).catch(() => null)
  const env = environ === null ? 'none' : environVerdict(environ, targets)
  const looksDemo = env === 'match' || cwd !== null && cwdInDemo(cwd, targets.dirs)
  const second = await procStat(pid, deps)
  // Exited while read: a Demo one may have forked on its way out, so the look runs again.
  if (second === 'gone') return looksDemo || env === 'ambiguous' ? 'raced' : 'skip'
  if (typeof second === 'string') return 'unreadable'
  if (second.start !== first.start) return 'raced'
  if (looksDemo) return 'match'
  if (second.state === 'Z' || second.state === 'X') return 'skip'
  if (env === 'ambiguous') return 'rootNoGeneration'
  // An empty environ holds no Demo variable; a refused read proves nothing.
  return environ === null || cwd === null ? 'unreadable' : 'clear'
}

async function linuxAttempt(targets: Targets, deps: ResidualDeps, uid: number, left: () => number): Promise<Attempt> {
  const boot = async () => (await deps.readFile('/proc/sys/kernel/random/boot_id').catch(() => '')).trim()
  const bootBefore = await boot()
  const out: Attempt = { complete: true, matched: 0, why: none() }
  const seen = new Set<number>()
  // Listed again until no new pid: a child forked after one listing by a parent that then exited is in the next.
  for (let round = 0; ; round++) {
    if (left() <= 0) return INCOMPLETE('deadline')
    let names: string[]
    try { names = await deps.readdir('/proc') } catch { return INCOMPLETE('proc') }
    const fresh = names.filter(name => /^\d+$/.test(name)).map(Number).filter(pid => !seen.has(pid))
    if (round === 0 && !fresh.includes(deps.selfPid)) return INCOMPLETE('proc')
    if (!fresh.length) break
    for (const pid of fresh) {
      seen.add(pid)
      if (pid <= 1 || pid === deps.selfPid) continue
      if (left() <= 0) return INCOMPLETE('deadline')
      const row = await linuxRow(pid, targets, deps, uid)
      if (row === 'match') out.matched++
      else if (row === 'unreadable' || row === 'raced' || row === 'rootNoGeneration') out.why[row]++
    }
  }
  if (!bootBefore || await boot() !== bootBefore) return INCOMPLETE('boot')
  return out
}

const total = (why: UnknownWhy) => why.envHidden + why.cwdUnreadable + why.unreadable + why.raced + why.rootNoGeneration

/** `read` holds the last whole look, so a retry the deadline cuts short still reports what that look found. */
async function sweep(paths: DemoPaths, deps: ResidualDeps, uid: number, left: () => number, read: { last?: Attempt }): Promise<ResidualReport> {
  let targets: Targets
  try { targets = await demoTargets(paths, deps) } catch { return report(INCOMPLETE('targets')) }
  let last = INCOMPLETE('deadline')
  for (let i = 0; i < ATTEMPTS; i++) {
    last = deps.platform === 'linux' ? await linuxAttempt(targets, deps, uid, left) : await darwinAttempt(targets, deps, uid, left)
    if (!last.complete) return report(last.incomplete === 'deadline' && read.last ? read.last : last)
    read.last = last
    // A start time that moved during the look is read again, never taken for gone; so is a row it could not judge, which on
    // a busy machine is mostly a short-lived program of the account (a shell, ps) that is gone by the next look.
    if (last.matched || !total(last.why) || left() <= 250) break
    await deps.sleep(200)
  }
  return report(last)
}

const report = (a: Attempt): ResidualReport => ({
  supported: true, complete: a.complete, matched: a.matched, unknown: total(a.why), why: a.why, ...(a.complete ? {} : { incomplete: a.incomplete ?? 'deadline' }),
})

export async function sweepDemoResidualProcesses(paths: DemoPaths, deps: ResidualDeps = defaultResidualDeps()): Promise<ResidualReport> {
  const uid = deps.uid
  if (uid === null || deps.platform !== 'linux' && deps.platform !== 'darwin') return { supported: false, complete: false, matched: 0, unknown: 0, why: none() }
  const deadline = deps.now() + DEADLINE_MS
  const left = () => deadline - deps.now()
  // A read that never answers ends the look as incomplete; its late answer is ignored.
  const read: { last?: Attempt } = {}
  const timedOut = deps.after(DEADLINE_MS).then(() => report(read.last ?? INCOMPLETE('deadline')))
  return Promise.race([sweep(paths, deps, uid, left, read), timedOut])
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Throws, keeping every file, unless the look found no live process tied to this Demo generation. */
export async function assertNoDemoResidualProcesses(paths: DemoPaths, deps?: ResidualDeps): Promise<void> {
  assertResidualReportClean(await sweepDemoResidualProcesses(paths, deps))
}

/** The same verdict on a look already taken (a reset reads once, then acts on that one answer). */
export function assertResidualReportClean(report: ResidualReport): void {
  if (!report.supported) throw new Error('Demo reset cannot check for Demo processes on this system, so Demo data was kept.')
  if (!report.complete) throw new Error('Demo could not read this account\'s processes in time, so Demo data was kept. Run walnut demo reset again.')
  if (report.matched) {
    const one = report.matched === 1
    throw new Error(`${n(report.matched, 'process', 'processes')} started in the Demo ${one ? 'is' : 'are'} still running, such as a background job from a Demo session. Let ${one ? 'it' : 'them'} finish or close ${one ? 'it' : 'them'}, then run walnut demo reset again. Demo data was kept.`)
  }
  if (report.unknown) {
    throw new Error(`${n(report.unknown, 'process', 'processes')} of this account could not be checked for Demo use. Run walnut demo reset again in a moment. Demo data was kept.`)
  }
}
