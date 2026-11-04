/**
 * The extension's pure autofill parts: a strong password made to fit what a field accepts
 * (field-rules.ts), and what a card or identity item fills by form part (bg-wallet.ts).
 */
import { describe, expect, it } from 'vitest'
import { generateFitting } from '../../../packages/browser-extension/src/field-rules'
import { identityParts, walletValues } from '../../../packages/browser-extension/src/bg-wallet'
import { DEFAULT_PASSWORD } from '../../../src/core/vault/generator'
import type { VaultItem } from '../../../src/core/vault/types'

const now = new Date().toISOString()

describe('a strong password that fits the field', () => {
  it('keeps to maxlength and minlength', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateFitting(DEFAULT_PASSWORD, { maxLength: 12 }).length).toBe(12)
      expect(generateFitting({ ...DEFAULT_PASSWORD, length: 10 }, { minLength: 16 }).length).toBe(16)
    }
  })

  it('follows a pattern that forbids symbols', () => {
    for (let i = 0; i < 20; i++) expect(generateFitting(DEFAULT_PASSWORD, { maxLength: 14, pattern: '[A-Za-z0-9]{8,14}' })).toMatch(/^[A-Za-z0-9]{14}$/)
  })

  it('follows passwordrules: lengths, classes, and a site\'s own special characters', () => {
    for (let i = 0; i < 20; i++) {
      const pw = generateFitting(DEFAULT_PASSWORD, { passwordrules: 'minlength: 10; maxlength: 15; required: lower; required: upper; required: digit; allowed: [-_]' })
      expect(pw.length).toBe(15)
      expect(pw).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(pw).toMatch(/[-_]/)
      expect(generateFitting(DEFAULT_PASSWORD, { passwordrules: 'required: digit; maxlength: 8' })).toMatch(/^\d{8}$/)
    }
  })

  it('a field with no rules gets the generator as set', () => {
    expect(generateFitting(DEFAULT_PASSWORD).length).toBe(DEFAULT_PASSWORD.length)
  })
})

describe('what a card or identity fills', () => {
  it('a card: number without spaces, a four-digit year, its code', () => {
    const card: VaultItem = { id: 'c', type: 'card', title: 'Visa', card: { holder: 'Ada Example', number: '4242 4242 4242 4242', expMonth: '03', expYear: '29', code: '123' }, createdAt: now, updatedAt: now }
    expect(walletValues(card)).toEqual({ 'cc-name': 'Ada Example', 'cc-number': '4242424242424242', 'cc-exp-month': '3', 'cc-exp-year': '2029', 'cc-csc': '123' })
  })

  it('an identity from its custom fields, by any usual name, with the name split and joined', () => {
    const who: VaultItem = {
      id: 'i', type: 'identity', title: 'Home', createdAt: now, updatedAt: now,
      fields: [{ name: 'Full name', value: 'Ada Lovelace Example' }, { name: 'E-mail', value: 'ada@example.test' }, { name: 'Address 1', value: '1 Main St' },
        { name: 'Address 2', value: 'Apt 4' }, { name: 'City', value: 'Springfield' }, { name: 'ZIP', value: '12345' }, { name: 'State', value: 'OR' }, { name: 'Phone', value: '555-0100' }],
    }
    expect(identityParts(who)).toMatchObject({
      name: 'Ada Lovelace Example', 'given-name': 'Ada', 'family-name': 'Lovelace Example', email: 'ada@example.test', tel: '555-0100',
      'address-line1': '1 Main St', 'address-line2': 'Apt 4', 'street-address': '1 Main St, Apt 4', city: 'Springfield', region: 'OR', 'postal-code': '12345',
    })
  })
})
