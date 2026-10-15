/**
 * The sign-in code field's formatter (web/src/components/common/sign-in-code.ts,
 * spec 3.3). Display only; the server normalizes again. The client alphabet is
 * pinned to the server's so a change on one side cannot drift silently.
 */
import { describe, it, expect } from 'vitest'
import {
  formatSignInCode, isSubmittableSignInCode, SIGN_IN_CODE_ALPHABET,
} from '../../web/src/components/common/sign-in-code'
import { CODE_ALPHABET } from '../../src/core/browser-pairing'

describe('formatSignInCode', () => {
  it.each([
    ['abcd efgh', 'ABCD-EFGH'],
    ['abcdefgh', 'ABCD-EFGH'],
    [' ab-cd ef gh ', 'ABCD-EFGH'],
    ['https://x.example/#pair=AB2C-DE3F', 'AB2C-DE3F'],
    ['https://x.example/#pair=ab2c-de3f', 'AB2C-DE3F'],
    ['ABCDEFGHJK', 'ABCD-EFGH'],
    ['ABCD', 'ABCD'],
    ['abcde', 'ABCD-E'],
    ['', ''],
    ['--- !! ...', ''],
    // Accented letters are not in the alphabet: dropped.
    ['\u00e9\u00e8 ab', 'AB'],
  ])('%j shows %j', (raw, display) => {
    expect(formatSignInCode(raw).display).toBe(display)
  })

  it('returns the code without the dash as normalized', () => {
    expect(formatSignInCode('abcd-efgh').normalized).toBe('ABCDEFGH')
    expect(formatSignInCode('ABCD').normalized).toBe('ABCD')
    expect(formatSignInCode('').normalized).toBe('')
  })

  it('keeps characters no code uses and flags them', () => {
    const typed = formatSignInCode('abcd-ef0h')
    expect(typed.display).toBe('ABCD-EF0H')
    expect(typed.badChars).toBe(true)
    for (const ch of ['0', '1', 'I', 'L', 'O', 'i', 'l', 'o']) {
      expect(formatSignInCode(`ABC${ch}`).badChars).toBe(true)
    }
    expect(formatSignInCode('AB2C-DE3F').badChars).toBe(false)
    expect(formatSignInCode('').badChars).toBe(false)
  })

  it('only a full code without a bad character may submit', () => {
    expect(isSubmittableSignInCode(formatSignInCode('abc'))).toBe(false)
    expect(isSubmittableSignInCode(formatSignInCode('abcd-efgh'))).toBe(true)
    expect(isSubmittableSignInCode(formatSignInCode('abcd-ef0h'))).toBe(false)
    expect(isSubmittableSignInCode(formatSignInCode('abcdefghjk'))).toBe(true)
  })

  it('a non-string input formats as empty', () => {
    expect(formatSignInCode(undefined as unknown as string).display).toBe('')
  })
})

describe('SIGN_IN_CODE_ALPHABET', () => {
  it('equals the server CODE_ALPHABET', () => {
    expect(SIGN_IN_CODE_ALPHABET).toBe(CODE_ALPHABET)
  })

  it('has none of 0, 1, I, L, O', () => {
    for (const ch of '01ILO') expect(SIGN_IN_CODE_ALPHABET.includes(ch)).toBe(false)
  })
})
