/**
 * The model a session's CLI was spawned on, as an e2e test on the MockDaemon proves it.
 *
 * Two facts, both kept after the process is gone: the `--model` the daemon's start
 * command carried (none for Auto), and the record's `cliModel` once the spawn's own
 * persist wrote it (the same persist writes `outputFile`, which nothing clears).
 *
 * Never the record's `pid`: a plain mock turn exits at its result and the runner clears
 * the pid then, so a poll on it raced the turn. Since a40f8c7193 the mock daemon answers
 * the start only once the first line went in, the turn often ended before the first
 * poll, and the waits timed out (quick-start-walnut-agent, mobile-launch-ask).
 * tests/core/spawn-signal-guard.test.ts fails on an e2e wait that reads a record's pid.
 */
import { expect, vi } from 'vitest'
import type { MockDaemon } from './mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'

/** The `--model` value of a start's args, or undefined when it names none. */
export function modelArg(args: readonly string[]): string | undefined {
  const i = args.indexOf('--model')
  return i >= 0 ? args[i + 1] : undefined
}

/** The model the session's first spawn ran on (undefined: Auto), once its record says the same. */
export async function spawnedCliModel(daemon: MockDaemon, sessionId: string, timeout = 10_000): Promise<string | undefined> {
  let seen: string | undefined
  await vi.waitFor(async () => {
    const start = daemon.getStartHistory().find((s) => s.sid === sessionId && !s.resume)
    expect(start, `no start of ${sessionId} reached the daemon`).toBeTruthy()
    const record = await getSessionByClaudeId(sessionId)
    expect(record?.outputFile, 'the spawn has not persisted its record yet').toBeTruthy()
    seen = modelArg(start!.args)
    expect(record!.cliModel).toBe(seen)
  }, { timeout })
  return seen
}
