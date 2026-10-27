/**
 * The host sign-in letter (src/core/hosts/host-auth-alert.ts): one letter per
 * expired login across every host and every detection point, none for network
 * trouble, archived by itself once the hosts connect again, and a server
 * restart in the middle neither sends it twice nor forgets to close it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createHostAuthAlert, frameVerdict, signInLetter, GENERIC_LOGIN_HINT, type AlertFrame, type HostAuthAlertDeps,
} from '../../src/core/hosts/host-auth-alert.js'

const CERT = 'Permission denied (publickey).\nwalnut-ssh-evidence: cert-expired (SSH certificate expired)'

const failed = (host: string, kind: string, error = CERT, label = host.toUpperCase()): AlertFrame =>
  ({ host, label, connected: false, phase: 'failed', kind, error })
const reconnecting = (host: string, lastKind: string, lastError = 'ssh: connect to host x port 22: No route to host'): AlertFrame =>
  ({ host, label: host.toUpperCase(), connected: false, phase: 'reconnecting', lastKind, lastError })
const connected = (host: string): AlertFrame => ({ host, label: host.toUpperCase(), connected: true, phase: 'connected' })
const dialing = (host: string): AlertFrame => ({ host, connected: false, phase: 'ssh' })
const removed = (host: string): AlertFrame => ({ host, removed: true })

describe('frameVerdict', () => {
  it.each<[string, AlertFrame, string]>([
    ['expired certificate', failed('a', 'cert_expired'), 'login'],
    ['no agent', failed('a', 'agent_missing'), 'login'],
    ['proxy login expired', failed('a', 'proxy_login'), 'login'],
    ['reconnect loop on an expired login', reconnecting('a', 'cert_expired'), 'login'],
    ['key refused', failed('a', 'auth'), 'key'],
    ['key refused on a host found only in ~/.ssh/config', { ...failed('a', 'auth'), discovered: true }, 'neutral'],
    ['host unreachable', failed('a', 'unreachable'), 'other-failure'],
    ['dns', failed('a', 'dns'), 'other-failure'],
    ['timeout while reconnecting', reconnecting('a', 'timeout'), 'other-failure'],
    ['changed host key is not a sign-in failure', failed('a', 'host_key'), 'other-failure'],
    ['connected', connected('a'), 'ok'],
    ['removed', removed('a'), 'gone'],
    ['dialing', dialing('a'), 'neutral'],
    ['failure cleared by Retry', { host: 'a', phase: 'failed', connected: false }, 'neutral'],
    ['reconnecting with no cause yet', { host: 'a', phase: 'reconnecting', connected: false }, 'neutral'],
    ['off (test server)', { host: 'a', phase: 'off', connected: false }, 'neutral'],
  ])('%s', (_name, frame, verdict) => {
    expect(frameVerdict(frame)).toBe(verdict)
  })
})

describe('signInLetter', () => {
  it('says the generic next step when config names none', () => {
    const l = signInLetter([{ label: 'Dev box', error: CERT }], undefined, { retries: true })
    expect(l.subject).toBe(`SSH sign-in to Dev box failed: ${GENERIC_LOGIN_HINT}`)
    expect(l.markdown).toContain(`To fix it, ${GENERIC_LOGIN_HINT}.`)
    expect(l.markdown).toContain('archives this letter by itself')
    expect(l.markdown).toContain('Dev box: Permission denied (publickey). walnut-ssh-evidence: cert-expired')
  })

  it("uses the user's own hint, without a doubled period", () => {
    const l = signInLetter([{ label: 'Dev box' }], '  run the login command on this Mac. ')
    expect(l.subject).toBe('SSH sign-in to Dev box failed: run the login command on this Mac')
    expect(l.markdown).toContain('To fix it, run the login command on this Mac.')
    expect(l.markdown).not.toContain('What SSH said')
  })

  it('names two hosts, and counts the rest past two', () => {
    expect(signInLetter([{ label: 'A' }, { label: 'B' }]).subject).toMatch(/^SSH sign-in to A and B failed/)
    const three = signInLetter([{ label: 'A' }, { label: 'B' }, { label: 'C' }])
    expect(three.subject).toMatch(/^SSH sign-in to A and 2 more hosts failed/)
    expect(three.markdown).toContain('**A**, **B** and **C**')
  })

  it('keeps the subject within the store limit and fences a hostile error', () => {
    const l = signInLetter([{ label: 'x'.repeat(300), error: '~~~\ninjected' }])
    expect(l.subject.length).toBeLessThanOrEqual(200)
    expect(l.markdown).not.toMatch(/~~~ injected/)
  })
})

describe('createHostAuthAlert', () => {
  let dir: string
  let clock: number
  let sent: Array<{ subject: string; markdown: string; opKey: string }>
  let archived: string[]
  let timers: Array<{ fn: () => void; at: number; cleared: boolean }>
  let known: Set<string>
  let hint: string | undefined
  let sendFails: boolean
  const GRACE = 60_000

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-auth-alert-'))
    clock = 1_000_000
    sent = []
    archived = []
    timers = []
    known = new Set(['dev', 'box2', 'box3'])
    hint = undefined
    sendFails = false
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const statePath = () => path.join(dir, 'local', 'host-auth-alert.json')
  function make(over: Partial<HostAuthAlertDeps> = {}) {
    return createHostAuthAlert({
      send: async (l) => {
        if (sendFails) throw new Error('store locked')
        sent.push(l)
        return `lt-${sent.length}`
      },
      archive: async ({ letterId, opKey }) => { archived.push(letterId ?? `op:${opKey}`) },
      loginHint: async () => hint,
      knownHosts: () => known,
      statePath: statePath(),
      graceMs: GRACE,
      now: () => clock,
      setTimer: (fn, ms) => { const t = { fn, at: clock + ms, cleared: false }; timers.push(t); return t as never },
      clearTimer: (t) => { (t as { cleared: boolean }).cleared = true },
      ...over,
    })
  }
  /** Advance the fake clock and fire every timer now due. */
  async function advance(alert: ReturnType<typeof make>, ms: number) {
    clock += ms
    for (const t of timers.filter((x) => !x.cleared && x.at <= clock)) { t.cleared = true; t.fn() }
    await alert.openLetterIds()
  }

  it('waits out the grace, then sends ONE letter however many frames repeat it', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE - 1)
    expect(sent).toHaveLength(0)
    // The reconnect loop and the warmup keep reporting the same failure, with dials in between.
    for (let i = 0; i < 5; i++) {
      await alert.observe(dialing('dev'))
      await alert.observe(failed('dev', 'cert_expired'))
    }
    await advance(alert, 1)
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe(`SSH sign-in to DEV failed: ${GENERIC_LOGIN_HINT}`)
    for (let i = 0; i < 5; i++) await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, 10 * GRACE)
    await alert.check()
    expect(sent).toHaveLength(1)
    expect(await alert.openLetterIds()).toEqual(['lt-1'])
  })

  it('a failure fixed within the grace sends nothing', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE / 2)
    await alert.observe(connected('dev'))
    await advance(alert, GRACE)
    expect(sent).toHaveLength(0)
    expect(fs.existsSync(statePath())).toBe(false)
  })

  it('network trouble and a host that is down send nothing', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'unreachable'))
    await alert.observe(reconnecting('box2', 'timeout'))
    await alert.observe(failed('box3', 'refused'))
    await advance(alert, 5 * GRACE)
    await alert.check()
    expect(sent).toHaveLength(0)
  })

  it('a sign-in failure that turns into a network failure before the grace sends nothing', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await alert.observe(failed('dev', 'unreachable'))
    await advance(alert, 2 * GRACE)
    expect(sent).toHaveLength(0)
  })

  it('one expired login on several hosts is one letter; it closes when the LAST one connects', async () => {
    hint = 'run the login command on this Mac'
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await alert.observe(reconnecting('box2', 'cert_expired', CERT))
    await advance(alert, GRACE)
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe('SSH sign-in to DEV and BOX2 failed: run the login command on this Mac')
    // A third host dials later, inside the same episode: no second letter.
    await alert.observe(failed('box3', 'agent_missing'))
    await advance(alert, 3 * GRACE)
    expect(sent).toHaveLength(1)
    await alert.observe(connected('dev'))
    await alert.observe(connected('box2'))
    expect(archived).toEqual([])
    await alert.observe(connected('box3'))
    expect(archived).toEqual(['lt-1'])
    expect(fs.existsSync(statePath())).toBe(false)
    // Further connected frames change nothing.
    await alert.observe(connected('dev'))
    expect(archived).toEqual(['lt-1'])
  })

  it('a host in the episode whose failure turns into a network one keeps it open until it connects', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE)
    await alert.observe(failed('dev', 'unreachable'))
    expect(archived).toEqual([])
    await alert.observe(connected('dev'))
    expect(archived).toEqual(['lt-1'])
  })

  it('the next expiry after a recovery is a new letter with its own op key', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE)
    await alert.observe(connected('dev'))
    await advance(alert, 1000)
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE)
    expect(sent).toHaveLength(2)
    expect(sent[0].opKey).not.toBe(sent[1].opKey)
    expect(await alert.openLetterIds()).toEqual(['lt-2'])
  })

  it('a restart in the middle neither sends again nor forgets to close', async () => {
    const first = make()
    await first.observe(failed('dev', 'cert_expired'))
    await advance(first, GRACE)
    expect(sent).toHaveLength(1)
    first.stop()

    const second = make()
    await second.observe(failed('dev', 'cert_expired'))
    await advance(second, 5 * GRACE)
    await second.check()
    expect(sent).toHaveLength(1)
    expect(await second.openLetterIds()).toEqual(['lt-1'])
    await second.observe(connected('dev'))
    expect(archived).toEqual(['lt-1'])
  })

  it('a host removed from Settings closes its episode, live or while the server was down', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE)
    await alert.observe(removed('dev'))
    expect(archived).toEqual(['lt-1'])

    await alert.observe(failed('box2', 'cert_expired'))
    await advance(alert, GRACE)
    expect(sent).toHaveLength(2)
    alert.stop()
    known = new Set(['dev'])
    const after = make()
    await after.openLetterIds()
    expect(archived).toEqual(['lt-1', 'lt-2'])
    expect(await after.openLetterIds()).toEqual([])
  })

  it('an unread config at boot keeps the episode', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE)
    alert.stop()
    known = new Set()
    const after = make()
    expect(await after.openLetterIds()).toEqual(['lt-1'])
    expect(archived).toEqual([])
  })

  it('a send that fails is tried again later, once', async () => {
    sendFails = true
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE)
    expect(sent).toHaveLength(0)
    sendFails = false
    await advance(alert, GRACE)
    expect(sent).toHaveLength(1)
  })

  it('switched off, frames are ignored', async () => {
    const alert = make()
    alert.configure({ enabled: false })
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, 2 * GRACE)
    await alert.check()
    expect(sent).toHaveLength(0)
  })

  it('a key refused by one host is its own letter, closed when that host connects', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'auth', 'Permission denied (publickey).'))
    await advance(alert, GRACE)
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toContain('use Retry on the host')
    expect(sent[0].markdown).not.toContain('keeps retrying')
    await alert.observe(failed('dev', 'unreachable'))
    expect(archived).toEqual([])
    await alert.observe(connected('dev'))
    expect(archived).toEqual(['lt-1'])
  })

  it('a host whose key stays refused never mutes a later expired login elsewhere', async () => {
    const alert = make()
    await alert.observe(failed('box3', 'auth', 'Permission denied (publickey).'))
    await advance(alert, GRACE)
    expect(sent).toHaveLength(1)
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE)
    expect(sent).toHaveLength(2)
    expect(sent[1].subject).toMatch(/^SSH sign-in to DEV failed/)
    expect(sent[1].markdown).toContain('keeps retrying')
    await alert.observe(connected('dev'))
    expect(archived).toEqual(['lt-2'])
    // The next expiry, while box3 still refuses its key: a new letter again.
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE)
    expect(sent).toHaveLength(3)
    expect(await alert.openLetterIds()).toEqual(['lt-1', 'lt-3'])
  })

  it('a host of the login episode that went unreachable does not hold it open once another host signs in', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await alert.observe(failed('box2', 'cert_expired'))
    await advance(alert, GRACE)
    await alert.observe(failed('box2', 'unreachable'))
    expect(archived).toEqual([])
    await alert.observe(connected('dev'))
    expect(archived).toEqual(['lt-1'])
  })

  it('a host that connects without being in the episode proves nothing (a shared SSH master)', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE)
    await alert.observe(failed('dev', 'unreachable'))
    await alert.observe(connected('box2'))
    expect(archived).toEqual([])
  })

  it('a crash between writing the episode and sending re-sends under the SAME op key', async () => {
    let crash = true
    const first = make({
      send: async (l) => { sent.push(l); if (crash) throw new Error('killed mid-send'); return `lt-${sent.length}` },
    })
    await first.observe(failed('dev', 'cert_expired'))
    await advance(first, GRACE)
    first.stop()
    crash = false
    const second = make({ send: async (l) => { sent.push(l); return 'lt-first' } })
    await second.observe(failed('dev', 'cert_expired'))
    await advance(second, GRACE)
    expect(sent).toHaveLength(2)
    expect(sent[1].opKey).toBe(sent[0].opKey)
    expect(await second.openLetterIds()).toEqual(['lt-first'])
  })

  it('a pending send whose host connects archives by op key (the store may hold the letter)', async () => {
    const first = make({ send: async () => { throw new Error('killed mid-send') } })
    await first.observe(failed('dev', 'cert_expired'))
    await advance(first, GRACE)
    first.stop()
    const second = make()
    await second.observe(connected('dev'))
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatch(/^op:host-sign-in:login:/)
    expect(fs.existsSync(statePath())).toBe(false)
  })

  it('switched off after a letter went out, a connect still archives it', async () => {
    const alert = make()
    await alert.observe(failed('dev', 'cert_expired'))
    await advance(alert, GRACE)
    alert.configure({ enabled: false })
    await alert.observe(connected('dev'))
    expect(archived).toEqual(['lt-1'])
  })

  it('a login fixed while the server was down closes at start', async () => {
    const first = make()
    await first.observe(failed('dev', 'cert_expired'))
    await advance(first, GRACE)
    first.stop()
    const second = make({ isConnected: (h) => h === 'dev' })
    expect(await second.openLetterIds()).toEqual([])
    expect(archived).toEqual(['lt-1'])
  })

  it('the cloud box is never an SSH sign-in', async () => {
    const alert = make()
    await alert.observe(failed('__cloudbox__', 'proxy_login'))
    await advance(alert, 2 * GRACE)
    expect(sent).toHaveLength(0)
  })

  it('the local host is never a remote sign-in', async () => {
    const alert = make()
    await alert.observe(failed('__local__', 'auth'))
    await advance(alert, 2 * GRACE)
    expect(sent).toHaveLength(0)
  })
})
