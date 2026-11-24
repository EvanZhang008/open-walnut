/**
 * A DELIBERATE stop reports a CLEAN exit, not an error.
 *
 * The daemon's own idle scanner reclaims a session after the idle threshold
 * (no subscribers, no output). That teardown is deliberate housekeeping, but it
 * used to surface in the UI as a red "Error": the kill lands asynchronously (the
 * orphan poll notices ESRCH and reaps with code -1), and reapSession's only
 * clean-exit signal was isTurnCompleteExit, which accepts a `type:"result"` tail
 * ONLY. A session whose last stream line is a `control_response` — the reply to
 * a Walnut-issued control request, a routine shape — therefore kept exitCode -1,
 * and projectProcessStatus mapped that to 'error' on a healthy, resumable
 * session (verified on a real remote daemon: idleMinutes 121, reason
 * "orphan-poll-dead", cleanExit false).
 *
 * TWO writers stamp that intent, and both matter. The daemon's own idle scanner
 * is one. The other is `cmdStop`, i.e. any `stop` RPC: the SERVER has its own
 * idle reaper that kills through `mgr.kill()` → `conn.send('stop')`, so it never
 * touched the daemon's scan at all. A LOCAL session auto-stopped after 2h idle
 * therefore still came back red, reading "Session ended unexpectedly and no
 * cause was recorded" on a machine where nothing had disconnected (2026-09-03).
 * Nobody sends `stop` by accident, so an explicit stop is never a crash.
 *
 * The fix records the INTENT on the session before the first signal
 * (`intentionalStopAt`) and normalizes the code in reapSession. Covered here:
 *   1. daemon-core behavior (the daemon reaps through it) — intentional vs.
 *      not, with the real non-result tail.
 *   2. the end-to-end MEANING: exitCode → assembleSnapshot →
 *      projectProcessStatus is 'stopped', not 'error'.
 *   3. source checks: reapSession reads the intent, and the daemon stamps it at
 *      exactly its three sites (idle scan, explicit stop, budget pause).
 *
 * MACHINE SAFETY: this file signals NOTHING. Every kill primitive is a spy
 * (`killProcessGroupFn` in the injected deps for daemon-core), `process.kill` is
 * spied on and asserted NEVER called, no child process is spawned, no timer callback is allowed to run, and
 * all files live under a per-test tmp dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore, type TestSession } from '../helpers/daemon-core-fixtures.js'
import { assembleSnapshot, initialFoldState } from '../../src/providers/daemon-fold.js'
import { projectProcessStatus } from '../../src/core/session-snapshot-apply.js'

const ROOT = path.resolve(__dirname, '../..')

/** The real production tail shape from the incident: a control_response reply. */
const CONTROL_RESPONSE_TAIL = JSON.stringify({
  type: 'control_response',
  response: { subtype: 'success', request_id: 'req_42', response: { behavior: 'allow' } },
}) + '\n'

/** A genuine turn end — what isTurnCompleteExit is built to recognize. */
const RESULT_TAIL = JSON.stringify({
  type: 'result', subtype: 'success', stop_reason: 'end_turn', is_error: false,
}) + '\n'

describe('daemon-core: an intentional stop normalizes the exit code', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    // Stub the ONE destructive primitive before any test body runs: nothing in
    // this file may reach a real process. daemon-core's own kill paths are
    // already injected spies; this catches an accidental direct call too.
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    vi.useFakeTimers()
    ctx = await buildDeps()
  })

  afterEach(async () => {
    vi.useRealTimers()
    expect(killSpy, 'no test in this file may signal a real process').not.toHaveBeenCalled()
    vi.restoreAllMocks()
    await ctx.cleanup()
  })

  /** Session whose stream file ends in `tail`. */
  function sessionWithTail(name: string, tail: string, extra: Partial<TestSession> = {}): TestSession {
    const jsonlPath = path.join(ctx.tmpDir, `jsonl-${name}`)
    fs.writeFileSync(jsonlPath, '{"type":"system","subtype":"init"}\n' + tail)
    return makeTestSession({ pid: 4242, jsonlPath, ...extra })
  }

  it('reaps to code 0 with an intentional reason when the tail is NOT a result line', () => {
    const core = createDaemonCore(ctx.deps)
    const session = sessionWithTail('intent', CONTROL_RESPONSE_TAIL, { intentionalStopAt: 1_700_000_000_000 })
    ctx.sessions.set('sid-intent', session)

    // Exactly the production call: the orphan poll saw ESRCH.
    core.reapSession('sid-intent', -1, 'orphan-poll-dead')

    expect(session.exitCode).toBe(0)
    expect(session.exitReason).toBe('orphan-poll-dead+intentional-stop')
    const payload = ctx.spies.broadcastSessionStateFn.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ state: 'dead', exitCode: 0 })
    expect(payload.reason).toBe('orphan-poll-dead+intentional-stop')
    // And it says so in the log, with the flag that carried the information.
    const normalized = ctx.spies.logger.mock.calls.find(
      (c) => c[1] === 'reapSession: intentional stop, normalizing exit code',
    )
    expect(normalized, 'the normalization must be logged, not silent').toBeTruthy()
    expect((normalized![2] as Record<string, unknown>).cleanExit).toBe(false)
  })

  it('keeps a NON-ZERO code for the SAME tail when the death was not intentional', () => {
    const core = createDaemonCore(ctx.deps)
    // Identical stream file, no intent stamp — a real crash / pid death.
    const session = sessionWithTail('crash', CONTROL_RESPONSE_TAIL)
    ctx.sessions.set('sid-crash', session)

    core.reapSession('sid-crash', -1, 'orphan-poll-dead')

    expect(session.exitCode).toBe(-1)
    expect(session.exitReason).toBe('orphan-poll-dead')
    expect(ctx.spies.logger.mock.calls.some(
      (c) => c[1] === 'reapSession: intentional stop, normalizing exit code',
    )).toBe(false)
  })

  it('leaves the isTurnCompleteExit normalization exactly as it was (genuine result tail)', () => {
    const core = createDaemonCore(ctx.deps)
    const session = sessionWithTail('turnend', RESULT_TAIL)
    ctx.sessions.set('sid-turnend', session)

    core.reapSession('sid-turnend', -1, 'orphan-poll-dead')

    expect(session.exitCode).toBe(0)
    expect(session.exitReason).toBe('orphan-poll-dead+turn-complete')
  })

  it('an intentional reclaim on a result tail reports the intentional reason (intent wins)', () => {
    const core = createDaemonCore(ctx.deps)
    const session = sessionWithTail('both', RESULT_TAIL, { intentionalStopAt: 1_700_000_000_000 })
    ctx.sessions.set('sid-both', session)

    core.reapSession('sid-both', -1, 'orphan-poll-dead')

    expect(session.exitCode).toBe(0)
    expect(session.exitReason).toBe('orphan-poll-dead+intentional-stop')
  })

  it('does not decorate a reason that already arrived with code 0', () => {
    const core = createDaemonCore(ctx.deps)
    const session = sessionWithTail('zero', CONTROL_RESPONSE_TAIL, { intentionalStopAt: 1_700_000_000_000 })
    ctx.sessions.set('sid-zero', session)

    core.reapSession('sid-zero', 0, 'proc-exit')

    expect(session.exitCode).toBe(0)
    expect(session.exitReason).toBe('proc-exit')
  })

  // The point of the whole change: the number has to MEAN 'stopped' downstream.
  it('the reaped exitCode projects to stopped for an intentional reap and error otherwise', () => {
    const core = createDaemonCore(ctx.deps)
    const reclaimed = sessionWithTail('proj-a', CONTROL_RESPONSE_TAIL, { intentionalStopAt: 1_700_000_000_000 })
    const crashed = sessionWithTail('proj-b', CONTROL_RESPONSE_TAIL)
    ctx.sessions.set('sid-proj-a', reclaimed)
    ctx.sessions.set('sid-proj-b', crashed)

    core.reapSession('sid-proj-a', -1, 'orphan-poll-dead')
    core.reapSession('sid-proj-b', -1, 'orphan-poll-dead')

    const snapshotOf = (s: TestSession) => assembleSnapshot({
      foldState: initialFoldState(0),
      pendingCtrl: null,
      dead: true,
      pid: s.pid,
      exitCode: s.exitCode,
    })

    expect(projectProcessStatus(snapshotOf(reclaimed))).toBe('stopped')
    expect(projectProcessStatus(snapshotOf(crashed))).toBe('error')
  })
})

// ── Source checks: the intent is read once in the reap and stamped at exactly three sites ──
describe('intentional-stop intent in the daemon source', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
  const coreSrc = read('src/providers/daemon-core.ts')
  const standaloneSrc = read('src/providers/daemon-standalone.ts')

  /**
   * Slice ONE function body by brace matching, skipping string literals and
   * line comments (the sources carry `{…}` inside comments, and daemon-core's
   * functions are NESTED inside createDaemonCore — so neither a naive `\n}`
   * anchor nor a raw brace count works).
   */
  function fnBody(src: string, name: string, label: string): string {
    const at = src.indexOf('function ' + name + '(')
    expect(at, `${label}: ${name} not found`).toBeGreaterThan(-1)
    let i = src.indexOf('{', at)
    let depth = 0
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue }
      if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue }
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch
        for (i++; i < src.length; i++) {
          if (src[i] === '\\') { i++; continue }
          if (src[i] === quote) break
        }
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) return src.slice(at, i + 1)
    }
    throw new Error(`${label}: unbalanced braces in ${name}`)
  }

  it('daemon-core reapSession checks the intent BEFORE the turn-complete branch', () => {
    const body = fnBody(coreSrc, 'reapSession', 'daemon-core')
    const intentIdx = body.indexOf('session.intentionalStopAt != null')
    const suffixIdx = body.indexOf("'+intentional-stop'")
    const turnCompleteIdx = body.indexOf("'+turn-complete'")
    expect(intentIdx, 'reapSession does not read the intent flag').toBeGreaterThan(-1)
    expect(suffixIdx, 'reapSession does not record the intentional reason').toBeGreaterThan(-1)
    expect(turnCompleteIdx, 'the turn-complete normalization is gone').toBeGreaterThan(-1)
    expect(suffixIdx, 'the intent branch must be evaluated before the JSONL-tail branch')
      .toBeLessThan(turnCompleteIdx)
  })

  it('isTurnCompleteExit itself is untouched — still result-lines only', () => {
    const body = fnBody(coreSrc, 'isTurnCompleteExit', 'daemon-core')
    expect(body, 'the clean-exit detector must still require a type:result tail')
      .toMatch(/parsed\.type !== 'result'\) return false/)
    expect(body, 'widening the tail detector would reclassify real crashes')
      .not.toContain('control_response')
    expect(body).not.toContain('intentionalStopAt')
  })

  it('the idle scan stamps the intent immediately before the kill', () => {
    const at = standaloneSrc.indexOf("'idle scan: killing idle session (no subscribers, no output)'")
    expect(at, 'the idle-scan kill log is gone').toBeGreaterThan(-1)
    const block = standaloneSrc.slice(at, at + 1200)
    const stampIdx = block.search(/session\.intentionalStopAt = now/)
    const killIdx = block.indexOf('killSessionProcessGroup(pid, sid)')
    expect(stampIdx, 'the idle scan does not record the reclaim intent').toBeGreaterThan(-1)
    expect(killIdx, 'the idle-scan kill call is gone').toBeGreaterThan(-1)
    expect(stampIdx, 'the intent must be stamped BEFORE the signal — the reap is async')
      .toBeLessThan(killIdx)
  })

  it('the stop RPC delegates to the process stop that stamps intent before the signal', () => {
    expect(fnBody(standaloneSrc, 'cmdStop', 'daemon-standalone')).toContain('stopSessionProcess(ws, id, sid)')
    const body = fnBody(standaloneSrc, 'stopSessionProcess', 'daemon-standalone')
    const stampIdx = body.search(/session\.intentionalStopAt = Date\.now\(\)/)
    const killIdx = body.indexOf("killProcessGroup(pid, 'SIGINT')")
    expect(stampIdx, 'cmdStop does not record the stop intent').toBeGreaterThan(-1)
    expect(killIdx, 'the cmdStop SIGINT is gone').toBeGreaterThan(-1)
    expect(stampIdx, 'the intent must be stamped BEFORE the signal — the reap is async')
      .toBeLessThan(killIdx)
  })

  it('only idle scan, explicit stop and an owned budget pause mark a death as intentional', () => {
    // Exact sites, not a relaxed count: crashes, ENXIO and pid recycling must remain errors.
    const src = standaloneSrc
    const stop = fnBody(src, 'stopSessionProcess', 'daemon-standalone')
    const budget = fnBody(src, 'pauseBudgetSession', 'daemon-standalone')
    const count = (text: string) => (text.match(/intentionalStopAt\s*=(?!=)/g) ?? []).length
    expect(count(stop), 'explicit process stop has one intent stamp').toBe(1)
    expect(count(budget), 'actual budget pause has one intent stamp').toBe(1)
    expect(budget.indexOf('persistBudgetStops()')).toBeLessThan(budget.indexOf('session.intentionalStopAt = Date.now()'))
    expect(budget.indexOf('session.intentionalStopAt = Date.now()')).toBeLessThan(budget.indexOf("subtype: 'stop_task'"))
    const remaining = src.replace(stop, '').replace(budget, '')
    expect(count(remaining), 'the only remaining stamp belongs to the idle scan').toBe(1)
    const idle = remaining.indexOf("'idle scan: killing idle session (no subscribers, no output)'")
    expect(idle).toBeGreaterThan(-1)
    expect(count(remaining.slice(idle, idle + 1200))).toBe(1)
    expect(count(src), 'exactly three intentional stop sites').toBe(3)
    expect((coreSrc.match(/intentionalStopAt\s*=(?!=)/g) ?? []).length).toBe(0)
  })

  it('the field is declared on both typed session shapes', () => {
    for (const [name, src] of [['daemon-core', coreSrc], ['daemon-standalone', standaloneSrc]] as const) {
      expect(src, `${name}: intentionalStopAt is not declared on the session shape`)
        .toMatch(/intentionalStopAt\?: number \| null/)
    }
  })
})
