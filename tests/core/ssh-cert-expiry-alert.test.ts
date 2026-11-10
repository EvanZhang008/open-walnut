/**
 * The SSH certificate letter (src/core/hosts/ssh-cert-expiry-alert.ts). 2026-11-04: the Mac's
 * certificate to a dev box expired at 15:52 UTC and nobody was told before a task hit
 * "Permission denied (publickey)"; the sign-in letter stayed quiet because Walnut's own long-lived
 * connection still worked. Pinned here: ONE letter a few hours ahead naming the hosts that share
 * the certificate, ONE more turn in it once the expiry passed and a fresh sign-in fails (never
 * while a fresh sign-in still works), archived once a renewed certificate is in place, a restart
 * that neither sends it twice nor forgets it, and the sign-in alert joining it instead of a second
 * letter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCertExpiryAlert, WARN_AHEAD_MS, type CertExpiryAlertDeps } from '../../src/core/hosts/ssh-cert-expiry-alert.js'
import { createHostAuthAlert } from '../../src/core/hosts/host-auth-alert.js'
import { SSH_CERT_EXPIRY, sshCertExpiredTurn } from '../../src/core/human-inbox/walnut-letters/ssh-cert-expiry.js'
import { sshCertificateExpiry, type RunResult } from '../../src/providers/ssh-credential-evidence.js'

const HOUR = 3_600_000
const EXPIRES = Date.UTC(2026, 10, 4, 15, 52)

let dir: string
let clock: number
let expiry: Record<string, number | null>
let signIn: { ok: boolean; error?: string }
let probes: string[]
let sent: Array<{ subject: string; markdown: string; opKey: string }>
let turns: Array<{ id: string; text: string }>
let archived: Array<{ letterId?: string; opKey: string }>
let hosts: Array<{ host: string; label: string }>

function deps(over: Partial<CertExpiryAlertDeps> = {}): CertExpiryAlertDeps {
  return {
    hosts: async () => hosts,
    certExpiry: async (h) => expiry[h] ?? null,
    freshSignIn: async (h) => { probes.push(h); return signIn },
    send: async (l) => { sent.push(l); return `letter-${sent.length}` },
    addTurn: async (id, text) => { turns.push({ id, text }) },
    archive: async (ref) => { archived.push(ref) },
    loginHint: async () => 'run your login command',
    statePath: path.join(dir, 'cert.json'),
    now: () => clock,
    setTimer: () => ({ unref: () => {} }),
    clearTimer: () => {},
    ...over,
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cert-alert-'))
  clock = EXPIRES - 5 * HOUR
  expiry = { dev: EXPIRES, build: EXPIRES + 20_000, gpu: null }
  signIn = { ok: false, error: 'Permission denied (publickey).' }
  probes = []
  sent = []
  turns = []
  archived = []
  hosts = [{ host: 'dev', label: 'Dev box' }, { host: 'build', label: 'Build host' }, { host: 'gpu', label: 'GPU box' }]
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('the SSH certificate letter', () => {
  it('nothing while the expiry is further than WARN_AHEAD_MS; one letter once it is nearer, naming the hosts that share it', async () => {
    const alert = createCertExpiryAlert(deps())
    await alert.check()
    expect(sent).toHaveLength(0)
    clock = EXPIRES - WARN_AHEAD_MS + 60_000
    await alert.check()
    await alert.check()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toBe('SSH certificate for Dev box and Build host expires at 2026-11-04 15:52 UTC')
    expect(sent[0]!.markdown).toContain('(in about 3 hours)')
    expect(sent[0]!.markdown).toContain('run your login command before then')
    expect(sent[0]!.markdown).not.toContain('GPU box')
    // Before the expiry nothing dials the host.
    expect(probes).toEqual([])
  })

  it('past the expiry a fresh sign-in that fails adds ONE turn to the same letter; renewal archives it', async () => {
    const alert = createCertExpiryAlert(deps())
    clock = EXPIRES - HOUR
    await alert.check()
    clock = EXPIRES + 60_000
    await alert.check()
    await alert.check()
    expect(sent).toHaveLength(1)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.id).toBe('letter-1')
    expect(turns[0]!.text).toContain('expired at 2026-11-04 15:52 UTC, and a fresh SSH sign-in to Dev box and Build host now fails')
    // A thread turn reads as written: no markdown marks in it.
    expect(turns[0]!.text).not.toMatch(/\*\*|~~~/)
    expect(turns[0]!.text).toContain('Permission denied (publickey).')
    expect(probes).toEqual(['dev'])
    // Renewed: valid for another day.
    expiry = { dev: EXPIRES + 24 * HOUR, build: EXPIRES + 24 * HOUR, gpu: null }
    await alert.check()
    expect(archived).toEqual([{ letterId: 'letter-1', opKey: sent[0]!.opKey }])
    expect(await alert.episode()).toBeNull()
  })

  it('past the expiry, a fresh sign-in that still works archives the letter (the host needs no certificate); a host that does not answer is asked again', async () => {
    const alert = createCertExpiryAlert(deps())
    clock = EXPIRES - HOUR
    await alert.check()
    expect(sent).toHaveLength(1)
    signIn = { ok: false, unknown: true }
    clock = EXPIRES + 60_000
    await alert.check()
    expect(turns).toHaveLength(0)
    expect(archived).toHaveLength(0)
    signIn = { ok: true }
    await alert.check()
    expect(turns).toHaveLength(0)
    expect(archived).toHaveLength(1)
    // Nothing more about that certificate: no new letter, no join.
    await alert.check()
    expect(sent).toHaveLength(1)
    expect(await alert.joinLetter(['dev'])).toBeNull()
  })

  it('first seen past the expiry: a fresh sign-in first, then the letter that it ran out (never a warning for a time gone); unknown waits, working sends none', async () => {
    signIn = { ok: false, unknown: true }
    const alert = createCertExpiryAlert(deps())
    clock = EXPIRES + 60_000
    await alert.check()
    expect(sent).toHaveLength(0)
    signIn = { ok: false, error: 'Permission denied (publickey).' }
    await alert.check()
    await alert.check()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toBe('SSH certificate for Dev box and Build host expired at 2026-11-04 15:52 UTC')
    expect(sent[0]!.markdown).toContain('Permission denied (publickey).')
    expect(turns).toHaveLength(0)
    expect((await alert.episode())?.expiredTold).toBe(true)
    // The sign-in alert joins it, with no second expired turn.
    expect(await alert.joinLetter(['dev'], 'denied')).toBe('letter-1')
    expect(turns).toHaveLength(0)
  })

  it('a step that fails (the turn could not be written) keeps the clock going, and the next check adds the turn', async () => {
    const arms: number[] = []
    let failTurn = true
    const alert = createCertExpiryAlert(deps({
      setTimer: (_fn, ms) => { arms.push(ms); return { unref: () => {} } },
      addTurn: async (id, text) => { if (failTurn) throw new Error('store busy'); turns.push({ id, text }) },
    }))
    clock = EXPIRES - HOUR
    await alert.check()
    clock = EXPIRES + 60_000
    const before = arms.length
    await alert.check()
    expect(arms.length).toBe(before + 1)
    expect(turns).toHaveLength(0)
    failTurn = false
    await alert.check()
    expect(turns).toHaveLength(1)
  })

  it('a renewed certificate valid forever is a renewal too', async () => {
    const alert = createCertExpiryAlert(deps())
    clock = EXPIRES - HOUR
    await alert.check()
    expiry = { dev: Infinity, build: Infinity, gpu: null }
    await alert.check()
    expect(archived).toHaveLength(1)
    expect(await alert.episode()).toBeNull()
    await alert.check()
    expect(sent).toHaveLength(1)
  })

  it('a certificate that cannot be read is no renewal', async () => {
    const alert = createCertExpiryAlert(deps())
    clock = EXPIRES - HOUR
    await alert.check()
    expiry = { dev: null, build: null, gpu: null }
    await alert.check()
    expect(archived).toEqual([])
    expect((await alert.episode())?.letterId).toBe('letter-1')
  })

  it('its hosts leaving Settings archive it', async () => {
    const alert = createCertExpiryAlert(deps())
    clock = EXPIRES - HOUR
    await alert.check()
    hosts = [{ host: 'gpu', label: 'GPU box' }]
    await alert.check()
    expect(archived).toHaveLength(1)
  })

  it('a restart neither sends it again nor forgets it', async () => {
    clock = EXPIRES - HOUR
    await createCertExpiryAlert(deps()).check()
    const again = createCertExpiryAlert(deps())
    clock = EXPIRES + 60_000
    await again.check()
    expect(sent).toHaveLength(1)
    expect(turns).toHaveLength(1)
    const third = createCertExpiryAlert(deps())
    await third.check()
    expect(turns).toHaveLength(1)
  })

  it('a failed send is tried again under the same op key', async () => {
    let fail = true
    const alert = createCertExpiryAlert(deps({ send: async (l) => { sent.push(l); if (fail) throw new Error('store busy'); return 'letter-x' } }))
    clock = EXPIRES - HOUR
    await alert.check()
    fail = false
    await alert.check()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.opKey).toBe(sent[0]!.opKey)
    expect((await alert.episode())?.letterId).toBe('letter-x')
  })

  it('handed off to another reminder: no letter, an open one archived, no join; handed back, it warns again', async () => {
    let off = false
    const alert = createCertExpiryAlert(deps({ handedOff: async () => off }))
    clock = EXPIRES - HOUR
    await alert.check()
    expect(sent).toHaveLength(1)
    off = true
    await alert.check()
    expect(archived).toHaveLength(1)
    expect(await alert.episode()).toBeNull()
    clock = EXPIRES + 60_000
    await alert.check()
    expect(sent).toHaveLength(1)
    expect(probes).toEqual([])
    expect(await alert.joinLetter(['dev'], 'denied')).toBeNull()
    off = false
    clock = EXPIRES - 30 * 60_000
    await alert.check()
    expect(sent).toHaveLength(2)
    // A new letter, never the archived one under its old key.
    expect(sent[1]!.opKey).not.toBe(sent[0]!.opKey)
  })

  it('handed back after a restart, with a store that answers a known key with its archived letter, the warning still reaches the user', async () => {
    // As sendLetterOnce: a key it has seen returns that letter and sends nothing.
    const byKey = new Map<string, string>()
    const delivered: string[] = []
    const send = async (l: { opKey: string }) => {
      if (byKey.has(l.opKey)) return byKey.get(l.opKey)!
      delivered.push(l.opKey)
      byKey.set(l.opKey, `letter-${delivered.length}`)
      return byKey.get(l.opKey)!
    }
    let off = false
    clock = EXPIRES - HOUR
    await createCertExpiryAlert(deps({ send, handedOff: async () => off })).check()
    off = true
    await createCertExpiryAlert(deps({ send, handedOff: async () => off })).check()
    off = false
    const back = createCertExpiryAlert(deps({ send, handedOff: async () => off }))
    await back.check()
    expect(delivered).toHaveLength(2)
    expect((await back.episode())?.letterId).toBe('letter-2')
  })

  it('reads in Chinese for a Chinese letter language', () => {
    const { subject } = SSH_CERT_EXPIRY.render('zh', { hosts: ['Dev box'], expiresAt: EXPIRES, now: EXPIRES - 2 * HOUR })
    expect(subject).toBe('Dev box 的 SSH 证书将于 2026-11-04 15:52 UTC 过期')
    expect(sshCertExpiredTurn('zh', { hosts: ['Dev box'], expiresAt: EXPIRES })).toContain('2026-11-04 15:52 UTC')
  })

  it('a step in another script than the letter stands apart after a colon, and the generic step asks once', () => {
    // 2026-11-06 on prod: the user's English hint ran straight into the Chinese sentence.
    const withHint = SSH_CERT_EXPIRY.render('zh', { hosts: ['Dev box'], expiresAt: EXPIRES, now: EXPIRES - 2 * HOUR, hint: 'run your login command on this Mac.' }).markdown
    expect(withHint).toContain('\u5b8c\u6210\uff1arun your login command on this Mac\u3002')
    const generic = SSH_CERT_EXPIRY.render('zh', { hosts: ['Dev box'], expiresAt: EXPIRES, now: EXPIRES - 2 * HOUR }).markdown
    expect(generic).toContain('\uff1a\u91cd\u65b0\u767b\u5f55')
    // "please" once, never "please ... please".
    expect(generic.split('\u8bf7').length - 1).toBe(1)
    expect(sshCertExpiredTurn('zh', { hosts: ['Dev box'], expiresAt: EXPIRES, hint: 'run your login command' })).toContain('\uff1arun your login command\u3002')
  })
})

describe('the sign-in letter joins the certificate letter (one expiry, one thread)', () => {
  it('a login failure on a host of the open certificate letter sends no second letter', async () => {
    const cert = createCertExpiryAlert(deps())
    clock = EXPIRES - HOUR
    await cert.check()
    const signInSent: string[] = []
    const auth = createHostAuthAlert({
      send: async (l) => { signInSent.push(l.subject); return 'signin-1' },
      archive: async () => {},
      loginHint: async () => undefined,
      knownHosts: () => new Set(['dev', 'build']),
      joinLetter: (h, e) => cert.joinLetter(h, e),
      statePath: path.join(dir, 'auth.json'),
      graceMs: 0,
      now: () => clock,
      setTimer: () => ({ unref: () => {} }),
      clearTimer: () => {},
    })
    clock = EXPIRES + 60_000
    await auth.observe({ host: 'dev', label: 'Dev box', connected: false, phase: 'failed', kind: 'cert_expired', error: 'Permission denied (publickey).' })
    await auth.check()
    expect(signInSent).toEqual([])
    expect(await auth.openLetterIds()).toEqual(['letter-1'])
    // The expired turn went into the certificate letter, once, even before its own check ran.
    expect(turns).toHaveLength(1)
    await cert.check()
    expect(turns).toHaveLength(1)
  })

  it('a host connecting again over an old connection does not archive the joined letter; the renewal does', async () => {
    const cert = createCertExpiryAlert(deps())
    clock = EXPIRES - HOUR
    await cert.check()
    const authArchived: unknown[] = []
    const auth = createHostAuthAlert({
      send: async () => 'signin-1',
      archive: async (ref) => { authArchived.push(ref) },
      loginHint: async () => undefined,
      knownHosts: () => new Set(['dev', 'build']),
      joinLetter: (h, e) => cert.joinLetter(h, e),
      statePath: path.join(dir, 'auth.json'),
      graceMs: 0,
      now: () => clock,
      setTimer: () => ({ unref: () => {} }),
      clearTimer: () => {},
    })
    clock = EXPIRES + 60_000
    await auth.observe({ host: 'dev', label: 'Dev box', connected: false, phase: 'failed', kind: 'cert_expired', error: 'denied' })
    await auth.check()
    await auth.observe({ host: 'dev', label: 'Dev box', connected: true, phase: 'connected' })
    expect(await auth.openLetterIds()).toEqual([])
    expect(authArchived).toEqual([])
    expect((await cert.episode())?.letterId).toBe('letter-1')
    expiry = { dev: EXPIRES + 24 * HOUR, build: EXPIRES + 24 * HOUR, gpu: null }
    await cert.check()
    expect(archived).toHaveLength(1)
  })

  it('a certificate letter handed off while a login failure was joined to it: the failure gets its own letter', async () => {
    let off = false
    let auth: ReturnType<typeof createHostAuthAlert> | null = null
    const cert = createCertExpiryAlert(deps({ handedOff: async () => off, onLetterClosed: async (id) => { await auth?.unjoin(id) } }))
    clock = EXPIRES - HOUR
    await cert.check()
    const signInSent: string[] = []
    auth = createHostAuthAlert({
      send: async (l) => { signInSent.push(l.subject); return 'signin-1' },
      archive: async () => {},
      loginHint: async () => undefined,
      knownHosts: () => new Set(['dev', 'build']),
      joinLetter: (h, e) => cert.joinLetter(h, e),
      statePath: path.join(dir, 'auth.json'),
      graceMs: 0,
      now: () => clock,
      setTimer: () => ({ unref: () => {} }),
      clearTimer: () => {},
    })
    clock = EXPIRES + 60_000
    await auth.observe({ host: 'dev', label: 'Dev box', connected: false, phase: 'failed', kind: 'cert_expired', error: 'denied' })
    await auth.check()
    expect(await auth.openLetterIds()).toEqual(['letter-1'])
    off = true
    await cert.check()
    expect(archived).toHaveLength(1)
    await auth.check()
    expect(signInSent).toHaveLength(1)
    expect(await auth.openLetterIds()).toEqual(['signin-1'])
  })

  it('with no certificate letter open, the sign-in letter goes out as before', async () => {
    const cert = createCertExpiryAlert(deps())
    const signInSent: string[] = []
    const auth = createHostAuthAlert({
      send: async (l) => { signInSent.push(l.subject); return 'signin-1' },
      archive: async () => {},
      loginHint: async () => undefined,
      knownHosts: () => new Set(['dev']),
      joinLetter: (h, e) => cert.joinLetter(h, e),
      statePath: path.join(dir, 'auth.json'),
      graceMs: 0,
      now: () => clock,
      setTimer: () => ({ unref: () => {} }),
      clearTimer: () => {},
    })
    await auth.observe({ host: 'dev', label: 'Dev box', connected: false, phase: 'failed', kind: 'cert_expired', error: 'x' })
    await auth.check()
    expect(signInSent).toHaveLength(1)
  })
})

describe('sshCertificateExpiry', () => {
  const report = (to: string) => `/dev/stdin:\n        Type: ecdsa-sha2-nistp256-cert-v01@openssh.com user certificate\n        Valid: from 2026-11-04T03:52:00 to ${to}\n`
  const CERT_LINE = 'ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAcert user@box'

  it("reads the host's own certificatefile and takes the latest valid-until", async () => {
    const reports = [report('2026-11-04T15:52:00'), report('2026-11-05T15:52:00')]
    const run = async (file: string, args: string[]): Promise<RunResult> => {
      if (file === 'ssh' && args[0] === '-G') return { code: 0, stdout: 'certificatefile ~/.ssh/a-cert.pub\ncertificatefile ~/.ssh/b-cert.pub\n', stderr: '' }
      if (file === 'ssh-keygen') return { code: 0, stdout: reports.shift()!, stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    }
    const at = await sshCertificateExpiry('dev', { env: { HOME: '/home/u' }, run, readFile: async () => CERT_LINE })
    expect(at).toBe(new Date('2026-11-05T15:52:00').getTime())
  })

  it('reads the -cert.pub ssh loads beside an identity file by itself', async () => {
    const reads: string[] = []
    const run = async (file: string, args: string[]): Promise<RunResult> => {
      if (file === 'ssh' && args[0] === '-G') return { code: 0, stdout: 'identityfile ~/.ssh/id_ed25519\n', stderr: '' }
      if (file === 'ssh-keygen') return { code: 0, stdout: report('2026-11-04T15:52:00'), stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    }
    const at = await sshCertificateExpiry('dev', { env: { HOME: '/home/u' }, run, readFile: async (p) => { reads.push(p); if (p.endsWith('-cert.pub')) return CERT_LINE; throw new Error('ENOENT') } })
    expect(reads).toEqual(['/home/u/.ssh/id_ed25519-cert.pub'])
    expect(at).toBe(new Date('2026-11-04T15:52:00').getTime())
  })

  it('a named certificatefile wins over an old -cert.pub beside the identity file', async () => {
    const reads: string[] = []
    const run = async (file: string, args: string[]): Promise<RunResult> => {
      if (file === 'ssh' && args[0] === '-G') return { code: 0, stdout: 'certificatefile ~/.ssh/named-cert.pub\nidentityfile ~/.ssh/key\n', stderr: '' }
      if (file === 'ssh-keygen') return { code: 0, stdout: report('2026-11-05T15:52:00'), stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    }
    const at = await sshCertificateExpiry('dev', { env: { HOME: '/home/u' }, run, readFile: async (p) => { reads.push(p); return CERT_LINE } })
    expect(reads).toEqual(['/home/u/.ssh/named-cert.pub'])
    expect(at).toBe(new Date('2026-11-05T15:52:00').getTime())
    // The named one not readable (mid-renewal): unknown, never the old one beside the key.
    reads.length = 0
    const missing = await sshCertificateExpiry('dev', { env: { HOME: '/home/u' }, run, readFile: async (p) => { reads.push(p); if (p.endsWith('named-cert.pub')) throw new Error('ENOENT'); return CERT_LINE } })
    expect(missing).toBeNull()
    expect(reads).toEqual(['/home/u/.ssh/named-cert.pub'])
  })

  it("falls back to the agent's certificates; none at all is null; forever is Infinity", async () => {
    const run = (keygen: string) => async (file: string, args: string[]): Promise<RunResult> => {
      if (file === 'ssh' && args[0] === '-G') return { code: 0, stdout: 'identityfile ~/.ssh/id_ed25519\n', stderr: '' }
      if (file === 'ssh-add') return { code: 0, stdout: `${CERT_LINE}\n`, stderr: '' }
      if (file === 'ssh-keygen') return { code: 0, stdout: keygen, stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    }
    expect(await sshCertificateExpiry('dev', { env: { HOME: '/h', SSH_AUTH_SOCK: '/s' }, run: run(report('2026-11-04T15:52:00')), readFile: async () => '' }))
      .toBe(new Date('2026-11-04T15:52:00').getTime())
    expect(await sshCertificateExpiry('dev', { env: { HOME: '/h' }, run: run(''), readFile: async () => '' })).toBeNull()
    expect(await sshCertificateExpiry('dev', { env: { HOME: '/h', SSH_AUTH_SOCK: '/s' }, run: run('        Valid: forever\n'), readFile: async () => '' }))
      .toBe(Infinity)
  })
})
