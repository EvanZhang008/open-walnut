/**
 * The tunnel supervisor (src/core/expose/supervisor.ts) with a fake child and a
 * fake clock: the URL is read from output, exits retry with growing waits, a
 * sign-in line and a missing command retry slowly, a stop ends the child, and a
 * replaced run's late events change nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  BACKOFF_MS, ExposeSupervisor, HEALTHY_MS, MISSING_RETRY_MS, NO_URL_MS, PROBE_EVERY_MS, PROBE_FAILURES,
  SIGN_IN_RETRY_MS, resolveRun, urlInLine, type ExposeChild, type SupervisorDeps,
} from '../../src/core/expose/supervisor.js'
import type { ExposeProviderDefinition } from '../../src/core/expose/types.js'

class FakeChild implements ExposeChild {
  static seq = 100
  readonly pid = FakeChild.seq++
  lines: Array<(l: string) => void> = []
  exits: Array<(c: number | null, s: string | null) => void> = []
  errors: Array<(e: NodeJS.ErrnoException) => void> = []
  signals: string[] = []
  exited = false
  onLine(h: (l: string) => void) { this.lines.push(h) }
  onExit(h: (c: number | null, s: string | null) => void) { this.exits.push(h) }
  onSpawnError(h: (e: NodeJS.ErrnoException) => void) { this.errors.push(h) }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal)
    if (!this.exited) this.exit(null, signal)
  }
  say(line: string) { for (const h of this.lines) h(line) }
  exit(code: number | null, signal: string | null = null) {
    this.exited = true
    for (const h of this.exits) h(code, signal)
  }
  failSpawn(code: string) {
    const e = Object.assign(new Error(code), { code }) as NodeJS.ErrnoException
    for (const h of this.errors) h(e)
    this.exit(null, null)
  }
}

function harness() {
  let now = 1_000_000
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let ids = 0
  const children: FakeChild[] = []
  const spawned: Array<{ command: string; args: string[] }> = []
  let probeOk = true
  const deps: SupervisorDeps = {
    spawn(command, args) {
      spawned.push({ command, args })
      const c = new FakeChild()
      children.push(c)
      return c
    },
    probe: async () => probeOk,
    now: () => now,
    setTimer(fn, ms) { const id = ++ids; timers.push({ at: now + ms, fn, id }); return id },
    clearTimer(id) { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1) },
    log: { info() {}, warn() {} },
  }
  const statuses: string[] = []
  const sup = new ExposeSupervisor(deps, (s) => statuses.push(s.state))
  async function advance(ms: number) {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > end) break
      timers.shift()
      now = next.at
      next.fn()
      await new Promise((r) => setImmediate(r))
    }
    now = end
  }
  return { sup, children, spawned, statuses, advance, setProbe: (ok: boolean) => { probeOk = ok }, now: () => now }
}

const DEF: ExposeProviderDefinition = {
  id: 'fake',
  title: 'Fake tunnel',
  command: '/usr/local/bin/faketunnel',
  args: ['create', '{port}', '--name', '{name}'],
  options: [{ key: 'name', label: 'Name', default: 'walnut', pattern: '[a-z0-9-]{1,30}' }],
  urlPattern: 'https://[a-z0-9.-]+\\.example\\.test',
  signInPatterns: ['sign-?in (has )?expired'],
  signInHint: 'Sign in again, then press Retry.',
  installHint: 'Install faketunnel.',
}

describe('resolveRun', () => {
  it('fills the port and the options into the arguments', () => {
    const run = resolveRun(DEF, 41234, { name: 'mybox' })
    expect(run.args).toEqual(['create', '41234', '--name', 'mybox'])
    expect(resolveRun(DEF, 1, {}).args[3]).toBe('walnut')
  })
  it('refuses a value that does not match its option pattern', () => {
    expect(() => resolveRun(DEF, 1, { name: 'bad name; rm -rf' })).toThrow(/Name "bad name; rm -rf" is not valid/)
  })
  it('expands a leading ~/ in the command', () => {
    const run = resolveRun({ ...DEF, command: '~/.bin/t' }, 1)
    expect(run.command.endsWith('/.bin/t')).toBe(true)
    expect(run.command.startsWith('~')).toBe(false)
  })
})

describe('urlInLine', () => {
  const p = new RegExp(DEF.urlPattern)
  it('finds the URL inside a sentence and drops trailing punctuation', () => {
    expect(urlInLine('Tunnel ready at https://me-walnut.example.test.', p)).toBe('https://me-walnut.example.test')
    expect(urlInLine('\u001b[32m(https://a.example.test)\u001b[0m', p)).toBe('https://a.example.test')
    expect(urlInLine('connecting...', p)).toBeNull()
  })
})

describe('ExposeSupervisor', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => { h = harness() })

  it('starting, then connected when the URL line arrives', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    expect(h.sup.status().state).toBe('starting')
    expect(h.spawned[0]).toEqual({ command: '/usr/local/bin/faketunnel', args: ['create', '5000', '--name', 'walnut'] })
    h.children[0]!.say('Your tunnel: https://me-walnut.example.test')
    expect(h.sup.status()).toMatchObject({ state: 'connected', url: 'https://me-walnut.example.test', port: 5000 })
  })

  it('with a ready pattern, the URL alone is not connected; the ready line completes it, in either order', async () => {
    const def = { ...DEF, readyPattern: '\\bconnected\\b' }
    await h.sup.start(resolveRun(def, 5000), 5000)
    h.children[0]!.say('   Public: https://me-walnut.example.test')
    expect(h.sup.status().state).toBe('starting')
    h.children[0]!.say('   Connected! Forwarding requests to http://localhost:5000')
    expect(h.sup.status()).toMatchObject({ state: 'connected', url: 'https://me-walnut.example.test' })

    await h.sup.start(resolveRun(def, 5000), 5000)
    h.children[1]!.say('Connected to the edge')
    expect(h.sup.status().state).toBe('starting')
    h.children[1]!.say('Public: https://other.example.test')
    expect(h.sup.status()).toMatchObject({ state: 'connected', url: 'https://other.example.test' })
  })

  it('a sign-in line while connected is needs-sign-in; the ready line after the renewal brings it back', async () => {
    const def = { ...DEF, readyPattern: 'connected!' }
    await h.sup.start(resolveRun(def, 5000), 5000)
    h.children[0]!.say('Public: https://me-walnut.example.test')
    h.children[0]!.say('Connected! Forwarding requests')
    expect(h.sup.status().state).toBe('connected')
    h.children[0]!.say('Disconnected: socket closed')
    h.children[0]!.say('Your sign-in expired; connecting once it is renewed.')
    expect(h.sup.status()).toMatchObject({ state: 'needs-sign-in', hint: 'Sign in again, then press Retry.' })
    h.children[0]!.say('Reconnected!')
    expect(h.sup.status()).toMatchObject({ state: 'connected', url: 'https://me-walnut.example.test' })
    expect(h.sup.status().hint).toBeUndefined()
  })

  it('an exit retries with growing waits, and a run that held up a minute starts the waits over', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    h.children[0]!.say('error: connection refused by edge')
    h.children[0]!.exit(1)
    expect(h.sup.status()).toMatchObject({ state: 'retrying', lastError: 'error: connection refused by edge' })
    expect(h.sup.status().nextRetryAt! - h.now()).toBe(BACKOFF_MS[0])
    await h.advance(BACKOFF_MS[0]!)
    expect(h.children).toHaveLength(2)
    h.children[1]!.exit(1)
    expect(h.sup.status().nextRetryAt! - h.now()).toBe(BACKOFF_MS[1])
    await h.advance(BACKOFF_MS[1]!)
    // Connected for longer than HEALTHY_MS: the next failure waits the first step again.
    h.children[2]!.say('https://x.example.test')
    await h.advance(HEALTHY_MS + 1)
    h.children[2]!.exit(0)
    expect(h.sup.status().nextRetryAt! - h.now()).toBe(BACKOFF_MS[0])
    expect(h.sup.status().url).toBe('https://x.example.test')
  })

  it('a sign-in line is needs-sign-in with the hint, and it retries slowly', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    h.children[0]!.say('ERROR: Sign-in expired, run the login tool')
    expect(h.sup.status()).toMatchObject({ state: 'needs-sign-in', hint: 'Sign in again, then press Retry.' })
    h.children[0]!.exit(1)
    expect(h.sup.status().state).toBe('needs-sign-in')
    expect(h.sup.status().nextRetryAt! - h.now()).toBe(SIGN_IN_RETRY_MS)
    await h.advance(SIGN_IN_RETRY_MS)
    expect(h.children).toHaveLength(2)
    h.children[1]!.say('https://back.example.test')
    expect(h.sup.status()).toMatchObject({ state: 'connected', url: 'https://back.example.test' })
    expect(h.sup.status().hint).toBeUndefined()
  })

  it('a command that is not installed is missing, with the install hint, retried slowly', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    expect(h.sup.status()).toMatchObject({ state: 'missing', hint: 'Install faketunnel.' })
    expect(h.sup.status().lastError).toMatch(/not installed here/)
    expect(h.sup.status().nextRetryAt! - h.now()).toBe(MISSING_RETRY_MS)
  })

  it('Retry starts again at once, whatever the wait', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    h.sup.retryNow()
    expect(h.children).toHaveLength(2)
    expect(h.sup.status().state).toBe('starting')
  })

  it('Retry while the child still runs (waiting on a sign-in) replaces it at once', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    h.children[0]!.say('Your sign-in expired.')
    expect(h.sup.status().state).toBe('needs-sign-in')
    h.sup.retryNow()
    expect(h.children[0]!.signals).toEqual(['SIGTERM'])
    expect(h.children).toHaveLength(2)
    expect(h.sup.status().state).toBe('starting')
    h.children[1]!.say('https://me-walnut.example.test')
    expect(h.sup.status().state).toBe('connected')
  })

  it('no URL within the limit stops the child and retries', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    await h.advance(NO_URL_MS)
    expect(h.children[0]!.signals).toContain('SIGTERM')
    expect(h.sup.status()).toMatchObject({ state: 'retrying' })
    expect(h.sup.status().lastError).toMatch(/printed no address/)
  })

  it('an address that stops answering is restarted after a few failed checks', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    h.children[0]!.say('https://x.example.test')
    h.setProbe(false)
    for (let i = 0; i < PROBE_FAILURES; i++) await h.advance(PROBE_EVERY_MS)
    expect(h.children[0]!.signals).toContain('SIGTERM')
    expect(h.sup.status().state).toBe('retrying')
  })

  it('a stop ends the child and turns it off; nothing restarts it', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    h.children[0]!.say('https://x.example.test')
    await h.sup.stop()
    expect(h.children[0]!.signals).toEqual(['SIGTERM'])
    expect(h.sup.status()).toEqual({ state: 'off', since: h.now() })
    await h.advance(10 * 60_000)
    expect(h.children).toHaveLength(1)
  })

  it('a replaced run: the old child is stopped and its late lines change nothing', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    const old = h.children[0]!
    await h.sup.start(resolveRun(DEF, 6000, { name: 'other' }), 6000)
    expect(old.signals).toEqual(['SIGTERM'])
    old.say('https://stale.example.test')
    expect(h.sup.status()).toMatchObject({ state: 'starting', port: 6000 })
    expect(h.sup.status().url).toBeUndefined()
  })
})
