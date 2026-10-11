/**
 * Progress per READ, counted per command (remote-read-bound.ts).
 *
 * A read on a remote host is judged by the bytes reaching it. Counted per host,
 * one slow read kept every other read on the host looking busy: a Files list
 * behind a 600KB file at 8KB/s never asked the link anything and sat until its
 * command's own 30s timeout (gate review, 2026-10-02). So each read runs in a
 * context of its own, and every daemon command sent inside it (DaemonConnection
 * .send) adds how many bytes have reached that command so far: those of the
 * socket its reply rides. A command on the main socket also counts what the
 * link brings ahead of its reply (on one ssh stream the reply waits behind the
 * bulk socket's bytes). A read with no command yet has no count of its own and
 * the caller falls back to the host's.
 *
 * A read's context outlives it: a timer or a loop started inside it (a dial the
 * read set off, that connection's own re-pushes) keeps the context for good. So
 * a settled read is CLOSED (close()): it takes no more commands and lets go of
 * the ones it had, or every background command of that connection would be
 * added to it forever.
 *
 * Zero imports beyond node: the pool and the bound both use it.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** One read's commands, each able to say how many bytes have reached it. */
export class ReadProgress {
  private credits: Array<() => number> = []
  private closed = false

  /** `parent`: the read this one runs inside (a bound read within a bound read); it counts these commands too. */
  constructor(private readonly parent?: ReadProgress) {}

  /** A command sent inside this read: `credit()` is its bytes so far (frozen once it settles). */
  add(credit: () => number): void {
    if (this.closed) return
    this.credits.push(credit)
    this.parent?.add(credit)
  }

  /** The read settled: no command counts for it any more. */
  close(): void {
    this.closed = true
    this.credits = []
  }

  /** Test seam: does it still take commands? */
  get open(): boolean {
    return !this.closed
  }

  /** Commands sent inside this read so far. */
  get commands(): number {
    return this.credits.length
  }

  /** Bytes that reached this read's commands so far; -1 before its first command. */
  bytes(): number {
    if (this.credits.length === 0) return -1
    let n = 0
    for (const credit of this.credits) n += Math.max(0, credit())
    return n
  }
}

const store = new AsyncLocalStorage<ReadProgress>()

/** Run `fn` as the read `progress` counts for (every await inside it included). */
export function runWithReadProgress<T>(progress: ReadProgress, fn: () => T): T {
  return store.run(progress, fn)
}

/** The read the caller runs inside, if any. */
export function currentReadProgress(): ReadProgress | undefined {
  return store.getStore()
}

/** A command was sent: count its bytes for the read it was sent inside, if any. */
export function creditCurrentRead(credit: () => number): void {
  store.getStore()?.add(credit)
}
