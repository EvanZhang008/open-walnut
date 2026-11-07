/**
 * Ending a fake child process the way a real one ends: only once someone listens.
 *
 * A real child's `exit` and `close` come from the OS after the parent registered its
 * listeners (the spawn returns synchronously, the events come later). A fake child that
 * emits them after a fixed sleep races the code under test: on a loaded machine its first
 * dynamic import (a cold transform) took longer than the 10 ms sleep, the events went out to
 * nobody, and the run waited for a close that never came until the test timed out
 * (2026-11-07, inline-subagent-slim). Wait for the listener, never for a clock.
 *
 * tests/helpers/fake-child.test.ts fails on a test that emits a fake child's exit or close
 * right after a fixed sleep.
 */
import type { EventEmitter } from 'node:events'

/** Resolves once `ready()` holds, checking after every turn of the event loop. */
export async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Emits the child's `exit` then `close` once the code under test listens for `close`. */
export async function endWhenHeard(proc: EventEmitter, code: number | null = 0, signal: NodeJS.Signals | null = null): Promise<void> {
  await until(() => proc.listenerCount('close') > 0)
  proc.emit('exit', code, signal)
  proc.emit('close', code, signal)
}
