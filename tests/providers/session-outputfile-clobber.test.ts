/**
 * Regression: the session-id rename must not wipe `outputFile`.
 *
 * BUG (found 2026-07-25). Every session — local included — now runs through the
 * daemon, and `RemoteSessionManager.outputFile` is a hardcoded `null` by design
 * (the JSONL lives wherever the daemon put it, so there is no local path). The
 * real value is the `remote://<host>/<sid>` sentinel returned by
 * `transport.start()`, which ClaudeCodeSession stores when the spawn resolves.
 *
 * On the init event the session renames the transport for the real session id and
 * then re-reads `this._transport.outputFile` — picking up that hardcoded null and
 * OVERWRITING the good sentinel. Observed timeline for a local session:
 *
 *   t+0ms    outputFile = null            (spawn not resolved yet)
 *   t+50ms   outputFile = remote://…      (correct — from transport.start())
 *   t+800ms  outputFile = null            (clobbered by the rename path)
 *
 * Why it matters: `outputFile` is threaded into readSessionHistory,
 * computeSessionChanges/GitDiff, session projection and the health monitor. The
 * codebase already carries a BACKFILL for "local session whose outputFile column
 * is empty" in src/core/session-reconciler.ts, and a comment there records that a
 * previous outputFile gate made the reconciler mark live sessions 'stopped' and
 * the orphan sweeper SIGTERM real CLI processes. That backfill treats the symptom;
 * this test pins the cause.
 *
 * The fix belongs in src/providers/claude-code-session.ts (do not re-read
 * `transport.outputFile` after renameForSession — keep the value from start(), or
 * make the daemon transport return the sentinel from its getter). That file has
 * uncommitted work from another agent, so this test lands first and documents the
 * contract; it is expected to FAIL until the clobber is removed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')

let daemon: MockDaemon

beforeAll(async () => {
  daemon = await createMockDaemon()
})

afterAll(async () => {
  await daemon.stop()
})

describe('outputFile survives the session-id rename', () => {
  it('stays a remote:// sentinel after the init event renames the transport', async () => {
    const session = new ClaudeCodeSession('outputfile-clobber', 'proj', MOCK_CLI)
    ;(session as unknown as { _testDaemonUrl?: string })._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`

    session.send('hello')

    // Wait for the spawn to resolve and set the sentinel.
    for (let i = 0; i < 100 && !session.outputFile; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(session.outputFile, 'spawn should publish a remote:// sentinel').toMatch(/^remote:\/\//)

    // Now let the init event (and its renameForSession) land. The value must NOT
    // revert to null — polling rather than one fixed sleep so this pins the
    // invariant instead of a timing coincidence.
    //
    // Assert on the raw value, not with toMatch(): once clobbered the value is
    // literally `null`, and toMatch on null reports the useless
    // ".toMatch() expects a string, but got object" instead of the real problem.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 25))
      const current = session.outputFile
      expect(
        typeof current === 'string' && current.startsWith('remote://'),
        `outputFile became ${JSON.stringify(current)} at ~${i * 25}ms after spawn — the rename path ` +
          're-read RemoteSessionManager.outputFile, which is hardcoded null by design, ' +
          'overwriting the sentinel that transport.start() published',
      ).toBe(true)
    }
  }, 20_000)
})
