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
 *   1. daemon-core behavior (the bun binary reaps through it) — intentional vs.
 *      not, with the real non-result tail.
 *   2. the SOURCE TEMPLATE's own reapSession text, evaluated (the JS fallback
 *      can't import daemon-core, so its copy is hand-synced).
 *   3. the end-to-end MEANING: exitCode → assembleSnapshot →
 *      projectProcessStatus is 'stopped', not 'error'.
 *   4. byte-level parity of BOTH intent stamps across all three twins.
 *
 * MACHINE SAFETY: this file signals NOTHING. Every kill primitive is a spy
 * (`killProcessGroupFn` in the injected deps for daemon-core; a `killProcessGroup`
 * stub in the template harness), `process.kill` is spied on and asserted NEVER
 * called, no child process is spawned, no timer callback is allowed to run, and
 * all files live under a per-test tmp dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore, type TestSession } from '../helpers/daemon-core-fixtures.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
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

// ── The JS-fallback twin runs its OWN copy of reapSession ──
// daemon-source.ts can't import daemon-core, so its reapSession is hand-synced.
// Byte checks alone would pass on a copy that kept the comment and dropped the
// branch, so the template's own function text is EVALUATED here against fakes.
describe('daemon-source template: reapSession honors the intentional-stop intent', () => {
  const deployed = getDaemonSource()

  /** Slice a top-level function out of the deployed source (closing `}` is at column 0). */
  function extractFn(src: string, name: string): string {
    const at = src.indexOf('function ' + name + '(')
    expect(at, `${name} not found in the deployed daemon source`).toBeGreaterThan(-1)
    const end = src.indexOf('\n}', at)
    expect(end).toBeGreaterThan(at)
    return src.slice(at, end + 2)
  }

  interface Harness {
    reapSession: (sid: string, code: number, reason: string) => void
    sessions: Map<string, Record<string, unknown>>
    killProcessGroup: ReturnType<typeof vi.fn>
    logMsg: ReturnType<typeof vi.fn>
    broadcastSessionState: ReturnType<typeof vi.fn>
  }

  /**
   * Build the template's reapSession with every free identifier injected. The
   * only signal-capable dependency (killProcessGroup) is a spy, and the injected
   * setTimeout never invokes its callback, so the SIGKILL escalation cannot run.
   */
  function buildHarness(mutate: (body: string) => string = (b) => b): Harness {
    const sessions = new Map<string, Record<string, unknown>>()
    const killProcessGroup = vi.fn(() => true)
    const logMsg = vi.fn()
    const broadcastSessionState = vi.fn()
    const env = {
      fs,
      path,
      sessions,
      logMsg,
      logStateTransition: vi.fn(),
      hookActions: () => [] as string[],
      stripDurableTasksForSession: () => ({ changed: false, text: null, removed: [] }),
      killProcessGroup,
      setTimeout: vi.fn(),          // never fires — no escalation, no real timer
      clearInterval: vi.fn(),
      persistRegistry: vi.fn(),
      drainSessionFold: vi.fn(),
      pushSnapshot: vi.fn(),
      stopSessionWatcher: vi.fn(),
      broadcastSessionState,
    }
    const body = mutate(extractFn(deployed, 'isTurnCompleteExit') + '\n' + extractFn(deployed, 'reapSession'))
    const factory = new Function('env', [
      '"use strict";',
      'const fs = env.fs, path = env.path, sessions = env.sessions;',
      'const logMsg = env.logMsg, logStateTransition = env.logStateTransition;',
      'const hookActions = env.hookActions, stripDurableTasksForSession = env.stripDurableTasksForSession;',
      'const killProcessGroup = env.killProcessGroup, setTimeout = env.setTimeout, clearInterval = env.clearInterval;',
      'const persistRegistry = env.persistRegistry, drainSessionFold = env.drainSessionFold;',
      'const pushSnapshot = env.pushSnapshot, stopSessionWatcher = env.stopSessionWatcher;',
      'const broadcastSessionState = env.broadcastSessionState;',
      body,
      'return reapSession;',
    ].join('\n')) as (e: typeof env) => Harness['reapSession']
    return { reapSession: factory(env), sessions, killProcessGroup, logMsg, broadcastSessionState }
  }

  let tmpDir: string
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-intentional-stop-'))
  })

  afterEach(() => {
    expect(killSpy, 'the template harness must never signal a real process').not.toHaveBeenCalled()
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeSession(name: string, tail: string, intentionalStopAt: number | null) {
    const jsonlPath = path.join(tmpDir, `jsonl-${name}`)
    fs.writeFileSync(jsonlPath, '{"type":"system","subtype":"init"}\n' + tail)
    return {
      pipePath: path.join(tmpDir, `pipe-${name}`),
      jsonlPath,
      pgidPath: path.join(tmpDir, `pgid-${name}`),
      pid: 4242,
      state: 'running',
      exitCode: null,
      exitReason: null,
      exitedAt: null,
      cwd: tmpDir,
      orphanPollTimer: null,
      subscribers: new Set(),
      intentionalStopAt,
    }
  }

  it('normalizes to code 0 on an intentional reclaim with a control_response tail', () => {
    const h = buildHarness()
    const session = makeSession('intent', CONTROL_RESPONSE_TAIL, 1_700_000_000_000)
    h.sessions.set('sid-intent', session)

    h.reapSession('sid-intent', -1, 'orphan-poll-dead')

    expect(session.exitCode).toBe(0)
    expect(session.exitReason).toBe('orphan-poll-dead+intentional-stop')
    // The kill ladder ran against the spy only, with the arguments we expect.
    expect(h.killProcessGroup).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(h.broadcastSessionState).toHaveBeenCalledWith('sid-intent', 'dead', expect.objectContaining({ exitCode: 0 }))
  })

  it('keeps a non-zero code for the same tail without the intent stamp', () => {
    const h = buildHarness()
    const session = makeSession('crash', CONTROL_RESPONSE_TAIL, null)
    h.sessions.set('sid-crash', session)

    h.reapSession('sid-crash', -1, 'orphan-poll-dead')

    expect(session.exitCode).toBe(-1)
    expect(session.exitReason).toBe('orphan-poll-dead')
  })

  it('the intent branch is what does it — cutting it out of the text restores the old -1', () => {
    // Proves this file can FAIL. Same harness, same input, but the extracted
    // text has the intent test forced false: the pre-fix behavior comes back.
    const h = buildHarness((body) => {
      const cut = body.replace('session.intentionalStopAt != null', 'false')
      expect(cut, 'the intent test is no longer in the deployed text').not.toBe(body)
      return cut
    })
    const session = makeSession('mutant', CONTROL_RESPONSE_TAIL, 1_700_000_000_000)
    h.sessions.set('sid-mutant', session)

    h.reapSession('sid-mutant', -1, 'orphan-poll-dead')

    expect(session.exitCode).toBe(-1)
  })

  it('still normalizes a genuine result tail via isTurnCompleteExit', () => {
    const h = buildHarness()
    const session = makeSession('turnend', RESULT_TAIL, null)
    h.sessions.set('sid-turnend', session)

    h.reapSession('sid-turnend', -1, 'orphan-poll-dead')

    expect(session.exitCode).toBe(0)
    expect(session.exitReason).toBe('orphan-poll-dead+turn-complete')
  })
})

// ── Parity: the intent stamp must exist in all three twins, once, at the scan ──
describe('intentional-stop intent parity across the three daemon twins', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
  const coreSrc = read('src/providers/daemon-core.ts')
  const standaloneSrc = read('src/providers/daemon-standalone.ts')
  const templateSrc = read('src/providers/daemon-source.ts')

  /**
   * Slice ONE function body by brace matching, skipping string literals and
   * line comments (both twins carry `{…}` inside comments, and daemon-core's
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

  it('both reapSession twins check the intent BEFORE the turn-complete branch', () => {
    for (const [name, src] of [['daemon-core', coreSrc], ['daemon-source', templateSrc]] as const) {
      const body = fnBody(src, 'reapSession', name)
      const intentIdx = body.indexOf('session.intentionalStopAt != null')
      const suffixIdx = body.indexOf("'+intentional-stop'")
      const turnCompleteIdx = body.indexOf("'+turn-complete'")
      expect(intentIdx, `${name}: reapSession does not read the intent flag`).toBeGreaterThan(-1)
      expect(suffixIdx, `${name}: reapSession does not record the intentional reason`).toBeGreaterThan(-1)
      expect(turnCompleteIdx, `${name}: the turn-complete normalization is gone`).toBeGreaterThan(-1)
      expect(suffixIdx, `${name}: the intent branch must be evaluated before the JSONL-tail branch`)
        .toBeLessThan(turnCompleteIdx)
    }
  })

  it('isTurnCompleteExit itself is untouched — still result-lines only', () => {
    for (const [name, src] of [['daemon-core', coreSrc], ['daemon-source', templateSrc]] as const) {
      const body = fnBody(src, 'isTurnCompleteExit', name)
      expect(body, `${name}: the clean-exit detector must still require a type:result tail`)
        .toMatch(/parsed\.type !== 'result'\) return false/)
      expect(body, `${name}: widening the tail detector would reclassify real crashes`)
        .not.toContain('control_response')
      expect(body).not.toContain('intentionalStopAt')
    }
  })

  it('each twin stamps the intent in the idle scan, immediately before the kill', () => {
    for (const [name, src] of [['daemon-standalone', standaloneSrc], ['daemon-source', templateSrc]] as const) {
      const at = src.indexOf("'idle scan: killing idle session (no subscribers, no output)'")
      expect(at, `${name}: the idle-scan kill log is gone`).toBeGreaterThan(-1)
      const block = src.slice(at, at + 1200)
      const stampIdx = block.search(/session\.intentionalStopAt = now/)
      const killIdx = block.indexOf('killSessionProcessGroup(pid, sid)')
      expect(stampIdx, `${name}: the idle scan does not record the reclaim intent`).toBeGreaterThan(-1)
      expect(killIdx, `${name}: the idle-scan kill call is gone`).toBeGreaterThan(-1)
      expect(stampIdx, `${name}: the intent must be stamped BEFORE the signal — the reap is async`)
        .toBeLessThan(killIdx)
    }
  })

  it('each twin stamps the intent in cmdStop, immediately before the kill', () => {
    // The SERVER's idle reaper kills through the stop RPC (mgr.kill() →
    // conn.send('stop')), NOT through the daemon's own scan — so without this
    // second stamp a local session auto-stopped after 2h came back as a red
    // "Session ended unexpectedly and no cause was recorded" (2026-09-03).
    for (const [name, src] of [['daemon-standalone', standaloneSrc], ['daemon-source', templateSrc]] as const) {
      const body = fnBody(src, 'cmdStop', name)
      const stampIdx = body.search(/session\.intentionalStopAt = Date\.now\(\)/)
      const killIdx = body.indexOf("killProcessGroup(pid, 'SIGINT')")
      expect(stampIdx, `${name}: cmdStop does not record the stop intent`).toBeGreaterThan(-1)
      expect(killIdx, `${name}: the cmdStop SIGINT is gone`).toBeGreaterThan(-1)
      expect(stampIdx, `${name}: the intent must be stamped BEFORE the signal — the reap is async`)
        .toBeLessThan(killIdx)
    }
  })

  it('nothing else in either twin marks a death as intentional', () => {
    // EXACTLY two writers: the daemon's own idle scan and cmdStop. A crash,
    // ENXIO, or a pid-recycle must keep reporting a non-zero code.
    for (const [name, src] of [['daemon-standalone', standaloneSrc], ['daemon-source', templateSrc]] as const) {
      const assignments = src.match(/intentionalStopAt\s*=(?!=)/g) ?? []
      expect(assignments.length, `${name}: exactly two intentionalStopAt assignments (idle scan + cmdStop)`).toBe(2)
    }
    // daemon-core only ever READS the flag (the scanners live in the twins).
    expect((coreSrc.match(/intentionalStopAt\s*=(?!=)/g) ?? []).length).toBe(0)
  })

  it('the field is declared on both typed session shapes', () => {
    for (const [name, src] of [['daemon-core', coreSrc], ['daemon-standalone', standaloneSrc]] as const) {
      expect(src, `${name}: intentionalStopAt is not declared on the session shape`)
        .toMatch(/intentionalStopAt\?: number \| null/)
    }
  })
})
