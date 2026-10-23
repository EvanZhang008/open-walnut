/**
 * The tunnel supervisor (src/core/expose/supervisor.ts) with a fake child and a
 * fake clock: the URL is read from output, exits retry with growing waits, a
 * sign-in line and a missing command retry slowly, a missing command with an
 * install command is installed once (Retry allows one more), a stop ends the
 * child, and a replaced run's late events change nothing. The check through the
 * address counts an error page as down and another Walnut holding the name as no
 * failure (probe.ts). The install's shell runs for real in expose-install-cli.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  BACKOFF_MS, ExposeSupervisor, HEALTHY_MS, INSTALL_TIMEOUT_MS, MISSING_RETRY_MS, NO_URL_MS, PROBE_EVERY_MS, PROBE_FAILURES,
  SIGN_IN_RETRY_MS, resolveRun, urlInLine, type ExposeChild, type InstallResult, type SupervisorDeps,
} from '../../src/core/expose/supervisor.js'
import type { ProbeAnswer } from '../../src/core/expose/probe.js'
import { validateExposeDefinition } from '../../src/core/expose/registry.js'
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

function harness(extra: Partial<SupervisorDeps> = {}) {
  let now = 1_000_000
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let ids = 0
  const children: FakeChild[] = []
  const spawned: Array<{ command: string; args: string[] }> = []
  let probeOk: ProbeAnswer | boolean = true
  const probes: Array<{ url: string; token: string }> = []
  const deps: SupervisorDeps = {
    spawn(command, args) {
      spawned.push({ command, args })
      const c = new FakeChild()
      children.push(c)
      return c
    },
    probe: async (url, _timeoutMs, token) => { probes.push({ url, token }); return probeOk },
    now: () => now,
    setTimer(fn, ms) { const id = ++ids; timers.push({ at: now + ms, fn, id }); return id },
    clearTimer(id) { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1) },
    log: { info() {}, warn() {} },
    ...extra,
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
  return { sup, children, spawned, statuses, advance, probes, setProbe: (ok: ProbeAnswer | boolean) => { probeOk = ok }, now: () => now }
}

const DEF: ExposeProviderDefinition = {
  id: 'fake',
  title: 'Fake tunnel',
  command: '/usr/local/bin/faketunnel',
  args: ['create', '{port}', '--name', '{name}'],
  options: [{ key: 'name', label: 'Name', default: 'acme-demo', pattern: '[a-z0-9-]{1,30}' }],
  urlPattern: 'https://[a-z0-9.-]+\\.example\\.test',
  signInPatterns: ['sign-?in (has )?expired'],
  signInHint: 'Sign in again, then press Retry.',
  installHint: 'Install faketunnel.',
}

describe('resolveRun', () => {
  it('fills the port and the options into the arguments', () => {
    const run = resolveRun(DEF, 41234, { name: 'mybox' })
    expect(run.args).toEqual(['create', '41234', '--name', 'mybox'])
    expect(resolveRun(DEF, 1, {}).args[3]).toBe('acme-demo')
  })
  it('refuses a value that does not match its option pattern, naming the option and never the value', () => {
    // The sentence becomes status.lastError (src/web/expose-runtime.ts, src/host-server/expose.ts),
    // which every paired device reads beside the masked options: a value quoted in it would undo the mask.
    let message = ''
    try { resolveRun(DEF, 1, { name: 'bad name; acme-tunnel-secret-0f3a9c' }) } catch (err) { message = (err as Error).message }
    expect(message).toMatch(/^Name is not valid for /)
    expect(message).not.toContain('acme-tunnel-secret')
    expect(message).not.toContain('0f3a9c')
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
    expect(urlInLine('Tunnel ready at https://me-acme-demo.example.test.', p)).toBe('https://me-acme-demo.example.test')
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
    expect(h.spawned[0]).toEqual({ command: '/usr/local/bin/faketunnel', args: ['create', '5000', '--name', 'acme-demo'] })
    h.children[0]!.say('Your tunnel: https://me-acme-demo.example.test')
    expect(h.sup.status()).toMatchObject({ state: 'connected', url: 'https://me-acme-demo.example.test', port: 5000 })
  })

  it('with a ready pattern, the URL alone is not connected; the ready line completes it, in either order', async () => {
    const def = { ...DEF, readyPattern: '\\bconnected\\b' }
    await h.sup.start(resolveRun(def, 5000), 5000)
    h.children[0]!.say('   Public: https://me-acme-demo.example.test')
    expect(h.sup.status().state).toBe('starting')
    h.children[0]!.say('   Connected! Forwarding requests to http://localhost:5000')
    expect(h.sup.status()).toMatchObject({ state: 'connected', url: 'https://me-acme-demo.example.test' })

    await h.sup.start(resolveRun(def, 5000), 5000)
    h.children[1]!.say('Connected to the edge')
    expect(h.sup.status().state).toBe('starting')
    h.children[1]!.say('Public: https://other.example.test')
    expect(h.sup.status()).toMatchObject({ state: 'connected', url: 'https://other.example.test' })
  })

  it('a sign-in line while connected is needs-sign-in; the ready line after the renewal brings it back', async () => {
    const def = { ...DEF, readyPattern: 'connected!' }
    await h.sup.start(resolveRun(def, 5000), 5000)
    h.children[0]!.say('Public: https://me-acme-demo.example.test')
    h.children[0]!.say('Connected! Forwarding requests')
    expect(h.sup.status().state).toBe('connected')
    h.children[0]!.say('Disconnected: socket closed')
    h.children[0]!.say('Your sign-in expired; connecting once it is renewed.')
    expect(h.sup.status()).toMatchObject({ state: 'needs-sign-in', hint: 'Sign in again, then press Retry.' })
    h.children[0]!.say('Reconnected!')
    expect(h.sup.status()).toMatchObject({ state: 'connected', url: 'https://me-acme-demo.example.test' })
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
    // No "here": a host's report is read on this computer too.
    expect(h.sup.status().lastError).toBe('Fake tunnel is not installed (/usr/local/bin/faketunnel not found).')
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
    h.children[1]!.say('https://me-acme-demo.example.test')
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

  it('the check asks which listener answers: an error page is down, its own token is fine', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    h.children[0]!.say('https://x.example.test')
    h.setProbe('down')
    for (let i = 0; i < PROBE_FAILURES - 1; i++) await h.advance(PROBE_EVERY_MS)
    // This run's own token, every time: the listener the tunnel points at answers with it.
    expect(h.probes.map((p) => p.token)).toEqual(Array(PROBE_FAILURES - 1).fill(h.sup.probeToken))
    expect(h.probes[0]!.url).toBe('https://x.example.test')
    h.setProbe('mine')
    await h.advance(PROBE_EVERY_MS)
    h.setProbe('down')
    for (let i = 0; i < PROBE_FAILURES - 1; i++) await h.advance(PROBE_EVERY_MS)
    expect(h.children[0]!.signals).toEqual([])
    await h.advance(PROBE_EVERY_MS)
    expect(h.children[0]!.signals).toContain('SIGTERM')
  })

  it('another Walnut holding the name is not a failure: this connection waits, it does not take the name back', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    h.children[0]!.say('https://x.example.test')
    h.setProbe('other')
    for (let i = 0; i < PROBE_FAILURES * 3; i++) await h.advance(PROBE_EVERY_MS)
    expect(h.children[0]!.signals).toEqual([])
    expect(h.sup.status().state).toBe('connected')
    // A sign-in page in front answers without a token: as before, that counts as answering.
    h.setProbe('unverified')
    for (let i = 0; i < PROBE_FAILURES * 2; i++) await h.advance(PROBE_EVERY_MS)
    expect(h.children[0]!.signals).toEqual([])
  })

  it('each supervisor has its own probe token', () => {
    const a = harness().sup.probeToken
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(harness().sup.probeToken).not.toBe(a)
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

/** An install the test finishes: each call waits until the test resolves or rejects it. */
function fakeInstall() {
  const calls: Array<{ command: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal; resolve(r: InstallResult): void; reject(e: Error): void }> = []
  const install = (command: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal) =>
    new Promise<InstallResult>((resolve, reject) => { calls.push({ command, env, timeoutMs, signal, resolve, reject }) })
  return { calls, install }
}
const flush = () => new Promise((r) => setImmediate(r))

describe('ExposeSupervisor, a missing CLI it installs (installCommand)', () => {
  const INSTALLABLE: ExposeProviderDefinition = { ...DEF, env: { FAKE_HOME: '/opt/fake' }, installCommand: '  curl -fsSL https://fake.example.test/install.sh | sh  ' }
  let f: ReturnType<typeof fakeInstall>
  let h: ReturnType<typeof harness>
  beforeEach(() => { f = fakeInstall(); h = harness({ install: f.install }) })

  it('installs it once, in the tunnel\'s environment, saying so meanwhile, then starts it', async () => {
    await h.sup.start(resolveRun(INSTALLABLE, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ command: 'curl -fsSL https://fake.example.test/install.sh | sh', env: { FAKE_HOME: '/opt/fake' }, timeoutMs: INSTALL_TIMEOUT_MS })
    expect(h.sup.status()).toMatchObject({ state: 'starting', activity: 'Installing Fake tunnel...' })
    expect(h.sup.status().lastError).toBeUndefined()
    f.calls[0]!.resolve({ ok: true, output: 'installed' })
    await flush()
    expect(h.children).toHaveLength(2)
    expect(h.sup.status().activity).toBeUndefined()
    h.children[1]!.say('https://me-acme-demo.example.test')
    expect(h.sup.status()).toMatchObject({ state: 'connected', url: 'https://me-acme-demo.example.test' })
  })

  it('a failed install is missing, with its last line and the hint, and waits like a missing CLI; it never runs twice', async () => {
    await h.sup.start(resolveRun(INSTALLABLE, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    f.calls[0]!.resolve({ ok: false, output: 'downloading\n\u001b[31merror: no access to the registry\u001b[0m\n\n' })
    await flush()
    expect(h.sup.status()).toMatchObject({
      state: 'missing', lastError: 'Installing Fake tunnel failed: error: no access to the registry.', hint: 'Install faketunnel.',
    })
    expect(h.sup.status().nextRetryAt! - h.now()).toBe(MISSING_RETRY_MS)
    await h.advance(MISSING_RETRY_MS)
    expect(h.children).toHaveLength(2)
    h.children[1]!.failSpawn('ENOENT')
    expect(f.calls).toHaveLength(1)
    expect(h.sup.status()).toMatchObject({ state: 'missing', lastError: 'Installing Fake tunnel failed: error: no access to the registry.' })
  })

  it('an install that throws, or prints nothing, still says it failed', async () => {
    await h.sup.start(resolveRun(INSTALLABLE, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    f.calls[0]!.reject(new Error('spawn /bin/sh EACCES'))
    await flush(); await flush()
    expect(h.sup.status()).toMatchObject({ state: 'missing', lastError: 'Installing Fake tunnel failed: spawn /bin/sh EACCES.' })
    h.sup.retryNow()
    h.children[1]!.failSpawn('ENOENT')
    f.calls[1]!.resolve({ ok: false, output: '' })
    await flush()
    expect(h.sup.status().lastError).toBe('Installing Fake tunnel failed.')
  })

  it('installed, but the command is still not where it says: missing, and no second install', async () => {
    await h.sup.start(resolveRun(INSTALLABLE, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    f.calls[0]!.resolve({ ok: true, output: '' })
    await flush()
    h.children[1]!.failSpawn('ENOENT')
    expect(f.calls).toHaveLength(1)
    expect(h.sup.status()).toMatchObject({ state: 'missing', lastError: 'Fake tunnel was installed, but /usr/local/bin/faketunnel is still not found.' })
  })

  it('Retry runs a finished install once more', async () => {
    await h.sup.start(resolveRun(INSTALLABLE, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    f.calls[0]!.resolve({ ok: false, output: 'no network' })
    await flush()
    h.sup.retryNow()
    expect(h.children).toHaveLength(2)
    h.children[1]!.failSpawn('ENOENT')
    expect(f.calls).toHaveLength(2)
    expect(h.sup.status()).toMatchObject({ state: 'starting', activity: 'Installing Fake tunnel...' })
    f.calls[1]!.resolve({ ok: true, output: '' })
    await flush()
    expect(h.children).toHaveLength(3)
  })

  it('Retry, or a new run, while it installs waits for that install: never a second one, and one start after it', async () => {
    await h.sup.start(resolveRun(INSTALLABLE, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    h.sup.retryNow()
    h.children[1]!.failSpawn('ENOENT')
    await h.sup.start(resolveRun(INSTALLABLE, 6000), 6000)
    h.children[2]!.failSpawn('ENOENT')
    expect(f.calls).toHaveLength(1)
    expect(h.sup.status()).toMatchObject({ state: 'starting', activity: 'Installing Fake tunnel...', port: 6000 })
    f.calls[0]!.resolve({ ok: true, output: '' })
    await flush()
    expect(h.children).toHaveLength(4)
    expect(h.spawned.at(-1)!.args).toContain('6000')
  })

  it('a stop while it installs: the install\'s end starts nothing', async () => {
    await h.sup.start(resolveRun(INSTALLABLE, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    await h.sup.stop()
    expect(h.sup.status()).toEqual({ state: 'off', since: h.now() })
    f.calls[0]!.resolve({ ok: true, output: '' })
    await flush()
    expect(h.children).toHaveLength(1)
    expect(h.sup.status().state).toBe('off')
  })

  it('a stop leaves a running install alone; a shutdown (the server stopping) ends it', async () => {
    await h.sup.start(resolveRun(INSTALLABLE, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    const signal = f.calls[0]!.signal!
    await h.sup.stop()
    // Another start reuses it: the CLI is still on its way.
    expect(signal.aborted).toBe(false)
    await h.sup.shutdown()
    expect(signal.aborted).toBe(true)
    expect(h.sup.status().state).toBe('off')
  })

  it('a provider without one is missing at once, as before', async () => {
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    h.children[0]!.failSpawn('ENOENT')
    expect(f.calls).toHaveLength(0)
    expect(h.sup.status().state).toBe('missing')
  })

  it('an installCommand is a shell command of at most 2000 characters', () => {
    expect(() => validateExposeDefinition({ ...DEF, installCommand: 'sh install.sh' })).not.toThrow()
    for (const bad of ['', '   ', 'x'.repeat(2_001), 7, ['sh']]) {
      expect(() => validateExposeDefinition({ ...DEF, installCommand: bad as never }), JSON.stringify(bad)).toThrow(/installCommand/)
    }
  })
})

describe('ExposeSupervisor.hold, what a handover reads', () => {
  it('the address it last held, kept while it retries, gone once stopped', async () => {
    const h = harness()
    expect(h.sup.hold()).toEqual({})
    await h.sup.start(resolveRun(DEF, 5000), 5000)
    expect(h.sup.hold()).toEqual({})
    h.children[0]!.say('https://me-acme-demo.example.test')
    expect(h.sup.hold()).toEqual({ url: 'https://me-acme-demo.example.test' })
    h.children[0]!.exit(1)
    expect(h.sup.hold()).toEqual({ url: 'https://me-acme-demo.example.test' })
    await h.sup.stop()
    expect(h.sup.hold()).toEqual({})
  })
})
