/**
 * Terminal streams ('pty-stream-v1'): a terminal on this host for the Walnut
 * server linked here, carried as a stream on that link (stream-relay-core.ts).
 * What `ssh -tt host CMD` gives a host reached over SSH, for every other kind of
 * link (the host network, the cloud box): the terminal is an abstraction over the
 * connection, never an SSH feature (the user, 2026-11-18).
 *
 *   server ──stream.open {sid, to: 'pty', command, cols, rows, env?}──▶ daemon
 *          ◀──stream-accept {sid, pid}──────────────────────────────── (the pty runs)
 *   then stream.data both ways (the terminal's bytes), stream.ack, and
 *   stream.resize {sid, cols, rows}; the daemon ends with
 *   stream-end {sid, exit: {code, signal}} after the last output.
 *
 * The daemon runs `<shell> -c <command>` on a pty, what sshd runs for `ssh host CMD`:
 * the passwd shell, as sshd takes it (a daemon started from cron has SHELL=/bin/sh),
 * read by uid with `getent passwd` (Linux) or `id -P` (macOS) once and kept, since bun's
 * os.userInfo() gives the env's SHELL instead (2026-11-18: clouddev's terminal came up
 * in sh, not the user's zsh); an open waits for that first read. The server reads the
 * same entry with src/lib/account.ts, synchronously; a daemon may not block its loop on a
 * child, and its source twin inlines this factory, so the read here is its own, async. Unless it is unusable (nologin, false, not an executable file: the cloud box's
 * service user is /usr/sbin/nologin), then the env's SHELL if it is usable, then
 * /bin/sh. The user's home and an sshd-like env (HOME,
 * USER, LOGNAME, SHELL, PATH, TERM=xterm-256color, and the opener's LANG / LC_*
 * as ssh's SendEnv passes them). A `close` from the link, or the link dropping,
 * hangs the pty up (SIGHUP and the pty closed), as an ssh disconnect does: a
 * dtach master under it keeps running, which is the terminal's persistence.
 *
 * Flow control: the pty's output goes out as it comes, and once WINDOW bytes are
 * not acked the terminal's foreground process group is stopped (SIGSTOP) until
 * they are (SIGCONT to the same group). The group is read once per pause, off the
 * output path (`ps -o tpgid=`, deps.foregroundGroup); one that cannot be read, is
 * not above 1, or is the daemon's own falls back to the pty's own process. For a
 * dtach attach that is the client, so the master waits for a client that can take
 * its bytes and the program writing blocks, the way an ssh channel window holds
 * it; for a plain shell it is the job printing (`yes | head`). Past HARD_CAP unacked
 * bytes the stream still ends rather than fill the daemon: the last resort.
 *
 * Shared by both daemon twins: daemon-standalone.ts imports it, daemon-source.ts
 * inlines its `toString()` through `__CREATE_PTY_STREAMS__`. So the factory body
 * references NOTHING at module scope.
 */

/** A pty as Bun's `Bun.spawn(argv, { terminal })` gives it (src/lib/pty.ts uses the same). */
export interface PtyTerminal {
  write(data: Uint8Array): number
  resize(cols: number, rows: number): void
  close(): void
}

export interface PtyChild {
  readonly pid: number
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: string | null
  readonly terminal?: PtyTerminal
  kill(signal?: string): void
}

export interface PtySpawnOptions {
  cwd: string
  env: Record<string, string>
  terminal: {
    cols: number
    rows: number
    data(terminal: PtyTerminal, bytes: Uint8Array): void
    exit(terminal: PtyTerminal): void
  }
}

export interface PtyStreamDeps<L> {
  /** Send one event frame to a link (the daemon's sendEvent). */
  send: (link: L, ev: string, data: Record<string, unknown>) => void
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** Start argv on a pty. Without it (a twin on Node), terminal streams are refused. */
  spawn?: (argv: string[], opts: PtySpawnOptions) => PtyChild
  /** The login user from passwd (os.userInfo(), which throws for a uid passwd lacks): its shell, home and name first. */
  user: () => { shell?: string | null; home?: string; name?: string }
  /** The daemon's own env: only PATH, TMPDIR, TZ and the locale pass from it; SHELL, HOME and USER only where passwd names none usable. */
  env: Record<string, string | undefined>
  /**
   * Run a program and give its stdout, or null on any failure (execFile with a timeout).
   * The passwd shell is read with it, by uid: `getent passwd <uid>` on Linux, `id -P` on
   * macOS. Without it, user().shell is all there is.
   */
  readCommand?: (file: string, args: string[], cb: (stdout: string | null) => void) => void
  /** process.platform: which of the two reads above. */
  platform?: string
  /** This process's uid (process.getuid), whose passwd entry names the shell. */
  uid?: () => number | null
  /** Whether `path` is an executable file (fs.accessSync X_OK and a file). Without it, any path counts. */
  executable?: (path: string) => boolean
  /** The pty's foreground process group (`ps -o tpgid= -p <pid>`), or null; `cb` once. Without it, the pty's own process is stopped. */
  foregroundGroup?: (pid: number, cb: (pgid: number | null) => void) => void
  /** This daemon's own process group (`ps -o pgid=`), never stopped; null when unknown. */
  ownGroup?: (cb: (pgid: number | null) => void) => void
  /** Signal a process group (process.kill(-pgid, signal)). */
  killGroup?: (pgid: number, signal: string) => void
  /** How long an exit waits for the pty's EOF (default 250 ms, src/lib/pty.ts EOF_WAIT_MS). */
  eofWaitMs?: number
}

export function createPtyStreams<L>(deps: PtyStreamDeps<L>) {
  const MAX_PER_LINK = 32
  const WINDOW = 256 * 1024
  const HARD_CAP = 16 * 1024 * 1024
  /** Pieces as link-stream.ts sends them: their base64 stays under the relay's data cap. */
  const PIECE = 48 * 1024
  const MAX_DATA_CHARS = 128 * 1024
  const MAX_COMMAND_CHARS = 64 * 1024
  const EOF_WAIT_MS = deps.eofWaitMs ?? 250
  /** What ssh's default SendEnv passes (LANG, LC_*), with a value a locale name can have. */
  const LOCALE_KEY = /^(LANG|LANGUAGE|LC_[A-Z]+)$/
  const LOCALE_VALUE = /^[A-Za-z0-9_.@:-]{1,64}$/

  interface PtyEnd {
    link: L; sid: string; proc: PtyChild | null; terminal: PtyTerminal | null
    unacked: number; paused: boolean; exitSent: boolean
    /** What a pause stopped: a group (> 1) or the pty's own process (0); null while none is stopped. */
    stopped: number | null; pauses: number
  }
  const byLink = new Map<L, Map<string, PtyEnd>>()

  /** The passwd shell once read ('' = read, none found); null until then, with the opens waiting on it. */
  let passwdShell: string | null = deps.readCommand ? null : ''
  const shellWaiters: Array<() => void> = []
  function shellRead(sh: string): void {
    if (passwdShell !== null) return
    passwdShell = sh
    for (const w of shellWaiters.splice(0)) w()
  }
  /**
   * The entry is found by the process's uid, never by $USER (under bun, the user name os.userInfo() gives
   * is $USER too, which a service or a test may set to anyone): `id -P` on macOS (Directory
   * Services), `getent passwd <uid>` elsewhere (NSS: LDAP users too), by path first, as
   * src/lib/account.ts reads it for the server. The shell is a line's last field in both forms.
   */
  function readPasswdShell(): void {
    if (passwdShell !== null || !deps.readCommand) return
    let uid: number | null = null
    try { uid = deps.uid?.() ?? null } catch { uid = null }
    if (uid === null || !Number.isInteger(uid) || uid < 0) return shellRead('')
    const t = setTimeout(() => shellRead(''), 3_000)
    ;(t as { unref?: () => void }).unref?.()
    const runs: Array<[string, string[]]> = deps.platform === 'darwin'
      ? [['/usr/bin/id', ['-P']]]
      : [['/usr/bin/getent', ['passwd', String(uid)]], ['/bin/getent', ['passwd', String(uid)]], ['getent', ['passwd', String(uid)]]]
    const next = (i: number): void => {
      if (i >= runs.length) { clearTimeout(t); return shellRead('') }
      try {
        deps.readCommand!(runs[i]![0], runs[i]![1], (out) => {
          if (out === null) return next(i + 1)
          clearTimeout(t)
          const line = String(out).split('\n').map((l) => l.trim().split(':')).find((f) => f.length >= 7 && f[2] === String(uid))
          const sh = line ? line[line.length - 1]!.trim() : ''
          shellRead(sh.startsWith('/') ? sh : '')
        })
      } catch { next(i + 1) }
    }
    next(0)
  }
  readPasswdShell()
  function whenShellKnown(go: () => void): void {
    if (passwdShell !== null) return go()
    shellWaiters.push(go)
  }

  function tracked(end: PtyEnd): boolean {
    return byLink.get(end.link)?.get(end.sid) === end
  }

  function forget(end: PtyEnd): void {
    const m = byLink.get(end.link)
    if (!m || m.get(end.sid) !== end) return
    m.delete(end.sid)
    if (m.size === 0) byLink.delete(end.link)
  }

  /** Send `signal` to what a pause stops: the group, else the pty's own process. */
  function signalStopped(end: PtyEnd, target: number, signal: string): void {
    try {
      if (target > 1 && deps.killGroup) deps.killGroup(target, signal)
      else end.proc?.kill(signal)
    } catch { /* gone */ }
  }

  /** Stop what writes to the terminal: its foreground group read once for this pause, off the output path. */
  function pause(end: PtyEnd): void {
    end.paused = true
    const seq = ++end.pauses
    const stop = (target: number) => {
      if (!end.paused || end.pauses !== seq || end.stopped !== null || !tracked(end)) return
      end.stopped = target
      signalStopped(end, target, 'SIGSTOP')
    }
    const proc = end.proc
    if (!proc || !deps.foregroundGroup) return stop(0)
    let done = false
    const once = (target: number) => { if (!done) { done = true; stop(target) } }
    try {
      deps.foregroundGroup(proc.pid, (tpgid) => {
        if (typeof tpgid !== 'number' || !Number.isInteger(tpgid) || tpgid <= 1) return once(0)
        if (!deps.ownGroup) return once(tpgid)
        try { deps.ownGroup((own) => once(own === tpgid ? 0 : tpgid)) } catch { once(0) }
      })
    } catch { once(0) }
  }

  /** Continue what the pause stopped, the same group or process. */
  function resume(end: PtyEnd): void {
    end.paused = false
    const target = end.stopped
    end.stopped = null
    if (target !== null) signalStopped(end, target, 'SIGCONT')
  }

  /** Hang the pty up, as an ssh disconnect does: SIGHUP (a stopped one continued so it sees it), then the pty closed. */
  function hangUp(end: PtyEnd): void {
    const proc = end.proc
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
    try { proc.kill('SIGHUP') } catch { /* gone */ }
    if (end.paused) resume(end)
    try { end.terminal?.close() } catch { /* closed */ }
  }

  function abort(end: PtyEnd, error: string): void {
    if (!tracked(end)) return
    forget(end)
    deps.send(end.link, 'stream-close', { sid: end.sid, error })
    hangUp(end)
  }

  function size(v: unknown): number | null {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4096 ? v : null
  }

  /** The env sshd gives a session: the user's, never the daemon's (no WALNUT_* or tokens of its own). */
  function loginEnv(user: { shell: string; home: string; name?: string }, asked: unknown): Record<string, string> {
    const env: Record<string, string> = {
      HOME: user.home, SHELL: user.shell, TERM: 'xterm-256color', PWD: user.home,
      PATH: deps.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    }
    if (user.name) { env.USER = user.name; env.LOGNAME = user.name }
    for (const k of ['TMPDIR', 'TZ']) { const v = deps.env[k]; if (v) env[k] = v }
    for (const k of Object.keys(deps.env)) { const v = deps.env[k]; if (LOCALE_KEY.test(k) && v && LOCALE_VALUE.test(v)) env[k] = v }
    if (asked && typeof asked === 'object') {
      for (const [k, v] of Object.entries(asked as Record<string, unknown>)) {
        if (LOCALE_KEY.test(k) && typeof v === 'string' && LOCALE_VALUE.test(v)) env[k] = v
      }
    }
    return env
  }

  /** The exit after the pty's last output: its EOF, at most EOF_WAIT_MS after the process ended. */
  function watchExit(end: PtyEnd, proc: PtyChild, eof: { seen: boolean; wake: (() => void) | null }): void {
    void proc.exited.then(async () => {
      if (!eof.seen) {
        await new Promise<void>((resolve) => {
          eof.wake = resolve
          const t = setTimeout(resolve, EOF_WAIT_MS)
          ;(t as { unref?: () => void }).unref?.()
        })
      }
      try { end.terminal?.close() } catch { /* closed */ }
      if (!tracked(end) || end.exitSent) return
      end.exitSent = true
      forget(end)
      deps.send(end.link, 'stream-end', { sid: end.sid, exit: { code: proc.exitCode, signal: proc.signalCode } })
    }, () => { abort(end, 'the terminal\'s process could not be waited for') })
  }

  /**
   * `from` (the server, checked by the caller; the relay checked the id) asks for a
   * terminal running `command`. Refused (a `stream-close` with why) for a bad
   * command or size, a daemon without a pty, or too many on the link.
   */
  function open(from: L, sid: string, msg: Record<string, unknown>): void {
    const refuse = (error: string) => deps.send(from, 'stream-close', { sid, error })
    if (!deps.spawn) return refuse('this daemon has no pty (it runs on Node), so it opens no terminal; a daemon on bun does')
    const command = msg.command
    if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_CHARS || command.includes('\0')) {
      return refuse('a terminal stream needs a command of at most 64 KB')
    }
    const cols = size(msg.cols)
    const rows = size(msg.rows)
    if (cols === null || rows === null) return refuse('a terminal stream needs cols and rows from 1 to 4096')
    if ((byLink.get(from)?.size ?? 0) >= MAX_PER_LINK) return refuse('too many terminal streams on this link')
    const end: PtyEnd = { link: from, sid, proc: null, terminal: null, unacked: 0, paused: false, exitSent: false, stopped: null, pauses: 0 }
    let m = byLink.get(from)
    if (!m) { m = new Map(); byLink.set(from, m) }
    m.set(sid, end)
    // A close or a dropped link while the passwd shell is read leaves nothing to start.
    whenShellKnown(() => { if (tracked(end)) start(end, command, cols, rows, msg.env) })
  }

  function start(end: PtyEnd, command: string, cols: number, rows: number, askedEnv: unknown): void {
    const { link: from, sid } = end
    const refuse = (error: string) => { forget(end); deps.send(from, 'stream-close', { sid, error }) }
    const spawn = deps.spawn!
    let who: { shell?: string | null; home?: string; name?: string } = {}
    // A uid passwd lacks makes os.userInfo() throw: the env still names the user.
    try { who = deps.user() || {} } catch { who = {} }
    const usable = (sh: unknown): sh is string => {
      if (typeof sh !== 'string' || !sh || /(^|\/)(nologin|false)$/.test(sh)) return false
      try { return deps.executable ? deps.executable(sh) : true } catch { return false }
    }
    // The passwd shell first, as sshd does (a daemon started from cron has SHELL=/bin/sh), unless
    // it is no login shell (the cloud box's service user has /usr/sbin/nologin).
    const shell = usable(passwdShell) ? passwdShell : usable(who.shell) ? who.shell : usable(deps.env.SHELL) ? deps.env.SHELL : '/bin/sh'
    const user = { shell, home: who.home || deps.env.HOME || '/', name: who.name || deps.env.USER }
    const eof = { seen: false, wake: null as (() => void) | null }
    let proc: PtyChild
    try {
      proc = spawn([user.shell, '-c', command], {
        cwd: user.home,
        env: loginEnv(user, askedEnv),
        terminal: {
          cols, rows,
          data: (_t, bytes) => output(end, bytes),
          exit: () => { eof.seen = true; eof.wake?.() },
        },
      })
    } catch (err) {
      return refuse(`the terminal did not start: ${String((err as Error)?.message ?? err).slice(0, 160)}`)
    }
    end.proc = proc
    end.terminal = proc.terminal ?? null
    if (!end.terminal) {
      try { proc.kill('SIGKILL') } catch { /* gone */ }
      return refuse('the terminal did not start: no pty was attached')
    }
    deps.send(from, 'stream-accept', { sid, pid: proc.pid })
    watchExit(end, proc, eof)
  }

  function output(end: PtyEnd, bytes: Uint8Array): void {
    if (!tracked(end) || bytes.length === 0) return
    for (let off = 0; off < bytes.length; off += PIECE) {
      const piece = bytes.subarray(off, off + PIECE)
      deps.send(end.link, 'stream-data', { sid: end.sid, d: Buffer.from(piece.buffer, piece.byteOffset, piece.length).toString('base64') })
      end.unacked += piece.length
    }
    if (end.unacked > HARD_CAP) { abort(end, 'the terminal printed far more than the link carried; it was hung up'); return }
    if (end.unacked > WINDOW && !end.paused && end.proc) pause(end)
  }

  /** A frame from the link for one of its terminals. */
  function frame(link: L, kind: string, msg: Record<string, unknown>): void {
    const end = typeof msg.sid === 'string' ? byLink.get(link)?.get(msg.sid) : undefined
    if (!end) return
    if (kind === 'data') {
      if (typeof msg.d !== 'string' || msg.d.length > MAX_DATA_CHARS) {
        deps.log('warn', 'pty stream: a bad data frame ends the terminal', { sid: end.sid })
        abort(end, 'bad data frame')
        return
      }
      const buf = Buffer.from(msg.d, 'base64')
      if (buf.length === 0) return
      try { end.terminal?.write(buf) } catch { /* the pty is closing; its exit follows */ }
      deps.send(end.link, 'stream-ack', { sid: end.sid, n: buf.length })
      return
    }
    if (kind === 'ack') {
      const n = msg.n
      if (typeof n !== 'number' || !(n > 0) || n > 64 * 1024 * 1024) return
      end.unacked = Math.max(0, end.unacked - n)
      if (end.paused && end.unacked <= WINDOW) resume(end)
      return
    }
    if (kind === 'resize') {
      const cols = size(msg.cols)
      const rows = size(msg.rows)
      if (cols === null || rows === null) return
      try { end.terminal?.resize(cols, rows) } catch { /* exiting */ }
      return
    }
    if (kind === 'close') {
      forget(end)
      hangUp(end)
    }
    // 'end' (no more input) leaves the pty as sshd does; 'accept' is the daemon's own word.
  }

  /** A link closed: every terminal on it is hung up. */
  function dropLink(link: L): void {
    const m = byLink.get(link)
    if (!m) return
    byLink.delete(link)
    for (const end of m.values()) hangUp(end)
  }

  return {
    open,
    frame,
    dropLink,
    has: (link: L, sid: string): boolean => byLink.get(link)?.has(sid) ?? false,
    count: (link?: L): number => {
      if (link !== undefined) return byLink.get(link)?.size ?? 0
      let n = 0
      for (const m of byLink.values()) n += m.size
      return n
    },
  }
}

export type PtyStreams<L> = ReturnType<typeof createPtyStreams<L>>
