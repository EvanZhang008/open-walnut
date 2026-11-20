import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
// @ts-expect-error a plain .mjs script
import { accessToken, compareVersions, decide, publishedVersion } from '../../scripts/extension-store-publish.mjs'

const published = (v: string) => ({ publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ deployPercentage: 100, crxVersion: v }] } })

describe('extension-store-publish', () => {
  it('compares versions the way Chrome does', () => {
    expect(compareVersions('0.6.36', '0.6.33')).toBe(1)
    expect(compareVersions('0.6.33', '0.6.33.0')).toBe(0)
    expect(compareVersions('0.6.9', '0.6.10')).toBe(-1)
  })

  it('submits only a version newer than the store has', () => {
    expect(publishedVersion(published('0.6.33'))).toBe('0.6.33')
    expect(decide(published('0.6.33'), '0.6.36')).toEqual({ act: 'publish' })
    expect(decide(published('0.6.36'), '0.6.36').act).toBe('skip')
    expect(decide(published('0.7.0'), '0.6.36').act).toBe('refuse')
    expect(decide({}, '0.6.36')).toEqual({ act: 'publish' })
  })

  it('waits while a submitted version is still in review', () => {
    const status = { ...published('0.6.33'), submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } }
    expect(decide(status, '0.6.36')).toEqual({ act: 'skip', why: 'a submitted version is still PENDING_REVIEW' })
  })

  it('signs a JWT bearer grant with the service account key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const key = { client_email: 'publisher@example.iam.gserviceaccount.com', token_uri: 'https://oauth2.example.test/token', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
    let sent: URLSearchParams | null = null
    const fake = async (_url: string, init: { body: URLSearchParams }) => { sent = init.body; return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }) }
    expect(await accessToken(key, fake, 1_000_000_000_000)).toBe('tok')
    const [head, claims, sig] = sent!.get('assertion')!.split('.')
    expect(createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true)
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/chromewebstore', aud: key.token_uri, iat: 1_000_000_000, exp: 1_000_003_600 })
  })
})
