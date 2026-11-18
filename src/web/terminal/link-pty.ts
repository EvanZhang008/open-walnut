/**
 * A terminal whose bytes ride the host's daemon link ('pty-stream-v1',
 * providers/pty-stream-core.ts) instead of a local `ssh -tt`: the `Pty` the
 * terminal manager already drives (src/lib/pty.ts), over a link stream.
 *
 * Same contract as the local pty:
 *  - output is decoded as a UTF-8 stream, so a character split across two
 *    pieces stays whole;
 *  - output that arrives before the first `onData` listener is kept for it;
 *  - the exit is reported after the last output, as `{ exitCode, signal }` with
 *    the signal as this machine's number for its name (0 when none) and exitCode
 *    0 for a signal death. A stream cut without an exit (the link dropped) exits
 *    255, what ssh says when its connection is lost;
 *  - `kill()` hangs the terminal up: the daemon sends SIGHUP and closes the pty,
 *    as an ssh disconnect does. A signal name is accepted for the contract and
 *    always means that hang-up (a remote pty has no other signal to take).
 */
import os from 'node:os'
import type { Pty, PtyExit } from '../../lib/pty.js'
import type { PtyStream } from '../../lib/link-stream.js'

/** The same two the daemon takes (providers/pty-stream-core.ts; tests/web/terminal/locale-env-parity.test.ts keeps them equal). */
const LOCALE_KEY = /^(LANG|LANGUAGE|LC_[A-Z]+)$/
const LOCALE_VALUE = /^[A-Za-z0-9_.@:-]{1,64}$/

/** What ssh's default SendEnv passes on (LANG, LC_*): the remote shell's locale, so its UTF-8 works. */
export function localeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (LOCALE_KEY.test(k) && v && LOCALE_VALUE.test(v)) out[k] = v
  return out
}

/**
 * The terminal on `host` running `command` under the login shell there, through its daemon
 * link (core/hosts/host-terminal.ts dials it as host_exec does, so a terminal never opens on a
 * link that died out of sight).
 */
export async function openLinkPty(host: string, command: string, cols: number, rows: number): Promise<Pty> {
  const { openTerminalStream } = await import('../../core/hosts/host-terminal.js')
  return ptyOverStream(await openTerminalStream(host, command, { cols, rows, env: localeEnv() }))
}

function signalNumber(name: string | null): number {
  if (!name) return 0
  return (os.constants.signals as Record<string, number>)[name] ?? 0
}

/** The `Pty` contract over an open terminal stream. */
export function ptyOverStream(stream: PtyStream): Pty {
  const decoder = new TextDecoder('utf-8')
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(e: PtyExit) => void> = []
  let early: string[] = []
  let exit: PtyExit | null = null

  const emit = (text: string): void => {
    if (!text) return
    if (dataListeners.length === 0) { early.push(text); return }
    for (const listener of dataListeners) listener(text)
  }

  const finish = (): void => {
    if (exit) return
    emit(decoder.decode())
    const e = stream.exit
    exit = e ? { exitCode: e.signal ? 0 : e.code ?? 0, signal: signalNumber(e.signal) } : { exitCode: 255, signal: 0 }
    const done = exit
    for (const listener of exitListeners) listener(done)
    // Its exit came with its end: let go of the stream (the daemon already forgot it).
    if (!stream.destroyed) stream.destroy()
  }

  stream.on('data', (chunk: Buffer) => emit(decoder.decode(chunk, { stream: true })))
  // A cut stream (the link dropped, the daemon hung it up) is reported as its exit, never thrown.
  stream.on('error', () => {})
  stream.on('end', finish)
  stream.on('close', finish)

  return {
    pid: stream.remotePid,
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
      if (!exit && !stream.destroyed && !stream.writableEnded) stream.write(data)
    },
    resize(cols, rows) {
      if (exit) throw new Error('the pty has exited')
      stream.resize(cols, rows)
    },
    kill(_signal?: string) {
      if (!exit && !stream.destroyed) stream.destroy()
    },
  }
}
