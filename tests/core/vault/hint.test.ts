/**
 * The master password hint rule (src/core/vault/hint.ts): what a hint may not say about the
 * password, and the server's check when it holds only the password key.
 */
import { describe, it, expect } from 'vitest'
import { HINT_MAX, hintIsPasswordKey, hintProblem, readHint } from '../../../src/core/vault/hint.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../../src/core/vault/crypto.js'

describe('hintProblem', () => {
  const pw = 'Correct Horse Battery'

  it('lets a hint that only reminds pass, and an empty one', () => {
    expect(hintProblem('the poster in my first flat', pw)).toBeNull()
    expect(hintProblem('', pw)).toBeNull()
    expect(hintProblem('   ', pw)).toBeNull()
  })

  it('refuses a hint that contains the password, in any case and with spaces moved', () => {
    expect(hintProblem('Correct Horse Battery', pw)).toMatch(/contains your master password/)
    expect(hintProblem('it is correct horse battery!', pw)).toMatch(/contains/)
    expect(hintProblem('CORRECTHORSEBATTERY', pw)).toMatch(/contains/)
    expect(hintProblem('c o r r e c t horse battery', pw)).toMatch(/contains/)
  })

  it('refuses a hint of 4+ characters that is part of the password, and lets a shorter one pass', () => {
    expect(hintProblem('horse', pw)).toMatch(/part of your master password/)
    expect(hintProblem('Horse Bat', pw)).toMatch(/part of/)
    expect(hintProblem('hors', pw)).toMatch(/part of/)
    expect(hintProblem('hor', pw)).toBeNull()
  })

  it('refuses one over the length limit, with or without a password', () => {
    expect(hintProblem('x'.repeat(HINT_MAX), pw)).toBeNull()
    expect(hintProblem('x'.repeat(HINT_MAX + 1))).toMatch(/at most 100/)
  })

  it('compares NFKC forms, as the key derivation does', () => {
    // U+FF28 FULLWIDTH LATIN CAPITAL LETTER H folds to "h".
    expect(hintProblem('Ｈorse', pw)).toMatch(/part of/)
  })
})

describe('readHint', () => {
  it('tells an absent field from an empty one, and tidies whitespace', () => {
    expect(readHint(undefined)).toBeUndefined()
    expect(readHint(42)).toBeUndefined()
    expect(readHint('')).toBe('')
    expect(readHint('  my\n first   dog ')).toBe('my first dog')
  })
})

describe('hintIsPasswordKey', () => {
  const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }

  it('finds a hint that is the password as typed, without spaces, or in lower case', async () => {
    const key = toB64(await derivePasswordKey('blue moon river', kdf))
    expect(await hintIsPasswordKey('blue moon river', key, kdf)).toBe(true)
    expect(await hintIsPasswordKey('Blue Moon River', key, kdf)).toBe(true)
    const squashed = toB64(await derivePasswordKey('bluemoonriver', kdf))
    expect(await hintIsPasswordKey('Blue Moon River', squashed, kdf)).toBe(true)
    expect(await hintIsPasswordKey('a song my mother sang', key, kdf)).toBe(false)
  }, 30_000)
})
