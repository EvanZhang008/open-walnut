import { describe, it, expect } from 'vitest'
import { credentialAskOf, normalizeCredentialAsk, sameCredentialAsk, findCredentialLetter, storedCredentialAskOf } from '../../src/core/human-inbox/credential-ask.js'
import type { LetterRecord } from '../../src/core/human-inbox/types.js'

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
  it('explicit scope supports cookie and certificate separately, and rejects malformed data', async () => {
    const cert = { host: 'legacybox', kind: 'ssh-certificate', expiresAt: 1000 } as const
    expect(await credentialAskOf({ subject: 'Credential renewal', credential_ask: cert }, context)).toEqual({ ...cert, host: 'cloudbox' })
    expect(sameCredentialAsk(cert, { ...cert, kind: 'login-cookie' })).toBe(false)
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
    expect(findCredentialLetter({ ...ask, kind: 'login-cookie' }, [letter(ask)])).toBeUndefined()
    expect(findCredentialLetter({ ...ask, expiresAt: 2000 }, [letter(ask)])).toBeUndefined()
    expect(findCredentialLetter(ask, [letter(ask, { archived: true })])?.id).toBe('lt-example-000001')
    expect(findCredentialLetter({ host: 'cloudbox', kind: 'ssh-certificate' }, [letter(ask, { archived: true })])).toBeUndefined()
  })
})
