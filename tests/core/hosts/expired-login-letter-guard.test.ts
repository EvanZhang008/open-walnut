/**
 * Every way Walnut learns this machine's login ran out reaches ONE inbox letter, whoever owns the
 * sign-in reminder. 2026-11-10: the sign-in plugin kept local/sign-in-state.json fresh with
 * `owns: true`, pushed a heads-up two hours before the SSH certificate expired, then wrote
 * `ok: false` with no letter of its own; both Walnut letters stepped aside for it
 * ("no letter, another reminder owns sign-in"), and for half an hour every host refused the
 * sign-in with nothing in the inbox.
 *
 * The rule pinned here: owning the reminder holds back only the warning BEFORE the expiry. Once
 * sign-in is broken (a host:status frame of any login-failure kind, or the certificate past its
 * expiry with a fresh sign-in refused) only the owner's own OPEN letter holds Walnut's letter back.
 * The kinds come from LOGIN_FAILURE_KINDS, so a new kind is covered by itself; the source ratchet
 * fails on a new caller of the broad owner reader outside the warning ahead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostAuthAlert, LOGIN_FAILURE_KINDS } from '../../../src/core/hosts/host-auth-alert.js'
import { createCertExpiryAlert, certLetterHandedOff } from '../../../src/core/hosts/ssh-cert-expiry-alert.js'
import { readSignInOwnerLetter } from '../../../src/core/sign-in-ask.js'

const HOUR = 3_600_000
const EXPIRES = Date.UTC(2026, 10, 10, 16, 4, 25)
const ROOT = path.resolve(__dirname, '../../..')

let dir: string
let clock: number
const openLetters = new Set<string>()
const isOpen = async (id: string) => openLetters.has(id)

/** The owner file shapes a checker may leave; `holds` = it shows the user its own open letter now. */
const OWNER_SHAPES: Array<{ name: string; file: Record<string, unknown> | null; holds: boolean }> = [
  { name: 'no checker', file: null, holds: false },
  { name: 'owns, broken, no letter (the 2026-11-10 file)', file: { ok: false, by: 'the sign-in plugin', owns: true, producer: 'p1' }, holds: false },
  { name: 'owns, says it works', file: { ok: true, by: 'the sign-in plugin', owns: true }, holds: false },
  { name: 'owns, broken, its letter archived', file: { ok: false, by: 'the sign-in plugin', owns: true, letterId: 'owner-archived' }, holds: false },
  { name: 'owns, broken, its letter open', file: { ok: false, by: 'the sign-in plugin', owns: true, letterId: 'owner-open' }, holds: true },
  { name: 'broken with a letter, but does not own', file: { ok: false, by: 'a checker', letterId: 'owner-open' }, holds: false },
  { name: 'owns with an open letter, but stale', file: { ok: false, by: 'the sign-in plugin', owns: true, letterId: 'owner-open', stale: true }, holds: false },
]

function writeOwner(file: Record<string, unknown> | null): void {
  const p = path.join(dir, 'sign-in-state.json')
  if (!file) { fs.rmSync(p, { force: true }); return }
  const { stale, ...rest } = file
  fs.writeFileSync(p, JSON.stringify({ ...rest, checkedAt: new Date(clock - (stale ? 2 * HOUR : 60_000)).toISOString() }))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-expired-login-'))
  clock = EXPIRES + 12 * 60_000
  openLetters.clear()
  openLetters.add('owner-open')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('a login failure frame reaches the one letter unless the owner shows its own', () => {
  const kinds = [...LOGIN_FAILURE_KINDS]
  it('covers every login-failure kind', () => { expect(kinds.length).toBeGreaterThanOrEqual(3) })

  for (const kind of kinds) {
    for (const shape of OWNER_SHAPES) {
      it(`${kind} × ${shape.name}`, async () => {
        writeOwner(shape.file)
        const sent: string[] = []
        const alert = createHostAuthAlert({
          send: async (l) => { sent.push(l.opKey); return `lt-${sent.length}` },
          archive: async () => {},
          loginHint: async () => undefined,
          knownHosts: () => new Set(['clouddev', 'olddev']),
          signInOwner: () => readSignInOwnerLetter(clock, dir, isOpen),
          statePath: path.join(dir, 'auth.json'),
          graceMs: 0,
          now: () => clock,
          setTimer: () => ({ unref: () => {} }),
          clearTimer: () => {},
        })
        for (const host of ['clouddev', 'olddev']) {
          await alert.observe({ host, label: host, connected: false, phase: 'failed', kind, error: 'Permission denied (publickey).' })
        }
        await alert.check()
        await alert.check()
        expect(sent).toHaveLength(shape.holds ? 0 : 1)
        if (shape.holds) {
          // The owner's letter goes away: Walnut's goes out at the next recheck.
          openLetters.delete('owner-open')
          await alert.check()
          expect(sent).toHaveLength(1)
        }
      })
    }
  }
})

describe('a certificate past its expiry reaches the one letter, even while Walnut\'s own link still works', () => {
  function cert(
    sent: Array<{ subject: string; markdown: string }>, signIn: { ok: boolean; error?: string; unknown?: boolean }, arms: number[] = [], turns: string[] = [],
    over: Partial<Parameters<typeof createCertExpiryAlert>[0]> = {},
  ) {
    return createCertExpiryAlert({
      hosts: async () => [{ host: 'clouddev', label: 'clouddev' }, { host: 'olddev', label: 'olddev' }],
      certExpiry: async () => EXPIRES,
      freshSignIn: async () => signIn,
      send: async (l) => { sent.push(l); return `cert-${sent.length}` },
      addTurn: async (_id, text) => { turns.push(text) },
      archive: async () => {},
      loginHint: async () => 'run your login command',
      handedOff: (phase) => certLetterHandedOff(undefined, clock, dir, phase, isOpen),
      statePath: path.join(dir, 'cert.json'),
      now: () => clock,
      setTimer: (_fn, ms) => { arms.push(ms); return { unref: () => {} } },
      clearTimer: () => {},
      ...over,
    })
  }

  for (const shape of OWNER_SHAPES) {
    it(`owner ${shape.name}: held ahead when it owns, one expired letter past the expiry unless its own letter is open`, async () => {
      const sent: Array<{ subject: string; markdown: string }> = []
      const arms: number[] = []
      const turns: string[] = []
      const alert = cert(sent, { ok: false, error: 'Permission denied (publickey).' }, arms, turns)
      const owns = shape.file?.owns === true && !shape.file.stale
      // Two hours ahead: an owner holds Walnut's warning (it pushes its own), and the clock is set
      // for the expiry itself.
      clock = EXPIRES - 2 * HOUR
      writeOwner(shape.file)
      await alert.check()
      expect(sent).toHaveLength(owns ? 0 : 1)
      if (owns) expect(arms.at(-1)).toBeLessThanOrEqual(10 * 60_000)
      // Past the expiry: the fresh sign-in is refused.
      clock = EXPIRES + 60_000
      writeOwner(shape.file)
      await alert.check()
      await alert.check()
      expect(sent).toHaveLength(shape.holds ? 0 : 1)
      // Warned ahead: the expiry is one more turn in that letter; first sent past it: none needed.
      expect(turns).toHaveLength(owns ? 0 : 1)
      if (owns && !shape.holds) {
        expect(sent[0]!.subject).toBe('SSH certificate for clouddev and olddev expired at 2026-11-10 16:04 UTC')
        expect(sent[0]!.markdown).toContain('a fresh SSH sign-in to **clouddev** and **olddev** now fails')
        expect(sent[0]!.markdown).toContain('Permission denied (publickey).')
        expect(sent[0]!.markdown).not.toContain('in about')
      }
    })
  }

  it('a fresh sign-in that still works past the expiry sends nothing; a host that does not answer waits', async () => {
    writeOwner(OWNER_SHAPES[1]!.file)
    const sent: Array<{ subject: string; markdown: string }> = []
    await cert(sent, { ok: true }).check()
    expect(sent).toHaveLength(0)
    fs.rmSync(path.join(dir, 'cert.json'), { force: true })
    await cert(sent, { ok: false, unknown: true }).check()
    expect(sent).toHaveLength(0)
  })

  it('a server first up after the expiry (no owner) sends the expired letter, never "expires in about 1 minutes"', async () => {
    const sent: Array<{ subject: string; markdown: string }> = []
    await cert(sent, { ok: false, error: 'Permission denied (publickey).' }).check()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toContain('expired at')
  })

  it('both paths together are one letter: the frame after the expired certificate letter joins it', async () => {
    writeOwner(OWNER_SHAPES[1]!.file)
    const certSent: Array<{ subject: string; markdown: string }> = []
    const c = cert(certSent, { ok: false, error: 'denied' })
    await c.check()
    const authSent: string[] = []
    const auth = createHostAuthAlert({
      send: async (l) => { authSent.push(l.opKey); return 'auth-1' },
      archive: async () => {},
      loginHint: async () => undefined,
      knownHosts: () => new Set(['clouddev', 'olddev']),
      joinLetter: (h, e) => c.joinLetter(h, e),
      signInOwner: () => readSignInOwnerLetter(clock, dir, isOpen),
      statePath: path.join(dir, 'auth.json'),
      graceMs: 0,
      now: () => clock,
      setTimer: () => ({ unref: () => {} }),
      clearTimer: () => {},
    })
    await auth.observe({ host: 'clouddev', label: 'clouddev', connected: false, phase: 'failed', kind: 'cert_expired', error: 'denied' })
    await auth.check()
    expect(certSent).toHaveLength(1)
    expect(authSent).toEqual([])
    expect(await auth.openLetterIds()).toEqual(['cert-1'])
  })
})

describe('both orders are one letter', () => {
  it('the sign-in failure letter first (a restart past the expiry: its grace is shorter than the first certificate check): no certificate letter', async () => {
    writeOwner(OWNER_SHAPES[1]!.file)
    const authSent: string[] = []
    const auth = createHostAuthAlert({
      send: async (l) => { authSent.push(l.opKey); return 'auth-1' },
      archive: async () => {},
      loginHint: async () => undefined,
      knownHosts: () => new Set(['clouddev', 'olddev']),
      signInOwner: () => readSignInOwnerLetter(clock, dir, isOpen),
      statePath: path.join(dir, 'auth.json'),
      graceMs: 0,
      now: () => clock,
      setTimer: () => ({ unref: () => {} }),
      clearTimer: () => {},
    })
    await auth.observe({ host: 'olddev', label: 'olddev', connected: false, phase: 'failed', kind: 'cert_expired', error: 'denied' })
    await auth.check()
    expect(authSent).toHaveLength(1)
    const certSent: unknown[] = []
    const c = createCertExpiryAlert({
      hosts: async () => [{ host: 'clouddev', label: 'clouddev' }, { host: 'olddev', label: 'olddev' }],
      certExpiry: async () => EXPIRES,
      freshSignIn: async () => ({ ok: false, error: 'denied' }),
      send: async (l) => { certSent.push(l); return 'cert-1' },
      addTurn: async () => {},
      archive: async () => {},
      loginHint: async () => undefined,
      handedOff: (phase) => certLetterHandedOff(undefined, clock, dir, phase, isOpen),
      loginLetterOpen: async (h) => !!(await auth.loginLetterFor(h)),
      statePath: path.join(dir, 'cert.json'),
      now: () => clock,
      setTimer: () => ({ unref: () => {} }),
      clearTimer: () => {},
    })
    await c.check()
    await c.check()
    expect(certSent).toEqual([])
    expect((await c.episode())?.expiredTold).toBe(true)
    // The renewal closes the certificate's episode; the sign-in letter closes on its own connect.
    expect(await c.joinLetter(['olddev'], 'denied')).toBeNull()
  })

  it('a config switch that hands the certificate letter off reads no host at all', async () => {
    let reads = 0
    const c = createCertExpiryAlert({
      hosts: async () => { reads += 1; return [{ host: 'clouddev', label: 'clouddev' }] },
      certExpiry: async () => { reads += 1; return EXPIRES },
      freshSignIn: async () => ({ ok: false }),
      send: async () => 'x', addTurn: async () => {}, archive: async () => {}, loginHint: async () => undefined,
      handedOff: (phase) => certLetterHandedOff(false, clock, dir, phase, isOpen),
      statePath: path.join(dir, 'cert.json'), now: () => clock, setTimer: () => ({ unref: () => {} }), clearTimer: () => {},
    })
    await c.check()
    expect(reads).toBe(0)
  })
})

describe('source ratchet: only the warning ahead may be held by owning the reminder', () => {
  function walk(d: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('readSignInOwner( is called only in the ahead branch of certLetterHandedOff', () => {
    const callers: string[] = []
    for (const file of walk(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf-8')
      for (const line of text.split('\n')) {
        if (/\breadSignInOwner\(/.test(line) && !/export async function readSignInOwner\(/.test(line)) callers.push(`${path.relative(ROOT, file)}: ${line.trim()}`)
      }
    }
    // One caller, in certLetterHandedOff, after its 'expired' branch returned on the owner's letter.
    expect(callers.map((c) => c.split(':')[0])).toEqual(['src/core/hosts/ssh-cert-expiry-alert.ts'])
    const certSrc = fs.readFileSync(path.join(ROOT, 'src/core/hosts/ssh-cert-expiry-alert.ts'), 'utf-8')
    expect(certSrc).toMatch(/phase === 'expired'\)\s*return[^\n]*readSignInOwnerLetter\(/)
  })

  it("the sign-in failure letter's owner hold reads the owner's open letter", () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/hosts/host-auth-alert.ts'), 'utf-8')
    expect(src).toMatch(/signInOwner:[^\n]*readSignInOwnerLetter\(/)
    expect(src).not.toMatch(/signInOwner:[^\n]*readSignInOwner\(/)
  })
})
