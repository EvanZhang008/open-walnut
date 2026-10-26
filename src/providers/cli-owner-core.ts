/**
 * One CLI per session id on a host, whichever daemon asks (cli-owner-v1).
 *
 * A daemon only knows the sessions in its own registry. A second daemon on the
 * same host (an ephemeral test server's, a sandbox's, a restarted daemon that
 * could not adopt) knows nothing of them, and `claude --resume <sid>` there
 * starts a second process on the SAME transcript: 2026-10-25, an ephemeral
 * server's copied wait_until clock resumed a live session under its own daemon,
 * and two CLIs of one session edited one working tree for ten minutes.
 *
 * The owner record is the host-wide answer, one file per transcript:
 * `<dir>/<configKey>/<sid>.json`, beside the spawn journal (so under the HOME
 * whose ~/.claude the CLI writes, and relocated with it in tests). `configKey`
 * names the CLI config dir, because a sid is only the same conversation inside
 * one transcript store.
 *
 *   - **claim** before a spawn: an O_EXCL create, so of two daemons racing for
 *     one sid exactly one gets the file. A record that is already there is
 *     judged against the live process table, never trusted: its CLI pid alive
 *     with the same start time (a reused pid is a different process) is a live
 *     holder, and the start is refused; a claim still being spawned by a live
 *     daemon (under CLAIM_TTL_MS) is refused too; anything else is stale and is
 *     broken (rename aside, re-read, put back if it was not the one judged).
 *   - after winning the claim, the **process scan**: a live process naming the
 *     sid (`--resume`, `-r`, `--session-id`, not a fork) in this config dir is a
 *     holder the record does not know (a CLI an older daemon started, a lost
 *     record, a hand-run `claude --resume`), and the start is refused. A host
 *     whose process table cannot be read skips this step and says so.
 *   - **commit** writes the spawned pid and its start time; **release** gives a
 *     claim back when the spawn fails. A record whose CLI exits is not removed:
 *     the next claim finds the pid gone and breaks it; prune clears old ones.
 *   - **adopt** writes the record for a live CLI the daemon has proven its own
 *     some other way (registry adoption after a restart, a fork's init line),
 *     unless a different live CLI already holds it.
 *
 * Refusals never touch the holder: no signal, no FIFO, no adoption of a stranger.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createCliOwner;
 * daemon-source.ts inlines `createCliOwner.toString()` through
 * `__CREATE_CLI_OWNER__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

export interface CliOwnerRecord {
  v: 1
  sid: string
  state: 'claiming' | 'running'
  nonce: string
  at: number
  /** The daemon that claimed or adopted it. */
  daemon: { pid: number; startTime: string | null; instance: string; home?: string }
  cli?: { pid: number; startTime: string | null }
}

export interface CliOwnerHolder {
  /** live: a CLI runs it; starting: a daemon is spawning one now. */
  kind: 'live' | 'starting'
  pid: number
  /** The daemon instance the record names, when there is a record. */
  instance?: string
  /** The Walnut data dir the record names. */
  home?: string
  /** True when this daemon's own record names it. */
  self: boolean
  /** True when no record names it (found in the process table). */
  unrecorded?: boolean
}

export interface CliOwnerDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** Records root (beside the spawn journal). */
  dir: string
  /** The CLI config dir spawned CLIs write their transcripts into. */
  configDir: string
  platform: string
  self: { pid: number; startTime: string | null; instance: string }
  now: () => number
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** kill(pid, 0): true unless the pid is gone (EPERM counts as alive). */
  isAlive: (pid: number) => boolean
  startTimeOf: (pid: number) => Promise<string | null>
  /** Run a command; stdout or null when it could not run. */
  exec: (file: string, args: string[], timeoutMs: number) => Promise<string | null>
  nonce: () => string
}

export interface CliClaim {
  sid: string
  /** The spawn started: record its pid. */
  commit(pid: number, startTime: string | null): void
  /** The spawn did not happen: give the claim back. */
  release(): void
}

export interface CliOwner {
  /** The transcript id the args resume or start; null for a fork or an unnamed new session. */
  transcriptIdOf(args: readonly string[]): string | null
  /**
   * Claim a sid before spawning it. Throws an Error with code SESSION_LIVE and
   * `holder` when a CLI already runs it or another daemon is starting one.
   * `exceptPid`: the caller's own process the spawn replaces, from its registry
   * (it is stopped after the claim and before the spawn); its record is taken
   * over and its process group is left out of the scan. Records that cannot be
   * written leave the process table to decide alone.
   */
  claim(sid: string, opts?: { exceptPid?: number; home?: string }): Promise<CliClaim>
  /** Record a CLI this daemon has proven its own. `home`: the Walnut it runs for, when known. */
  adopt(sid: string, pid: number, startTime: string | null, home?: string): Promise<'written' | 'kept' | 'conflict'>
  /** The live holder of a sid, from its record and the process table, or null. */
  holderOf(sid: string, opts?: { exceptPid?: number }): Promise<CliOwnerHolder | null>
  /** Remove records whose process is gone. Returns how many went. */
  prune(): number
}

export function createCliOwner(deps: CliOwnerDeps): CliOwner {
  const { fs, path } = deps
  const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
  /** A daemon spawning a CLI holds a claim this long at most; a spawn takes seconds. */
  const CLAIM_TTL_MS = 120_000
  /** A record that does not parse is in the middle of being written for this long. */
  const TORN_GRACE_MS = 10_000
  const MAX_RECORD_BYTES = 16 * 1024
  const PS_TIMEOUT_MS = 8000
  const RESUME_FLAGS = ['--resume', '-r', '--session-id']

  function configKey(dir: string): string {
    // FNV-1a over the resolved path: a short stable directory name.
    let h = 0x811c9dc5
    const s = real(dir)
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return 'c' + h.toString(16).padStart(8, '0')
  }
  const recordsDir = path.join(deps.dir, configKey(deps.configDir))
  const fileOf = (sid: string) => path.join(recordsDir, sid + '.json')

  function transcriptIdOf(args: readonly string[]): string | null {
    if (!Array.isArray(args) || args.includes('--fork-session')) return null
    for (const flag of ['--session-id', '--resume']) {
      const i = args.indexOf(flag)
      const v = i >= 0 ? args[i + 1] : undefined
      if (typeof v === 'string' && SID_RE.test(v)) return v
    }
    return null
  }

  function refusal(sid: string, holder: CliOwnerHolder): Error {
    const who = holder.self ? 'this daemon'
      : holder.unrecorded ? 'a process no Walnut daemon recorded'
        : holder.home ? `the Walnut at ${holder.home}` : 'another Walnut daemon'
    const text = holder.kind === 'starting'
      ? `start: another daemon is starting this session now (${who}); not started twice`
      : `start: this session already has a running CLI (pid ${holder.pid}, started by ${who}); not started a second time. Send to it through its owner, or retry once it has ended`
    return Object.assign(new Error(text), { code: 'SESSION_LIVE', errorKind: 'session_live', holder, sid })
  }

  function readRecord(file: string): { rec: CliOwnerRecord | null; raw: string | null; mtimeMs: number } {
    let raw: string
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(file).mtimeMs
      raw = fs.readFileSync(file, 'utf8')
    } catch { return { rec: null, raw: null, mtimeMs } }
    if (raw.length > MAX_RECORD_BYTES) return { rec: null, raw, mtimeMs }
    try {
      const rec = JSON.parse(raw) as CliOwnerRecord
      if (rec?.v !== 1 || typeof rec.sid !== 'string' || typeof rec.nonce !== 'string' || !rec.daemon
        || !Number.isSafeInteger(rec.daemon.pid)) return { rec: null, raw, mtimeMs }
      return { rec, raw, mtimeMs }
    } catch { return { rec: null, raw, mtimeMs } }
  }

  /** Same process: alive, and the same start time when both readings exist. */
  async function sameProcess(pid: number, startTime: string | null | undefined): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false
    if (!deps.isAlive(pid)) return false
    if (!startTime) return true
    const now = await deps.startTimeOf(pid)
    return !now || now === startTime
  }

  /** What a record proves: a live holder, or nothing (stale). */
  async function judge(rec: CliOwnerRecord): Promise<CliOwnerHolder | null> {
    const base = { instance: rec.daemon.instance, home: rec.daemon.home, self: rec.daemon.instance === deps.self.instance }
    if (rec.state === 'running' && rec.cli) {
      if (!await sameProcess(rec.cli.pid, rec.cli.startTime)) return null
      // No start time was recorded: a reused pid is told apart by what it runs.
      if (!rec.cli.startTime && deps.platform !== 'win32') {
        const argv = await deps.exec('ps', ['-ww', '-o', 'args=', '-p', String(rec.cli.pid)], PS_TIMEOUT_MS)
        if (argv !== null && argv.trim() && !namesSession(argv, rec.sid)) return null
      }
      return { kind: 'live', pid: rec.cli.pid, ...base }
    }
    if (rec.state === 'claiming') {
      if (deps.now() - rec.at > CLAIM_TTL_MS) return null
      return await sameProcess(rec.daemon.pid, rec.daemon.startTime) ? { kind: 'starting', pid: rec.daemon.pid, ...base } : null
    }
    return null
  }

  function tokens(line: string): string[] {
    return line.split(/\s+/).filter(Boolean)
  }

  /** argv (as ps prints it) resumes or starts `sid`, and is not a fork. */
  function namesSession(argv: string, sid: string): boolean {
    if (!argv.includes(sid)) return false
    const t = tokens(argv)
    if (t.includes('--fork-session')) return false
    // A CLI: named claude somewhere (a shim, a versioned binary), or run in print
    // mode as Walnut runs every one (`node …/cli.js -p`). Not a grep for the id.
    if (!t.some((x) => /claude/i.test(path.basename(x))) && !t.includes('-p') && !t.includes('--print')) return false
    for (let i = 0; i < t.length; i++) {
      if (RESUME_FLAGS.includes(t[i]) && t[i + 1] === sid) return true
      if (t[i] === `--resume=${sid}` || t[i] === `--session-id=${sid}`) return true
    }
    return false
  }

  /** The real path, so a symlinked ~/.claude is the same store. */
  function real(dir: string): string {
    try { return fs.realpathSync(dir) } catch { return path.resolve(dir) }
  }

  function configDirFromEnv(env: Record<string, string>): string | null {
    if (env.CLAUDE_CONFIG_DIR) return real(env.CLAUDE_CONFIG_DIR)
    if (env.HOME) return real(path.join(env.HOME, '.claude'))
    return null
  }

  /** The CLI config dir a live process writes into, or null when its env cannot be read. */
  async function configDirOf(pid: number): Promise<string | null> {
    if (deps.platform === 'linux') {
      try {
        const env: Record<string, string> = {}
        for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
          const eq = kv.indexOf('=')
          if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1)
        }
        return configDirFromEnv(env)
      } catch { return null }
    }
    // macOS: `ps -E` prints the env after the args; the args alone tell where it starts.
    const args = await deps.exec('ps', ['-ww', '-o', 'args=', '-p', String(pid)], PS_TIMEOUT_MS)
    const withEnv = await deps.exec('ps', ['-Eww', '-o', 'args=', '-p', String(pid)], PS_TIMEOUT_MS)
    if (!args || !withEnv) return null
    const a = args.replace(/\n+$/, '')
    const w = withEnv.replace(/\n+$/, '')
    if (!w.startsWith(a) || w.length === a.length) return null
    const env: Record<string, string> = {}
    for (const kv of tokens(w.slice(a.length))) {
      const eq = kv.indexOf('=')
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1)
    }
    return configDirFromEnv(env)
  }

  /**
   * Live CLIs that run `sid` in this config dir, from the process table, by
   * process group: a CLI is often a tree (a launcher shim, its node, the binary)
   * whose members all carry the sid, spawned detached so the group id is the
   * leader's pid. Groups in `except` are left out. Returns group ids; null when
   * the table could not be read (the caller says so and goes on).
   */
  async function scan(sid: string, except: Set<number>): Promise<number[] | null> {
    if (deps.platform === 'win32') return null
    const out = await deps.exec('ps', ['-A', '-ww', '-o', 'pid=,pgid=,args='], PS_TIMEOUT_MS)
    if (out === null) return null
    const mine = real(deps.configDir)
    const found: number[] = []
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (!m) continue
      const pid = Number(m[1])
      const group = Number(m[2]) > 1 ? Number(m[2]) : pid
      if (except.has(pid) || except.has(group) || found.includes(group) || !namesSession(m[3], sid)) continue
      const dir = await configDirOf(pid)
      // An env that cannot be read is not proof of another store: it counts.
      if (dir !== null && dir !== mine) continue
      if (deps.isAlive(pid)) found.push(group)
    }
    return found
  }

  function exceptSet(opts?: { exceptPid?: number }): Set<number> {
    const s = new Set<number>([deps.self.pid])
    if (opts?.exceptPid) s.add(opts.exceptPid)
    return s
  }

  /** Move a judged-stale record aside; put it back if it changed after it was judged. */
  function breakStale(file: string, judgedRaw: string | null): void {
    const aside = `${file}.stale-${deps.nonce()}`
    try { fs.renameSync(file, aside) } catch { return }
    let now: string | null = null
    try { now = fs.readFileSync(aside, 'utf8') } catch { /* gone */ }
    if (now !== judgedRaw) {
      // Someone wrote a fresh record between our read and our rename: give it back.
      try { fs.linkSync(aside, file) } catch (err) {
        deps.log('warn', 'cli owner: a fresh record was moved aside and could not be restored', { file, error: (err as Error).message })
      }
    }
    try { fs.unlinkSync(aside) } catch { /* gone */ }
  }

  function writeOwn(file: string, rec: CliOwnerRecord): void {
    const tmp = `${file}.${deps.nonce()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function makeRecord(sid: string, state: CliOwnerRecord['state'], home: string | undefined, cli?: CliOwnerRecord['cli']): CliOwnerRecord {
    return {
      v: 1, sid, state, nonce: deps.nonce(), at: deps.now(),
      daemon: { pid: deps.self.pid, startTime: deps.self.startTime, instance: deps.self.instance, ...(home ? { home } : {}) },
      ...(cli ? { cli } : {}),
    }
  }

  /** The records cannot be written (disk full, read-only): the process table alone decides. */
  async function scanOnlyClaim(sid: string, opts: { exceptPid?: number } | undefined, err: unknown): Promise<CliClaim> {
    deps.log('warn', 'cli owner: records unavailable; process table check only', { sid, error: (err as Error)?.message })
    const found = await scan(sid, exceptSet(opts))
    if (found && found.length > 0) throw refusal(sid, { kind: 'live', pid: found[0], self: false, unrecorded: true })
    return { sid, commit() {}, release() {} }
  }

  async function claim(sid: string, opts?: { exceptPid?: number; home?: string }): Promise<CliClaim> {
    if (!SID_RE.test(sid)) throw new Error('cli owner: bad session id')
    try { fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 }) } catch (err) { return scanOnlyClaim(sid, opts, err) }
    const file = fileOf(sid)
    for (let attempt = 0; attempt < 4; attempt++) {
      const mine = makeRecord(sid, 'claiming', opts?.home)
      let fd: number | null = null
      try {
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return scanOnlyClaim(sid, opts, err)
      }
      if (fd !== null) {
        try { fs.writeSync(fd, JSON.stringify(mine)) } catch (err) {
          try { fs.closeSync(fd) } catch { /* closed */ }
          try { fs.unlinkSync(file) } catch { /* gone */ }
          return scanOnlyClaim(sid, opts, err)
        }
        fs.closeSync(fd)
        const ours = () => readRecord(file).rec?.nonce === mine.nonce
        const release = () => { if (ours()) { try { fs.unlinkSync(file) } catch { /* gone */ } } }
        const found = await scan(sid, exceptSet(opts))
        if (found === null) deps.log('warn', 'cli owner: process table unreadable; record check only', { sid })
        else if (found.length > 0) {
          release()
          throw refusal(sid, { kind: 'live', pid: found[0], self: false, unrecorded: true })
        }
        // A breaker that misjudged our claim moved it aside while we scanned. It
        // puts a record it should not have moved back, so look again, take ours
        // back out, and claim afresh.
        if (!ours()) {
          await new Promise((r) => setTimeout(r, 100))
          release()
          continue
        }
        return {
          sid,
          commit(pid: number, startTime: string | null) {
            try { writeOwn(file, makeRecord(sid, 'running', opts?.home, { pid, startTime })) } catch (err) {
              deps.log('warn', 'cli owner: could not record the spawned CLI', { sid, pid, error: (err as Error).message })
            }
          },
          release,
        }
      }
      const { rec, raw, mtimeMs } = readRecord(file)
      if (!rec) {
        // Unreadable: being written this instant (the O_EXCL create precedes its
        // write), or junk once it has stayed unreadable past the grace.
        if (raw !== null && deps.now() - mtimeMs > TORN_GRACE_MS) breakStale(file, raw)
        else await new Promise((r) => setTimeout(r, 50))
        continue
      }
      // The process the spawn replaces (the caller's own, from its registry, stopped
      // before the spawn): take its record over, whichever instance wrote it.
      if (opts?.exceptPid && rec.state === 'running' && rec.cli?.pid === opts.exceptPid) {
        breakStale(file, raw)
        continue
      }
      const holder = await judge(rec)
      if (holder) throw refusal(sid, holder)
      deps.log('info', 'cli owner: breaking a stale record', { sid, state: rec.state, pid: rec.cli?.pid ?? rec.daemon.pid, instance: rec.daemon.instance })
      breakStale(file, raw)
    }
    throw refusal(sid, { kind: 'starting', pid: 0, self: false })
  }

  async function adopt(sid: string, pid: number, startTime: string | null, home?: string): Promise<'written' | 'kept' | 'conflict'> {
    if (!SID_RE.test(sid) || !Number.isSafeInteger(pid) || pid <= 1) return 'kept'
    try {
      fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 })
      const file = fileOf(sid)
      const { rec, raw } = readRecord(file)
      if (rec && rec.state === 'running' && rec.cli?.pid === pid && rec.daemon.instance === deps.self.instance) return 'kept'
      if (rec && !(rec.state === 'running' && rec.cli?.pid === pid)) {
        const holder = await judge(rec)
        if (holder && holder.pid !== pid) {
          deps.log('error', 'cli owner: another live CLI holds this session; not adopting its record', { sid, pid, holderPid: holder.pid, holderInstance: holder.instance })
          return 'conflict'
        }
      }
      if (raw !== null && !rec) breakStale(file, raw)
      writeOwn(file, makeRecord(sid, 'running', home ?? rec?.daemon.home, { pid, startTime }))
      return 'written'
    } catch (err) {
      deps.log('warn', 'cli owner: could not record an adopted CLI', { sid, pid, error: (err as Error).message })
      return 'kept'
    }
  }

  async function holderOf(sid: string, opts?: { exceptPid?: number }): Promise<CliOwnerHolder | null> {
    if (!SID_RE.test(sid)) return null
    const { rec } = readRecord(fileOf(sid))
    if (rec) {
      const holder = await judge(rec)
      if (holder && holder.pid !== opts?.exceptPid) return holder
    }
    const found = await scan(sid, exceptSet(opts))
    return found && found.length > 0 ? { kind: 'live', pid: found[0], self: false, unrecorded: true } : null
  }

  function prune(): number {
    let names: string[]
    try { names = fs.readdirSync(recordsDir) } catch { return 0 }
    let removed = 0
    for (const name of names) {
      const file = path.join(recordsDir, name)
      if (name.includes('.stale-') || name.endsWith('.tmp')) {
        try { if (deps.now() - fs.statSync(file).mtimeMs > CLAIM_TTL_MS) { fs.unlinkSync(file); removed++ } } catch { /* gone */ }
        continue
      }
      if (!name.endsWith('.json')) continue
      const { rec, raw, mtimeMs } = readRecord(file)
      const dead = rec
        ? rec.state === 'running' ? !rec.cli || !deps.isAlive(rec.cli.pid)
          : deps.now() - rec.at > CLAIM_TTL_MS || !deps.isAlive(rec.daemon.pid)
        : deps.now() - mtimeMs > TORN_GRACE_MS
      if (dead) { breakStale(file, raw); removed++ }
    }
    return removed
  }

  return { transcriptIdOf, claim, adopt, holderOf, prune }
}
