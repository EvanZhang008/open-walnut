// Pure readers of the process tables the Demo residual look takes (ps, lsof, launchctl, /proc environ): text in, facts out.

/** `env` pairs match alone; the Demo root counts only with this generation, since a kept older generation shares it. */
export interface Targets {
  env: Array<[string, string]>; demo: { root: string; generation: string }; dirs: string[]
  /** macOS: when this generation's HOME dir was made. */
  bornAtMs?: number
}

export function cwdInDemo(cwd: string, dirs: string[]): boolean {
  const candidates = cwd.endsWith(' (deleted)') ? [cwd, cwd.slice(0, -' (deleted)'.length)] : [cwd]
  return candidates.some(c => dirs.some(d => c === d || c.startsWith(d + '/')))
}

/** match: this generation; ambiguous: the Demo root with no generation, which may be this one; none: anything else. */
export type EnvVerdict = 'match' | 'ambiguous' | 'none'

const sameDir = (value: string, dir: string) => value === dir || value === dir + '/'

/** Exact KEY=VALUE pairs of a NUL separated /proc environ; a trailing slash on a path value still counts. */
export function environVerdict(environ: string, targets: Pick<Targets, 'env' | 'demo'>): EnvVerdict {
  let root = false
  const generations: string[] = []
  for (const entry of environ.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq), value = entry.slice(eq + 1)
    if (targets.env.some(([k, v]) => k === key && sameDir(value, v))) return 'match'
    if (key === 'WALNUT_DEMO_ROOT' && sameDir(value, targets.demo.root)) root = true
    if (key === 'WALNUT_DEMO_GENERATION') generations.push(value)
  }
  if (!root) return 'none'
  if (generations.includes(targets.demo.generation)) return 'match'
  return generations.length ? 'none' : 'ambiguous'
}

/** ps -E prints the env after the args, space joined: a whole ` KEY=VALUE` then a space or the end (text holding it elsewhere over-matches, the safe way). */
export function psEnvVerdict(envText: string, targets: Pick<Targets, 'env' | 'demo'>): EnvVerdict {
  const text = ' ' + envText
  const has = (key: string, value: string) => {
    const needle = ` ${key}=${value}`
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
      const after = text[i + needle.length]
      if (after === undefined || after === ' ' || after === '\n') return true
    }
    return false
  }
  if (targets.env.some(([k, v]) => has(k, v) || has(k, v + '/'))) return 'match'
  if (!has('WALNUT_DEMO_ROOT', targets.demo.root) && !has('WALNUT_DEMO_ROOT', targets.demo.root + '/')) return 'none'
  if (has('WALNUT_DEMO_GENERATION', targets.demo.generation)) return 'match'
  return /(?:^| )WALNUT_DEMO_GENERATION=[A-Za-z0-9-]{1,64}(?= |\n|$)/.test(envText) ? 'none' : 'ambiguous'
}

export interface PsRow { ppid: number; stat: string; start: string; text: string }

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})(?: (.*))?$/

/** `ps -o pid= -o ppid= -o stat= -o lstart= -o args=` by pid; a line that is no row continues the last (an argv newline); null when unreadable. */
export function parsePs(stdout: string): Map<number, PsRow> | null {
  const rows = new Map<number, PsRow>()
  let last: PsRow | null = null
  for (const line of stdout.replace(/\n$/, '').split('\n')) {
    const m = PS_ROW.exec(line)
    if (m) {
      const pid = Number(m[1])
      if (rows.has(pid)) return null
      last = { ppid: Number(m[2]), stat: m[3]!, start: m[4]!, text: m[5] ?? '' }
      rows.set(pid, last)
    } else if (last) last.text += '\n' + line
    else if (line.trim()) return null
  }
  return rows
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A ps `lstart` printed under TZ=UTC and LC_ALL=C, to ms at second precision; NaN when it is not one. */
export function lstartMs(start: string): number {
  const m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) ([ \d]\d) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(start)
  const month = m ? MONTHS.indexOf(m[1]!) : -1
  if (!m || month < 0) return NaN
  return Date.UTC(Number(m[6]), month, Number(m[2]!.trim()), Number(m[3]), Number(m[4]), Number(m[5]))
}

/** `lsof -F pn -d cwd`: the cwd name of each process. */
export function parseLsofCwd(stdout: string): Map<number, string> {
  const cwd = new Map<number, string>()
  let pid: number | null = null
  for (const line of stdout.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null && !cwd.has(pid)) cwd.set(pid, line.slice(1))
  }
  return cwd
}

/** What lsof listed for one pid; `partial` when part of it could not be read, so the names may miss a Demo file. */
export interface OpenFiles { names: string[]; partial: boolean }

/**
 * `lsof -F pfn` of chosen pids (`p`, then an `f` before each `n`): the names each listed pid holds open; a pid lsof could
 * not read at all is absent. An `fNOFD` entry, or a name that is lsof's error text (`(readlink: ...)`), marks it partial.
 */
export function parseLsofFiles(stdout: string): Map<number, OpenFiles> {
  const files = new Map<number, OpenFiles>()
  let entry: OpenFiles | null = null
  let noFd = false
  for (const line of stdout.split('\n')) {
    if (/^p\d+$/.test(line)) { files.set(Number(line.slice(1)), entry = { names: [], partial: false }); noFd = false }
    else if (!entry) continue
    else if (line.startsWith('f')) { noFd = line === 'fNOFD'; if (noFd) entry.partial = true }
    else if (line.startsWith('n')) {
      if (noFd || line.startsWith('n(')) entry.partial = true
      else entry.names.push(line.slice(1))
    }
  }
  return files
}

/** launchd's own jobs: the PID column of `launchctl list` (a `-` is a job not running); a line of another shape is skipped. */
export function parseLaunchctlList(stdout: string): Set<number> {
  const pids = new Set<number>()
  for (const line of stdout.split('\n')) {
    const m = /^(\d+)\t\S+\t\S/.exec(line)
    if (m) pids.add(Number(m[1]))
  }
  return pids
}

/** The pids launchd listed, and the wall time just before the list was read. */
export interface LaunchdList { pids: Set<number>; readAtMs: number }
