/**
 * Guard: an engine that retries by itself with no limit, or goes quiet with a turn open, never
 * holds a session at Running (src/providers/engine-turn-watch.ts). 2026-11-24: Codex retried
 * "Reconnecting... waiting for network" every minute for 7 hours, and the session read Running.
 *
 * The class, enumerated from the source:
 *   - every engine of the registry runs its turns through a transport with a bound
 *     (ENGINE_RETRY_BOUNDS); a new engine kind, or a new native engine, fails here
 *   - every file under src/ that reads an engine's retry signal is listed below with what bounds
 *     it; a new reader (a new engine's retry notice) fails here until it is
 *   - each bound's feeder really feeds the policy
 * Behaviour: tests/providers/acp-worker-turn-bound.test.ts (adapters) and
 * tests/providers/codex-app-server-worker.test.ts (direct Codex).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ENGINE_REGISTRY, acpEngineIds } from '../../src/core/agents/engine-registry.js'
import {
  ACP_RETRY_SHAPES, ENGINE_RETRY_BOUNDS, ENGINE_RETRY_LIMIT_DEFAULT_MS, RETRY_SHAPE_MATCHERS, TurnWatch, acpRetryNotice,
  claudeRetryEnv, endpointWords, retryKindOf, retryLimitMs, stallIdleMs, stallItemMs, transportsOf, type RetryShape,
} from '../../src/providers/engine-turn-watch.js'
import { classifyTurnError } from '../../src/providers/daemon-core.js'

/** One real frame per retry shape, as its adapter sends it (the shape's source is in ACP_RETRY_SHAPES). */
const SHAPE_FIXTURES: Record<RetryShape, Record<string, unknown>> = {
  'codex-meta': { sessionUpdate: 'session_info_update', _meta: { codex: { error: { message: 'Reconnecting... waiting for network', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, willRetry: true } } } },
  'pi-text': { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Retrying (attempt 2/3, waiting 4s)...' } },
}

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** The words an engine uses to say it retries by itself. */
const RETRY_SIGNAL = /willRetry|['"]api_retry['"]|retry_delay_ms/

/** Every file under src/ that reads a retry signal, and what bounds the retries it reads. */
const READERS: Record<string, string> = {
  'src/providers/engine-turn-watch.ts': 'the policy itself (acpRetryNotice)',
  'src/providers/codex-app-server/connection.ts': 'direct Codex: feeds TurnWatch.retried, checkStall stops the turn',
  'src/providers/codex-app-server/events.ts': "maps Codex's notice to the ACP frame; the bound is connection.ts's",
  'src/providers/acp-journal-projector.ts': "shows the adapter's notice in the chat; the bound is the worker's (adapter-turn-watch.ts)",
  'src/providers/claude-code-session.ts': "shows Claude Code's api_retry; Claude Code ends the turn itself (claudeRetryEnv in the daemon)",
  'src/core/cron/run-log.ts': "a routine run's own retry flag, not an engine's",
  'src/core/cron/sent-run.ts': "a routine run's own retry flag, not an engine's",
  'src/core/cron/timer.ts': "a routine run's own retry flag, not an engine's",
  'src/core/cron/types.ts': "a routine run's own retry flag, not an engine's",
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walk(rel, out)
    else if (/\.(ts|mjs|js)$/.test(e.name)) out.push(rel)
  }
  return out
}

describe('every engine retry is bounded (guard)', () => {
  it('every registered engine runs through a transport with a bound', () => {
    for (const [id, caps] of ENGINE_REGISTRY) {
      const transports = transportsOf(id, caps.runtimeKind)
      expect(transports.length, `${id} (${caps.runtimeKind}) has no transport with a retry bound in ENGINE_RETRY_BOUNDS`).toBeGreaterThan(0)
      for (const t of transports) expect(ENGINE_RETRY_BOUNDS[t], `${id} via ${t}`).toBeDefined()
    }
  })

  it('every reader of a retry signal under src/ is listed with its bound', () => {
    const found = walk('src').filter((f) => RETRY_SIGNAL.test(read(f))).sort()
    const unlisted = found.filter((f) => !READERS[f])
    expect(unlisted, 'a new reader of an engine retry signal: bound it (engine-turn-watch.ts) and list it in READERS').toEqual([])
    const stale = Object.keys(READERS).filter((f) => !found.includes(f))
    expect(stale, 'listed readers that no longer read a retry signal: drop them').toEqual([])
  })

  it('every ACP engine names its retry frames, or why none is known', () => {
    for (const id of acpEngineIds()) {
      const row = ACP_RETRY_SHAPES[id]
      expect(row, `ACP engine ${id}: read its adapter's source and list its retry frames (or why none) in ACP_RETRY_SHAPES`).toBeDefined()
      expect(row.basis.length, `${id}: say where the shapes come from`).toBeGreaterThan(20)
    }
    expect(Object.keys(ACP_RETRY_SHAPES).sort()).toEqual([...acpEngineIds()].sort())
  })

  it('every retry shape has a matcher and a real frame it matches', () => {
    const used = new Set(Object.values(ACP_RETRY_SHAPES).flatMap((r) => r.shapes))
    expect([...used].sort()).toEqual(Object.keys(RETRY_SHAPE_MATCHERS).sort())
    for (const shape of Object.keys(RETRY_SHAPE_MATCHERS) as RetryShape[]) {
      expect(acpRetryNotice(SHAPE_FIXTURES[shape]), shape).not.toBeNull()
    }
  })

  it("each bound's feeder feeds the policy", () => {
    const direct = read('src/providers/codex-app-server/connection.ts')
    expect(direct).toMatch(/watch\.retried\(retryKindOf\(/)
    expect(direct).toMatch(/watch\.verdict\(/)
    const adapter = read('src/providers/acp-worker/adapter-turn-watch.ts')
    expect(adapter).toMatch(/acpRetryNotice\(update\)/)
    expect(adapter).toMatch(/watch\.verdict\(/)
    const worker = read('src/providers/acp-worker/worker.ts')
    expect(worker).toMatch(/new AdapterTurnWatch\(/)
    expect(worker).toMatch(/this\.turnWatch\?\.frame\(update\)/)
    // Both prompt paths (a turn and a self-report question) run under it.
    expect(worker.match(/this\.watchedPrompt\(conn\.prompt\(/g)?.length).toBe(2)
    expect(read('src/providers/daemon-session-start.ts')).toMatch(/\.\.\.claudeRetryEnv\(daemonEnv\)/)
  })
})

describe('the policy', () => {
  const env = { WALNUT_ENGINE_RETRY_LIMIT_MS: '1000', WALNUT_TURN_STALL_MS: '500', WALNUT_TURN_STALL_ITEM_MS: '5000' }
  const facts = (now: number, extra: Partial<{ itemRunning: boolean; holding: boolean; endpoint: string }> = {}) =>
    ({ now, itemRunning: false, holding: false, env, engine: 'Codex', ...extra })

  it('retry notices keep the idle clock alive but not the retry clock', () => {
    const w = new TurnWatch(0)
    for (let t = 100; t <= 900; t += 100) w.retried('connection', t)
    expect(w.verdict(facts(950))).toBeNull()
    w.retried('connection', 1000)
    const v = w.verdict(facts(1100, { endpoint: 'http://127.0.0.1:8402/openai/v1' }))
    expect(v?.kind).toBe('connection')
    expect(v?.words).toBe('Codex could not reach its model at http://127.0.0.1:8402/openai/v1 for 1 second and Walnut stopped the turn (network error; 10 retries).')
    // Short enough for the status's 140 characters at a 30-minute stop.
    expect(v!.words.replace('1 second', '30 minutes').replace('10 retries', '28 retries').length).toBeLessThanOrEqual(140)
  })

  it('progress ends a streak; silence is a stall; a running item and a waiting person stretch or hold it', () => {
    const w = new TurnWatch(0)
    w.retried('connection', 100)
    w.progress(1050)
    expect(w.verdict(facts(1200))).toBeNull()
    expect(w.verdict(facts(1600))?.kind).toBe('turn_stalled')
    expect(w.verdict(facts(1600, { itemRunning: true }))).toBeNull()
    expect(w.verdict(facts(99_999, { holding: true }))).toBeNull()
    expect(w.verdict(facts(1600))?.words).toBe('Codex sent nothing for 1 second and Walnut stopped the turn (operation timed out).')
  })

  it('limits default to 30 minutes of retries, 15 of silence, 90 while an item runs; the old Codex knobs still work', () => {
    expect(retryLimitMs({})).toBe(ENGINE_RETRY_LIMIT_DEFAULT_MS)
    expect(ENGINE_RETRY_LIMIT_DEFAULT_MS).toBe(30 * 60_000)
    expect(stallIdleMs({})).toBe(15 * 60_000)
    expect(stallItemMs({})).toBe(90 * 60_000)
    expect(stallIdleMs({ WALNUT_CODEX_STALL_MS: '400' })).toBe(400)
    expect(stallItemMs({ WALNUT_CODEX_STALL_ITEM_MS: '700' })).toBe(700)
  })

  it('reads a retry notice under any engine key, and its kind from the error code', () => {
    const notice = (error: Record<string, unknown>, ns = 'codex') => ({ sessionUpdate: 'session_info_update', _meta: { [ns]: { error } } })
    expect(acpRetryNotice(notice({ willRetry: true }))).toBe('connection')
    expect(acpRetryNotice(notice({ willRetry: true, codexErrorInfo: 'rateLimitExceeded' }, 'opencode'))).toBe('rate_limited')
    expect(acpRetryNotice(notice({ willRetry: false }))).toBeNull()
    expect(acpRetryNotice({ sessionUpdate: 'agent_message_chunk', _meta: { codex: { error: { willRetry: true } } } })).toBeNull()
    // Pi's text: the notice exactly, never a model's sentence that mentions retrying.
    expect(acpRetryNotice({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Retrying...' } })).toBe('unknown')
    expect(acpRetryNotice({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Retry finished, resuming.' } })).toBeNull()
    expect(acpRetryNotice({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Retrying the build now...' } })).toBeNull()
    expect(retryKindOf({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } })).toBe('connection')
    expect(retryKindOf({ codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 429 } } })).toBe('rate_limited')
    expect(retryKindOf({ codexErrorInfo: 'serverOverloaded' })).toBe('overloaded')
    expect(retryKindOf({ codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 502 } } })).toBe('server_error')
    expect(retryKindOf({})).toBe('connection')
  })

  it('an endpoint that reads as a final failure is left out, so the stop stays retryable', () => {
    const w = new TurnWatch(0)
    w.retried('connection', 0)
    for (const endpoint of ['http://127.0.0.1:401/v1', 'https://api.example.invalid/billing/v1', 'http://127.0.0.1:400/v1']) {
      const v = w.verdict(facts(2000, { endpoint }))
      expect(v?.words, endpoint).not.toContain(endpoint)
      expect(classifyTurnError(`${v?.kind}: ${v?.words}`), endpoint).toBe('retryable')
    }
    expect(w.verdict(facts(2000, { endpoint: 'http://127.0.0.1:8402/openai/v1' }))?.words).toContain('http://127.0.0.1:8402/openai/v1')
  })

  it('names an endpoint without a user, a password, a query or a fragment', () => {
    expect(endpointWords('http://u:p@127.0.0.1:8402/openai/v1/?key=k#x')).toBe('http://127.0.0.1:8402/openai/v1')
    expect(endpointWords('file:///etc/passwd')).toBeUndefined()
    expect(endpointWords('not a url')).toBeUndefined()
  })

  it("bounds Claude Code's unattended retry mode at the same limit, unless the host set its own", () => {
    expect(claudeRetryEnv({})).toEqual({ CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: String(30 * 60_000) })
    expect(claudeRetryEnv({ WALNUT_ENGINE_RETRY_LIMIT_MS: '600000' })).toEqual({ CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: '600000' })
    expect(claudeRetryEnv({ CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: '5' })).toEqual({})
  })
})
