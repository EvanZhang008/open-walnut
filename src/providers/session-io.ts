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
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { JsonlTailer } from '../core/jsonl-tailer.js'
import { SESSION_STREAMS_DIR, REMOTE_IMAGES_DIR } from '../constants.js'
import { log } from '../logging/index.js'

// ── Embedded remote script ──
// walnut-remote.sh is embedded as a string to avoid file path issues with bundlers.
// This script runs independently on the remote machine (nohup) — SSH is only the transport.
const WALNUT_REMOTE_SCRIPT = `#!/bin/bash
# walnut-remote.sh — Independent remote session runner for Walnut.
# Runs as a detached process on the remote machine (nohup).
# SSH only starts it and tails the output — if SSH dies, the session continues.
set -u

REMOTE_DIR="\${WALNUT_REMOTE_DIR:-/tmp/walnut-streams}"
ACTION="\${1:-}"
SESSION_ID="\${2:-}"

if [ -z "$ACTION" ] || [ -z "$SESSION_ID" ]; then
  echo "Usage: walnut-remote.sh {start|status|stop} <session-id> [cwd] [claude-args...]" >&2
  exit 1
fi

PIPE="$REMOTE_DIR/$SESSION_ID.pipe"
JSONL="$REMOTE_DIR/$SESSION_ID.jsonl"
PGID="$REMOTE_DIR/$SESSION_ID.pgid"
LOG="$REMOTE_DIR/$SESSION_ID.log"
ERR="$REMOTE_DIR/$SESSION_ID.err"

log() { echo "[\$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

do_status() {
  if [ ! -f "$PGID" ]; then echo "no-pgid"; exit 0; fi
  local pid; pid=\$(cat "$PGID" 2>/dev/null)
  if [ -z "$pid" ]; then echo "empty-pgid"; exit 0; fi
  if kill -0 "$pid" 2>/dev/null; then echo "running:$pid"; else echo "dead:$pid"; fi
}

do_stop() {
  if [ ! -f "$PGID" ]; then log "stop: no PGID file"; exit 0; fi
  local pid; pid=\$(cat "$PGID" 2>/dev/null)
  if [ -z "$pid" ] || [ "$pid" -le 1 ] 2>/dev/null; then
    log "stop: invalid PID: $pid"; rm -f "$PGID"; exit 0
  fi
  log "stop: sending SIGINT to claude PID=$pid"
  kill -INT "$pid" 2>/dev/null
  local i=0
  while [ $i -lt 25 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.2; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    log "stop: SIGINT timeout, sending SIGTERM"; kill -TERM "$pid" 2>/dev/null; sleep 1
  fi
  rm -f "$PGID" "$PIPE"; log "stop: done"
}

do_start() {
  local CWD="\${3:-\$HOME}"
  shift 3 2>/dev/null || shift $# 2>/dev/null
  local CLAUDE_ARGS="$*"

  mkdir -p "$REMOTE_DIR"
  log "=== session start ==="
  log "PID=$$, session=$SESSION_ID, cwd=$CWD"
  log "claude args: $CLAUDE_ARGS"

  if [ ! -d "$CWD" ]; then
    log "ERROR: CWD not found: $CWD"; echo "walnut: CWD not found: $CWD" >&2; exit 1
  fi
  cd "$CWD" || { log "ERROR: cd failed: $CWD"; exit 1; }
  log "working directory: \$(pwd)"

  rm -f "$PIPE"
  mkfifo "$PIPE" || { log "ERROR: mkfifo failed"; exit 1; }
  log "FIFO created: $PIPE"

  sleep infinity > "$PIPE" &
  WRITER_PID=$!
  log "writer started PID=$WRITER_PID"

  claude $CLAUDE_ARGS < "$PIPE" > "$JSONL" 2>"$ERR" &
  CLAUDE_PID=$!
  log "claude started PID=$CLAUDE_PID"
  echo $CLAUDE_PID > "$PGID"
  log "PGID file written: $PGID"

  EXIT_CODE=0
  cleanup() {
    local sig="\${1:-EXIT}"
    log "cleanup triggered (signal=$sig)"
    kill -INT $CLAUDE_PID 2>/dev/null
    local i=0
    while [ $i -lt 10 ] && kill -0 $CLAUDE_PID 2>/dev/null; do sleep 0.5; i=$((i + 1)); done
    if kill -0 $CLAUDE_PID 2>/dev/null; then
      log "cleanup: SIGINT timeout, sending SIGTERM"; kill -TERM $CLAUDE_PID 2>/dev/null; sleep 1
    fi
    kill $WRITER_PID 2>/dev/null
    rm -f "$PGID" "$PIPE"
    log "=== session end (signal=$sig, exit=$EXIT_CODE) ==="
  }
  trap 'cleanup HUP' HUP
  trap 'cleanup TERM' TERM
  trap 'cleanup INT' INT

  wait $CLAUDE_PID 2>/dev/null
  EXIT_CODE=$?
  log "claude exited code=$EXIT_CODE"
  kill $WRITER_PID 2>/dev/null
  rm -f "$PGID" "$PIPE"
  log "=== session end (normal, exit=$EXIT_CODE) ==="
}

case "$ACTION" in
  start)  do_start "$@" ;;
  status) do_status ;;
  stop)   do_stop ;;
  *)      echo "Unknown action: $ACTION" >&2; exit 1 ;;
esac
`

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

    // Touch the output file so health monitor sees a fresh mtime on resume.
    // Opening in append mode doesn't update mtime — the health monitor would
    // see the old mtime from the previous turn and kill the just-spawned process.
    if (append) {
      const now = new Date()
      try { fs.utimesSync(this._outputFile, now, now) } catch (e) {
        log.session.warn('failed to touch output file mtime on resume', { file: this._outputFile, error: String(e) })
      }
    }

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
 * Base PATH setup + node auto-discovery for remote SSH commands.
 *
 * Non-interactive SSH doesn't load shell profiles, so node version managers
 * (nvm, fnm, volta, asdf) aren't activated. This preamble auto-detects them.
 *
 * Guard: if `node` is already in PATH, the entire if-block is skipped (zero overhead).
 * Order: nvm (most popular) > fnm > volta > asdf/mise.
 */
export const REMOTE_BASE_PATH = [
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
  // Source the user's shell RC file to get their full environment (nvm, pyenv,
  // conda, rbenv, etc.) — just like their interactive terminal/tmux session.
  //
  // Why: `$SHELL -lc` only sources .zprofile/.profile, NOT .bashrc/.zshrc.
  // Most tools (nvm, pyenv, conda) are configured in .bashrc/.zshrc.
  // Explicitly sourcing the RC file fills this gap.
  //
  // Why not `-i` flag? Interactive mode causes plugins (oh-my-zsh, iTerm2,
  // p10k) to write escape codes to STDOUT, corrupting our JSONL stream.
  //
  // Match RC file to $SHELL: zsh sources .zshrc, bash sources .bashrc.
  // Redirect >/dev/null 2>&1: suppress all output from interactive plugins
  // while preserving PATH/env changes (process-level, not stdout-level).
  //
  // Note: some RC files have interactive guards ([[ $- != *i* ]] && return)
  // that skip setup in non-interactive mode. The fallback chain below handles
  // that case. RC sourcing still helps for pyenv, conda, and other tools
  // that don't guard on interactivity.
  'case "$SHELL" in'
    + ' */zsh) [ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc" >/dev/null 2>&1 ;;'
    + ' */bash) [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 ;;'
    + ' esac',
  // Fallback auto-discovery if the RC file didn't provide node (e.g., no RC file,
  // interactive guard skipped setup, or nvm default is broken).
  // Tries nvm > fnm > volta > asdf. All stdout suppressed to avoid JSONL pollution.
  // Use `||` instead of `if !` — zsh non-interactive mode has issues with `if ! cmd`.
  // Ends with `true` to ensure exit code 0 for downstream `&&` chains.
  'command -v node >/dev/null 2>&1 || {'
    + ' if [ -s "$HOME/.nvm/nvm.sh" ]; then'
    + '   . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1;'
    + '   command -v node >/dev/null 2>&1 || {'
    + '     for v in $(ls -1r "$NVM_DIR/versions/node/" 2>/dev/null); do'
    + '       nvm use --delete-prefix "$v" >/dev/null 2>&1 && node -v >/dev/null 2>&1 && break;'
    + '     done; };'
    + ' elif [ -x "$HOME/.fnm/fnm" ]; then eval "$("$HOME/.fnm/fnm" env)" >/dev/null 2>&1;'
    + ' elif [ -d "$HOME/.volta" ]; then export PATH="$HOME/.volta/bin:$PATH";'
    + ' elif [ -s "$HOME/.asdf/asdf.sh" ]; then . "$HOME/.asdf/asdf.sh" >/dev/null 2>&1;'
    + ' fi;'
    + ' true; }',
].join('; ')

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
    // IMPORTANT: Use { ...; } (group command) NOT (...) (subshell).
    // Tools like nvm/fnm modify PATH — subshell changes are lost on exit.
    parts.push(`{ ${shellSetup}; } 2>/dev/null || true`)
  }
  return parts.join('; ')
}

/**
 * Wrap a remote command to run inside the user's login shell.
 *
 * Uses `$SHELL -lc` (login + command). This sources `.zprofile`/`.profile`
 * but NOT `.bashrc`/`.zshrc` (those require interactive mode).
 *
 * We intentionally do NOT use `-i` (interactive) because:
 *   - SSH stdout is our data channel (JSONL stream from remote claude)
 *   - Interactive plugins (iTerm2 shell integration, oh-my-zsh, p10k)
 *     emit escape codes to stdout, corrupting the JSONL stream
 *   - This is an architecture conflict, not a fixable side effect
 *
 * Instead, node/tools are found via:
 *   1. REMOTE_BASE_PATH auto-discovery (nvm > fnm > volta > asdf)
 *   2. User's `shell_setup` config for edge cases
 */
export function wrapInLoginShell(cmd: string, shellSetup?: string): string {
  const parts: string[] = []
  if (shellSetup) {
    // IMPORTANT: Use { ...; } (group command) NOT (...) (subshell).
    // Tools like nvm/fnm modify PATH — subshell changes are lost on exit.
    parts.push(`{ ${shellSetup}; } 2>/dev/null || true`)
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
    return `{ cd ${shellQuote(cwd)} || exit 1; } && ${claudeCmd}`
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
  /** Remote PID file path — stores the claude process PID for remote kill/cleanup. */
  private remotePgidPath: string | null = null
  /** Remote log file path — structured debug log written by walnut-remote.sh. */
  private remoteLogPath: string | null = null
  private _localOutputFile: string
  private tailProc: ChildProcess | null = null
  private tailer: JsonlTailer | null = null
  private _onLine: ((line: string) => void) | null = null
  private _tailOffset = 0
  private sshTarget: SshTarget
  private _hasPipe = false
  /** SSH PID monitoring the tail -f connection. Tracked for reconnect. */
  private _tailSshPid: number | null = null
  /** Whether a reconnect attempt is already in progress (prevents races). */
  private _reconnecting = false

  /** Remote directory where transferred images are stored (for cleanup). */
  remoteImagesDir?: string

  /** Expose SSH target for downstream consumers (e.g. remote image download). */
  get target(): SshTarget {
    return this.sshTarget
  }

  /** PID of the SSH process tailing remote JSONL (for liveness monitoring). */
  get tailSshPid(): number | null {
    return this._tailSshPid
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
   * Set up remote session using an independent script.
   *
   * Architecture (decoupled from SSH lifecycle):
   *   Step 1: Deploy walnut-remote.sh to remote (~50 lines, <0.1s)
   *   Step 2: Start script via SSH (nohup — detached, survives SSH drop)
   *   Step 3: Write initial message to remote FIFO (if any)
   *   Step 4: Return SSH tail args for caller to spawn the viewer process
   *
   * The SSH process spawned by the caller is ONLY a viewer (tail -f).
   * If it dies (SSH drop, network hiccup), the remote session continues.
   * Walnut can reconnect via reconnectTail() without --resume.
   *
   * @param append — when true, open the LOCAL output file in append mode.
   */
  setupRemote(claudeArgs: string[], cwd?: string, initialMessage?: string, append?: boolean): {
    sshArgs: string[]
    localOutputFd: number
    localStderrFd: number
  } {
    const t0 = Date.now()

    // Pre-flight: ensure SSH agent has a valid (non-expired) cert.
    // mwinit writes fresh certs to disk but doesn't flush old ones from the agent.
    // A long-running ssh-agent accumulates expired certs that cause intermittent
    // "Permission denied (publickey)" when the server tries an expired cert first.
    try {
      const certCheck = execFileSync('ssh-add', ['-L'], { encoding: 'utf-8', timeout: 5000 })
      const certLines = certCheck.split('\n').filter(l => l.includes('cert-v01'))
      if (certLines.length > 1) {
        log.session.info('RemoteIO: flushing stale SSH agent certs', { certCount: certLines.length })
        execFileSync('ssh-add', ['-D'], { timeout: 5000, stdio: 'pipe' })
        execFileSync('ssh-add', [path.join(os.homedir(), '.ssh', 'id_ecdsa')], { timeout: 5000, stdio: 'pipe' })
      }
    } catch (e) {
      log.session.debug('RemoteIO: SSH agent pre-flight check failed (non-fatal)', {
        error: e instanceof Error ? e.message : String(e),
      })
    }

    const remoteDir = '/tmp/walnut-streams'
    const tmpId = path.basename(this._localOutputFile, '.jsonl')
    this.remotePipePath = `${remoteDir}/${tmpId}.pipe`
    this.remoteOutputPath = `${remoteDir}/${tmpId}.jsonl`
    this.remotePgidPath = `${remoteDir}/${tmpId}.pgid`
    this.remoteLogPath = `${remoteDir}/${tmpId}.log`

    const hostString = this.sshTarget.user
      ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
      : this.sshTarget.hostname
    const baseSshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=15',
    ]
    if (this.sshTarget.port) baseSshArgs.push('-p', String(this.sshTarget.port))

    // ── Step 1: Deploy walnut-remote.sh to remote ──
    // Deploy via "ssh cat > file" — faster than scp and doesn't need scp binary.
    // Script is embedded as a string constant (WALNUT_REMOTE_SCRIPT) to avoid
    // file path issues with bundlers (tsup puts everything in dist/).
    const scriptPath = `${remoteDir}/walnut-remote.sh`
    const scriptContent = WALNUT_REMOTE_SCRIPT
    try {
      execFileSync('ssh', [
        ...baseSshArgs, hostString,
        `mkdir -p ${shellQuote(remoteDir)} && cat > ${shellQuote(scriptPath)} && chmod +x ${shellQuote(scriptPath)}`,
      ], {
        input: scriptContent,
        timeout: 15_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      log.session.debug('RemoteIO: deployed walnut-remote.sh', { host: this.host })
    } catch (e) {
      log.session.error('RemoteIO: failed to deploy walnut-remote.sh', {
        host: this.host,
        error: e instanceof Error ? e.message : String(e),
      })
      throw new Error(`Failed to deploy remote script to ${hostString}: ${e instanceof Error ? e.message : String(e)}`)
    }

    const deployMs = Date.now() - t0

    // ── Step 2: Start script on remote (nohup — survives SSH drop) ──
    // The script creates FIFO, starts claude, writes PGID, handles signals.
    const quotedArgs = claudeArgs.map((a) => shellQuote(a)).join(' ')
    const quotedCwd = shellQuote(cwd ?? '$HOME')
    // The remote script needs PATH setup to find `claude` binary.
    // buildRemotePreamble handles base PATH; wrapInLoginShell handles shell_setup.
    // Only pass shell_setup to one of them to avoid running it twice.
    const preamble = buildRemotePreamble()
    const startCmd = `${preamble} && CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 nohup bash ${shellQuote(scriptPath)} start ${shellQuote(tmpId)} ${quotedCwd} ${quotedArgs} </dev/null >/dev/null 2>&1 &`
    const wrappedStartCmd = wrapInLoginShell(startCmd, this.sshTarget.shell_setup)

    try {
      execFileSync('ssh', [...baseSshArgs, hostString, wrappedStartCmd], {
        timeout: 15_000,
        stdio: 'pipe',
      })
      log.session.debug('RemoteIO: remote script started', { host: this.host, sessionId: tmpId })
    } catch (e) {
      log.session.error('RemoteIO: failed to start remote script', {
        host: this.host, sessionId: tmpId,
        error: e instanceof Error ? e.message : String(e),
      })
      throw new Error(`Failed to start remote session on ${hostString}: ${e instanceof Error ? e.message : String(e)}`)
    }

    const startMs = Date.now() - t0

    // ── Step 3: Wait for FIFO to be ready, then write initial message ──
    // The script creates the FIFO synchronously before starting claude,
    // but nohup may not have executed yet. Brief poll for the FIFO.
    if (initialMessage) {
      const payload = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: initialMessage },
      })
      // Wait up to 3s for the FIFO to appear (script creates it immediately)
      const waitCmd = `for i in 1 2 3 4 5 6; do [ -p ${shellQuote(this.remotePipePath)} ] && break; sleep 0.5; done; [ -p ${shellQuote(this.remotePipePath)} ] && printf '%s\\n' ${shellQuote(payload)} > ${shellQuote(this.remotePipePath)}`
      try {
        execFileSync('ssh', [...baseSshArgs, hostString, waitCmd], {
          timeout: 15_000,
          stdio: 'pipe',
        })
        log.session.debug('RemoteIO: initial message written', { host: this.host, messageLength: initialMessage.length })
      } catch (e) {
        log.session.warn('RemoteIO: failed to write initial message (session may not start)', {
          host: this.host,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    const msgMs = Date.now() - t0

    // ── Step 4: Build tail SSH args (viewer — the process caller spawns) ──
    // Wait for JSONL file to appear (script creates it when claude starts)
    const tailCmd = `for i in 1 2 3 4 5 6 7 8 9 10; do [ -f ${shellQuote(this.remoteOutputPath)} ] && break; sleep 0.5; done; tail -f -c +1 ${shellQuote(this.remoteOutputPath)}`

    const sshArgs = [
      ...baseSshArgs,
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      hostString, tailCmd,
    ]

    // Local output file — SSH stdout (remote tail -f) goes here
    const localOutputFd = fs.openSync(this._localOutputFile, append ? 'a' : 'w')
    const localStderrFd = fs.openSync(this._localOutputFile + '.err', append ? 'a' : 'w')

    if (append) {
      const now = new Date()
      try { fs.utimesSync(this._localOutputFile, now, now) } catch (e) {
        log.session.warn('failed to touch output file mtime on resume', { file: this._localOutputFile, error: String(e) })
      }
    }

    this._hasPipe = true

    log.session.info('RemoteIO: SSH session setup (script-based)', {
      host: this.host,
      hostString,
      cwd: cwd ?? '(default)',
      remotePipe: this.remotePipePath,
      remoteJsonl: this.remoteOutputPath,
      remoteLog: this.remoteLogPath,
      localOutputFile: this._localOutputFile,
      append: append ?? false,
      hasInitialMessage: !!initialMessage,
      initialMessageLength: initialMessage?.length ?? 0,
      deployMs,
      startMs,
      msgMs,
      totalMs: Date.now() - t0,
    })

    return { sshArgs, localOutputFd, localStderrFd }
  }

  /**
   * Reconnect the tail -f SSH process after a disconnect.
   *
   * The remote session continues running independently (started via nohup).
   * This just spawns a new SSH process to resume tailing the JSONL output.
   *
   * @param fromOffset — byte offset in the LOCAL output file. The remote JSONL
   *   is tailed from the equivalent position using `tail -f -c +{offset}`.
   * @returns The spawned SSH process, or null if reconnect failed.
   */
  reconnectTail(fromOffset?: number): ChildProcess | null {
    if (this._reconnecting) {
      log.session.debug('RemoteIO: reconnect already in progress, skipping', { host: this.host })
      return null
    }
    if (!this.remoteOutputPath) {
      log.session.warn('RemoteIO: cannot reconnect — no remote output path', { host: this.host })
      return null
    }

    this._reconnecting = true

    const hostString = this.sshTarget.user
      ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
      : this.sshTarget.hostname
    const baseSshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
    ]
    if (this.sshTarget.port) baseSshArgs.push('-p', String(this.sshTarget.port))

    // Use byte offset to avoid re-reading already-received data.
    // +1 because tail -c +N is 1-based (byte N from start, not 0-based).
    const offset = (fromOffset ?? 0) + 1
    const tailCmd = `tail -f -c +${offset} ${shellQuote(this.remoteOutputPath)}`

    // Append to existing local output file (don't truncate!)
    const localOutputFd = fs.openSync(this._localOutputFile, 'a')
    const localStderrFd = fs.openSync(this._localOutputFile + '.err', 'a')

    try {
      const proc = spawn('ssh', [...baseSshArgs, hostString, tailCmd], {
        detached: true,
        stdio: ['pipe', localOutputFd, localStderrFd],
      })
      proc.stdin?.end()
      fs.closeSync(localOutputFd)
      fs.closeSync(localStderrFd)
      proc.unref()

      this._tailSshPid = proc.pid ?? null

      log.session.info('RemoteIO: tail reconnected', {
        host: this.host,
        pid: proc.pid,
        fromOffset: offset,
        localFile: this._localOutputFile,
      })

      this._reconnecting = false
      return proc
    } catch (e) {
      fs.closeSync(localOutputFd)
      fs.closeSync(localStderrFd)
      log.session.error('RemoteIO: tail reconnect failed', {
        host: this.host,
        error: e instanceof Error ? e.message : String(e),
      })
      this._reconnecting = false
      return null
    }
  }

  /**
   * Check if the remote session process is still alive (via PGID file).
   * Returns: 'running', 'dead', 'no-pgid', 'error'
   */
  async checkRemoteAlive(): Promise<'running' | 'dead' | 'no-pgid' | 'error'> {
    if (!this.remotePgidPath) return 'no-pgid'

    const hostString = this.sshTarget.user
      ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
      : this.sshTarget.hostname
    const baseSshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10']
    if (this.sshTarget.port) baseSshArgs.push('-p', String(this.sshTarget.port))

    const scriptPath = `/tmp/walnut-streams/walnut-remote.sh`
    const sessionId = path.basename(this.remotePgidPath, '.pgid')
    // Use the remote script's `status` command, with a direct PGID+kill-0 fallback
    // in case the script is missing (e.g., /tmp was cleaned).
    const cmd = `bash ${shellQuote(scriptPath)} status ${shellQuote(sessionId)} 2>/dev/null || { pid=$(cat ${shellQuote(this.remotePgidPath)} 2>/dev/null); [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "running:$pid" || echo "dead:$pid"; }`

    try {
      const result = await new Promise<string>((resolve, reject) => {
        execFile('ssh', [...baseSshArgs, hostString, cmd], {
          timeout: 10_000,
          encoding: 'utf-8',
        }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()))
      })

      if (result.startsWith('running:')) return 'running'
      if (result.startsWith('dead:')) return 'dead'
      if (result === 'no-pgid' || result === 'empty-pgid') return 'no-pgid'
      return 'error'
    } catch {
      return 'error'
    }
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
    log.session.info('RemoteIO: tailer started', {
      host: this.host,
      file: this._localOutputFile,
      fromOffset: fromOffset ?? 0,
    })
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
        // Rename FIFO + PGID + LOG files in a single SSH command
        const renameParts = [`mv ${shellQuote(oldRemotePipe)} ${shellQuote(newRemotePipe)} 2>/dev/null`]
        if (this.remotePgidPath) {
          const newRemotePgid = `${remoteDir}/${sessionId}.pgid`
          if (this.remotePgidPath !== newRemotePgid) {
            renameParts.push(`mv ${shellQuote(this.remotePgidPath)} ${shellQuote(newRemotePgid)} 2>/dev/null`)
            this.remotePgidPath = newRemotePgid
          }
        }
        if (this.remoteLogPath) {
          const newRemoteLog = `${remoteDir}/${sessionId}.log`
          if (this.remoteLogPath !== newRemoteLog) {
            renameParts.push(`mv ${shellQuote(this.remoteLogPath)} ${shellQuote(newRemoteLog)} 2>/dev/null`)
            this.remoteLogPath = newRemoteLog
          }
        }
        const renameCmd = renameParts.join('; ')
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
    this.remotePgidPath = `${remoteDir}/${sessionId}.pgid`
    this.remoteLogPath = `${remoteDir}/${sessionId}.log`
    this._hasPipe = true  // Optimistic — write() will detect if it's gone
    log.session.debug('RemoteIO: recovered pipe paths (optimistic)', {
      host: this.host,
      remotePipe: this.remotePipePath,
      remoteJsonl: this.remoteOutputPath,
      remoteLog: this.remoteLogPath,
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

  /**
   * Gracefully stop all remote processes — mirrors local gracefulStop() logic.
   * Phase 1: SIGINT to remote claude PID (saves session state).
   * Phase 2 (deferred 5s): SIGTERM fallback + PGID file cleanup.
   * Fire-and-forget — does NOT block. Local gracefulStop() handles polling.
   */
  gracefulStopRemote(): void {
    if (!this.remotePgidPath) return

    const pgidPath = this.remotePgidPath
    const hostString = this.sshTarget.user
      ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
      : this.sshTarget.hostname
    const baseSshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10']
    if (this.sshTarget.port) baseSshArgs.push('-p', String(this.sshTarget.port))

    log.session.info('RemoteIO: gracefulStopRemote — sending SIGINT to remote claude', {
      host: this.host, pgidPath,
    })

    // Phase 1: SIGINT to claude (graceful — saves session state)
    const sigintCmd = `pid=$(cat ${shellQuote(pgidPath)} 2>/dev/null) && [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && kill -INT $pid 2>/dev/null`
    try {
      const proc = spawn('ssh', [...baseSshArgs, hostString, sigintCmd], { detached: true, stdio: 'ignore' })
      proc.unref()
    } catch {
      log.session.debug('RemoteIO: gracefulStopRemote SIGINT spawn failed', { host: this.host })
    }

    // Phase 2: deferred SIGTERM + cleanup (5s later, fire-and-forget)
    const sigtermCmd = `pid=$(cat ${shellQuote(pgidPath)} 2>/dev/null) && [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && kill -TERM $pid 2>/dev/null; rm -f ${shellQuote(pgidPath)}`
    setTimeout(() => {
      try {
        const proc = spawn('ssh', [...baseSshArgs, hostString, sigtermCmd], { detached: true, stdio: 'ignore' })
        proc.unref()
      } catch { /* non-fatal */ }
    }, 5_000)
  }

  /**
   * Force-kill remote claude process — sends SIGTERM and cleans up PGID file.
   * Fire-and-forget.
   */
  killRemote(): void {
    if (!this.remotePgidPath) return

    const pgidPath = this.remotePgidPath
    const hostString = this.sshTarget.user
      ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
      : this.sshTarget.hostname
    const baseSshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10']
    if (this.sshTarget.port) baseSshArgs.push('-p', String(this.sshTarget.port))

    log.session.info('RemoteIO: killRemote — sending SIGTERM to remote claude', {
      host: this.host, pgidPath,
    })

    const cmd = `pid=$(cat ${shellQuote(pgidPath)} 2>/dev/null) && [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && kill -TERM $pid 2>/dev/null; rm -f ${shellQuote(pgidPath)}`
    try {
      const proc = spawn('ssh', [...baseSshArgs, hostString, cmd], { detached: true, stdio: 'ignore' })
      proc.unref()
    } catch { /* non-fatal */ }
  }

  /**
   * Kill a remote session by its session ID — reads the PGID file and sends SIGTERM.
   * Used by the health monitor when it doesn't have a live RemoteIO instance.
   * Fire-and-forget.
   */
  static killRemoteBySessionId(sshTarget: SshTarget, sessionId: string): void {
    const pgidPath = `/tmp/walnut-streams/${sessionId}.pgid`
    const hostString = sshTarget.user
      ? `${sshTarget.user}@${sshTarget.hostname}`
      : sshTarget.hostname
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10']
    if (sshTarget.port) sshArgs.push('-p', String(sshTarget.port))

    const cmd = `pid=$(cat ${shellQuote(pgidPath)} 2>/dev/null) && [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && kill -TERM $pid 2>/dev/null; rm -f ${shellQuote(pgidPath)}`
    sshArgs.push(hostString, cmd)

    log.session.info('RemoteIO: killRemoteBySessionId', { host: hostString, sessionId, pgidPath })

    try {
      const proc = spawn('ssh', sshArgs, { detached: true, stdio: 'ignore' })
      proc.unref()
    } catch { /* non-fatal */ }
  }

  /**
   * Sweep a remote host for orphaned PGID files and kill their processes.
   * Compares PGID filenames against known session IDs in the registry.
   * Returns the number of orphans cleaned up.
   */
  static async sweepRemoteOrphans(sshTarget: SshTarget, knownSessionIds: Set<string>): Promise<number> {
    const hostString = sshTarget.user
      ? `${sshTarget.user}@${sshTarget.hostname}`
      : sshTarget.hostname
    const baseSshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10']
    if (sshTarget.port) baseSshArgs.push('-p', String(sshTarget.port))

    const remoteDir = '/tmp/walnut-streams'

    // List all PGID files on the remote host (async to avoid blocking event loop)
    let listing: string
    try {
      listing = await new Promise<string>((resolve, reject) => {
        execFile('ssh', [...baseSshArgs, hostString, `ls ${remoteDir}/*.pgid 2>/dev/null || true`], {
          timeout: 15_000,
          encoding: 'utf-8',
        }, (err, stdout) => err ? reject(err) : resolve(stdout))
      })
    } catch {
      return 0  // SSH failed — will retry next sweep
    }

    const pgidFiles = listing.trim().split('\n').filter(Boolean)
    if (pgidFiles.length === 0) return 0

    // Batch all orphan kill+cleanup into a single SSH command per host
    const orphanFiles: string[] = []
    for (const pgidFile of pgidFiles) {
      const basename = path.basename(pgidFile, '.pgid')
      if (knownSessionIds.has(basename)) continue
      orphanFiles.push(pgidFile)
      log.session.info('RemoteIO: sweepRemoteOrphans — cleaning orphan', {
        host: hostString, pgidFile, sessionId: basename,
      })
    }

    if (orphanFiles.length === 0) return 0

    // Single SSH command kills all orphans — avoids N+1 SSH calls.
    // PID validation: check numeric and > 1 to avoid killing init.
    const killCmds = orphanFiles.map(f =>
      `pid=$(cat ${shellQuote(f)} 2>/dev/null); [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && kill -TERM $pid 2>/dev/null; rm -f ${shellQuote(f)}`
    ).join('; ')

    try {
      await new Promise<void>((resolve, reject) => {
        execFile('ssh', [...baseSshArgs, hostString, killCmds], {
          timeout: 15_000,
        }, (err) => err ? reject(err) : resolve())
      })
    } catch { /* non-fatal */ }

    return orphanFiles.length
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
      // Delete JSONL + PGID + LOG + ERR files in a single SSH command
      const rmTargets = [shellQuote(jsonlToDelete)]
      if (this.remotePgidPath) rmTargets.push(shellQuote(this.remotePgidPath))
      if (this.remoteLogPath) rmTargets.push(shellQuote(this.remoteLogPath))
      rmTargets.push(shellQuote(jsonlToDelete + '.err'))
      log.session.debug('RemoteIO: deleting remote files (fire-and-forget)', {
        host: this.host,
        remoteJsonl: jsonlToDelete,
        remotePgid: this.remotePgidPath,
        remoteLog: this.remoteLogPath,
      })
      const sshArgs = [...baseSshArgs, hostString, `rm -f ${rmTargets.join(' ')}`]
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
 * Relative image filename regex — matches bare filenames like `screenshot.png`
 * or relative paths like `subdir/img.png` (NOT starting with /).
 * Boundaries include backtick (Claude Code wraps filenames in backticks).
 */
const RELATIVE_IMAGE_RE = new RegExp(
  `(?:^|[\\s"'\`=:(])` +                           // boundary before
  `((?:[\\w][\\w.-]*/)*[\\w][\\w.-]*\\.(?:${IMG_EXT}))` + // capture: filename
  `(?=[\\s"'\`),;\\]}]|$)`,                         // boundary after (lookahead)
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
 * Find relative image filenames in text (e.g. `screenshot.png`, `subdir/img.jpg`).
 * Only returns names that do NOT start with `/` (absolute paths handled separately).
 */
export function findRelativeImageNames(text: string): string[] {
  const found = new Set<string>()
  let m: RegExpExecArray | null
  RELATIVE_IMAGE_RE.lastIndex = 0
  while ((m = RELATIVE_IMAGE_RE.exec(text)) !== null) {
    const p = m[1]
    if (!p.startsWith('/')) found.add(p)
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
 * When `cwd` is provided, also detects relative image filenames (e.g. `screenshot.png`)
 * and resolves them against the remote CWD before downloading.
 *
 * @param cache — per-session Map<remotePath, localPath> to avoid re-downloading
 * @param cwd — session working directory on the remote host (for relative filename resolution)
 */
export function rewriteRemoteImagePaths(
  text: string,
  sshTarget: SshTarget,
  sessionId: string,
  cache: Map<string, string>,
  cwd?: string,
): string {
  let rewritten = text

  // Pass 1: absolute remote paths (existing behavior)
  const remotePaths = findRemoteImagePaths(text)
  for (const remotePath of remotePaths) {
    let localPath = cache.get(remotePath)
    if (!localPath) {
      localPath = path.join(REMOTE_IMAGES_DIR, sessionId, path.basename(remotePath))
      cache.set(remotePath, localPath)

      if (!fs.existsSync(localPath)) {
        downloadRemoteImage(sshTarget, remotePath, localPath).catch(() => {})
      }
    }
    rewritten = rewritten.split(remotePath).join(localPath)
  }

  // Pass 2: relative image filenames resolved against remote CWD
  if (cwd) {
    const relNames = findRelativeImageNames(rewritten)
    for (const relName of relNames) {
      const absoluteRemote = `${cwd.replace(/\/$/, '')}/${relName}`
      // Skip if this absolute path was already handled in pass 1
      if (cache.has(absoluteRemote)) continue

      let localPath = cache.get(`rel:${relName}`)
      if (!localPath) {
        localPath = path.join(REMOTE_IMAGES_DIR, sessionId, path.basename(relName))
        cache.set(`rel:${relName}`, localPath)

        if (!fs.existsSync(localPath)) {
          downloadRemoteImage(sshTarget, absoluteRemote, localPath).catch(() => {})
        }
      }
      // Rewrite relative name → local absolute path in the text
      // Use regex to avoid partial matches (e.g. don't match inside a longer path)
      const escaped = relName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const nameRe = new RegExp(`(?<=^|[\\s"'\`=:(])${escaped}(?=[\\s"'\`),;\\]}]|$)`, 'g')
      rewritten = rewritten.replace(nameRe, localPath)
    }
  }

  return rewritten
}
