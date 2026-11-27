/**
 * A notice Rhythm raised before a restart, whose moment passed while nothing dismissed it, is gone
 * once Rhythm loads (2026-11-22: a day-old "Focus block done" still offered End break and Another
 * block; it came from a version whose buttons carried no expiry, and its break had long ended).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOTICE_KEYS, staleNoticeKeys } from '../../../plugin-store/walnut-rhythm/src/server/notices'
import { makeHarness, MIN } from './harness'

const NINE = new Date(2026, 8, 25, 9, 0).getTime()

/** The notice a version before expiring buttons left in the feed: no expiresAt on either button. */
const OLD_FOCUS_DONE = {
  kind: 'reminder' as const,
  title: 'Focus block done, 10 min break',
  body: '45 min. Stand up and move; the break ends at 2:50 PM.',
  dedupKey: 'focus-done',
  severity: 'success' as const,
  actions: [
    { label: 'End break', op: 'break_skip' },
    { label: 'Another block', op: 'focus_start', args: { minutes: 45, breakMinutes: 10 } },
  ],
}

async function loadWith(focus: Record<string, unknown>, feed: string[]) {
  const h = makeHarness({ start: NINE })
  await h.fake.api.storage.writeJson('state.json', { version: 1, focus })
  for (const key of feed) h.feed.set(key, key === 'focus-done' ? OLD_FOCUS_DONE : { ...OLD_FOCUS_DONE, dedupKey: key, title: 'Break over. Start the next block?' })
  const runtime = h.build()
  await runtime.load()
  return { h, runtime }
}

const IDLE = { phase: 'idle', minutes: 45, breakMinutes: 10, completedInCycle: 1, lastEndedAt: NINE - 23 * 60 * MIN }

describe('Rhythm drops its notices whose moment passed when it loads', () => {
  it('idle a day after the break: the block-done notice and its buttons are gone, the next-block question stays', async () => {
    const { h } = await loadWith(IDLE, ['focus-done', 'break-over'])
    expect(h.feed.has('focus-done')).toBe(false)
    expect(h.feed.has('break-over')).toBe(true)
  })

  it('a break still running keeps its block-done notice', async () => {
    const { h } = await loadWith({ phase: 'break', minutes: 45, breakMinutes: 10, breakKind: 'short', startedAt: NINE - 2 * MIN, endsAt: NINE + 8 * MIN, runStartedAt: NINE - 47 * MIN, completedInCycle: 1 }, ['focus-done', 'break-over'])
    expect(h.feed.has('focus-done')).toBe(true)
    expect(h.feed.has('break-over')).toBe(false)
  })

  it('a block running: neither the old block-done notice nor the old question stays', async () => {
    const { h } = await loadWith({ phase: 'focus', minutes: 25, breakMinutes: 5, startedAt: NINE - 5 * MIN, endsAt: NINE + 20 * MIN, runStartedAt: NINE - 5 * MIN }, ['focus-done', 'break-over'])
    expect(h.feed.has('focus-done')).toBe(false)
    expect(h.feed.has('break-over')).toBe(false)
  })

  it('a break that ended while Walnut was down: load keeps the notice, the late break end then takes it', async () => {
    const { h, runtime } = await loadWith({ phase: 'break', minutes: 45, breakMinutes: 10, breakKind: 'short', startedAt: NINE - 30 * MIN, endsAt: NINE - 20 * MIN, runStartedAt: NINE - 75 * MIN, completedInCycle: 1 }, ['focus-done'])
    // Load alone judges the stored phase (a break): the break end, not load, retires it.
    expect(h.feed.has('focus-done')).toBe(true)
    await runtime.kick()
    expect(runtime.focus.phase).toBe('idle')
    expect(h.feed.has('focus-done')).toBe(false)
    // Twenty minutes late is too late to ask the next block.
    expect(h.feed.has('break-over')).toBe(false)
  })

  it('a break that ended a few minutes before the restart still asks the next block', async () => {
    const { h, runtime } = await loadWith({ phase: 'break', minutes: 45, breakMinutes: 10, breakKind: 'short', startedAt: NINE - 13 * MIN, endsAt: NINE - 3 * MIN, runStartedAt: NINE - 58 * MIN, completedInCycle: 1 }, ['focus-done'])
    await runtime.kick()
    expect(h.feed.has('focus-done')).toBe(false)
    expect(h.feed.get('break-over')?.title).toBe('Break over. Start the next block?')
  })

  it('a block that ended while Walnut was down: the old notice goes, the new block-done notice carries expiring buttons', async () => {
    const { h, runtime } = await loadWith({ phase: 'focus', minutes: 25, breakMinutes: 5, startedAt: NINE - 26 * MIN, endsAt: NINE - MIN, runStartedAt: NINE - 26 * MIN }, ['focus-done'])
    expect(h.feed.has('focus-done')).toBe(false)
    await runtime.kick()
    const fresh = h.feed.get('focus-done')
    expect(fresh?.actions?.every((action) => typeof action.expiresAt === 'number')).toBe(true)
  })

  it('every notice Rhythm raises has a key that says when it holds (a new notice cannot skip the reconcile)', () => {
    const server = resolve(__dirname, '../../../plugin-store/walnut-rhythm/src/server')
    const notices = readFileSync(resolve(server, 'notices.ts'), 'utf8')
    const declared = [...notices.matchAll(/export const (KEY_[A-Z_]+) = '([^']+)'/g)].map((match) => match[2]).sort()
    expect(declared.length).toBeGreaterThan(0)
    expect([...NOTICE_KEYS].sort()).toEqual(declared)
    // A notice's key is always one of those constants, never a string of its own.
    for (const line of notices.split('\n').filter((one) => /^\s*dedupKey:/.test(one))) expect(line).toMatch(/dedupKey: KEY_[A-Z_]+,/)
    // And only the runtime raises notices, from the builders in notices.ts.
    for (const file of readdirSync(server).filter((name) => name.endsWith('.ts') && name !== 'runtime.ts')) {
      expect(readFileSync(resolve(server, file), 'utf8'), file).not.toMatch(/notifications\.notify\(/)
    }
    expect(new Set(staleNoticeKeys('idle'))).toEqual(new Set(['stand-up', 'focus-done']))
    expect(new Set(staleNoticeKeys('break'))).toEqual(new Set(['stand-up', 'break-over']))
    expect(new Set(staleNoticeKeys('focus'))).toEqual(new Set(NOTICE_KEYS))
  })
})
