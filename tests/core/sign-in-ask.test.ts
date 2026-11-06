/**
 * What counts as asking the user to sign in again (src/core/sign-in-ask.ts), and what Walnut knows
 * of the sign-in itself. The login command is invented; it comes from config ssh_login_hint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSignInAsk, loginCommandWords, readSignInOwner, readSignInState, SIGN_IN_OK_FRESH_MS } from '../../src/core/sign-in-ask.js'
import { certLetterHandedOff } from '../../src/core/hosts/ssh-cert-expiry-alert.js'

const WORDS = loginCommandWords('run acmelogin -o on this Mac')

describe('isSignInAsk', () => {
  it('reads the command out of the login hint, never its frame', () => {
    expect(WORDS).toEqual(['acmelogin'])
    expect(loginCommandWords('renew your login credentials')).toEqual([])
    expect(loginCommandWords(undefined)).toEqual([])
    // An argument after the command is never taken for it.
    expect(loginCommandWords('run cloudctl login --profile work on this Mac')).toEqual(['cloudctl'])
  })

  it('names a sign-in ask by its meaning or by the login command, in any words', () => {
    for (const ask of [
      'Please run `acmelogin -s` on the dev box',
      'Run acmelogin -o --refresh, then tell me',
      'Your login expired on the build host',
      'Please sign in again on the dev box so the tests can run',
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
      // Someone else's account, not this machine's sign-in.
      'Please sign in again to your bank account',
      'Renew your payment API token',
      'Please sign in again so the tests can run',
      '',
    ]) expect(isSignInAsk(ask, WORDS), ask).toBe(false)
  })
})

describe('readSignInState', () => {
  let dir: string
  const write = (name: string, v: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(v))
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sign-in-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const open = async () => true

  it('nothing known is nothing', async () => {
    expect(await readSignInState(Date.now(), dir, open)).toEqual({})
  })

  it("an open sign-in letter, then an expired certificate's letter, are what is broken", async () => {
    write('ssh-cert-expiry-alert.json', { episode: { letterId: 'lt-cert', expiredTold: true } })
    expect(await readSignInState(Date.now(), dir, open)).toEqual({ broken: { letterId: 'lt-cert', by: 'the certificate letter' } })
    write('host-auth-alert.json', { episodes: [{ key: 'host:devbox', letterId: 'lt-key' }, { key: 'login', letterId: 'lt-login' }] })
    expect(await readSignInState(Date.now(), dir, open)).toEqual({ broken: { letterId: 'lt-login', by: 'the sign-in letter' } })
    // The user archived both: nothing is asked there any more.
    expect(await readSignInState(Date.now(), dir, async () => false)).toEqual({})
  })

  it('a check that works after the letter went out wins; one before it does not', async () => {
    const now = Date.now()
    write('host-auth-alert.json', { episodes: [{ key: 'login', letterId: 'lt-login', openedAt: now - 10 * 60_000 }] })
    write('sign-in-state.json', { ok: true, checkedAt: new Date(now - 60_000).toISOString() })
    expect((await readSignInState(now, dir, open)).ok).toBeDefined()
    write('sign-in-state.json', { ok: true, checkedAt: new Date(now - 20 * 60_000).toISOString() })
    expect((await readSignInState(now, dir, open)).broken?.letterId).toBe('lt-login')
  })

  it("a checker's word counts while it is fresh", async () => {
    const now = Date.now()
    write('sign-in-state.json', { ok: true, checkedAt: new Date(now - 60_000).toISOString(), by: 'a plugin' })
    expect((await readSignInState(now, dir, open)).ok?.by).toBe('a plugin')
    expect(await readSignInState(now + SIGN_IN_OK_FRESH_MS, dir, open)).toEqual({})
    write('sign-in-state.json', { ok: false, checkedAt: new Date(now).toISOString(), letterId: 'lt-p' })
    expect(await readSignInState(now, dir, open)).toEqual({ broken: { letterId: 'lt-p', by: 'the sign-in check' } })
    // A checker that stopped says nothing of now, a broken word no more than a working one.
    expect(await readSignInState(now + SIGN_IN_OK_FRESH_MS + 1, dir, open)).toEqual({})
  })

  it('a file without ok or a time, or dated ahead, counts for nothing', async () => {
    const now = Date.now()
    for (const bad of [{ checkedAt: new Date(now).toISOString(), owns: true }, { ok: true, owns: true }, { ok: 'yes', checkedAt: new Date(now).toISOString() }, { ok: true, checkedAt: new Date(now + 5 * 60_000).toISOString(), owns: true }]) {
      write('sign-in-state.json', bad)
      expect(await readSignInState(now, dir, open)).toEqual({})
      expect(await readSignInOwner(now, dir)).toBeNull()
    }
  })
})

describe('an outside reminder owns sign-in only while it runs (readSignInOwner, certLetterHandedOff)', () => {
  let dir: string
  const write = (v: unknown) => fs.writeFileSync(path.join(dir, 'sign-in-state.json'), JSON.stringify(v))
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sign-in-owner-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('fresh with owns: true it owns, whatever it found; without owns, stale or removed, Walnut speaks', async () => {
    const now = Date.now()
    expect(await readSignInOwner(now, dir)).toBeNull()
    expect(await certLetterHandedOff(undefined, now, dir)).toBe(false)
    write({ ok: false, checkedAt: new Date(now - 60_000).toISOString(), by: 'the sign-in plugin', owns: true })
    expect(await readSignInOwner(now, dir)).toEqual({ by: 'the sign-in plugin' })
    expect(await certLetterHandedOff(undefined, now, dir)).toBe(true)
    write({ ok: true, checkedAt: new Date(now - 60_000).toISOString() })
    expect(await readSignInOwner(now, dir)).toBeNull()
    write({ ok: true, checkedAt: new Date(now - 60_000).toISOString(), owns: true })
    expect(await readSignInOwner(now + SIGN_IN_OK_FRESH_MS, dir)).toBeNull()
    expect(await certLetterHandedOff(undefined, now + SIGN_IN_OK_FRESH_MS, dir)).toBe(false)
    fs.rmSync(path.join(dir, 'sign-in-state.json'))
    expect(await readSignInOwner(now, dir)).toBeNull()
    // The config switch hands it off with no owner at all.
    expect(await certLetterHandedOff(false, now, dir)).toBe(true)
  })
})

describe('askIsPartOf: one part of an answered ask, never a new decision', () => {
  it('a part in its own words and order is a part; another direction, target or order is not', async () => {
    const { askIsPartOf, answerHolds } = await import('../../src/core/same-ask.js')
    const SIX = 'Decide for the review: the launch month, the owner team, the budget line and the rollback owner'
    expect(askIsPartOf('Decide the launch month for the review', SIX)).toBe(true)
    expect(askIsPartOf('Decide the launch month and the pricing', SIX)).toBe(false)
    expect(askIsPartOf('Approve migrating account records from production to staging', 'Approve migrating account records from staging to production')).toBe(false)
    expect(askIsPartOf('Approve deleting production database 1', 'Approve deleting staging database 1 and production database 2')).toBe(false)
    const answer = { key: 'k', ask: 'Approve migrating account records from staging to production', text: 'Yes', by: 'lead', byTitle: 'Lead', at: new Date().toISOString() }
    expect(answerHolds(answer, 'Approve migrating account records from production to staging')).toBe(false)
    expect(answerHolds(answer, 'Please approve migrating the account records from staging to production now')).toBe(true)
  })
})
