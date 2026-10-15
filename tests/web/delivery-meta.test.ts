/**
 * The delivery line under a just-sent message on a phone (spec 4.4, C71):
 * one reading per state, `Starting the session...` after 5 s, `Delivered`
 * fades after 2 s, a failure is the retry. Nothing here ever resends.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  ageOf, deliveryMeta, DELIVERY_TEXT, STARTING_AFTER_MS, DELIVERED_FADE_AFTER_MS,
} from '../../web/src/components/sessions/delivery-meta'
import { promptsWaitingLabel } from '../../web/src/components/sessions/PhoneTimelinePills'

const ROOT = join(__dirname, '..', '..')

describe('deliveryMeta', () => {
  it('an RPC in flight reads Sending...', () => {
    expect(deliveryMeta({ status: 'pending', turnRunning: false, ageMs: 100 })).toMatchObject({
      kind: 'sending', text: 'Sending...', retry: false,
    })
  })

  it('a queued line behind a running turn says when it lands', () => {
    expect(deliveryMeta({ status: 'received', turnRunning: true, ageMs: 9000 })?.text)
      .toBe('Queued: delivered when this turn ends')
  })

  it('a queued line with no turn running is still on its way (a cold resume)', () => {
    expect(deliveryMeta({ status: 'received', turnRunning: false, ageMs: 1000 })?.text).toBe('Sending...')
    expect(deliveryMeta({ status: 'received', turnRunning: false, ageMs: STARTING_AFTER_MS })?.text)
      .toBe('Sending... Starting the session...')
    expect(deliveryMeta({ status: 'pending', turnRunning: false, ageMs: STARTING_AFTER_MS + 1 })?.text)
      .toBe(`${DELIVERY_TEXT.sending} ${DELIVERY_TEXT.starting}`)
  })

  it('Delivered fades after 2 s', () => {
    expect(deliveryMeta({ status: 'delivered', turnRunning: false, ageMs: 0, deliveredForMs: 100 }))
      .toMatchObject({ text: 'Delivered', fading: false })
    expect(deliveryMeta({ status: 'delivered', turnRunning: true, ageMs: 0, deliveredForMs: DELIVERED_FADE_AFTER_MS }))
      .toMatchObject({ text: 'Delivered', fading: true })
  })

  it('a failure is a tap to retry, never an automatic resend', () => {
    expect(deliveryMeta({ status: 'failed', turnRunning: true, ageMs: 60_000 }))
      .toEqual({ kind: 'failed', text: 'Not sent. Tap to retry.', retry: true, fading: false })
  })

  it('a row with no send state draws no line', () => {
    expect(deliveryMeta({ status: undefined, turnRunning: false, ageMs: 0 })).toBeNull()
  })
})

describe('ageOf', () => {
  it('measures from an ISO time and never goes negative', () => {
    const now = Date.parse('2026-10-14T10:00:10.000Z')
    expect(ageOf('2026-10-14T10:00:00.000Z', now)).toBe(10_000)
    expect(ageOf('2026-10-14T10:00:20.000Z', now)).toBe(0)
    expect(ageOf(undefined, now)).toBe(0)
    expect(ageOf('not a date', now)).toBe(0)
  })
})

describe('promptsWaitingLabel', () => {
  it('counts the prompts in words', () => {
    expect(promptsWaitingLabel(1)).toBe('1 prompt waiting')
    expect(promptsWaitingLabel(2)).toBe('2 prompts waiting')
  })
})

/**
 * Release hygiene for this package's new files (C54): English copy only, no
 * em or en dash, nothing outside ASCII (a glyph is written as a \u escape).
 */
describe('phone session files: release hygiene (C54)', () => {
  const files = [
    'web/src/components/sessions/phone-session-layer.tsx',
    'web/src/components/sessions/PhoneSessionHeaderRows.tsx',
    'web/src/components/sessions/PromptCards.tsx',
    'web/src/components/sessions/tool-call-grouping.ts',
    'web/src/components/sessions/delivery-meta.ts',
    'web/src/components/sessions/DeliveryMetaLine.tsx',
    'web/src/components/sessions/PhoneTimelinePills.tsx',
    'web/src/components/chat/touch-return.ts',
    'web/src/hooks/useArmAfterAppear.ts',
    'web/src/hooks/usePhoneRestore.ts',
    'web/src/styles/phone-session.css',
    'tests/e2e/browser/phone-session.spec.ts',
    'tests/e2e/browser/phone-prompts.spec.ts',
    'tests/e2e/browser/phone-boot-latency.spec.ts',
  ]
  for (const rel of files) {
    it(`${rel} is plain ASCII with no dashes`, () => {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      expect(text.match(/[\u2013\u2014]/g) ?? []).toEqual([])
      const odd = [...text].filter((ch) => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && ch !== '\n' && ch !== '\t'))
      expect(odd).toEqual([])
    })
  }
})
