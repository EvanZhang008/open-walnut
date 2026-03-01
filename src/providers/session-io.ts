/**
 * SessionIO — Unified I/O abstraction for Claude Code sessions.
 *
 * Both local and SSH sessions use the same pattern:
 *   FIFO (named pipe) → claude stdin   (write path)
 *   claude stdout → JSONL file          (read path)
 *
 * The only difference is WHERE these files live:
 *   - LocalIO:  files on the local filesystem, accessed directly
 *   - RemoteIO: files on the remote machine, accessed via SSH commands
 *
 * This abstraction lets ClaudeCodeSession treat both cases identically.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { JsonlTailer } from '../core/jsonl-tailer.js'
import { SESSION_STREAMS_DIR, REMOTE_IMAGES_DIR } from '../constants.js'
import { log } from '../logging/index.js'

// ── SessionIO interface ──

export interface SessionIO {
  /**
   * Write a stream-json message to the session's stdin FIFO.
   * Returns true on success, false if the pipe is broken / unavailable.
   */
  write(message: string): boolean

  /**
   * Start tailing the JSONL output file, calling onLine for each new line.
   * @param fromOffset — byte offset to start reading from (0 = replay all)
   */
  startTail(onLine: (line: string) => void, fromOffset?: number): void

  /** Stop tailing (but don't delete files). */
  stopTail(): void

  /** Flush remaining buffered data from the tailer (call when process exits). */
  flushTail(): void

  /** Current byte offset in the JSONL file (for resumption). */
  readonly tailOffset: number

  /** The JSONL output file path (for stall detection, file renaming, etc.) */
  readonly outputFile: string

  /** Process name used for liveness checks ('claude' for local, 'ssh' for remote). */
  readonly processName: string

  /** Whether this IO has an active write pipe (FIFO exists and is usable). */
  readonly hasPipe: boolean

  /** Current size of the output file in bytes. */
  readonly fileSize: number

  /**
   * Rename output + pipe files to use the real Claude session ID.
   * Called when the system init event arrives with the actual session_id.
   */
  renameForSession(sessionId: string): void

  /**
   * Try to recover the FIFO pipe from a previous server instance.
   * Used by attachToExisting() — if a named FIFO with the session ID exists
   * on disk, reclaim it for writing.
   */
  recoverPipe(sessionId: string): void

  /** Clean up FIFO pipe (but not the JSONL file). */
  deletePipe(): void

  /** Full cleanup — delete pipe and output files. */
  cleanup(): Promise<void>
}

// ── LocalIO ──

/**
 * Local filesystem I/O for sessions running on this machine.
 * FIFO and JSONL files live in SESSION_STREAMS_DIR.
 */
export class LocalIO implements SessionIO {
  private pipePath: string | null = null
  private tailer: JsonlTailer | null = null
  private _outputFile: string
  private _onLine: ((line: string) => void) | null = null

  readonly processName = 'claude'

  constructor(tmpId: string, outputFileOverride?: string) {
    this._outputFile = outputFileOverride ?? path.join(SESSION_STREAMS_DIR, `${tmpId}.jsonl`)
  }

  get outputFile(): string {
    return this._outputFile
  }

  get hasPipe(): boolean {
    return this.pipePath !== null
  }

  get tailOffset(): number {
    return this.tailer?.currentOffset ?? 0
  }

  get fileSize(): number {
    try { return fs.statSync(this._outputFile).size } catch { return 0 }
  }

  /**
   * Create a named FIFO and spawn the local claude process.
   * Returns { pipeFd, outputFd, stderrFd } for the caller to wire into spawn().
   *
   * @param append — when true, open the output file in append mode instead of truncating.
   *   Used for session resumes to preserve previous turns' JSONL data.
   */
  createFiles(append = false): { pipePath: string; pipeFd: number; outputFd: number; stderrFd: number } {
    fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })

    const tmpId = path.basename(this._outputFile, '.jsonl')
    const pipeTmpPath = path.join(SESSION_STREAMS_DIR, `${tmpId}.pipe`)

    // Clean up stale FIFO
    try { fs.unlinkSync(pipeTmpPath) } catch { /* doesn't exist */ }
    execFileSync('mkfifo', [pipeTmpPath])

    // Open FIFO with O_RDWR so the child holds both ends (prevents EOF
    // when all external writers close — the child is its own writer).
    const pipeFd = fs.openSync(pipeTmpPath, fs.constants.O_RDWR)
    this.pipePath = pipeTmpPath

    const outputFd = fs.openSync(this._outputFile, append ? 'a' : 'w')
    const stderrFd = fs.openSync(this._outputFile + '.err', append ? 'a' : 'w')

    log.session.debug('LocalIO: files created', {
      pipePath: pipeTmpPath,
      outputFile: this._outputFile,
      append,
    })

    return { pipePath: pipeTmpPath, pipeFd, outputFd, stderrFd }
  }

  /**
   * Write the initial message to the FIFO and close the parent's fd.
   * Must be called immediately after spawn() with the pipeFd.
   */
  writeInitialMessage(pipeFd: number, message: string): void {
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    })
    fs.writeSync(pipeFd, Buffer.from(payload + '\n'))
    fs.closeSync(pipeFd)
    log.session.debug('LocalIO: initial message written to FIFO', { messageLength: message.length })
  }

  write(message: string): boolean {
    if (!this.pipePath) {
      log.session.debug('LocalIO write skipped: no pipe', { messageLength: message.length })
      return false
    }
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    })
    try {
      const fd = fs.openSync(this.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      fs.writeSync(fd, Buffer.from(payload + '\n'))
      fs.closeSync(fd)
      log.session.debug('LocalIO write ok', { pipePath: this.pipePath, messageLength: message.length })
      return true
    } catch (err) {
      log.session.warn('LocalIO write failed — pipe broken, clearing', {
        pipePath: this.pipePath,
        messageLength: message.length,
        error: err instanceof Error ? err.message : String(err),
      })
      this.pipePath = null
      return false
    }
  }

  startTail(onLine: (line: string) => void, fromOffset?: number): void {
    this._onLine = onLine
    this.tailer = new JsonlTailer(this._outputFile, onLine)
    this.tailer.start(fromOffset)
  }

  stopTail(): void {
    if (this.tailer) {
      this.tailer.stop()
      this.tailer = null
    }
  }

  flushTail(): void {
    if (this.tailer) {
      this.tailer.flush()
    }
  }

  renameForSession(sessionId: string): void {
    // Rename JSONL output file
    const oldOutput = this._outputFile
    if (!oldOutput.includes(sessionId)) {
      const newPath = path.join(path.dirname(oldOutput), `${sessionId}.jsonl`)
      try {
        fs.renameSync(oldOutput, newPath)
        try { fs.renameSync(oldOutput + '.err', newPath + '.err') } catch { /* ignore */ }
        this._outputFile = newPath

        // Restart tailer on the new file path (preserving offset)
        if (this.tailer && this._onLine) {
          const offset = this.tailer.currentOffset
          this.tailer.stop()
          this.tailer = new JsonlTailer(newPath, this._onLine)
          this.tailer.start(offset)
        }

        log.session.debug('LocalIO: renamed output file', { from: oldOutput, to: newPath })
      } catch (err) {
        log.session.debug('LocalIO: failed to rename output file', {
          from: oldOutput, to: newPath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Rename FIFO pipe
    if (this.pipePath && !this.pipePath.includes(sessionId)) {
      const newPipePath = path.join(SESSION_STREAMS_DIR, `${sessionId}.pipe`)
      try {
        try { fs.unlinkSync(newPipePath) } catch { /* doesn't exist */ }
        fs.renameSync(this.pipePath, newPipePath)
        this.pipePath = newPipePath
        log.session.debug('LocalIO: renamed FIFO', { to: newPipePath })
      } catch {
        // Rename failed — keep using the temp name
      }
    }
  }

  recoverPipe(sessionId: string): void {
    // Use the outputFile's directory (not SESSION_STREAMS_DIR) — after server restart
    // the constant may point to a different dir than where the session was created.
    const streamsDir = path.dirname(this._outputFile)
    const candidatePipe = path.join(streamsDir, `${sessionId}.pipe`)
    try {
      const stat = fs.statSync(candidatePipe)
      if (stat.isFIFO()) {
        this.pipePath = candidatePipe
        log.session.debug('LocalIO: recovered FIFO pipe', { pipePath: candidatePipe, sessionId })
      } else {
        log.session.debug('LocalIO: candidate pipe is not a FIFO', { pipePath: candidatePipe, sessionId })
      }
    } catch {
      log.session.debug('LocalIO: no FIFO found for recovery', { pipePath: candidatePipe, sessionId })
    }
  }

  deletePipe(): void {
    if (this.pipePath) {
      log.session.debug('LocalIO: deleting FIFO', { pipePath: this.pipePath })
      try { fs.unlinkSync(this.pipePath) } catch { /* doesn't exist */ }
      this.pipePath = null
    }
  }

  async cleanup(): Promise<void> {
    this.deletePipe()
    try { await fsp.unlink(this._outputFile) } catch { /* ignore */ }
    try { await fsp.unlink(this._outputFile + '.err') } catch { /* ignore */ }
  }
}

// ── RemoteIO ──

/** SSH connection target resolved from config.hosts */
export interface SshTarget {
  hostname: string
  user?: string
  port?: number
  /** Optional shell snippet run before claude (e.g. nvm/fnm/volta setup). */
  shell_setup?: string
}

/**
 * Shell-quote a string for safe embedding in a remote sh command.
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Base PATH setup for remote SSH commands.
 * Adds common install locations (~/.local/bin, ~/.npm-global/bin).
 */
export const REMOTE_BASE_PATH = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"'

/**
 * Build the full remote preamble: base PATH + optional user shell_setup + env vars.
 *
 * Non-interactive SSH doesn't source .bashrc/.zshrc, so tools like nvm/fnm/volta
 * aren't in PATH. The `shell_setup` config field lets users add custom env setup:
 *
 *   hosts:
 *     mydev:
 *       hostname: dev.example.com
 *       shell_setup: 'source $HOME/.nvm/nvm.sh 2>/dev/null'
 *
 * @param shellSetup — optional shell snippet from config.hosts[].shell_setup
 */
export function buildRemotePreamble(shellSetup?: string): string {
  const parts = [REMOTE_BASE_PATH]
  if (shellSetup) {
    // User's shell_setup runs after base PATH; `|| true` ensures exit 0
    // so downstream && chains are not short-circuited when setup fails.
    parts.push(`(${shellSetup}) 2>/dev/null || true`)
  }
  return parts.join('; ')
}

/**
 * Wrap a remote command to run inside the user's login shell.
 *
 * SSH non-interactive commands (`ssh host 'cmd'`) don't source profile files
 * (.bashrc, .zshrc, .profile, etc.) — unlike tmux which spawns `$SHELL -l`.
 * This means node version managers (nvm, fnm, volta, asdf) aren't loaded.
 *
 * Fix: wrap the command in `$SHELL -lc '...'` so the remote shell runs as a
 * login shell and sources all profile files automatically.
 * `$SHELL` is always set by sshd to the user's login shell (from /etc/passwd).
 *
 * When `shell_setup` is configured, it's injected INSIDE the login shell
 * (after profiles are loaded) for additional setup that profiles miss.
 */
export function wrapInLoginShell(cmd: string, shellSetup?: string): string {
  const parts: string[] = []
  if (shellSetup) {
    parts.push(`(${shellSetup}) 2>/dev/null || true`)
  }
  parts.push(cmd)
  const inner = parts.join('; ')
  return `$SHELL -lc ${shellQuote(inner)}`
}

/**
 * Build the remote shell command string for SSH execution.
 * Produces: `cd '/path' && CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude <args>`
 * All arguments are shell-quoted for safety on the remote shell.
 */
export function buildRemoteCommand(claudeArgs: string[], cwd?: string, shellSetup?: string): string {
  const quotedArgs = claudeArgs.map((a) => shellQuote(a))
  const preamble = `${buildRemotePreamble(shellSetup)} && CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
  const claudeCmd = `${preamble} claude ${quotedArgs.join(' ')}`
  if (cwd) {
    return `cd ${shellQuote(cwd)} && ${claudeCmd}`
  }
  return claudeCmd
}

/**
 * Remote SSH I/O for sessions running on a remote machine.
 *
 * Architecture:
 *   Remote machine: FIFO → claude stdin → stdout → JSONL file
 *   Local machine:  SSH commands to write FIFO / tail JSONL
 *
 * The remote JSONL is tailed via a persistent `ssh tail -f` connection.
 * Messages are written to the remote FIFO via short-lived SSH commands.
 */
export class RemoteIO implements SessionIO {
  private remotePipePath: string | null = null
  private remoteOutputPath: string | null = null
  private _localOutputFile: string
  private tailProc: ChildProcess | null = null
  private tailer: JsonlTailer | null = null
  private _onLine: ((line: string) => void) | null = null
  private _tailOffset = 0
  private sshTarget: SshTarget
  private _hasPipe = false

  /** Remote directory where transferred images are stored (for cleanup). */
  remoteImagesDir?: string

  /** Expose SSH target for downstream consumers (e.g. remote image download). */
  get target(): SshTarget {
    return this.sshTarget
  }

  readonly processName = 'ssh'

  constructor(
    tmpId: string,
    readonly host: string,
    sshTarget: SshTarget,
  ) {
    this.sshTarget = sshTarget
    // Local output file — we write data tailed from remote into this file
    // so JsonlTailer can read it identically to local sessions
    this._localOutputFile = path.join(SESSION_STREAMS_DIR, `${tmpId}.jsonl`)
    fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })
  }

  get outputFile(): string {
    return this._localOutputFile
  }

  get hasPipe(): boolean {
    return this._hasPipe
  }

  get tailOffset(): number {
    return this.tailer?.currentOffset ?? this._tailOffset
  }

  get fileSize(): number {
    try { return fs.statSync(this._localOutputFile).size } catch { return 0 }
  }

  /**
   * Set up remote FIFO + JSONL files and spawn claude on the remote machine.
   * Returns the SSH spawn args and env needed for the caller to spawn the process.
   *
   * Remote setup:
   *   1. mkdir -p /tmp/walnut-streams/
   *   2. mkfifo /tmp/walnut-streams/{id}.pipe
   *   3. claude --input-format stream-json < fifo > jsonl &
   *   (all done via a single SSH command)
   *
   * FIFO initial message is written via the same SSH session that spawns claude,
   * using a background subshell pattern:
   *   ( echo 'message' > fifo ) & claude --input-format stream-json < fifo > jsonl
   *
   * @param append — when true, open the LOCAL output file in append mode.
   *   The remote JSONL still truncates (each turn is a fresh Claude process),
   *   but the local file preserves all turns' data received via SSH stdout.
   */
  setupRemote(claudeArgs: string[], cwd?: string, initialMessage?: string, append?: boolean): {
    sshArgs: string[]
    localOutputFd: number
    localStderrFd: number
  } {
    const remoteDir = '/tmp/walnut-streams'
    const tmpId = path.basename(this._localOutputFile, '.jsonl')
    this.remotePipePath = `${remoteDir}/${tmpId}.pipe`
    this.remoteOutputPath = `${remoteDir}/${tmpId}.jsonl`

    // Build the remote command that:
    // 1. Creates the streams directory
    // 2. Creates the FIFO
    // 3. Writes the initial message to the FIFO in background
    // 4. Starts claude reading from the FIFO, writing to JSONL
    // 5. Tails the JSONL to stdout (so SSH connection streams it back)
    const quotedArgs = claudeArgs.map((a) => shellQuote(a))
    // shell_setup is handled by wrapInLoginShell() below — preamble only needs base PATH
    const preamble = `${REMOTE_BASE_PATH} && CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`

    const setupCmds = [
      `mkdir -p ${shellQuote(remoteDir)}`,
      `rm -f ${shellQuote(this.remotePipePath)}`,
      `mkfifo ${shellQuote(this.remotePipePath)}`,
    ]

    // Write initial message to FIFO in background, THEN start claude
    // The FIFO write must happen in a subshell that runs concurrently with claude's read
    //
    // IMPORTANT: Use ';' (not '&&') to separate background-job lines from subsequent
    // commands. The pattern `cmd & && next` is a zsh syntax error because '&&' cannot
    // follow '&' (a background job terminator). 'cmd &; next' is valid in both bash and zsh.
    let claudeCmd: string
    if (initialMessage) {
      const payload = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: initialMessage },
      })
      // Setup section: uses '&&' (no background jobs → safe for both bash and zsh)
      const setupSection = [
        `${preamble}`,
        `(printf '%s\\n' ${shellQuote(payload)} > ${shellQuote(this.remotePipePath)} &)`,
      ].join(' && ')
      // Execution section: uses ';' to avoid '& &&' zsh parse error.
      //
      // Persistent FIFO writer: `sleep infinity > FIFO &` keeps at least one
      // writer fd open on the named pipe. Without it, Claude's stdin sees EOF
      // the moment the initial `printf` closes its writer — causing Claude to
      // exit after the first turn. With the persistent writer, Claude blocks
      // on `read()` between turns (writer count ≥ 1 → no EOF), and subsequent
      // messages injected via `RemoteIO.write()` are delivered reliably.
      //
      // EXIT trap: ensures all background processes are killed when the SSH
      // connection drops (server kills SSH process → remote shell exits →
      // trap fires → cleanup). Without the trap, Claude/tail/sleep would be
      // orphaned on the remote machine.
      const execSection = [
        `sleep infinity > ${shellQuote(this.remotePipePath)} &`,
        `WRITER_PID=$!`,
        `claude ${quotedArgs.join(' ')} < ${shellQuote(this.remotePipePath)} > ${shellQuote(this.remoteOutputPath)} 2>/dev/null &`,
        `CLAUDE_PID=$!`,
        `sleep 0.5`,
        `tail -f -c +1 ${shellQuote(this.remoteOutputPath)} &`,
        `TAIL_PID=$!`,
        `trap 'kill $CLAUDE_PID $TAIL_PID $WRITER_PID 2>/dev/null' EXIT`,
        `wait $CLAUDE_PID 2>/dev/null`,
        `sleep 2`,
        `kill $TAIL_PID 2>/dev/null`,
        `kill $WRITER_PID 2>/dev/null`,
      ].join('; ')
      claudeCmd = `${setupSection}; ${execSection}`
    } else {
      // Resume case: no initial message, just start claude with FIFO
      const execSection = [
        `sleep infinity > ${shellQuote(this.remotePipePath)} &`,
        `WRITER_PID=$!`,
        `claude ${quotedArgs.join(' ')} < ${shellQuote(this.remotePipePath)} > ${shellQuote(this.remoteOutputPath)} 2>/dev/null &`,
        `CLAUDE_PID=$!`,
        `sleep 0.5`,
        `tail -f -c +1 ${shellQuote(this.remoteOutputPath)} &`,
        `TAIL_PID=$!`,
        `trap 'kill $CLAUDE_PID $TAIL_PID $WRITER_PID 2>/dev/null' EXIT`,
        `wait $CLAUDE_PID 2>/dev/null`,
        `sleep 2`,
        `kill $TAIL_PID 2>/dev/null`,
        `kill $WRITER_PID 2>/dev/null`,
      ].join('; ')
      claudeCmd = `${preamble}; ${execSection}`
    }

    let fullCmd: string
    if (cwd) {
      fullCmd = `${setupCmds.join(' && ')} && cd ${shellQuote(cwd)} && ${claudeCmd}`
    } else {
      fullCmd = `${setupCmds.join(' && ')} && ${claudeCmd}`
    }

    // Wrap in a login shell so profile files (.bashrc, .zshrc, .profile) are
    // sourced — same as tmux. This ensures node version managers (nvm, fnm,
    // volta) are loaded automatically. $SHELL is set by sshd.
    const wrappedCmd = wrapInLoginShell(fullCmd, this.sshTarget.shell_setup)

    // Build SSH args
    const hostString = this.sshTarget.user
      ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
      : this.sshTarget.hostname

    const sshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
    ]
    if (this.sshTarget.port) {
      sshArgs.push('-p', String(this.sshTarget.port))
    }
    sshArgs.push(hostString, wrappedCmd)

    // Local output file — SSH stdout (which is remote tail -f) goes here.
    // On resume (append=true), append to preserve previous turns' data.
    // The remote JSONL still truncates (fresh Claude process each turn),
    // but the local file accumulates all turns' output for history viewing.
    const localOutputFd = fs.openSync(this._localOutputFile, append ? 'a' : 'w')
    const localStderrFd = fs.openSync(this._localOutputFile + '.err', append ? 'a' : 'w')

    this._hasPipe = true

    log.session.info('RemoteIO: SSH session setup', {
      host: this.host,
      hostString,
      cwd: cwd ?? '(default)',
      remotePipe: this.remotePipePath,
      remoteJsonl: this.remoteOutputPath,
      localOutputFile: this._localOutputFile,
      append: append ?? false,
      hasInitialMessage: !!initialMessage,
      initialMessageLength: initialMessage?.length ?? 0,
    })
    log.session.debug('RemoteIO: full SSH command', { cmd: fullCmd })

    return { sshArgs, localOutputFd, localStderrFd }
  }

  write(message: string): boolean {
    if (!this._hasPipe || !this.remotePipePath) {
      log.session.debug('RemoteIO write skipped: no pipe', {
        host: this.host,
        hasPipe: this._hasPipe,
        remotePipe: this.remotePipePath,
        messageLength: message.length,
      })
      return false
    }

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    })

    // Write to remote FIFO via short-lived SSH command
    const hostString = this.sshTarget.user
      ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
      : this.sshTarget.hostname

    const sshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
    ]
    if (this.sshTarget.port) {
      sshArgs.push('-p', String(this.sshTarget.port))
    }

    const writeCmd = `printf '%s\\n' ${shellQuote(payload)} > ${shellQuote(this.remotePipePath)}`
    sshArgs.push(hostString, writeCmd)

    log.session.debug('RemoteIO write: sending to remote FIFO', {
      host: this.host,
      remotePipe: this.remotePipePath,
      messageLength: message.length,
    })

    try {
      // Use execFileSync for synchronous write (consistent with LocalIO.write)
      execFileSync('ssh', sshArgs, { timeout: 10_000, stdio: 'pipe' })
      log.session.debug('RemoteIO write: ok', {
        host: this.host,
        remotePipe: this.remotePipePath,
        messageLength: message.length,
      })
      return true
    } catch (err) {
      // Promote to warn — a write failure means the session must fall back to --resume,
      // which adds latency and is a signal the persistent FIFO writer may have died.
      log.session.warn('RemoteIO write failed — clearing hasPipe, will fall back to --resume', {
        host: this.host,
        remotePipe: this.remotePipePath,
        messageLength: message.length,
        error: err instanceof Error ? err.message : String(err),
      })
      this._hasPipe = false
      return false
    }
  }

  startTail(onLine: (line: string) => void, fromOffset?: number): void {
    this._onLine = onLine
    // Tail the local output file (SSH stdout → local file)
    this.tailer = new JsonlTailer(this._localOutputFile, onLine)
    this.tailer.start(fromOffset)
  }

  stopTail(): void {
    if (this.tailer) {
      this._tailOffset = this.tailer.currentOffset
      this.tailer.stop()
      this.tailer = null
    }
    if (this.tailProc) {
      try { this.tailProc.kill('SIGTERM') } catch { /* already dead */ }
      this.tailProc = null
    }
  }

  flushTail(): void {
    if (this.tailer) {
      this.tailer.flush()
    }
  }

  renameForSession(sessionId: string): void {
    // Rename local JSONL output file
    const oldOutput = this._localOutputFile
    if (!oldOutput.includes(sessionId)) {
      const newPath = path.join(path.dirname(oldOutput), `${sessionId}.jsonl`)
      try {
        fs.renameSync(oldOutput, newPath)
        try { fs.renameSync(oldOutput + '.err', newPath + '.err') } catch { /* ignore */ }
        this._localOutputFile = newPath

        // Restart tailer on the new file path
        if (this.tailer && this._onLine) {
          const offset = this.tailer.currentOffset
          this.tailer.stop()
          this.tailer = new JsonlTailer(newPath, this._onLine)
          this.tailer.start(offset)
          log.session.debug('RemoteIO: tailer restarted on renamed file', { newPath, offset })
        }

        log.session.info('RemoteIO: renamed local output file', {
          from: oldOutput,
          to: newPath,
          sessionId,
        })
      } catch (err) {
        log.session.warn('RemoteIO: failed to rename local output file', {
          from: oldOutput,
          to: newPath,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Rename remote FIFO only — NOT the JSONL output file.
    // The remote JSONL is actively being tailed by `tail -f`; renaming it
    // via a separate SSH command triggers IN_MOVE_SELF on inotify, which
    // causes tail to lose its watch and stop sending data. The FIFO is safe
    // to rename because claude already has it open by fd; future write()
    // calls will use the updated remotePipePath.
    if (this.remotePipePath) {
      const remoteDir = '/tmp/walnut-streams'
      const newRemotePipe = `${remoteDir}/${sessionId}.pipe`

      if (this.remotePipePath !== newRemotePipe) {
        const oldRemotePipe = this.remotePipePath
        const renameCmd = `mv ${shellQuote(oldRemotePipe)} ${shellQuote(newRemotePipe)} 2>/dev/null`
        this.remotePipePath = newRemotePipe

        const hostString = this.sshTarget.user
          ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
          : this.sshTarget.hostname
        const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
        if (this.sshTarget.port) sshArgs.push('-p', String(this.sshTarget.port))
        sshArgs.push(hostString, renameCmd)

        log.session.info('RemoteIO: renaming remote FIFO (fire-and-forget)', {
          host: this.host,
          from: oldRemotePipe,
          to: newRemotePipe,
          sessionId,
        })

        try {
          const proc = spawn('ssh', sshArgs, { detached: true, stdio: 'ignore' })
          proc.unref()
        } catch (err) {
          log.session.warn('RemoteIO: failed to spawn SSH for remote FIFO rename', {
            host: this.host,
            from: oldRemotePipe,
            to: newRemotePipe,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        log.session.debug('RemoteIO: remote FIFO rename skipped (path unchanged)', {
          remotePipe: this.remotePipePath,
          sessionId,
        })
      }
    }
  }

  recoverPipe(sessionId: string): void {
    // For remote sessions, set the expected remote paths optimistically —
    // actual liveness is verified on the first write() attempt.
    const remoteDir = '/tmp/walnut-streams'
    this.remotePipePath = `${remoteDir}/${sessionId}.pipe`
    this.remoteOutputPath = `${remoteDir}/${sessionId}.jsonl`
    this._hasPipe = true  // Optimistic — write() will detect if it's gone
    log.session.debug('RemoteIO: recovered pipe paths (optimistic)', {
      host: this.host,
      remotePipe: this.remotePipePath,
      remoteJsonl: this.remoteOutputPath,
      sessionId,
    })
  }

  deletePipe(): void {
    if (this.remotePipePath) {
      const pipeToDelete = this.remotePipePath
      log.session.debug('RemoteIO: deleting remote FIFO (fire-and-forget)', {
        host: this.host,
        remotePipe: pipeToDelete,
      })
      // Delete remote FIFO via SSH (best-effort, fire-and-forget)
      const hostString = this.sshTarget.user
        ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
        : this.sshTarget.hostname
      const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
      if (this.sshTarget.port) sshArgs.push('-p', String(this.sshTarget.port))
      sshArgs.push(hostString, `rm -f ${shellQuote(pipeToDelete)}`)

      try {
        const proc = spawn('ssh', sshArgs, { detached: true, stdio: 'ignore' })
        proc.unref()
      } catch (err) {
        log.session.debug('RemoteIO: failed to spawn SSH for deletePipe', {
          host: this.host,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      this.remotePipePath = null
      this._hasPipe = false
    }
  }

  async cleanup(): Promise<void> {
    log.session.debug('RemoteIO: cleanup start', {
      host: this.host,
      remotePipe: this.remotePipePath,
      remoteJsonl: this.remoteOutputPath,
      localOutputFile: this._localOutputFile,
    })
    this.stopTail()
    this.deletePipe()

    // Clean up remote JSONL + images directory
    const hostString = this.sshTarget.user
      ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
      : this.sshTarget.hostname
    const baseSshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
    if (this.sshTarget.port) baseSshArgs.push('-p', String(this.sshTarget.port))

    if (this.remoteOutputPath) {
      const jsonlToDelete = this.remoteOutputPath
      log.session.debug('RemoteIO: deleting remote JSONL (fire-and-forget)', {
        host: this.host,
        remoteJsonl: jsonlToDelete,
      })
      const sshArgs = [...baseSshArgs, hostString, `rm -f ${shellQuote(jsonlToDelete)}`]
      try {
        const proc = spawn('ssh', sshArgs, { detached: true, stdio: 'ignore' })
        proc.unref()
      } catch (err) {
        log.session.debug('RemoteIO: failed to spawn SSH for remote JSONL cleanup', {
          host: this.host,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (this.remoteImagesDir) {
      log.session.debug('RemoteIO: deleting remote images dir (fire-and-forget)', {
        host: this.host,
        remoteImagesDir: this.remoteImagesDir,
      })
      const sshArgs = [...baseSshArgs, hostString, `rm -rf ${shellQuote(this.remoteImagesDir)}`]
      try {
        const proc = spawn('ssh', sshArgs, { detached: true, stdio: 'ignore' })
        proc.unref()
      } catch (err) {
        log.session.debug('RemoteIO: failed to spawn SSH for remote images cleanup', {
          host: this.host,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Clean up local files
    try { await fsp.unlink(this._localOutputFile) } catch { /* ignore */ }
    try { await fsp.unlink(this._localOutputFile + '.err') } catch { /* ignore */ }
    log.session.debug('RemoteIO: cleanup complete', { host: this.host })
  }
}

/**
 * Create the appropriate SessionIO implementation based on whether this is
 * a local or remote session.
 */
export function createSessionIO(
  tmpId: string,
  host?: string,
  sshTarget?: SshTarget,
  outputFileOverride?: string,
): SessionIO {
  if (host && sshTarget) {
    return new RemoteIO(tmpId, host, sshTarget)
  }
  return new LocalIO(tmpId, outputFileOverride)
}

// ── Image transfer for remote sessions ──

/** Image extensions we recognize. */
const IMG_EXT = 'png|jpg|jpeg|gif|webp|bmp|tiff'

/**
 * Unquoted path regex — no spaces allowed (safe default for free text).
 * Matches: /some/path/image.png
 */
const UNQUOTED_IMAGE_RE = new RegExp(`(\\/[\\w./_-]+\\.(?:${IMG_EXT}))\\b`, 'gi')

/**
 * Quoted/backtick path regex — allows spaces in paths.
 * Matches: `/path with spaces/image.png` or "/path with spaces/image.png"
 * or '/path with spaces/image.png'
 * The path must start with / and end with an image extension.
 */
const QUOTED_IMAGE_RE = new RegExp(
  `[\`"'](\\/[\\w./ _-]+\\.(?:${IMG_EXT}))[\`"']`,
  'gi',
)

/**
 * Find absolute image paths in text, handling both spaced and non-spaced paths.
 *
 * Two-pass detection:
 *   1. Quoted/backtick paths (can contain spaces): `/path with spaces/img.png`
 *   2. Unquoted paths (no spaces, safe default): /path/img.png
 *
 * Returns deduplicated list of paths (without surrounding quotes).
 */
export function findImagePaths(text: string): string[] {
  const found = new Set<string>()

  // Pass 1: paths inside backticks, double quotes, or single quotes (may have spaces)
  let m: RegExpExecArray | null
  QUOTED_IMAGE_RE.lastIndex = 0
  while ((m = QUOTED_IMAGE_RE.exec(text)) !== null) {
    found.add(m[1])
  }

  // Pass 2: unquoted paths (no spaces)
  UNQUOTED_IMAGE_RE.lastIndex = 0
  while ((m = UNQUOTED_IMAGE_RE.exec(text)) !== null) {
    found.add(m[1])
  }

  return [...found]
}

/**
 * Find local image file paths referenced in a text string.
 * Returns deduplicated list of paths that actually exist on the local filesystem.
 */
export function findLocalImagePaths(text: string): string[] {
  return findImagePaths(text).filter((p) => {
    try { return fs.statSync(p).isFile() } catch { return false }
  })
}

/**
 * Transfer local image files to a remote host via SCP, then rewrite paths in the text.
 * Returns the text with local paths replaced by their remote counterparts.
 *
 * Graceful failure: if SCP or mkdir fails, logs a warning and returns the original text.
 */
export async function transferImagesForRemoteSession(
  text: string,
  sshTarget: SshTarget,
  remoteDir: string,
): Promise<string> {
  const localPaths = findLocalImagePaths(text)
  if (localPaths.length === 0) return text

  const hostString = sshTarget.user
    ? `${sshTarget.user}@${sshTarget.hostname}`
    : sshTarget.hostname

  // Build base SSH args (port handling: ssh uses -p, scp uses -P)
  const baseSshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
  if (sshTarget.port) baseSshArgs.push('-p', String(sshTarget.port))

  // 1. Create remote directory
  try {
    execFileSync('ssh', [...baseSshArgs, hostString, `mkdir -p ${shellQuote(remoteDir)}`], {
      timeout: 10_000,
      stdio: 'pipe',
    })
  } catch (err) {
    log.session.warn('image transfer: failed to create remote dir — proceeding without images', {
      remoteDir,
      host: sshTarget.hostname,
      error: err instanceof Error ? err.message : String(err),
    })
    return text
  }

  // 2. SCP all files in one batch (scp uses -P for port, not -p)
  const scpArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
  if (sshTarget.port) scpArgs.push('-P', String(sshTarget.port))
  scpArgs.push(...localPaths, `${hostString}:${remoteDir}/`)

  try {
    execFileSync('scp', scpArgs, { timeout: 60_000, stdio: 'pipe' })
  } catch (err) {
    log.session.warn('image transfer: scp failed — proceeding without images', {
      fileCount: localPaths.length,
      host: sshTarget.hostname,
      error: err instanceof Error ? err.message : String(err),
    })
    return text
  }

  // 3. Rewrite paths in text
  let rewritten = text
  for (const localPath of localPaths) {
    const remotePath = `${remoteDir}/${path.basename(localPath)}`
    rewritten = rewritten.split(localPath).join(remotePath)
  }

  log.session.info('image transfer: transferred and rewrote paths', {
    fileCount: localPaths.length,
    remoteDir,
    host: sshTarget.hostname,
  })

  return rewritten
}

// ── Remote → local image download (reverse proxy) ──

/**
 * Find remote image file paths referenced in a text string.
 * Unlike findLocalImagePaths(), skips the local fs.statSync check
 * (we can't stat remote files). Returns deduplicated path list.
 */
export function findRemoteImagePaths(text: string): string[] {
  return findImagePaths(text)
}

/**
 * Download a single file from the remote host via SCP.
 * Returns true on success, false on failure (graceful degradation).
 */
export function downloadRemoteImage(
  sshTarget: SshTarget,
  remotePath: string,
  localPath: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    // Ensure local directory exists
    const dir = path.dirname(localPath)
    fs.mkdirSync(dir, { recursive: true })

    const hostString = sshTarget.user
      ? `${sshTarget.user}@${sshTarget.hostname}`
      : sshTarget.hostname

    // SCP uses -P for port (not -p)
    const scpArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
    if (sshTarget.port) scpArgs.push('-P', String(sshTarget.port))
    scpArgs.push(`${hostString}:${remotePath}`, localPath)

    execFile('scp', scpArgs, { timeout: 30_000 }, (err) => {
      if (err) {
        log.session.warn('remote image download failed', {
          remotePath,
          localPath,
          host: sshTarget.hostname,
          error: err.message,
        })
        resolve(false)
      } else {
        log.session.debug('remote image downloaded', { remotePath, localPath, host: sshTarget.hostname })
        resolve(true)
      }
    })
  })
}

/**
 * Rewrite remote image paths in text to local paths, and fire-and-forget
 * SCP downloads for images not yet on disk.
 *
 * Synchronously rewrites ALL detected paths (so downstream events use local paths).
 * The actual download happens asynchronously — by the time a human looks at the
 * image in the UI, the SCP (~100-500ms on LAN) is complete.
 *
 * @param cache — per-session Map<remotePath, localPath> to avoid re-downloading
 */
export function rewriteRemoteImagePaths(
  text: string,
  sshTarget: SshTarget,
  sessionId: string,
  cache: Map<string, string>,
): string {
  const remotePaths = findRemoteImagePaths(text)
  if (remotePaths.length === 0) return text

  let rewritten = text
  for (const remotePath of remotePaths) {
    // Check cache first
    let localPath = cache.get(remotePath)
    if (!localPath) {
      // Compute local target: ~/.walnut/images/remote/{sessionId}/{filename}
      localPath = path.join(REMOTE_IMAGES_DIR, sessionId, path.basename(remotePath))
      cache.set(remotePath, localPath)

      // If not already downloaded, fire-and-forget SCP
      if (!fs.existsSync(localPath)) {
        downloadRemoteImage(sshTarget, remotePath, localPath).catch(() => {
          // Already logged inside downloadRemoteImage
        })
      }
    }

    rewritten = rewritten.split(remotePath).join(localPath)
  }

  return rewritten
}
