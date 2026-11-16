/**
 * The relay's refusal log writes one line per caller and reason every few minutes, and an op's
 * own HTTP answer (a 404) is not a refusal (2026-11-15: one script's 2,947 throttled calls and
 * 826 404s tipped the log-spike alarm on "gateway relay refused").
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRefusalLog, isOpAnswerStatus, REFUSAL_LOG_WINDOW_MS } from '../../src/providers/gateway-refusal-log.js'

describe('gateway refusal log', () => {
  it('writes the first refusal of a caller for a reason, counts the rest, and names the count on the next line', () => {
    const log = createRefusalLog(1_000)
    expect(log.admit('clouddev', 'sid-a', 'throttled', 0)).toEqual({ write: true, suppressed: 0 })
    for (let i = 1; i <= 5; i++) expect(log.admit('clouddev', 'sid-a', 'throttled', i * 10)).toEqual({ write: false, suppressed: i })
    expect(log.admit('clouddev', 'sid-a', 'throttled', 1_000)).toEqual({ write: true, suppressed: 5 })
    expect(log.admit('clouddev', 'sid-a', 'throttled', 1_500)).toEqual({ write: false, suppressed: 1 })
  })

  it('a caller that stops still has its count written once its window ends', () => {
    const log = createRefusalLog(1_000)
    log.admit('clouddev', 'sid-a', 'throttled', 0)
    for (let i = 1; i <= 4; i++) log.admit('clouddev', 'sid-a', 'throttled', i)
    log.admit('clouddev', 'sid-b', 'throttled', 0)
    expect(log.sweep(999)).toEqual([])
    // sid-b left nothing out: no line for it.
    expect(log.sweep(1_000)).toEqual([{ host: 'clouddev', callerSid: 'sid-a', code: 'throttled', suppressed: 4 }])
    expect(log.sweep(5_000)).toEqual([])
    expect(log.size()).toBe(0)
    // A window the next line already named is not summarised twice.
    log.admit('h', 'sid-c', 'throttled', 10_000)
    log.admit('h', 'sid-c', 'throttled', 10_001)
    expect(log.admit('h', 'sid-c', 'throttled', 11_000)).toEqual({ write: true, suppressed: 1 })
    expect(log.sweep(20_000)).toEqual([])
  })

  it('keeps callers, hosts and reasons apart', () => {
    const log = createRefusalLog(1_000)
    expect(log.admit('clouddev', 'sid-a', 'throttled', 0).write).toBe(true)
    expect(log.admit('clouddev', 'sid-b', 'throttled', 0).write).toBe(true)
    expect(log.admit('olddev', 'sid-a', 'throttled', 0).write).toBe(true)
    expect(log.admit('clouddev', 'sid-a', 'bad_request', 0).write).toBe(true)
    expect(log.admit('clouddev', 'sid-a', 'throttled', 1).write).toBe(false)
  })

  it('stays bounded with many callers', () => {
    const log = createRefusalLog(60_000, 50)
    for (let i = 0; i < 500; i++) log.admit('h', `sid-${i}`, 'throttled', i)
    expect(log.size()).toBeLessThanOrEqual(50)
  })

  it('one looping caller writes at most a few lines an hour, under the spike alarm', () => {
    const log = createRefusalLog()
    let lines = 0
    for (let t = 0; t < 3_600_000; t += 100) if (log.admit('clouddev', 'sid-loop', 'throttled', t).write) lines++
    expect(lines).toBe(3_600_000 / REFUSAL_LOG_WINDOW_MS)
    expect(lines).toBeLessThan(30)
  })

  it('an op answer is the API saying no about the call, never a policy refusing the caller', () => {
    for (const s of [400, 404, 409, 410, 422]) expect(isOpAnswerStatus(s), String(s)).toBe(true)
    // 401/403 (session_only, 2026-11-14) stay refusals, as do timeouts, too-many and server faults.
    for (const s of [undefined, 200, 401, 403, 408, 429, 500, 503, 507]) expect(isOpAnswerStatus(s), String(s)).toBe(false)
  })
})

describe('ratchet: every gateway refusal line of the relay goes through the refusal log', () => {
  it('daemon-connection.ts writes "gateway relay refused" only behind gatewayRefusalLog.admit', () => {
    const src = readFileSync(join(__dirname, '../../src/providers/daemon-connection.ts'), 'utf8')
    const lines = src.split('\n')
    const sites = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /log\.session\.(warn|error)\('DaemonConnection: gateway relay refused'/.test(line))
    expect(sites.length).toBeGreaterThan(0)
    // Every such line sits right under the limiter's yes.
    for (const { i } of sites) expect(lines[i - 1], `line ${i + 1}`).toMatch(/if \(seen\.write\b/)
    // And the op-answer line too, and both decisions come from one admit of this outcome.
    const answered = lines.findIndex((l) => l.includes("'DaemonConnection: gateway relay handled, the op answered an error'"))
    expect(answered).toBeGreaterThan(0)
    expect(lines[answered - 1]).toMatch(/if \(seen\.write\b/)
    expect(src).toMatch(/const seen = gatewayRefusalLog\.admit\(/)
    expect(src).toMatch(/isOpAnswerStatus\(outcome\.opStatus\)/)
    expect(src).toMatch(/gatewayRefusalLog\.sweep\(\)/)
  })
})
