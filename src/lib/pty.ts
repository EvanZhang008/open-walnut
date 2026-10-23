/**
 * Pseudo terminals for Walnut: the one place that starts a process on a pty
 * (docs/plan/walnut-single-binary.md). The in-app terminal (src/web/terminal/)
 * is its only user.
 *
 * On bun the pty is built in (`Bun.spawn` with a `terminal`). node-pty loads on
 * bun but its output never arrives (bun 1.4.4: no data event at all, then
 * `ioctl(2) failed, EBADF` on resize), so bun never loads it. Until no Node build
 * of Walnut is left, a process running on Node keeps node-pty.
 *
 * What the bun side does to behave like node-pty:
 *  - output is decoded as a UTF-8 stream, so a character split across two reads
 *    stays whole;
 *  - output that arrives before the first `onData` listener is kept for it;
 *  - the exit is reported after the pty's last output (its EOF, at most
 *    EOF_WAIT_MS after the process ended), as `{ exitCode, signal }` with the
 *    signal as a number (0 when none) and exitCode 0 for a signal death;
 *  - the env is set up as node-pty does (PWD, TERM from `name`), and `kill()`
 *    sends SIGHUP by default.
 */

import os from 'node:os'
import { ON_BUN, bunGlobal } from './runtime.js'

export interface PtyExit {
  exitCode: number
  signal?: number
}

export interface Pty {
  readonly pid: number
  onData(listener: (data: string) => void): void
  onExit(listener: (e: PtyExit) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Signal the process (SIGHUP by default, as node-pty). */
  kill(signal?: string): void
}

export interface PtySpawnOptions {
  /** Terminal name, set as TERM. */
  name?: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface PtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): Pty
}

/**
 * The pty implementation for this runtime. On Node this imports node-pty, which
 * throws when its native binary is missing: callers treat that as "no terminal".
 */
export async function loadPty(): Promise<PtyModule> {
  if (ON_BUN) return { spawn: spawnBun }
  return (await import('@homebridge/node-pty-prebuilt-multiarch')) as unknown as PtyModule
}

// ── bun ─────────────────────────────────────────────────────────────────────

interface BunTerminal {
  write(data: string): number
  resize(cols: number, rows: number): void
  close(): void
}

interface BunSubprocess {
  readonly pid: number
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: string | null
  readonly terminal?: BunTerminal
  kill(signal?: string): void
}

interface BunSpawnOptions {
  cwd?: string
  env: Record<string, string>
  terminal: {
    cols: number
    rows: number
    data(terminal: BunTerminal, bytes: Uint8Array): void
    exit(terminal: BunTerminal): void
  }
}

/** How long an exit waits for the pty's EOF, when a process still holds the pty open. */
const EOF_WAIT_MS = 250

/** Dropped from an inherited env, as node-pty does (tmux, screen, a fixed size). */
const SANITIZED_ENV = ['TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'WINDOWID', 'TERMCAP', 'COLUMNS', 'LINES']

function spawnBun(file: string, args: string[], options: PtySpawnOptions): Pty {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined) env[key] = value
  }
  // As node-pty: the server's own terminal variables never reach a shell that
  // inherits its whole env, PWD names the start dir (a shell trusts PWD over
  // getcwd, which would answer macOS's /private alias of a temp dir), TERM the pty.
  if (!options.env) for (const key of SANITIZED_ENV) delete env[key]
  const cwd = options.cwd ?? process.cwd()
  env.PWD = cwd
  env.TERM = options.name || env.TERM || 'xterm'

  const decoder = new TextDecoder('utf-8')
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(e: PtyExit) => void> = []
  let early: string[] = []
  let eof = false
  let onEof: (() => void) | null = null
  let exit: PtyExit | null = null

  const emit = (text: string): void => {
    if (!text) return
    if (dataListeners.length === 0) { early.push(text); return }
    for (const listener of dataListeners) listener(text)
  }

  const proc = bunGlobal<{ spawn(cmd: string[], opts: BunSpawnOptions): BunSubprocess }>().spawn([file, ...args], {
    cwd,
    env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data: (_terminal, bytes) => emit(decoder.decode(bytes, { stream: true })),
      exit: () => { eof = true; onEof?.() },
    },
  })
  const terminal = proc.terminal
  if (!terminal) {
    proc.kill('SIGKILL')
    throw new Error('bun did not attach a terminal to the process')
  }

  void proc.exited.then(async () => {
    if (!eof) {
      await new Promise<void>((resolve) => {
        onEof = resolve
        setTimeout(resolve, EOF_WAIT_MS).unref?.()
      })
    }
    emit(decoder.decode())
    try { terminal.close() } catch { /* already closed */ }
    const signal = proc.signalCode ? (os.constants.signals as Record<string, number>)[proc.signalCode] ?? 0 : 0
    exit = { exitCode: proc.exitCode ?? 0, signal }
    for (const listener of exitListeners) listener(exit)
  })

  return {
    pid: proc.pid,
    onData(listener) {
      dataListeners.push(listener)
      if (early.length > 0) {
        const kept = early
        early = []
        for (const text of kept) listener(text)
      }
    },
    onExit(listener) {
      exitListeners.push(listener)
      const done = exit
      if (done) queueMicrotask(() => listener(done))
    },
    write(data) {
      if (!exit) terminal.write(data)
    },
    resize(cols, rows) {
      if (exit) throw new Error('the pty has exited')
      terminal.resize(cols, rows)
    },
    kill(signal = 'SIGHUP') {
      if (!exit) proc.kill(signal)
    },
  }
}
