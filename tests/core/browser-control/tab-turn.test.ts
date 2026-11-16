/**
 * A tab's queue of commands in the extension (packages/browser-extension/src/tab-turn.ts): one at a
 * time, in order, and never held for good by a turn Chrome never answers (2026-11-16: after one
 * upload, every read of that tab went unanswered for 15 minutes, until the extension reloaded).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { inTurn, TURN_MS, STALE_MS, _resetTurnsForTesting } from '../../../packages/browser-extension/src/tab-turn.js'

beforeEach(() => { _resetTurnsForTesting(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const never = () => new Promise<never>(() => undefined)

describe('a tab\'s turn', () => {
  it('one at a time, in order, per tab; another tab never waits', async () => {
    const seen: string[] = []
    let release!: () => void
    const first = inTurn(1, () => new Promise<void>((r) => { release = () => { seen.push('a'); r() } }))
    const second = inTurn(1, async () => { seen.push('b') })
    await inTurn(2, async () => { seen.push('other tab') })
    expect(seen).toEqual(['other tab'])
    release()
    await first; await second
    expect(seen).toEqual(['other tab', 'a', 'b'])
  })

  it('a turn that never ends holds the tab at most its limit; the next command then goes', async () => {
    void inTurn(7, never)
    let ran = false
    const next = inTurn(7, async () => { ran = true; return 'read' })
    await vi.advanceTimersByTimeAsync(TURN_MS - 1000)
    expect(ran).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await next).toBe('read')
    // Every later command too, not only the first after it.
    expect(await inTurn(7, async () => 'again')).toBe('again')
  })

  it('a shorter limit for a step\'s replay picture', async () => {
    void inTurn(9, never, 15_000)
    const next = inTurn(9, async () => 'click')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await next).toBe('click')
  })

  it('the limit counts from the turn\'s own start, not from when it was queued', async () => {
    let release!: () => void
    void inTurn(3, () => new Promise<void>((r) => { release = r }))
    void inTurn(3, never, 5_000)
    let ran = false
    const third = inTurn(3, async () => { ran = true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ran).toBe(false)
    release()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(ran).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await third
    expect(ran).toBe(true)
  })

  it('a command queued past the server\'s longest wait never runs late; the queue lets go only after that', () => {
    const src = fs.readFileSync('src/web/routes/browser-v1.ts', 'utf8')
    const waits = [...(/const TIMEOUT[^=]*= \{([^}]*)\}/.exec(src)?.[1] ?? '').matchAll(/(\d+)_000/g), ...src.matchAll(/FULL_SCREENSHOT_MS = (\d+)_000/g)].map((m) => Number(m[1]) * 1000)
    expect(waits.length).toBeGreaterThan(3)
    expect(Math.max(...waits)).toBeLessThan(STALE_MS)
    expect(STALE_MS).toBeLessThan(TURN_MS)
    expect(fs.readFileSync('packages/browser-extension/src/agent.ts', 'utf8')).toMatch(/Date\.now\(\) - queued > STALE_MS/)
  })
})
