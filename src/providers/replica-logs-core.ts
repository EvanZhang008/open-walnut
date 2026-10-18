/**
 * `logs.tail` (cap 'replica-logs-v1', docs/plan/walnut-replica-servers-impl.md WP14):
 * the Mac reads the lines a host replica and this daemon's journal wrote ON the
 * host, because presence changes, forwards and journal appends happen there
 * (`scripts/walnut-logs.sh replica --host <alias>`).
 *
 *   logs.tail {home, sources: ['replica', 'journal', 'stdout'], n, match?}
 *
 * What it reads, and nothing else (never a path from the request):
 *   - 'replica': the structured log files (`open-walnut-YYYY-MM-DD.log`) in the
 *     run dir of the server this daemon runs for `home` (the spec's and its
 *     fallback's WALNUT_DAEMON_DIR, host-server-core.ts logsOf);
 *   - 'stdout': that server's stdout log (the spec's `log`) and its `.1`;
 *   - 'journal': this daemon's own log files (`daemon-d-<pid>-<hex>.log` in its
 *     dir), only lines whose message starts with "journal" and whose `home` is
 *     `home`. A line that names no Walnut is never returned.
 * The twins check the caller first: a trusted leader socket whose leader.configure
 * named `home`. Another Walnut's logs are never readable, and a follower, a
 * bridge or a lane is refused.
 * Bounds: at most MAX_LINES lines per source, the newest; at most MAX_FILE_BYTES
 * read from the end of each file and MAX_FILES files per source; a line over
 * MAX_LINE_CHARS is cut. Regular files only (a symlink is skipped).
 *
 * How the daemon twins get it: daemon-standalone.ts imports createReplicaLogs;
 * daemon-source.ts inlines its `toString()` through `__CREATE_REPLICA_LOGS__`.
 * So the factory body references NOTHING at module scope.
 */

export type ReplicaLogSource = 'replica' | 'journal' | 'stdout'

export interface ReplicaLogLine {
  source: ReplicaLogSource
  file: string
  line: string
}

export interface ReplicaLogsDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** This daemon's dir (its own logs). */
  daemonDir: string
  /** Where the server this daemon runs for `home` logs (host-server-core.ts logsOf). */
  logsOf: (home: string) => { stdout: string; dirs: string[] } | null
}

export type ReplicaLogsAnswer =
  | { ok: true; lines: ReplicaLogLine[]; files: string[]; truncated: boolean; running: boolean }
  | { ok: false; message: string; code: 'bad_request' }

export function createReplicaLogs(deps: ReplicaLogsDeps) {
  const { fs, path } = deps
  const SOURCES = ['replica', 'journal', 'stdout']
  const DEFAULT_LINES = 200
  const MAX_LINES = 2000
  const MAX_FILES = 3
  const MAX_FILE_BYTES = 1024 * 1024
  const MAX_LINE_CHARS = 8 * 1024
  const MAX_MATCH = 20
  const MAX_MATCH_CHARS = 80
  const REPLICA_FILE = /^open-walnut-\d{4}-\d{2}-\d{2}\.log$/
  const DAEMON_FILE = /^daemon-d-\d+-[0-9a-f]+\.log$/

  /** The last bytes of a regular file, split in lines (the first, maybe partial, is dropped). */
  function tailOf(file: string): { lines: string[]; cut: boolean } | null {
    let fd: number | undefined
    try {
      const st = fs.lstatSync(file)
      if (!st.isFile()) return null
      const len = Math.min(st.size, MAX_FILE_BYTES)
      if (len === 0) return { lines: [], cut: false }
      const buf = Buffer.alloc(len)
      fd = fs.openSync(file, 'r')
      const got = fs.readSync(fd, buf, 0, len, st.size - len)
      let text = buf.subarray(0, got).toString('utf8')
      const cut = st.size > len
      if (cut) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1) }
      const lines = text.split('\n').filter((l) => l.length > 0)
      return { lines: lines.map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l)), cut }
    } catch {
      return null
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* closed */ } }
    }
  }

  /** The newest MAX_FILES names in `dir` matching `re`, oldest first (by mtime, then name). */
  function newest(dir: string, re: RegExp): string[] {
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { return [] }
    const rows: Array<{ name: string; at: number }> = []
    for (const name of names) {
      if (!re.test(name)) continue
      try { rows.push({ name, at: fs.lstatSync(path.join(dir, name)).mtimeMs }) } catch { /* gone */ }
    }
    rows.sort((a, b) => (a.at - b.at) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return rows.slice(-MAX_FILES).map((r) => path.join(dir, r.name))
  }

  function messageOf(line: string): { msg: string; home: unknown } | null {
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      const msg = typeof o.msg === 'string' ? o.msg : typeof o.message === 'string' ? o.message : ''
      return { msg, home: o.home }
    } catch { return null }
  }

  function tail(home: unknown, rawSources: unknown, rawN: unknown, rawMatch?: unknown): ReplicaLogsAnswer {
    if (typeof home !== 'string' || !home) return { ok: false, message: 'missing home', code: 'bad_request' }
    const asked = Array.isArray(rawSources) ? rawSources : ['replica', 'journal']
    const sources: ReplicaLogSource[] = []
    for (const s of asked) {
      if (typeof s !== 'string' || SOURCES.indexOf(s) === -1) return { ok: false, message: 'unknown source ' + String(s), code: 'bad_request' }
      if (sources.indexOf(s as ReplicaLogSource) === -1) sources.push(s as ReplicaLogSource)
    }
    const n = typeof rawN === 'number' && Number.isFinite(rawN) && rawN > 0 ? Math.min(MAX_LINES, Math.floor(rawN)) : DEFAULT_LINES
    let match: string[] = []
    if (rawMatch !== undefined) {
      if (!Array.isArray(rawMatch) || rawMatch.length > MAX_MATCH) return { ok: false, message: 'match: at most ' + MAX_MATCH + ' strings', code: 'bad_request' }
      for (const m of rawMatch) {
        if (typeof m !== 'string' || !m || m.length > MAX_MATCH_CHARS) return { ok: false, message: 'match: each a string of 1 to ' + MAX_MATCH_CHARS + ' characters', code: 'bad_request' }
      }
      match = rawMatch as string[]
    }
    const where = deps.logsOf(home)
    const lines: ReplicaLogLine[] = []
    const files: string[] = []
    let truncated = false
    const wanted = (msg: string): boolean => match.length === 0 || match.some((m) => msg.indexOf(m) !== -1)
    for (const source of sources) {
      const picked: Array<{ file: string; line: string }> = []
      const read = (file: string, accept: (line: string) => boolean): void => {
        const t = tailOf(file)
        if (!t) return
        if (t.cut) truncated = true
        files.push(file)
        for (const line of t.lines) if (accept(line)) picked.push({ file, line })
      }
      if (source === 'replica' && where) {
        for (const dir of where.dirs) for (const file of newest(dir, REPLICA_FILE)) {
          read(file, (line) => { const m = messageOf(line); return !!m && wanted(m.msg) })
        }
      } else if (source === 'stdout' && where) {
        for (const file of [`${where.stdout}.1`, where.stdout]) read(file, (line) => wanted(line))
      } else if (source === 'journal') {
        for (const file of newest(deps.daemonDir, DAEMON_FILE)) {
          read(file, (line) => { const m = messageOf(line); return !!m && m.home === home && m.msg.indexOf('journal') === 0 && wanted(m.msg) })
        }
      }
      const rows = picked.slice(-n)
      if (rows.length < picked.length) truncated = true
      for (const r of rows) lines.push({ source, file: path.basename(r.file), line: r.line })
    }
    return { ok: true, lines, files: files.map((f) => path.basename(f)), truncated, running: !!where }
  }

  return { tail, SOURCES, MAX_LINES }
}

export type ReplicaLogs = ReturnType<typeof createReplicaLogs>
