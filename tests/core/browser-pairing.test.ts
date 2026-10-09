/** Browser sign-in codes (src/core/browser-pairing.ts): one use, ten minutes, typed loosely. */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  CODE_ALPHABET, CODE_TTL_MS, MAX_LIVE_CODES, _resetBrowserCodesForTesting, consumeBrowserCode, mintBrowserCode, normalizeCode,
} from '../../src/core/browser-pairing.js'

beforeEach(() => _resetBrowserCodesForTesting())

describe('browser sign-in codes', () => {
  it('a code is eight characters without look-alikes, shown with a dash', () => {
    const { code } = mintBrowserCode()
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    for (const ch of normalizeCode(code)) expect(CODE_ALPHABET).toContain(ch)
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/)
  })

  it('works once, typed in lower case, with or without the dash or spaces', () => {
    const { code } = mintBrowserCode()
    const typed = ` ${code.toLowerCase().replace('-', ' ')} `
    expect(consumeBrowserCode(typed)).toBe(true)
    expect(consumeBrowserCode(code)).toBe(false)
  })

  it('expires after ten minutes', () => {
    const t0 = 5_000_000
    const { code } = mintBrowserCode(t0)
    expect(consumeBrowserCode(code, t0 + CODE_TTL_MS + 1)).toBe(false)
    const second = mintBrowserCode(t0)
    expect(consumeBrowserCode(second.code, t0 + CODE_TTL_MS - 1)).toBe(true)
  })

  it('a wrong or malformed code is refused and leaves the live one alone', () => {
    const { code } = mintBrowserCode()
    expect(consumeBrowserCode('ABCD-EFGH')).toBe(false)
    expect(consumeBrowserCode('')).toBe(false)
    expect(consumeBrowserCode('x'.repeat(30))).toBe(false)
    expect(consumeBrowserCode(code)).toBe(true)
  })

  it('keeps only the newest few live codes', () => {
    const codes = Array.from({ length: MAX_LIVE_CODES + 2 }, () => mintBrowserCode().code)
    expect(consumeBrowserCode(codes[0]!)).toBe(false)
    expect(consumeBrowserCode(codes[1]!)).toBe(false)
    expect(consumeBrowserCode(codes.at(-1)!)).toBe(true)
  })
})
