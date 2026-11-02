/**
 * Keep a long-lived process alive when nobody reads its stdout or stderr any more.
 *
 * On bun, process.stdout and process.stderr are fs WriteStreams. When their reader
 * is gone (a closed terminal, a parent that piped them and died) the next write
 * fails with EPIPE as an 'error' EVENT on the stream. A try around write() never
 * sees it, and with no listener it is an uncaughtException, which the server
 * treats as fatal. These streams only carry copies (the log file keeps every
 * line), so the guard notes the first failure per stream and drops the rest.
 */
export function guardProcessStdio(onFirstError: (name: 'stdout' | 'stderr', err: NodeJS.ErrnoException) => void): void {
  for (const [name, stream] of [['stdout', process.stdout], ['stderr', process.stderr]] as const) {
    let noted = false
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (noted) return
      // Set first: the note may write to this very stream and fail again.
      noted = true
      try { onFirstError(name, err) } catch { /* a note must never be the crash */ }
    })
  }
}
