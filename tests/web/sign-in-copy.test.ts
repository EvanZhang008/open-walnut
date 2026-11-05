/**
 * The sign-in page's words (web/src/components/common/sign-in-copy.ts, spec
 * 3.2 and 3.4), pinned verbatim: the page, its Playwright specs and the phone
 * layout spec all assert these strings.
 */
import { describe, it, expect } from 'vitest'
import {
  signInCopy, errorMessage, errorKindFor, pickSignInState, SIGN_IN_BAD_CHARS, SIGN_IN_PENDING_TITLE,
  SIGN_IN_PENDING_LINE, SIGN_IN_PENDING_SLOW,
} from '../../web/src/components/common/sign-in-copy'

const STEP1 = 'On your computer, open Walnut and go to Settings > Phones & Cloud > Browser link.'
const STEP2_TOUCH = 'On this phone, open the link shown under Open on your phone.'
const STEP2_DESK = 'Open the link shown under Open on your phone in this browser, or paste it below.'
const STEP2_HOME = 'Paste the link shown under Open on your phone into the field above. Opening the link opens Safari, not this app.'
const TAGLINE = 'Your tasks, AI sessions and notes, from the computer Walnut runs on.'
const REVOKED_PHONE = 'Removed on your computer, or its sign-in ended. Sign in again with a new link.'
const REVOKED_DESK = REVOKED_PHONE
const HINT = "Can't open the link? Paste it here."
const FOOTER = 'On the computer Walnut runs on? Open Walnut there; it needs no code.'
const NETWORK = 'Walnut did not answer. Check the connection, then try again.'

describe('signInCopy', () => {
  it('unpaired phone', () => {
    const c = signInCopy({ state: 'unpaired', touch: true, standalone: false })
    expect(c.title).toBe('Sign in to Walnut')
    expect(c.tagline).toBe(TAGLINE)
    expect(c.steps).toEqual([STEP1, STEP2_TOUCH])
    expect(c.codeHeading).toBe('Sign-in code')
    expect(c.codeHint).toBe(HINT)
    expect(c.submit).toBe('Sign in')
    expect(c.submitBusy).toBe('Signing in...')
    // No note on a phone: it is never the computer Walnut runs on (2026-11-04, two reviewers).
    expect(c.footer).toBeNull()
    // A computer's browser may be the one Walnut runs on.
    expect(signInCopy({ state: 'unpaired', touch: false, standalone: false }).footer).toBe(FOOTER)
    expect(c.inputLabel).toBe('Sign-in code')
    expect(c.placeholder).toBe('XXXX-XXXX')
    expect(c.retry).toBeNull()
    expect(c.probeError).toBeNull()
    expect(c.codeFirst).toBe(false)
  })

  it('unpaired browser on another computer', () => {
    const c = signInCopy({ state: 'unpaired', touch: false, standalone: false })
    expect(c.title).toBe('Sign in to Walnut')
    expect(c.steps).toEqual([STEP1, STEP2_DESK])
    expect(c.codeHeading).toBe('Sign-in code')
    expect(c.codeHint).toBeNull()
  })

  it('revoked says why when the renewal said: cookies cleared, used elsewhere, a year unused', () => {
    const line = (reason: 'cookie_gone' | 'used_elsewhere' | 'year_unused' | 'removed') => signInCopy({ state: 'revoked', touch: true, standalone: false, reason }).tagline
    expect(line('removed')).toBe('It was signed out from your computer. Sign in again with a new link.')
    expect(line('cookie_gone')).toBe('Its sign-in was cleared from this browser. Sign in again with a new link.')
    expect(line('used_elsewhere')).toBe('Its sign-in was used from another device, so Walnut ended it to keep it safe. Sign in again with a new link.')
    expect(line('year_unused')).toBe('It was not used for a year. Sign in again with a new link.')
    expect(signInCopy({ state: 'revoked', touch: true, standalone: false, reason: null }).tagline).toBe(REVOKED_PHONE)
  })

  it('a phone page has no footer in any state; a computer browser keeps its one line', () => {
    for (const state of ['unpaired', 'revoked', 'signed-out', 'probe-failed'] as const) {
      expect(signInCopy({ state, touch: true, standalone: false, reason: 'removed' }).footer, state).toBeNull()
      expect(signInCopy({ state, touch: false, standalone: false }).footer, state).toBe(FOOTER)
    }
  })

  it('revoked says which device was signed out and how to come back; no retry (a reload shows the same page)', () => {
    const phone = signInCopy({ state: 'revoked', touch: true, standalone: false })
    expect(phone.title).toBe('This phone was signed out')
    expect(phone.tagline).toBe(REVOKED_PHONE)
    expect(phone.retry).toBeNull()
    expect(phone.steps).toEqual([STEP1, STEP2_TOUCH])
    expect(phone.codeHeading).toBe('Sign-in code')
    const desk = signInCopy({ state: 'revoked', touch: false, standalone: false })
    expect(desk.title).toBe('This browser was signed out')
    expect(desk.tagline).toBe(REVOKED_DESK)
  })

  it('signed out by itself: no retry', () => {
    const c = signInCopy({ state: 'signed-out', touch: true, standalone: false })
    expect(c.title).toBe('Signed out')
    expect(c.tagline).toBe('This phone no longer has access to Walnut. Sign in again below.')
    expect(c.retry).toBeNull()
    expect(c.steps).toEqual([STEP1, STEP2_TOUCH])
  })

  it('probe failed: the unpaired page plus an error line and a retry', () => {
    const c = signInCopy({ state: 'probe-failed', touch: true, standalone: false })
    expect(c.title).toBe('Sign in to Walnut')
    expect(c.tagline).toBe(TAGLINE)
    expect(c.probeError).toBe(NETWORK)
    expect(c.probeRetry).toBe('Try again')
    expect(c.retry).toBeNull()
  })

  it('a Home Screen app puts the code first and drops the scan wording', () => {
    const c = signInCopy({ state: 'unpaired', touch: true, standalone: true })
    expect(c.codeFirst).toBe(true)
    expect(c.steps).toEqual([STEP1, STEP2_HOME])
    expect(c.codeHeading).toBe('Sign-in code')
    expect(c.codeHint).toBeNull()
  })

  it('standalone without touch is the plain browser page', () => {
    const c = signInCopy({ state: 'unpaired', touch: false, standalone: true })
    expect(c.codeFirst).toBe(false)
    expect(c.steps[1]).toBe(STEP2_DESK)
  })

  it('no string carries a tunnel or port hint', () => {
    for (const state of ['unpaired', 'revoked', 'signed-out', 'probe-failed'] as const) {
      for (const touch of [true, false]) {
        for (const standalone of [true, false]) {
          const text = JSON.stringify(signInCopy({ state, touch, standalone }))
          expect(text).not.toMatch(/ssh|localhost|-L |:\d{2,5}\b|pair the Walnut app/)
          expect(text).not.toMatch(/[\u2013\u2014]/)
        }
      }
    }
  })

  it('pending and field lines', () => {
    expect(SIGN_IN_PENDING_TITLE).toBe('Signing in...')
    expect(SIGN_IN_PENDING_LINE).toBe('Checking the code from your link.')
    expect(SIGN_IN_PENDING_SLOW).toBe('Still waiting for Walnut. The connection may be slow.')
    expect(SIGN_IN_BAD_CHARS).toBe('Codes never use 0, 1, I, L or O.')
  })
})

describe('errorMessage', () => {
  it('has one line per kind', () => {
    expect(errorMessage('invalid_code', 400)).toBe('That code is wrong, already used or expired. Make a new one in Walnut on your computer.')
    expect(errorMessage('rate_limited', 429)).toBe('Too many wrong codes. Wait a minute, then try again.')
    expect(errorMessage('network')).toBe(NETWORK)
    expect(errorMessage('other', 500, 'Walnut is restarting.')).toBe('Walnut is restarting.')
    expect(errorMessage('other', 503, '')).toBe('Walnut refused the code (503).')
    expect(errorMessage('other', 502, null)).toBe('Walnut refused the code (502).')
  })

  it('classifies a refusal', () => {
    expect(errorKindFor(null)).toBe('network')
    expect(errorKindFor(400, 'invalid_code')).toBe('invalid_code')
    expect(errorKindFor(429, null)).toBe('rate_limited')
    expect(errorKindFor(429, 'rate_limited')).toBe('rate_limited')
    expect(errorKindFor(500, null)).toBe('other')
  })
})

describe('pickSignInState', () => {
  it('a failed probe shows probe-failed (spec D5, C87: the gate does not pass it yet)', () => {
    expect(pickSignInState('ok', true, false)).toBe('probe-failed')
    const c = signInCopy({ state: pickSignInState('ok', true, false), touch: true, standalone: false })
    expect(c.probeError).toBe(NETWORK)
    expect(c.probeRetry).toBe('Try again')
  })

  it('a refusal outranks a failed probe', () => {
    expect(pickSignInState('revoked', true, false)).toBe('revoked')
    expect(pickSignInState('unpaired', false, false)).toBe('unpaired')
    expect(pickSignInState('unpaired', true, false)).toBe('probe-failed')
  })

  it('a self sign-out wins over the refusal its reload meets', () => {
    expect(pickSignInState('revoked', false, true)).toBe('signed-out')
    expect(pickSignInState('unpaired', false, true)).toBe('signed-out')
    // Signed in again (state ok): a leftover mark shows nothing by itself.
    expect(pickSignInState('ok', false, true)).toBe('unpaired')
  })
})
