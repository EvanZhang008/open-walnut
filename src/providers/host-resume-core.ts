/**
 * Host resume: how a daemon wakes a stopped session of its own host without a
 * Walnut server (docs/plan/walnut-trigger.md, "Delivered on the host").
 *
 * The idle reaper stops a quiet CLI after two hours, so a trigger that fires
 * overnight almost always finds its session stopped. The server resumes it
 * (`start --resume`) when it claims the fire; while it is away the fire used to
 * wait for it (2026-10-09: one fire waited six hours on a host). The daemon
 * spawned that CLI and can spawn it again, with the same command:
 *   - a **resume record** per session, `<dir>/<sid>.json` (mode 0600, beside the
 *     trigger state, so a reboot keeps it): the last spawn's argv, cwd and
 *     permission mode, written at every spawn and again when the session ends or
 *     its mode changes. The in-memory record has the same and wins while the
 *     daemon that spawned it runs; this file covers a daemon restart or a reboot.
 *     Kept 30 days, at most 300 (the oldest go first).
 *   - **resumeArgs**: that argv turned into a resume of the same conversation,
 *     the way the server builds one: `--resume <sid>`, no `--session-id` and no
 *     `--fork-session` (the CLI refuses `--session-id` with `--resume` unless it
 *     forks), the permission mode the session has now, and the bypass
 *     capability without the bare flag that would select bypass on its own.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createHostResume;
 * daemon-source.ts inlines `createHostResume.toString()` through
 * `__CREATE_HOST_RESUME__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

export interface ResumeRecord {
  v: 1
  sid: string
  args: string[]
  cwd: string
  /** Walnut's mode id (bypass, plan, accept, default, auto, dontAsk). */
  mode?: string
  /** The Walnut data dir and task the spawn was for, when the server said. */
  home?: string
  task?: string
  at: number
}

export interface HostResumeDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** Directory for <sid>.json. */
  dir: string
  now: () => number
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** Walnut mode id → `claude --permission-mode` value (MODE_CLI). */
  modeCli: Readonly<Record<string, string>>
}

export interface HostResume {
  /** Keep (or refresh) a session's resume record. Never throws. */
  remember(sid: string, rec: { args: string[]; cwd: string; mode?: string; home?: string; task?: string }): void
  /** A session's resume record, or null when there is none or it does not read back whole. */
  recall(sid: string): ResumeRecord | null
  /** Drop records past their age and over the count. Returns how many went. */
  prune(): number
  /** The argv that resumes `sid` in `mode`, built from the last spawn's argv. */
  resumeArgs(args: readonly string[], sid: string, mode?: string): string[]
}

export function createHostResume(deps: HostResumeDeps): HostResume {
  const { fs, path, dir } = deps
  const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
  const MAX_RECORD_BYTES = 512 * 1024
  const TTL_MS = 30 * 24 * 60 * 60 * 1000
  const MAX_RECORDS = 300
  /** A prune runs on the first write and then every this many writes. */
  const PRUNE_EVERY = 25
  let writesSincePrune = PRUNE_EVERY

  function fileOf(sid: string): string {
    return path.join(dir, sid + '.json')
  }

  function stringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')
  }

  function remember(sid: string, rec: { args: string[]; cwd: string; mode?: string; home?: string; task?: string }): void {
    if (!SID_RE.test(sid) || !stringArray(rec.args) || typeof rec.cwd !== 'string' || !rec.cwd) return
    const body: ResumeRecord = {
      v: 1,
      sid,
      args: rec.args.slice(),
      cwd: rec.cwd,
      ...(typeof rec.mode === 'string' && rec.mode ? { mode: rec.mode } : {}),
      ...(typeof rec.home === 'string' && rec.home ? { home: rec.home } : {}),
      ...(typeof rec.task === 'string' && rec.task ? { task: rec.task } : {}),
      at: deps.now(),
    }
    const text = JSON.stringify(body)
    if (text.length > MAX_RECORD_BYTES) {
      deps.log('warn', 'host resume: spawn command too large to keep', { sid, bytes: text.length })
      return
    }
    const file = fileOf(sid)
    const tmp = file + '.tmp'
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, text, { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (err) {
      try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
      deps.log('warn', 'host resume: could not keep the spawn command', { sid, error: (err as Error).message })
      return
    }
    writesSincePrune += 1
    if (writesSincePrune >= PRUNE_EVERY) { writesSincePrune = 0; prune() }
  }

  function recall(sid: string): ResumeRecord | null {
    if (!SID_RE.test(sid)) return null
    let raw: string
    try { raw = fs.readFileSync(fileOf(sid), 'utf8') } catch { return null }
    try {
      const rec = JSON.parse(raw) as Partial<ResumeRecord>
      if (rec?.v !== 1 || rec.sid !== sid || !stringArray(rec.args) || typeof rec.cwd !== 'string' || !rec.cwd) return null
      if (typeof rec.at !== 'number' || deps.now() - rec.at > TTL_MS) return null
      return rec as ResumeRecord
    } catch {
      return null
    }
  }

  function prune(): number {
    let names: string[]
    try { names = fs.readdirSync(dir) } catch { return 0 }
    const now = deps.now()
    const kept: Array<{ name: string; at: number }> = []
    let removed = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      let at = 0
      try { at = fs.statSync(path.join(dir, name)).mtimeMs } catch { continue }
      if (now - at > TTL_MS) {
        try { fs.unlinkSync(path.join(dir, name)); removed++ } catch { /* gone already */ }
      } else {
        kept.push({ name, at })
      }
    }
    if (kept.length > MAX_RECORDS) {
      kept.sort((a, b) => a.at - b.at)
      for (const { name } of kept.slice(0, kept.length - MAX_RECORDS)) {
        try { fs.unlinkSync(path.join(dir, name)); removed++ } catch { /* gone already */ }
      }
    }
    return removed
  }

  /** Remove `flag` and, when it takes one, its value; every occurrence. */
  function drop(args: string[], flag: string, takesValue: boolean): void {
    for (let i = args.indexOf(flag); i >= 0; i = args.indexOf(flag)) args.splice(i, takesValue ? 2 : 1)
  }

  function setValue(args: string[], flag: string, value: string): void {
    const i = args.indexOf(flag)
    if (i >= 0 && i + 1 < args.length) args[i + 1] = value
    else {
      if (i >= 0) args.splice(i, 1)
      args.push(flag, value)
    }
  }

  function resumeArgs(source: readonly string[], sid: string, mode?: string): string[] {
    const args = source.slice()
    drop(args, '--session-id', true)
    drop(args, '--fork-session', false)
    // Bypass CAPABILITY only. The bare --dangerously-skip-permissions also
    // SELECTS bypass and outranks --permission-mode, so keeping it would resume
    // a plan/accept/default session in full-trust bypass.
    drop(args, '--dangerously-skip-permissions', false)
    if (!args.includes('--allow-dangerously-skip-permissions')) args.splice(1, 0, '--allow-dangerously-skip-permissions')
    const cli = typeof mode === 'string' ? deps.modeCli[mode] : undefined
    if (cli) setValue(args, '--permission-mode', cli)
    setValue(args, '--resume', sid)
    return args
  }

  return { remember, recall, prune, resumeArgs }
}
