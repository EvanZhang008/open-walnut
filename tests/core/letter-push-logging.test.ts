/**
 * Every reason a letter produces no push must be GREPPABLE.
 *
 * This is the other half of the invisible-failure bug: the zero-token exit
 * returned `reason: 'no device registered for push'` to a caller that discards it
 * (the bus subscriber), and logged nothing at all. `/tmp/open-walnut/*.log` held
 * no line about push for any letter, ever, which is why a broken registration
 * path survived for weeks with a letter arriving every day.
 *
 * Contract under test:
 *   - EXACTLY ONE `letter push` line per letter, on every path (sent, suppressed,
 *     zero tokens, unreadable config, credential missing).
 *   - a letter that reached no device logs at WARN, so it shows up in an errors
 *     sweep instead of hiding among info chatter.
 *   - the line names the reason and the full untruncated letter id.
 *   - the permanent-condition remediation text (no device registered / APNs not
 *     configured) is logged ONCE per process, not once per letter — loud, not a
 *     flood.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const getConfig = vi.hoisted(() => vi.fn())
const updatePushTokens = vi.hoisted(() => vi.fn(
  async (mutate: (t: unknown[]) => unknown[] | null) => mutate([]) ?? [],
))
const sendApns = vi.hoisted(() => vi.fn(async () => ({
  attempted: true, sent: 1, failed: 0, deadTokens: [] as string[],
})))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-letter-push-log'))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig, updatePushTokens }))
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test' })),
  recordApnsError: vi.fn(),
  closeApnsSessions: vi.fn(),
}))

import { pushLetter, resetLetterPushWarningsForTests } from '../../src/core/push/letter-push.js'
import { log } from '../../src/logging/index.js'
import type { PushTokenEntry } from '../../src/core/types.js'

const TOKEN = 'd'.repeat(64)
const LETTER_ID = 'lt-m9x2k1-a4f7'

function letter(over: Record<string, unknown> = {}) {
  return {
    letterId: LETTER_ID,
    subject: 'Sync freeze root cause found',
    type: 'review',
    textPreview: 'The 22h stall was an orphaned rebase lock.',
    kind: 'new' as const,
    ...over,
  }
}

function device(over: Partial<PushTokenEntry> = {}): PushTokenEntry {
  return {
    token: TOKEN, platform: 'ios', kind: 'apns', environment: 'production',
    key_name: 'iPhone', registered_at: new Date().toISOString(), mode: 'always',
    ...over,
  }
}

type Line = { message: string; fields: Record<string, unknown> }

function lines(spy: ReturnType<typeof vi.spyOn>): Line[] {
  return spy.mock.calls.map((c) => ({
    message: String(c[0]),
    fields: (c[1] ?? {}) as Record<string, unknown>,
  }))
}

let warn: ReturnType<typeof vi.spyOn>
let info: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // restoreAllMocks resets the module mocks too, so every implementation this
  // file depends on is (re)established right after it.
  vi.restoreAllMocks()
  getConfig.mockReset()
  sendApns.mockClear()
  sendApns.mockResolvedValue({ attempted: true, sent: 1, failed: 0, deadTokens: [] })
  updatePushTokens.mockImplementation(
    async (mutate: (t: unknown[]) => unknown[] | null) => mutate([]) ?? [],
  )
  resetLetterPushWarningsForTests()
  warn = vi.spyOn(log.notif, 'warn').mockImplementation(() => {})
  info = vi.spyOn(log.notif, 'info').mockImplementation(() => {})
})

describe('one greppable line per letter', () => {
  it('zero registered devices warns once, and every letter still logs its own line', async () => {
    getConfig.mockResolvedValue({ push_tokens: [] })

    await pushLetter(letter())
    const first = lines(warn)
    // The remediation text: once per process.
    const remediation = first.filter((l) => l.message.includes('no device is registered'))
    expect(remediation).toHaveLength(1)
    expect(String(remediation[0]?.fields.hint)).toMatch(/replica/i)
    // The per-letter line: warn (nothing was sent), with the reason and full id.
    const summary = first.filter((l) => l.message === 'letter push')
    expect(summary).toHaveLength(1)
    expect(summary[0]?.fields).toMatchObject({
      letterId: LETTER_ID, attempted: false, sent: 0, devices: 0,
      reason: 'no device registered for push',
    })

    await pushLetter(letter({ letterId: 'lt-second-9f21' }))
    const all = lines(warn)
    // Still exactly one remediation line, now two per-letter lines.
    expect(all.filter((l) => l.message.includes('no device is registered'))).toHaveLength(1)
    const summaries = all.filter((l) => l.message === 'letter push')
    expect(summaries).toHaveLength(2)
    expect(summaries[1]?.fields.letterId).toBe('lt-second-9f21')
  })

  it('a successful send logs one info line naming the device count', async () => {
    getConfig.mockResolvedValue({ push_tokens: [device()] })
    const out = await pushLetter(letter())
    expect(out).toMatchObject({ attempted: true, sent: 1 })
    const summaries = lines(info).filter((l) => l.message === 'letter push')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.fields).toMatchObject({
      letterId: LETTER_ID, devices: 1, targeted: 1, sent: 1, failed: 0, suppressed: 0,
    })
    expect(lines(warn).filter((l) => l.message === 'letter push')).toHaveLength(0)
  })

  it('an all-suppressed letter logs once, at warn, with the reason', async () => {
    getConfig.mockResolvedValue({
      push_tokens: [device({ mode: 'when-inactive', active_at: Date.now() })],
    })
    const out = await pushLetter(letter())
    expect(out).toMatchObject({ attempted: false, sent: 0, suppressed: 1 })
    const summaries = lines(warn).filter((l) => l.message === 'letter push')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.fields).toMatchObject({
      letterId: LETTER_ID, devices: 1, targeted: 0, suppressed: 1,
      reason: 'all devices are foreground-active or muted this letter type',
    })
    expect(lines(info).filter((l) => l.message === 'letter push')).toHaveLength(0)
  })

  it('a missing APNs credential warns once and names the reason per letter', async () => {
    getConfig.mockResolvedValue({ push_tokens: [device()] })
    sendApns.mockResolvedValue({
      attempted: false,
      reason: 'APNs auth key not configured (missing key_id, team_id, key_path)',
      sent: 0, failed: 0, deadTokens: [],
    })

    await pushLetter(letter())
    await pushLetter(letter({ letterId: 'lt-third-77aa' }))

    const all = lines(warn)
    expect(all.filter((l) => l.message.includes('APNs is not configured'))).toHaveLength(1)
    const summaries = all.filter((l) => l.message === 'letter push')
    expect(summaries).toHaveLength(2)
    for (const s of summaries) {
      expect(String(s.fields.reason)).toMatch(/APNs auth key not configured/)
      expect(s.fields.attempted).toBe(false)
    }
  })

  it('an APNs rejection that killed a token reports the prune in the same line', async () => {
    getConfig.mockResolvedValue({ push_tokens: [device()] })
    sendApns.mockResolvedValue({
      attempted: true, sent: 0, failed: 1, deadTokens: [TOKEN],
    })
    const out = await pushLetter(letter())
    expect(out).toMatchObject({ attempted: true, sent: 0, failed: 1 })
    const summaries = lines(warn).filter((l) => l.message === 'letter push')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.fields).toMatchObject({ failed: 1, deadTokensPruned: 1 })
  })

  it('an unreadable config is a logged line, not a silent return', async () => {
    getConfig.mockRejectedValue(new Error('config.yaml is a directory'))
    const out = await pushLetter(letter())
    expect(out.attempted).toBe(false)
    const summaries = lines(warn).filter((l) => l.message === 'letter push')
    expect(summaries).toHaveLength(1)
    expect(String(summaries[0]?.fields.reason)).toMatch(/config unreadable/)
  })

  it('a THROWING callee still leaves exactly one line behind', async () => {
    // The guarantee has to be structural: before this, a throw from any callee
    // skipped the summary entirely and the letter produced ZERO lines — the same
    // invisibility the whole funnel exists to prevent.
    const error = vi.spyOn(log.notif, 'error').mockImplementation(() => {})
    getConfig.mockResolvedValue({ push_tokens: [device()] })
    sendApns.mockRejectedValue(new Error('http2 session exploded'))

    await expect(pushLetter(letter())).rejects.toThrow('http2 session exploded')

    const summaries = [...lines(error), ...lines(warn), ...lines(info)]
      .filter((l) => l.message === 'letter push')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.fields).toMatchObject({ letterId: LETTER_ID, attempted: false, sent: 0 })
    expect(String(summaries[0]?.fields.reason)).toMatch(/push threw: http2 session exploded/)
  })
})
