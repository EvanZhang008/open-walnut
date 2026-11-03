/**
 * The vault's pure parts (src/core/vault/): crypto, Secret Key, generator, site
 * matching, TOTP, strength and the importers. Fake data only.
 */
import { describe, it, expect } from 'vitest'
import {
  seal, open, sealJson, openJson, randomBytes, newSecretKey, parseSecretKey, deriveUnlockKey, derivePasswordKey, toB64,
} from '../../../src/core/vault/crypto.js'
import { generatePassword, generatePassphrase, generatorBits, randomInt, DEFAULT_PASSWORD } from '../../../src/core/vault/generator.js'
import { WORDLIST } from '../../../src/core/vault/wordlist.js'
import { matchSite, matchItem, normalizeUrl } from '../../../src/core/vault/url-match.js'
import { parseTotp, totpAt, base32Decode } from '../../../src/core/vault/totp.js'
import { passwordStrength, securityReport } from '../../../src/core/vault/strength.js'
import { detectFormat, parseCsv, parseImport, ImportError } from '../../../src/core/vault/import.js'
import { exportItems } from '../../../src/core/vault/export.js'
import type { VaultItem } from '../../../src/core/vault/types.js'

describe('crypto', () => {
  it('seals and opens, and refuses another key, a changed byte or another label', async () => {
    const k = randomBytes(32)
    const s = await seal(k, new TextEncoder().encode('hunter2'), 'item:a')
    expect(new TextDecoder().decode(await open(k, s, 'item:a'))).toBe('hunter2')
    await expect(open(randomBytes(32), s, 'item:a')).rejects.toThrow()
    await expect(open(k, s, 'item:b')).rejects.toThrow()
    const ct = Uint8Array.from(atob(s.ct), (c) => c.charCodeAt(0))
    ct[0] ^= 1
    await expect(open(k, { iv: s.iv, ct: toB64(ct) }, 'item:a')).rejects.toThrow()
    expect(await openJson(k, await sealJson(k, { a: '密码' }, 'x'), 'x')).toEqual({ a: '密码' })
  })

  it('a Secret Key round-trips in any case and spacing, and a bad one is refused', () => {
    for (let i = 0; i < 50; i++) {
      const sk = newSecretKey()
      expect(sk).toMatch(/^W1-[A-Z2-9]{6}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/)
      const b = parseSecretKey(sk)!
      expect(b.length).toBe(16)
      expect(parseSecretKey(sk.toLowerCase().replace(/-/g, ' '))).toEqual(b)
    }
    expect(parseSecretKey('W1-ABC')).toBeNull()
    expect(parseSecretKey('X1-' + 'A'.repeat(26))).toBeNull()
    expect(parseSecretKey('W1-' + '0'.repeat(26))).toBeNull()
  })

  it('the unlock key needs both the password and the Secret Key', async () => {
    const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
    const pw = await derivePasswordKey('correct horse', kdf)
    expect(await derivePasswordKey('correct horse', kdf)).toEqual(pw)
    expect(await derivePasswordKey('correct horsf', kdf)).not.toEqual(pw)
    const salt = randomBytes(16)
    const sk = parseSecretKey(newSecretKey())!
    const a = await deriveUnlockKey(pw, sk, salt)
    expect(await deriveUnlockKey(pw, sk, salt)).toEqual(a)
    expect(await deriveUnlockKey(pw, parseSecretKey(newSecretKey())!, salt)).not.toEqual(a)
  })
})

describe('generator', () => {
  it('random passwords have the length and one of each chosen class', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword({ ...DEFAULT_PASSWORD, length: 12 })
      expect(p).toHaveLength(12)
      expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[0-9]/); expect(p).toMatch(/[^A-Za-z0-9]/)
      expect(p).not.toMatch(/[lI1|O0o]/)
    }
    expect(generatePassword({ ...DEFAULT_PASSWORD, length: 3 })).toHaveLength(8)
    expect(generatePassword({ ...DEFAULT_PASSWORD, upper: false, lower: false, digits: true, symbols: false, length: 10 })).toMatch(/^[2-9]{10}$/)
    expect(generatorBits(DEFAULT_PASSWORD)).toBeGreaterThan(110)
  })

  it('passphrases use the word list, the separator and one digit', () => {
    expect(WORDLIST).toHaveLength(1296)
    const p = generatePassphrase({ kind: 'words', words: 5, separator: '-', capitalize: true, number: true })
    const parts = p.split('-')
    expect(parts).toHaveLength(5)
    expect(parts.every((w) => /^[A-Z]/.test(w))).toBe(true)
    expect(p.replace(/[^0-9]/g, '')).toHaveLength(1)
  })

  it('randomInt is roughly uniform', () => {
    const counts = new Array(6).fill(0)
    for (let i = 0; i < 6000; i++) counts[randomInt(6)]++
    for (const c of counts) { expect(c).toBeGreaterThan(850); expect(c).toBeLessThan(1150) }
  })
})

describe('site matching', () => {
  it('normalizes a bare host to https and drops the fragment', () => {
    expect(normalizeUrl('GitHub.com')).toBe('https://github.com')
    expect(normalizeUrl('https://a.example.com/login#x')).toBe('https://a.example.com/login')
    expect(normalizeUrl('   ')).toBe('')
  })

  it('matches by registrable domain, never across a private suffix or from https to http', () => {
    expect(matchSite('https://github.com', 'https://github.com/login')).toBe('exact_host')
    expect(matchSite('https://accounts.example.co.uk', 'https://www.example.co.uk/')).toBe('domain')
    expect(matchSite('https://alice.github.io', 'https://mallory.github.io/')).toBeNull()
    expect(matchSite('https://example.com', 'http://example.com/')).toBeNull()
    expect(matchSite('http://example.com', 'https://example.com/')).toBe('exact_host')
    expect(matchSite('https://example.com', 'https://example.com.evil.test/')).toBeNull()
    expect(matchItem(['https://x.test', 'https://login.example.com'], 'https://login.example.com/a')).toBe('exact_host')
    expect(matchSite('https://192.168.1.10:8443', 'https://192.168.1.10/')).toBe('exact_host')
  })
})

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', async () => {
    const secret = new TextEncoder().encode('12345678901234567890')
    const p = { secret, digits: 8, period: 30, algorithm: 'SHA-1' as const }
    expect((await totpAt(p, 59_000)).code).toBe('94287082')
    expect((await totpAt(p, 1111111109_000)).code).toBe('07081804')
    expect((await totpAt(p, 20000000000_000)).code).toBe('65353130')
    const p256 = { secret: new TextEncoder().encode('12345678901234567890123456789012'), digits: 8, period: 30, algorithm: 'SHA-256' as const }
    expect((await totpAt(p256, 59_000)).code).toBe('46119246')
  })

  it('reads otpauth URIs and bare seeds, and refuses junk', () => {
    const p = parseTotp('otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=6')!
    expect(p.issuer).toBe('Example')
    expect(p.account).toBe('alice@example.com')
    expect(p.secret).toEqual(base32Decode('JBSWY3DPEHPK3PXP'))
    expect(parseTotp('jbsw y3dp ehpk 3pxp')).not.toBeNull()
    expect(parseTotp('not a seed!')).toBeNull()
    expect(parseTotp('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP')).toBeNull()
  })
})

describe('strength and report', () => {
  it('rates common shapes weak and generated ones strong', () => {
    expect(passwordStrength('password').level).toBe('very_weak')
    expect(passwordStrength('Summer2024!').level).not.toMatch(/strong/)
    expect(passwordStrength('aaaaaaaaaaaa').level).toMatch(/weak/)
    expect(passwordStrength(generatePassword(DEFAULT_PASSWORD)).level).toBe('very_strong')
  })

  it('finds weak, reused, old and http logins, skipping the trash', () => {
    const base = { type: 'login' as const, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' }
    const items: VaultItem[] = [
      { ...base, id: 'a', title: 'A', password: 'same-Strong-pw-9x!Q', urls: ['http://a.test'] },
      { ...base, id: 'b', title: 'B', password: 'same-Strong-pw-9x!Q', createdAt: new Date().toISOString() },
      { ...base, id: 'c', title: 'C', password: '123456', createdAt: new Date().toISOString() },
      { ...base, id: 'd', title: 'D', password: '123456', trashedAt: new Date().toISOString() },
    ]
    const r = securityReport(items)
    expect(r.weak).toEqual(['c'])
    expect(r.reused).toEqual([['a', 'b']])
    expect(r.old).toEqual(['a'])
    expect(r.insecureUrl).toEqual(['a'])
  })
})

describe('import', () => {
  it('parses quoted CSV with commas, quotes and newlines', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi""\nthere"\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"\nthere']])
    expect(() => parseCsv('a,"b')).toThrow(ImportError)
  })

  it('detects and reads every supported CSV', () => {
    const files: Record<string, string> = {
      bitwarden_csv: 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nWork,1,login,Git,,"pin: 42",1,github.com,alice,pw1,JBSWY3DPEHPK3PXP\n,,note,Wifi,the code,,0,,,,\n',
      '1password_csv': 'Title,Website,Username,Password,One-time password,Favorite,Archived,Tags,Notes\nShop,shop.test,bob,pw2,,true,false,a;b,hi\nOld,old.test,x,y,,false,true,,\n',
      apple_csv: 'Title,URL,Username,Password,Notes,OTPAuth\nBank (bank.test),https://bank.test/,carol,pw3,,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP\n',
      chrome_csv: 'name,url,username,password,note\nmail.test,https://mail.test/,dan,pw4,\n,https://empty.test/,,,\n',
      firefox_csv: 'url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged\nhttps://fox.test,erin,pw5,,https://fox.test,{1},1,1,1\n',
    }
    const bw = parseImport(files.bitwarden_csv)
    expect(bw.format).toBe('bitwarden_csv')
    expect(bw.items[0]).toMatchObject({ type: 'login', title: 'Git', username: 'alice', password: 'pw1', urls: ['https://github.com'], tags: ['Work'], favorite: true, sensitive: true, fields: [{ name: 'pin', value: '42' }] })
    expect(bw.items[1]).toMatchObject({ type: 'note', title: 'Wifi', notes: 'the code' })
    const op = parseImport(files['1password_csv'])
    expect(op.items).toHaveLength(1)
    expect(op.items[0]).toMatchObject({ title: 'Shop', tags: ['a', 'b'], favorite: true })
    expect(op.skipped[0].reason).toMatch(/archived/)
    expect(parseImport(files.apple_csv).items[0]).toMatchObject({ username: 'carol', totp: expect.stringContaining('otpauth') })
    const ch = parseImport(files.chrome_csv)
    expect(ch.items).toHaveLength(1)
    expect(ch.skipped).toHaveLength(1)
    expect(parseImport(files.firefox_csv).items[0]).toMatchObject({ title: 'fox.test', username: 'erin' })
    for (const [fmt, text] of Object.entries(files)) expect(detectFormat(text)).toBe(fmt)
  })

  it('reads Bitwarden JSON with folders, cards, hidden fields and passkeys, and refuses an encrypted one', () => {
    const json = JSON.stringify({
      encrypted: false,
      folders: [{ id: 'f1', name: 'Home' }],
      items: [
        { type: 1, name: 'Site', folderId: 'f1', reprompt: 1, fields: [{ name: 'q', value: 'a', type: 1 }],
          login: { uris: [{ uri: 'site.test' }], username: 'u', password: 'p', totp: 'JBSWY3DPEHPK3PXP', fido2Credentials: [{ credentialId: 'c1', rpId: 'site.test' }] } },
        { type: 3, name: 'Visa', card: { cardholderName: 'A', number: '4111111111111111', expMonth: '1', expYear: '2030', code: '123' } },
        { type: 4, name: 'Me' },
      ],
    })
    const r = parseImport(json)
    expect(r.format).toBe('bitwarden_json')
    expect(r.passkeys).toBe(1)
    expect(r.items[0]).toMatchObject({ tags: ['Home'], sensitive: true, fields: [{ name: 'q', hidden: true }], passkeys: [{ credentialId: 'c1' }] })
    expect(r.items[1]).toMatchObject({ type: 'card', card: { number: '4111111111111111' } })
    expect(r.skipped).toHaveLength(1)
    expect(() => parseImport(JSON.stringify({ encrypted: true, items: [] }))).toThrow(/encrypted/)
  })

  it('a Walnut CSV export reads back as the same logins', () => {
    const now = new Date().toISOString()
    const items: VaultItem[] = [{ id: '1', type: 'login', title: 'A, "quoted"', username: 'u', password: 'p,1', urls: ['https://a.test'], notes: 'line1\nline2', createdAt: now, updatedAt: now }]
    const back = parseImport(exportItems(items, 'csv'))
    expect(back.format).toBe('bitwarden_csv')
    expect(back.items[0]).toMatchObject({ title: 'A, "quoted"', username: 'u', password: 'p,1', notes: 'line1\nline2', urls: ['https://a.test'] })
  })
})

describe('vault sessions', () => {
  it('a read that does not touch never keeps a window unlocked', async () => {
    const { vi } = await import('vitest')
    const s = await import('../../../src/core/vault/sessions.js')
    s.resetSessionsForTest()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const { token } = s.createSession('test', 1)
      vi.setSystemTime(new Date('2026-01-01T00:00:50Z'))
      expect(s.useSession(token, false, undefined)).not.toBeNull()
      vi.setSystemTime(new Date('2026-01-01T00:01:10Z'))
      expect(s.useSession(token, false, undefined)).toBeNull()
    } finally {
      vi.useRealTimers()
      s.resetSessionsForTest()
    }
  })

  it('a session a device opened holds only for that device, and ends with it', async () => {
    const s = await import('../../../src/core/vault/sessions.js')
    s.resetSessionsForTest()
    try {
      const a = s.createSession('ext', 5, 'extension-aaaaaa')
      expect(s.useSession(a.token, true, 'extension-aaaaaa')).not.toBeNull()
      expect(s.useSession(a.token, true, 'browser-bbbbbb')).toBeNull()
      expect(s.useSession(a.token, true, 'extension-aaaaaa')).toBeNull() // gone for good
      const b = s.createSession('ext', 5, 'extension-aaaaaa')
      const c = s.createSession('web', 5)
      expect(s.endDeviceSessions('extension-aaaaaa')).toBe(1)
      expect(s.useSession(b.token, true, 'extension-aaaaaa')).toBeNull()
      // A session no device opened is anyone's who holds it, as before.
      expect(s.useSession(c.token, true, undefined)).not.toBeNull()
      expect(s.useSession(c.token, true, 'extension-aaaaaa')).not.toBeNull()
    } finally {
      s.resetSessionsForTest()
    }
  })

  it('the vault closes when a removed device or a wrong one ends the last session', async () => {
    const s = await import('../../../src/core/vault/sessions.js')
    s.resetSessionsForTest()
    let closed = 0
    try {
      s.onSessionsExpired(() => { closed++ })
      s.createSession('ext', 5, 'extension-aaaaaa')
      const web = s.createSession('web', 5)
      s.endDeviceSessions('extension-aaaaaa')
      await Promise.resolve()
      expect(closed).toBe(0) // the web window still holds one
      s.endSession(web.token)
      const b = s.createSession('ext', 5, 'extension-aaaaaa')
      s.endDeviceSessions('extension-aaaaaa')
      await Promise.resolve()
      expect(closed).toBe(1)
      expect(s.useSession(b.token, true, 'extension-aaaaaa')).toBeNull()
      const c = s.createSession('ext', 5, 'extension-aaaaaa')
      expect(s.useSession(c.token, true, undefined)).toBeNull()
      await Promise.resolve()
      expect(closed).toBe(2)
    } finally {
      s.onSessionsExpired(null)
      s.resetSessionsForTest()
    }
  })

  it('closes the vault when the last window idles out, with nobody pressing Lock', async () => {
    const { vi } = await import('vitest')
    const s = await import('../../../src/core/vault/sessions.js')
    s.resetSessionsForTest()
    vi.useFakeTimers()
    let closed = 0
    try {
      s.onSessionsExpired(() => { closed++ })
      const a = s.createSession('a', 1)
      s.createSession('b', 3)
      await vi.advanceTimersByTimeAsync(62_000)
      expect(s.useSession(a.token, true, undefined)).toBeNull()
      expect(closed).toBe(0) // b is still open
      await vi.advanceTimersByTimeAsync(120_000)
      expect(closed).toBe(1)
      expect(s.liveSessionCount()).toBe(0)
    } finally {
      s.onSessionsExpired(null)
      vi.useRealTimers()
      s.resetSessionsForTest()
    }
  })

  it('lets one master-password check run at a time, and the brake counts it', async () => {
    const s = await import('../../../src/core/vault/sessions.js')
    s.resetSessionsForTest()
    expect(s.beginAttempt()).toBeNull()
    expect(s.beginAttempt()?.code).toBe('unlock_busy')
    s.endAttempt('wrong')
    for (let i = 0; i < 4; i++) { expect(s.beginAttempt()).toBeNull(); s.endAttempt('wrong') }
    expect(s.beginAttempt()?.code).toBe('unlock_slowed')
    s.resetSessionsForTest()
  })
})
