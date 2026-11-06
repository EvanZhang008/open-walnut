/**
 * What counts as asking the user to sign in again (src/core/sign-in-ask.ts), and what Walnut knows
 * of the sign-in itself. The login command is invented; it comes from config ssh_login_hint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSignInAsk, loginCommandWords, readSignInState, SIGN_IN_OK_FRESH_MS } from '../../src/core/sign-in-ask.js'

const WORDS = loginCommandWords('run acmelogin -o on this Mac')

describe('isSignInAsk', () => {
  it('reads the command out of the login hint, never its frame', () => {
    expect(WORDS).toEqual(['acmelogin'])
    expect(loginCommandWords('renew your login credentials')).toEqual([])
    expect(loginCommandWords(undefined)).toEqual([])
  })

  it('names a sign-in ask by its meaning or by the login command, in any words', () => {
    for (const ask of [
      'Please run `acmelogin -s` on the dev box',
      'Run acmelogin -o --refresh, then tell me',
      'Your login expired on the build host',
      'Please sign in again so the tests can run',
      'Re-authenticate on the cloud box',
      'Renew your SSH certificate before 16:00',
      // "Please sign in again on the Mac".
      '\u8bf7\u5728 Mac \u4e0a\u91cd\u65b0\u767b\u5f55',
    ]) expect(isSignInAsk(ask, WORDS), ask).toBe(true)
  })

  it('leaves every other ask alone', () => {
    for (const ask of [
      'Approve deleting the staging database',
      'Review the login page copy before it ships',
      'Pick the launch month for the plugin',
      'Rename acmeloginx to the new name?',
      '',
    ]) expect(isSignInAsk(ask, WORDS), ask).toBe(false)
  })
})

describe('readSignInState', () => {
  let dir: string
  const write = (name: string, v: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(v))
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sign-in-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('nothing known is nothing', async () => {
    expect(await readSignInState(Date.now(), dir)).toEqual({})
  })

  it("an open sign-in letter, then an expired certificate's letter, are what is broken", async () => {
    write('ssh-cert-expiry-alert.json', { episode: { letterId: 'lt-cert', expiredTold: true } })
    expect(await readSignInState(Date.now(), dir)).toEqual({ broken: { letterId: 'lt-cert', by: 'the certificate letter' } })
    write('host-auth-alert.json', { episodes: [{ key: 'host:devbox', letterId: 'lt-key' }, { key: 'login', letterId: 'lt-login' }] })
    expect(await readSignInState(Date.now(), dir)).toEqual({ broken: { letterId: 'lt-login', by: 'the sign-in letter' } })
  })

  it("a checker's word counts while it is fresh", async () => {
    const now = Date.now()
    write('sign-in-state.json', { ok: true, checkedAt: new Date(now - 60_000).toISOString(), by: 'a plugin' })
    expect((await readSignInState(now, dir)).ok?.by).toBe('a plugin')
    expect(await readSignInState(now + SIGN_IN_OK_FRESH_MS, dir)).toEqual({})
    write('sign-in-state.json', { ok: false, checkedAt: new Date(now).toISOString(), letterId: 'lt-p' })
    expect(await readSignInState(now, dir)).toEqual({ broken: { letterId: 'lt-p', by: 'the sign-in check' } })
  })
})
