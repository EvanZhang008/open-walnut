/**
 * A turn's generation is never reused by a later turn.
 *
 * The bug (CI 2026-11-07, tests/e2e/plugin-ai-agent-e2e.test.ts): an ai.run
 * conversation's second call answered with the first call's text. The lane's CLI
 * had exited right after its first answer, and the next send raced that exit:
 *
 *   1. writeMessage's dispatch opened turn G+1 (its generation bumped);
 *   2. the exit event arrived before the daemon's ENXIO reply, and the quiet-exit
 *      handler completed the open turn: a SESSION_RESULT stamped G+1 carrying the
 *      previous answer (fullText);
 *   3. the failed write's undo rolled the generation back to G;
 *   4. the --resume spawn opened the real turn without a generation of its own,
 *      so its delivery reported G and the lane (lane-turn.ts isOurs) took the held
 *      G+1 result as the answer to the new message.
 *
 * The rule now: a dispatch is not undone once the process ended meanwhile, and a
 * spawn that carries a message bumps the generation like every other turn start.
 * Every result the previous process emitted is then older than the resumed turn.
 *
 * What's real: ClaudeCodeSession (writeMessage, the quiet-exit handler, send and
 * start). Mocked: the transport (no process) and the liveness timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-turn-gen-never-reused'))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import * as sessionManagers from '../../src/providers/session-manager.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'
import { closeDb } from '../../src/core/session-db.js'
import { _resetSessionTrackerForTesting, createSessionRecord } from '../../src/core/session-tracker.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'

const SID = '50000000-0000-4000-8000-0000000000c1'

function assistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant', session_id: SID,
    message: { id: 'msg_turn_gen_1', type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
  })
}
function resultLine(text: string): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 10, num_turns: 1,
    result: text, session_id: SID, total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 },
  })
}

interface Internals {
  _transport: unknown
  _active: boolean
  _processStatus: string
  claudeSessionId: string | null
  turnGen: number
  handleStreamLine(line: string, v?: number): void
  handleQuietProcessExit(): void
  writeMessage(message: string): Promise<boolean>
  startLivenessMonitor(): void
  startStallDiagTimer(): void
  awaitSpawn(): Promise<unknown>
  send(...args: unknown[]): void
}

/** The live process's transport: `onWrite` decides each write (after its dispatch). */
function liveTransport(onWrite: () => boolean) {
  return {
    isRemote: true, hasPipe: true, processName: 'claude', pid: 4242, outputFile: null, host: null, fileSize: 0,
    imageCache: new Map<string, string>(), lastEventAt: 0, tailOffset: 0,
    writeMessage: async (_m: string, o?: { onDispatch?: () => void }) => { o?.onDispatch?.(); return onWrite() },
    writeRaw: () => true, writeSyntheticUserEvent: () => {}, deletePipe: () => {}, detach: () => {},
    renameForSession: () => {}, kill: () => {}, stop: async () => {}, stopTail: () => {}, flushTail: () => {},
  }
}

/** A session whose first turn has answered on a live process. */
function answeredSession(onWrite: () => boolean): { session: Internals; results: Array<Record<string, unknown>> } {
  const session = new ClaudeCodeSession('', 'proj', '/bin/true') as unknown as Internals
  Object.assign(session, { _transport: liveTransport(onWrite), _active: true, _processStatus: 'running', claudeSessionId: SID })
  vi.spyOn(session, 'startLivenessMonitor').mockImplementation(() => {})
  vi.spyOn(session, 'startStallDiagTimer').mockImplementation(() => {})
  const results: Array<Record<string, unknown>> = []
  bus.subscribe('turn-gen-probe', (e: BusEvent) => {
    if (e.name === EventNames.SESSION_RESULT) results.push(e.data as Record<string, unknown>)
  }, { global: true, interest: [EventNames.SESSION_RESULT] })
  // The answer streams, then its result: fullText holds it, as the mock CLI's did on CI.
  session.handleStreamLine(assistantLine('first answer'), 900)
  session.handleStreamLine(resultLine('first answer'), 1000)
  expect(results.map((r) => r.result)).toEqual(['first answer'])
  return { session, results }
}

/** The runner's --resume fallback: a spawn of the same session carrying the message. */
async function resume(session: Internals, message: string): Promise<void> {
  vi.spyOn(process, 'kill').mockReturnValue(true)
  const next = {
    ...liveTransport(() => true),
    start: async () => ({ pid: 5151, outputFile: path.join(WALNUT_HOME, 'resumed.jsonl'), fileSize: 0 }),
  }
  vi.spyOn(sessionManagers, 'createSessionManager').mockReturnValue(next as never)
  try {
    session.send(message, WALNUT_HOME, SID)
    await session.awaitSpawn()
  } finally {
    sessionManagers.unregisterSessionManager(SID)
  }
}

beforeEach(async () => {
  bus.clear()
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
  await createSessionRecord(SID, '', 'proj', WALNUT_HOME)
})

afterEach(async () => {
  vi.restoreAllMocks()
  bus.clear()
  closeDb()
  _resetSessionTrackerForTesting()
  await new Promise((r) => setTimeout(r, 100))
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('a turn generation is never reused', () => {
  it('the process exits between the dispatch and the failed write: its result stays older than the resumed turn', async () => {
    let session!: Internals
    const probe = answeredSession(() => {
      // The exit event lands before the daemon's ENXIO reply (the CI ordering).
      session.handleQuietProcessExit()
      return false
    })
    session = probe.session
    expect(await session.writeMessage('second question')).toBe(false)
    // The CI shape: the exit completed the turn the dispatch had opened with a result of
    // its own (on CI it quoted the previous answer). If the exit stops emitting that result,
    // this probe no longer models the race: rewrite it.
    expect(probe.results).toHaveLength(2)
    expect(probe.results[1].turnGen as number).toBeGreaterThan(probe.results[0].turnGen as number)
    // Whatever the exit emitted, the generation never went back below it.
    for (const r of probe.results) expect(session.turnGen).toBeGreaterThanOrEqual(r.turnGen as number)

    await resume(session, 'second question')
    // The resumed turn is newer than every result of the process that ended.
    for (const r of probe.results) expect(r.turnGen as number).toBeLessThan(session.turnGen)
  })

  it('the failed write is answered before the exit: the dispatch is undone, no stale result, the resumed turn is newer', async () => {
    const { session, results } = answeredSession(() => false)
    expect(await session.writeMessage('second question')).toBe(false)
    session.handleQuietProcessExit()
    expect(results.map((r) => r.result)).toEqual(['first answer'])

    await resume(session, 'second question')
    expect(results[0].turnGen as number).toBeLessThan(session.turnGen)
  })

  it('every turn-start anchor in the session runner bumps the generation', () => {
    // A new place that opens a turn (sets _turnEdgeAt) without a generation of its
    // own reopens this bug: list each anchor and require a bump beside it.
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/providers/claude-code-session.ts'), 'utf-8').split('\n')
    const anchors = src.flatMap((line, i) => /this\._turnEdgeAt = (?!undefined)/.test(line) ? [i] : [])
    expect(anchors.length).toBeGreaterThanOrEqual(3)
    for (const i of anchors) {
      const near = src.slice(Math.max(0, i - 10), i + 10).join('\n')
      expect(near, `turn anchor at line ${i + 1} has no _turnGen++ beside it`).toContain('this._turnGen++')
    }
  })
})
