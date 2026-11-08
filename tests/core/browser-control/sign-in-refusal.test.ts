/**
 * A sign-in page that refuses the agent's browser is known by its address or its words
 * (src/core/browser-control/sign-in-refusal.ts), so the agent hands the sign-in to the person
 * instead of trying again (2026-11-08: another agent's browser met Google's "This browser or app
 * may not be secure"; the user: "let our browser task learn from this").
 */
import { describe, expect, it } from 'vitest'
import { signInRefusalOf } from '../../../src/core/browser-control/sign-in-refusal'

describe('a sign-in refusal', () => {
  it('Google\'s refusal pages, by address (v3 and v2) or by their words', () => {
    for (const url of [
      'https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fmail.google.com',
      'https://accounts.google.com/signin/v2/deniedsigninrejected?flowName=GlifWebSignIn',
      'https://accounts.google.com/signin/rejected',
    ]) expect(signInRefusalOf({ url })?.why, url).toBe('google_refused_browser')
    expect(signInRefusalOf({ url: 'https://accounts.google.com/v3/signin/identifier', snapshot: 'Couldn’t sign you in\nThis browser or app may not be secure. Learn more' }))
      .toMatchObject({ why: 'google_refused_browser', site: 'accounts.google.com', next: 'request_sign_in' })
    expect(signInRefusalOf({ url: 'https://accounts.google.co.uk/signin/rejected' })?.why).toBe('google_refused_browser')
  })

  it('nothing on an ordinary sign-in page, another site saying the words, or no address', () => {
    expect(signInRefusalOf({ url: 'https://accounts.google.com/v3/signin/identifier', title: 'Sign in - Google Accounts' })).toBeNull()
    expect(signInRefusalOf({ url: 'https://blog.example.test/why', text: 'This browser or app may not be secure, says Google' })).toBeNull()
    expect(signInRefusalOf({ url: 'https://accounts.google.com.evil.test/signin/rejected' })).toBeNull()
    expect(signInRefusalOf({})).toBeNull()
    expect(signInRefusalOf(undefined)).toBeNull()
  })
})
