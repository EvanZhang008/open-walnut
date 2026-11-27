import { describe, it, expect } from 'vitest'
import { credentialAskOf, normalizeCredentialAsk, sameCredentialAsk, findCredentialLetter, storedCredentialAskOf, credentialFoldAddsTurn, credentialAfterFold, CREDENTIAL_KINDS } from '../../src/core/human-inbox/credential-ask.js'
import type { LetterRecord } from '../../src/core/human-inbox/types.js'
import { signInLineOf } from '../../src/core/sign-in-ask.js'

const context = {
  hint: 'run acmelogin on the Mac',
  names: [{ host: '__local__', names: ['Mac', 'this computer'] }, { host: 'cloudbox', names: ['cloudbox', 'legacybox', 'Cloud workstation'] }],
  canonical: async (host: string) => host === 'legacybox' ? 'cloudbox' : host === 'local' ? '__local__' : host,
}
const letter = (credentialAsk: LetterRecord['credentialAsk'], over: Partial<LetterRecord> = {}) => ({
  id: 'lt-example-000001', archived: false, credentialAsk, ...over,
} as LetterRecord)

describe('credential owner is not its login target', () => {
  it('the two incident-shaped asks name distinct machines and stay separate', async () => {
    const local = await credentialAskOf({ subject: 'Legacybox SSH certificate expires soon', markdown: 'To keep it working, run acmelogin on the Mac before then.' }, context)
    const remote = await credentialAskOf({ subject: 'Cloudbox SSH certificate expired', markdown: 'Please run acmelogin -o on cloudbox.' }, context)
    expect(local).toEqual({ host: '__local__', kind: 'ssh-certificate' })
    expect(remote).toEqual({ host: 'cloudbox', kind: 'ssh-certificate' })
    expect(sameCredentialAsk(local!, remote!)).toBe(false)
  })
  it('an alias and display name canonicalize to one renewal machine', async () => {
    expect(await credentialAskOf({ subject: 'Renew certificate', markdown: 'Please run acmelogin on legacybox.' }, context)).toEqual({ host: 'cloudbox', kind: 'ssh-certificate' })
    expect(await credentialAskOf({ subject: 'Renew certificate', markdown: 'Please run acmelogin on Cloud workstation.' }, context)).toEqual({ host: 'cloudbox', kind: 'ssh-certificate' })
  })
  it('never guesses owner from the destination or sender when the execution location is absent', async () => {
    expect(await credentialAskOf({ subject: 'SSH certificate expired on cloudbox', markdown: 'Please run acmelogin.' }, context)).toBeUndefined()
    expect(await credentialAskOf({ subject: 'Package report', markdown: 'No need to run acmelogin on the Mac.' }, context)).toBeUndefined()
  })
  it('explicit scope keeps its kind, and rejects malformed data', async () => {
    const cert = { host: 'legacybox', kind: 'ssh-certificate', expiresAt: 1000 } as const
    expect(await credentialAskOf({ subject: 'Credential renewal', credential_ask: cert }, context)).toEqual({ ...cert, host: 'cloudbox' })
    expect(normalizeCredentialAsk({ ...cert, folded: [{ kind: 'login-cookie', expiresAt: 5 }, { kind: 'nonsense' }, { kind: 'ssh-certificate' }, 'login'] })).toEqual({ ...cert, folded: [{ kind: 'login-cookie', expiresAt: 5 }] })
    expect(normalizeCredentialAsk({ host: '', kind: 'login' })).toBeUndefined()
    expect(normalizeCredentialAsk({ host: 'cloudbox', kind: 'login', expiresAt: NaN })).toBeUndefined()
  })
  it('legacy core expiry letters identify the local owner even though the subject only names a target alias', async () => {
    expect(await storedCredentialAskOf(letter(undefined, { subject: 'Legacybox certificate expired', createdByOp: 'ssh-cert-expiry:1000' }), '', context))
      .toEqual({ host: '__local__', kind: 'ssh-certificate', expiresAt: 1000 });
  })

  it('all senders share one active credential ask, but a known new expiry is a new episode', () => {
    const ask = { host: 'cloudbox', kind: 'ssh-certificate', expiresAt: 1000 } as const
    expect(findCredentialLetter(ask, [letter(ask)])?.id).toBe('lt-example-000001')
    expect(findCredentialLetter({ ...ask, host: '__local__' }, [letter(ask)])).toBeUndefined()
    // Another part of the same machine's sign-in is the same ask while the letter is open.
    expect(findCredentialLetter({ ...ask, kind: 'login-cookie', expiresAt: 3000 }, [letter(ask)])?.id).toBe('lt-example-000001')
    expect(findCredentialLetter({ ...ask, kind: 'login-cookie' }, [letter(ask, { archived: true })])).toBeUndefined()
    expect(findCredentialLetter({ ...ask, expiresAt: 2000 }, [letter(ask)])).toBeUndefined()
    expect(findCredentialLetter(ask, [letter(ask, { archived: true })])?.id).toBe('lt-example-000001')
    expect(findCredentialLetter({ host: 'cloudbox', kind: 'ssh-certificate' }, [letter(ask, { archived: true })])).toBeUndefined()
  })

  it('the 2026-11-27 asks: a Chinese ask sentence names its machine', async () => {
    const md = '**\u8981\u4f60\u505a\u7684\u4e00\u4ef6\u4e8b\uff1a\u5728 cloudbox\uff08dev box\uff09\u4e0a\u8dd1\u4e00\u6b21 `acmelogin -o`\uff0c\u63d2\u94a5\u5319\u8f93 PIN\u3002**'
    expect(await credentialAskOf({ subject: 'cloudbox login expired', markdown: md }, context)).toEqual({ host: 'cloudbox', kind: 'login' })
  })
})

describe('one machine is signed in once: every pair of credential kinds on one machine is one ask (guard)', () => {
  // Enumerated from CREDENTIAL_KINDS, so a new kind is covered by itself.
  for (const a of CREDENTIAL_KINDS) for (const b of CREDENTIAL_KINDS) {
    it(`${a} then ${b}`, () => {
      const first = { host: 'cloudbox', kind: a, expiresAt: 1000 } as const
      const asked = { host: 'cloudbox', kind: b, expiresAt: a === b ? 1000 : 5000 } as const
      expect(sameCredentialAsk(asked, first)).toBe(true)
      expect(sameCredentialAsk({ ...asked, host: '__local__' }, first)).toBe(false)
      // Another kind adds its words once; the same kind and expiry adds nothing.
      expect(credentialFoldAddsTurn(asked, first)).toBe(a !== b)
      const after = credentialAfterFold(asked, first)
      expect(after.kind).toBe(a)
      expect(credentialFoldAddsTurn(asked, after)).toBe(false)
      // A later episode of that other kind (a new known expiry) is told again, once.
      if (a !== b) {
        const next = { ...asked, expiresAt: 9000 }
        expect(credentialFoldAddsTurn(next, after)).toBe(true)
        expect(credentialFoldAddsTurn(next, credentialAfterFold(next, after))).toBe(false)
      }
      // A core alert's own send folds only into its own kind.
      expect(sameCredentialAsk(asked, first, { crossKind: false })).toBe(a === b)
    })
  }
})

describe('Chinese words that put the sign-in on the user, and news that does not', () => {
  const W = ['acmelogin']
  it('asks', () => {
    for (const s of [
      '\u8981\u4f60\u505a\u7684\u4e00\u4ef6\u4e8b\uff1a\u5728 cloudbox \u4e0a\u8dd1\u4e00\u6b21 `acmelogin -o`\u3002',
      '\u4f60\u8dd1\u4e00\u4e0b acmelogin\uff0c\u6211\u63a5\u7740\u6d4b\u3002',
      '\u8bf7\u5728 cloudbox \u4e0a\u8dd1\u4e00\u6b21 acmelogin\u3002',
    ]) expect(signInLineOf(null, s, W), s).not.toBeNull()
  })
  it('news', () => {
    for (const s of [
      '\u4f60\u8dd1\u5b8c acmelogin \u4e4b\u540e\uff0c\u6211\u91cd\u65b0\u6d4b\u4e86\u5ef6\u8fdf\u3002',
      '\u4f60\u6267\u884c\u8fc7 acmelogin \u4e86\uff0c\u8bc1\u4e66\u5df2\u66f4\u65b0\u3002',
      '\u4e0d\u8981\u4f60\u518d\u8dd1 acmelogin \u4e86\u3002',
      '\u53ea\u8981\u4f60\u8dd1\u8fc7 acmelogin \u5c31\u884c\u3002',
      '\u6211\u5df2\u7ecf\u5e2e\u6211\u4eec\u5728 cloudbox \u4e0a\u8dd1\u4e86 acmelogin\u3002',
    ]) expect(signInLineOf(null, s, W), s).toBeNull()
  })
  it('a box named only as the owner of the expired credential ("<box> \u7684 SSH \u8bc1\u4e66") is the machine, when no sentence says where to run it', async () => {
    expect(await credentialAskOf({ subject: 'Sign-in', markdown: 'cloudbox \u7684 SSH \u8bc1\u4e66\u8fc7\u671f\u4e86\uff0c\u8bf7\u8dd1\u4e00\u6b21 acmelogin\u3002' }, context)).toEqual({ host: 'cloudbox', kind: 'ssh-certificate' })
    // Where to run it wins over whose credential it is.
    expect(await credentialAskOf({ subject: 'Sign-in', markdown: '\u767b\u5f55 cloudbox \u7684\u8bc1\u4e66\u8fc7\u671f\u4e86\uff0c\u8bf7\u5728 Mac \u4e0a\u8dd1 acmelogin\u3002' }, context)).toEqual({ host: '__local__', kind: 'ssh-certificate' })
  })
})

