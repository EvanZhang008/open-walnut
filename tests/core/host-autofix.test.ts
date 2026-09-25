/**
 * Host autofix (src/core/hosts/host-autofix.ts + the round in host-readiness.ts):
 * after a preflight with problems on a daemon that has 'hostfix-v1', the server
 * runs host.fix in order, re-runs the preflight after each fix, publishes the
 * progress on the readiness, and never retries a failed fix on its own.
 *
 * Only the daemon connection is faked: a tiny host whose preflight answer
 * changes when a fix "installs" something. No installer ever runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-autofix'))

import {
  clearHostReadiness,
  getHostReadiness,
  hostAutofixRound,
  onHostReadinessChange,
  refreshHostReadiness,
  resetHostAutofixAttempts,
  type AutofixOptions,
  type PreflightConnection,
} from '../../src/core/hosts/host-readiness.js'
import { autofixDisabledReason, describeFixOutcome, fixActionFor, isTransportError, nextFixAction, withFixState } from '../../src/core/hosts/host-autofix.js'
import type { HostFixAction } from '../../src/core/hosts/host-autofix.js'

interface HostState {
  claude: Record<string, unknown>
  compiler: { found: boolean; name?: string }
  dtach: { found: boolean; path?: string }
  platform?: string
  arch?: string
}
type FixReply = Record<string, unknown> | Promise<Record<string, unknown>> | Error

const NPM_NO_NODE = { found: true, path: '/home/dev/.local/bin/claude', kind: 'npm', needsNode: true, nodeFound: false }
const NATIVE = { found: true, path: '/home/dev/.local/bin/claude', kind: 'native', needsNode: false, version: '2.1.280' }

/** A host that "installs" what each fix names, unless `replies` says otherwise. */
function fakeHost(initial: Partial<HostState>, replies: Partial<Record<HostFixAction, (s: HostState) => FixReply>> = {}, caps = ['preflight-v1', 'hostfix-v1']) {
  const state: HostState = {
    claude: NPM_NO_NODE, compiler: { found: false }, dtach: { found: false }, platform: 'linux', ...initial,
  }
  const sent: string[] = []
  const params: Array<Record<string, unknown>> = []
  const defaults: Record<HostFixAction, (s: HostState) => FixReply> = {
    'install-claude-native': (s) => { s.claude = NATIVE; return { action: 'install-claude-native', ok: true, claude: { path: NATIVE.path, kind: 'native', version: '2.1.280' }, log: '', durationMs: 5 } },
    'update-claude': (s) => { s.claude = { ...s.claude, version: '2.1.280', versionOk: true }; return { action: 'update-claude', ok: true, claude: { path: NATIVE.path, kind: 'native', version: '2.1.280' }, log: '', durationMs: 5 } },
    'install-compiler': (s) => { s.compiler = { found: true, name: 'gcc' }; return { action: 'install-compiler', ok: true, packageManager: 'yum', log: '', durationMs: 5 } },
    'build-dtach': (s) => { s.dtach = { found: true, path: '/home/dev/.local/bin/walnut-dtach' }; return { action: 'build-dtach', ok: true, path: '/home/dev/.local/bin/walnut-dtach', log: '', durationMs: 5 } },
  }
  const send = vi.fn(async (cmd: string, p: Record<string, unknown> = {}) => {
    if (cmd === 'host.preflight') {
      sent.push('preflight')
      return { ok: true, ...JSON.parse(JSON.stringify(state)) }
    }
    const action = p.action as HostFixAction
    sent.push(`fix:${action}`)
    params.push(p)
    const out = await (replies[action] ?? defaults[action])(state)
    if (out instanceof Error) throw out
    return { ok: true, result: out }
  })
  const conn: PreflightConnection = { hasCapability: (c) => caps.includes(c), send: send as PreflightConnection['send'] }
  return { conn, send, sent, params, state }
}

const onFixed = vi.fn()
const SOURCES = { 'main.c': 'bWFpbg==' }
/** The terminal's ssh provisioning; by default it cannot help (so the daemon compiles). */
const provisionDtach = vi.fn(async (_host: string): Promise<{ kind: string; source?: string; stderr?: string }> => ({ kind: 'build_failed', stderr: 'cc: error' }))
/** Seams: the host's config entry is `hostDef`, and the env is empty unless given. */
function autofix(hostDef: { autofix?: unknown } | undefined = {}, env: Record<string, string> = {}): AutofixOptions {
  return { hostSettings: async () => hostDef, env, onFixed, dtachSources: async () => SOURCES, provisionDtach }
}
/** No prebuilt dtach unless a test says so. */
let prebuilt: (platform?: string, arch?: string) => Promise<string | null> = async () => null

async function refreshAndSettle(host: string, conn: PreflightConnection, opts: AutofixOptions = autofix(), extra: { force?: boolean } = {}) {
  const r = await refreshHostReadiness(host, { getConnection: () => conn, autofix: opts, force: extra.force, findPrebuilt: (p, a) => prebuilt(p, a) })
  await hostAutofixRound(host)
  return r
}

beforeEach(() => {
  clearHostReadiness()
  onFixed.mockReset()
  provisionDtach.mockClear()
  prebuilt = async () => null
})

describe('the autofix round', () => {
  it('fixes in order (claude, gcc, dtach), re-running the preflight after each, until nothing is left', async () => {
    const h = fakeHost({})
    await refreshAndSettle('devbox', h.conn)
    // dtach: the terminal's own provisioning first; it failed, and gcc is there now,
    // so the daemon compiles.
    expect(provisionDtach.mock.calls).toEqual([['devbox']])
    expect(h.sent).toEqual([
      'preflight', 'fix:install-claude-native',
      'preflight', 'fix:install-compiler',
      'preflight', 'fix:build-dtach',
      'preflight',
    ])
    // build-dtach carries the vendored source; the others carry only their name.
    expect(h.params.map((p) => Object.keys(p).sort())).toEqual([['action'], ['action'], ['action', 'sources']])
    expect(h.params[2]!.sources).toBe(SOURCES)
    const r = getHostReadiness('devbox')!
    expect(r.problems).toEqual([])
    expect(r.fixing).toBeUndefined()
    expect(r.fixes.map((f) => [f.action, f.ok, f.text])).toEqual([
      ['install-claude-native', true, 'Installed Claude Code 2.1.280'],
      ['install-compiler', true, 'Installed gcc'],
      ['build-dtach', true, 'Built dtach, so terminals here survive a disconnect'],
    ])
    // The terminal's cached "no compiler" must not outlive the fixes that change it.
    expect(onFixed.mock.calls).toEqual([['devbox', 'install-claude-native'], ['devbox', 'install-compiler'], ['devbox', 'build-dtach']])
  })

  it('publishes progress: fixing + a running problem while the fix runs, then the record', async () => {
    let finish: (v: Record<string, unknown>) => void = () => {}
    const h = fakeHost({ compiler: { found: true, name: 'gcc' }, dtach: { found: true } }, {
      'install-claude-native': () => new Promise((resolve) => { finish = resolve }),
    })
    const pushes: string[] = []
    const off = onHostReadinessChange((host) => pushes.push(host))
    const first = await refreshHostReadiness('devbox', { getConnection: () => h.conn, autofix: autofix(), now: () => 1000 })
    expect(first!.problems.map((p) => p.kind)).toEqual(['claude_needs_node'])
    await vi.waitFor(() => expect(getHostReadiness('devbox')!.fixing).toBeDefined())
    const during = getHostReadiness('devbox')!
    expect(during.fixing).toEqual({ action: 'install-claude-native', startedAt: 1000, text: 'Installing Claude Code' })
    expect(during.problems[0]!.fix).toEqual({ action: 'install-claude-native', state: 'running', text: 'Installing Claude Code' })
    h.state.claude = NATIVE
    finish({ action: 'install-claude-native', ok: true, claude: { version: '2.1.281' }, log: '', durationMs: 1 })
    await hostAutofixRound('devbox')
    off()
    const after = getHostReadiness('devbox')!
    expect(after.fixing).toBeUndefined()
    expect(after.problems).toEqual([])
    expect(after.fixes).toEqual([{ action: 'install-claude-native', ok: true, finishedAt: 1000, text: 'Installed Claude Code 2.1.281', ageMs: expect.any(Number) }])
    // The age is the server's own difference, so a client never compares clocks.
    expect(getHostReadiness('devbox', 61_000)!.fixes[0]!.ageMs).toBe(60_000)
    // preflight, fix started, fix finished, re-preflight: each one is a host:status push.
    expect(pushes).toEqual(['devbox', 'devbox', 'devbox', 'devbox'])
  })

  it('a sudo password refusal keeps the line, says why, and hands over the exact command', async () => {
    const h = fakeHost({ claude: NATIVE }, {
      'install-compiler': () => ({
        action: 'install-compiler', ok: false, error: 'needs-password', needsPassword: true,
        manualCommand: 'sudo apt-get install -y gcc libc6-dev', log: 'sudo: a password is required', durationMs: 3,
      }),
    })
    await refreshAndSettle('devbox', h.conn)
    expect(h.sent).toEqual(['preflight', 'fix:install-compiler', 'preflight'])
    const r = getHostReadiness('devbox')!
    expect(r.problems).toEqual([expect.objectContaining({
      kind: 'compiler_missing',
      commands: ['sudo apt-get install -y gcc libc6-dev'],
      fix: {
        action: 'install-compiler', state: 'failed', needsPassword: true, detail: 'sudo: a password is required',
        text: 'Could not install gcc automatically (sudo needs a password)',
      },
    })])
    expect(r.fixes).toEqual([expect.objectContaining({ action: 'install-compiler', ok: false, needsPassword: true, error: 'needs-password' })])
    expect(onFixed).not.toHaveBeenCalled()
  })

  it('once per problem: a reconnect does not retry a failed fix; Check again allows exactly one more', async () => {
    const refuse = () => ({ action: 'install-compiler', ok: false, error: 'needs-password', needsPassword: true, log: '', durationMs: 1 })
    const h = fakeHost({ claude: NATIVE }, { 'install-compiler': refuse })
    await refreshAndSettle('devbox', h.conn)
    await refreshAndSettle('devbox', h.conn)
    await refreshAndSettle('devbox', h.conn, autofix(), { force: true })
    expect(h.sent.filter((s) => s.startsWith('fix:'))).toEqual(['fix:install-compiler'])
    resetHostAutofixAttempts('devbox')
    await refreshAndSettle('devbox', h.conn, autofix(), { force: true })
    await refreshAndSettle('devbox', h.conn)
    expect(h.sent.filter((s) => s.startsWith('fix:'))).toEqual(['fix:install-compiler', 'fix:install-compiler'])
    expect(getHostReadiness('devbox')!.fixes).toHaveLength(2)
  })

  it('a dropped connection is no attempt: the next connect tries again', async () => {
    let calls = 0
    const h = fakeHost({ compiler: { found: true }, dtach: { found: true } }, {
      'install-claude-native': (s) => {
        if (++calls === 1) return new Error('DaemonConnection not connected to devbox')
        s.claude = NATIVE
        return { action: 'install-claude-native', ok: true, log: '', durationMs: 1 }
      },
    })
    await refreshAndSettle('devbox', h.conn)
    expect(getHostReadiness('devbox')!.problems[0]!.fix).toMatchObject({ state: 'failed', text: 'Could not install Claude Code automatically (the connection to the host dropped)' })
    expect(h.sent).toEqual(['preflight', 'fix:install-claude-native'])
    await refreshAndSettle('devbox', h.conn)
    expect(h.sent.slice(2)).toEqual(['preflight', 'fix:install-claude-native', 'preflight'])
    expect(getHostReadiness('devbox')!.problems).toEqual([])
  })

  it('a daemon-side refusal is a real attempt with the daemon\'s words, not a dropped connection, and is not retried on reconnect', async () => {
    const h = fakeHost({ compiler: { found: true }, dtach: { found: true } })
    h.send.mockImplementation(async (cmd: string, p: Record<string, unknown> = {}) => {
      if (cmd === 'host.preflight') { h.sent.push('preflight'); return { ok: true, ...JSON.parse(JSON.stringify(h.state)) } }
      h.sent.push(`fix:${p.action as string}`)
      return { ok: false, error: 'host.fix failed: EACCES: permission denied, mkdtemp' }
    })
    await refreshAndSettle('devbox', h.conn)
    await refreshAndSettle('devbox', h.conn)
    expect(h.sent.filter((s) => s.startsWith('fix:'))).toEqual(['fix:install-claude-native'])
    expect(getHostReadiness('devbox')!.problems[0]!.fix).toMatchObject({
      state: 'failed', text: 'Could not install Claude Code automatically (the host said: host.fix failed: EACCES: permission denied, mkdtemp)',
    })
  })

  it('a claude that shadows the new install keeps its line, names the path, and offers rm as the command', async () => {
    const h = fakeHost({ claude: { found: true, path: '/usr/local/bin/claude', kind: 'npm', needsNode: true, nodeFound: false }, compiler: { found: true }, dtach: { found: true } }, {
      'install-claude-native': () => ({ action: 'install-claude-native', ok: false, error: 'shadowed', shadowedBy: '/usr/local/bin/claude', manualCommand: 'curl -fsSL https://claude.ai/install.sh | bash', log: '', durationMs: 5 }),
    })
    await refreshAndSettle('devbox', h.conn)
    const line = getHostReadiness('devbox')!.problems[0]!
    expect(line.kind).toBe('claude_needs_node')
    expect(line.commands).toEqual(['rm /usr/local/bin/claude'])
    expect(line.fix).toMatchObject({ state: 'failed', text: expect.stringContaining('the claude at /usr/local/bin/claude comes first on PATH') })
  })

  it('an ssh failure in the dtach step is no attempt: the next connect tries again', async () => {
    prebuilt = async () => '/opt/walnut/dtach-linux-x64'
    const h = fakeHost({ claude: NATIVE, compiler: { found: false }, dtach: { found: false }, arch: 'x64' })
    provisionDtach
      .mockImplementationOnce(async () => ({ kind: 'ssh_failed', stderr: 'ssh: connect to host devbox port 22: Operation timed out' }))
      .mockImplementationOnce(async () => {
        h.state.dtach = { found: true }
        return { kind: 'ok', source: 'prebuilt' }
      })
    await refreshAndSettle('devbox', h.conn)
    expect(getHostReadiness('devbox')!.problems[0]!.fix).toMatchObject({ state: 'failed', text: 'Could not install dtach automatically (ssh to the host failed)' })
    // The prebuilt is still on offer: ssh trouble says nothing about it.
    expect(getHostReadiness('devbox')!.problems.map((p) => p.kind)).toEqual(['dtach_missing'])
    await refreshAndSettle('devbox', h.conn)
    expect(provisionDtach).toHaveBeenCalledTimes(2)
    expect(getHostReadiness('devbox')!.problems).toEqual([])
  })

  it('an unreadable host config fails closed: no fix runs, and the next readable connect runs them', async () => {
    const h = fakeHost({ compiler: { found: true }, dtach: { found: true } })
    await refreshAndSettle('devbox', h.conn, { ...autofix(), hostSettings: async () => { throw new Error('config.yaml: bad indentation') } })
    expect(h.sent).toEqual(['preflight'])
    await refreshAndSettle('devbox', h.conn)
    expect(h.sent.filter((s) => s.startsWith('fix:'))).toEqual(['fix:install-claude-native'])
  })

  it('the default dtach provisioning forgets the cached ok before probing (a reimaged host must really be looked at)', async () => {
    prebuilt = async () => '/opt/walnut/dtach-linux-x64'
    const order: string[] = []
    const terminal = await import('../../src/web/terminal/dtach-provision.js')
    const inv = vi.spyOn(terminal, 'invalidateDtachCache').mockImplementation((host) => { order.push(`invalidate:${host}`) })
    const res = vi.spyOn(terminal, 'resolveRemoteDtach').mockImplementation(async (host, o) => {
      order.push(`resolve:${host}:${o?.fresh}`)
      return { kind: 'ok', path: '/home/dev/.local/bin/walnut-dtach', source: 'walnut' }
    })
    const h = fakeHost({ claude: NATIVE, compiler: { found: false }, dtach: { found: false }, arch: 'x64' })
    const { provisionDtach: _seam, ...withoutSeam } = autofix()
    await refreshAndSettle('devbox', h.conn, withoutSeam)
    expect(order.slice(0, 2)).toEqual(['invalidate:devbox', 'resolve:devbox:true'])
    inv.mockRestore(); res.mockRestore()
  })

  it('the off switch: WALNUT_HOST_AUTOFIX=0 (read live) or hosts.<alias>.autofix: false', async () => {
    const byEnv = fakeHost({})
    await refreshAndSettle('devbox', byEnv.conn, autofix({}, { WALNUT_HOST_AUTOFIX: '0' }))
    const byConfig = fakeHost({})
    await refreshAndSettle('marina', byConfig.conn, autofix({ autofix: false }))
    expect(byEnv.sent).toEqual(['preflight'])
    expect(byConfig.sent).toEqual(['preflight'])
    // Without an explicit env seam the live process.env decides, on every call.
    const live = fakeHost({})
    const saved = process.env.WALNUT_HOST_AUTOFIX
    process.env.WALNUT_HOST_AUTOFIX = '0'
    try {
      await refreshAndSettle('acme', live.conn, { hostSettings: async () => ({}), onFixed, dtachSources: async () => SOURCES })
    } finally {
      if (saved === undefined) delete process.env.WALNUT_HOST_AUTOFIX
      else process.env.WALNUT_HOST_AUTOFIX = saved
    }
    expect(live.sent).toEqual(['preflight'])
    // Turned back on, the same host gets its fixes (the off round tried nothing).
    await refreshAndSettle('acme', live.conn, autofix())
    expect(live.sent.filter((s) => s.startsWith('fix:'))).toHaveLength(3)
  })

  it('never fixes a healthy host, an old daemon without hostfix-v1, or a Mac compiler', async () => {
    const healthy = fakeHost({ claude: NATIVE, compiler: { found: true, name: 'cc' }, dtach: { found: false } })
    const settings = vi.fn(async () => ({}))
    await refreshAndSettle('devbox', healthy.conn, { ...autofix(), hostSettings: settings })
    expect(healthy.sent).toEqual(['preflight'])
    expect(settings).not.toHaveBeenCalled()

    const old = fakeHost({}, {}, ['preflight-v1'])
    await refreshAndSettle('marina', old.conn)
    expect(old.sent).toEqual(['preflight'])
    expect(getHostReadiness('marina')!.fixes).toEqual([])

    const mac = fakeHost({ claude: NATIVE, platform: 'darwin' })
    await refreshAndSettle('studio', mac.conn)
    expect(mac.sent).toEqual(['preflight'])
    expect(getHostReadiness('studio')!.problems).toEqual([expect.objectContaining({ kind: 'compiler_missing', commands: ['xcode-select --install'] })])
  })

  it('a busy daemon is no attempt either, and a second trigger during a round starts nothing', async () => {
    let finish: (v: Record<string, unknown>) => void = () => {}
    let asked = 0
    const h = fakeHost({ compiler: { found: true }, dtach: { found: true } }, {
      'install-claude-native': (s) => {
        if (++asked === 1) return new Promise((resolve) => { finish = resolve })
        s.claude = NATIVE
        return { action: 'install-claude-native', ok: true, log: '', durationMs: 1 }
      },
    })
    await refreshHostReadiness('devbox', { getConnection: () => h.conn, autofix: autofix() })
    await vi.waitFor(() => expect(h.sent).toContain('fix:install-claude-native'))
    await refreshHostReadiness('devbox', { getConnection: () => h.conn, autofix: autofix() })
    expect(h.sent.filter((s) => s.startsWith('fix:'))).toHaveLength(1)
    finish({ action: 'install-claude-native', ok: false, error: 'busy', log: '', durationMs: 0 })
    await hostAutofixRound('devbox')
    // busy: not counted, so the next connect asks again.
    await refreshAndSettle('devbox', h.conn)
    expect(h.sent.filter((s) => s.startsWith('fix:'))).toHaveLength(2)
  })
})

describe('a prebuilt dtach the server ships', () => {
  const NO_TOOLS = { compiler: { found: false }, dtach: { found: false }, platform: 'linux', arch: 'x64' }

  it('makes the compiler moot: no compiler_missing line, but dtach_missing until the prebuilt is really in place', async () => {
    const seen: Array<[string | undefined, string | undefined]> = []
    prebuilt = async (p, a) => { seen.push([p, a]); return '/opt/walnut/dtach-linux-x64' }
    const h = fakeHost({ claude: NATIVE, ...NO_TOOLS })
    provisionDtach.mockImplementationOnce(async () => {
      h.state.dtach = { found: true, path: '/home/dev/.local/bin/walnut-dtach' }
      return { kind: 'ok', source: 'prebuilt' }
    })
    const first = await refreshHostReadiness('devbox', { getConnection: () => h.conn, autofix: autofix(), findPrebuilt: (p, a) => prebuilt(p, a) })
    expect(seen[0]).toEqual(['linux', 'x64'])
    expect(first!.problems.map((p) => p.kind)).toEqual(['dtach_missing'])
    await hostAutofixRound('devbox')
    // The terminal provisioning installs it; install-compiler never runs.
    expect(h.sent).toEqual(['preflight', 'preflight'])
    expect(provisionDtach).toHaveBeenCalledTimes(1)
    expect(getHostReadiness('devbox')!.problems).toEqual([])
  })

  it('with the fixes off, a host whose prebuilt is not installed never reads as healthy', async () => {
    prebuilt = async () => '/opt/walnut/dtach-linux-x64'
    const h = fakeHost({ claude: NATIVE, ...NO_TOOLS })
    await refreshAndSettle('devbox', h.conn, autofix({ autofix: false }))
    expect(getHostReadiness('devbox')!.problems).toEqual([expect.objectContaining({ kind: 'dtach_missing', commands: [] })])
    expect(provisionDtach).not.toHaveBeenCalled()
  })

  it('in a round, dtach comes from the terminal provisioning (the prebuilt), never from install-compiler', async () => {
    prebuilt = async () => '/opt/walnut/dtach-linux-x64'
    const h = fakeHost(NO_TOOLS)
    provisionDtach.mockImplementationOnce(async () => {
      h.state.dtach = { found: true, path: '/home/dev/.local/bin/walnut-dtach' }
      return { kind: 'ok', source: 'prebuilt' }
    })
    await refreshAndSettle('devbox', h.conn)
    expect(getHostReadiness('devbox')!.fixes.map((f) => f.action)).toEqual(['install-claude-native', 'build-dtach'])
    expect(h.sent).toEqual(['preflight', 'fix:install-claude-native', 'preflight', 'preflight'])
    expect(getHostReadiness('devbox')!.fixes[1]).toMatchObject({ ok: true, text: 'Installed dtach, so terminals here survive a disconnect' })
    expect(getHostReadiness('devbox')!.problems).toEqual([])
  })

  it('a prebuilt that does not run on the host brings gcc back: install-compiler, then dtach again', async () => {
    prebuilt = async () => '/opt/walnut/dtach-linux-x64'
    const h = fakeHost(NO_TOOLS)
    provisionDtach
      .mockImplementationOnce(async () => ({ kind: 'no_compiler' }))
      .mockImplementationOnce(async () => {
        h.state.dtach = { found: true, path: '/home/dev/.local/bin/walnut-dtach' }
        return { kind: 'ok', source: 'built' }
      })
    await refreshAndSettle('devbox', h.conn)
    expect(provisionDtach).toHaveBeenCalledTimes(2)
    expect(h.sent).toEqual([
      'preflight', 'fix:install-claude-native',
      'preflight', /* dtach via the terminal: the prebuilt did not run */
      'preflight', 'fix:install-compiler',
      'preflight', /* dtach via the terminal again: compiled over ssh */
      'preflight',
    ])
    expect(getHostReadiness('devbox')!.fixes.map((f) => [f.action, f.ok])).toEqual([
      ['install-claude-native', true], ['build-dtach', false], ['install-compiler', true], ['build-dtach', true],
    ])
    expect(getHostReadiness('devbox')!.fixes[1]!.text).toBe('Could not install dtach automatically (there is no C compiler)')
  })

  it('after the prebuilt failed there, the compiler line comes back with its fix state', async () => {
    prebuilt = async () => '/opt/walnut/dtach-linux-x64'
    const h = fakeHost(NO_TOOLS, {
      'install-compiler': () => ({ action: 'install-compiler', ok: false, error: 'needs-password', needsPassword: true, manualCommand: 'sudo yum install -y gcc glibc-devel', log: '', durationMs: 1 }),
    })
    provisionDtach.mockImplementationOnce(async () => ({ kind: 'no_compiler' }))
    await refreshAndSettle('devbox', h.conn)
    expect(getHostReadiness('devbox')!.problems).toEqual([expect.objectContaining({
      kind: 'compiler_missing', commands: ['sudo yum install -y gcc glibc-devel'],
      fix: expect.objectContaining({ state: 'failed', needsPassword: true }),
    })])
  })
})

describe('a claude older than the model needs', () => {
  const OLD_NATIVE = { ...NATIVE, version: '2.1.258', versionOk: false, minVersion: '2.1.280', installMethod: 'native', auth: 'ok' }
  const floorCtx = async () => ({ label: 'devbox', sshTarget: 'devbox', floor: { minVersion: '2.1.280', model: 'Opus 5.5' } })

  it('the native installer\'s build gets update-claude with the floor, then the line is gone', async () => {
    const h = fakeHost({ claude: OLD_NATIVE, compiler: { found: true, name: 'gcc' }, dtach: { found: true } })
    await refreshHostReadiness('devbox', { getConnection: () => h.conn, autofix: autofix(), hostContext: floorCtx })
    await hostAutofixRound('devbox')
    expect(h.sent).toEqual(['preflight', 'fix:update-claude', 'preflight'])
    expect(h.params[0]).toEqual({ action: 'update-claude', minClaudeVersion: '2.1.280' })
    const r = getHostReadiness('devbox')!
    expect(r.problems).toEqual([])
    expect(r.fixes.map((f) => [f.action, f.ok, f.text])).toEqual([['update-claude', true, 'Updated Claude Code to 2.1.280']])
  })

  it('while it runs the outdated line reads "Updating Claude Code"; a refusal keeps the line with its reason', async () => {
    let release!: (v: Record<string, unknown>) => void
    const h = fakeHost({ claude: OLD_NATIVE, compiler: { found: true, name: 'gcc' }, dtach: { found: true } }, {
      'update-claude': () => new Promise((resolve) => { release = resolve }),
    })
    await refreshHostReadiness('devbox', { getConnection: () => h.conn, autofix: autofix(), hostContext: floorCtx })
    await vi.waitFor(() => expect(getHostReadiness('devbox')!.fixing?.action).toBe('update-claude'))
    expect(getHostReadiness('devbox')!.problems[0]).toMatchObject({ kind: 'claude_outdated', fix: { action: 'update-claude', state: 'running', text: 'Updating Claude Code' } })
    release({ action: 'update-claude', ok: false, error: 'still-outdated', manualCommand: 'claude install latest', log: 'Claude Code is up to date\n', durationMs: 5 })
    await hostAutofixRound('devbox')
    expect(getHostReadiness('devbox')!.problems[0]).toMatchObject({
      kind: 'claude_outdated', commands: ['claude install latest'],
      fix: { action: 'update-claude', state: 'failed', text: 'Could not update Claude Code automatically (the newest release it could reach is still too old)' },
    })
  })

  it('an outdated npm build gets the native build instead; Homebrew, a wrapper, or sign-in get no fix at all', () => {
    const q = (claude: Record<string, unknown>) => ({ claude, compiler: { found: true }, dtach: { found: true } }) as never
    expect(nextFixAction(q({ ...OLD_NATIVE, kind: 'npm', installMethod: 'npm' }), new Set())).toBe('install-claude-native')
    expect(nextFixAction(q(OLD_NATIVE), new Set())).toBe('update-claude')
    expect(nextFixAction(q(OLD_NATIVE), new Set(['update-claude']))).toBeNull()
    expect(nextFixAction(q({ ...OLD_NATIVE, installMethod: 'homebrew' }), new Set())).toBeNull()
    expect(nextFixAction(q({ ...OLD_NATIVE, installMethod: 'other' }), new Set())).toBeNull()
    // A daemon from before install methods: the version is known but not how it was installed.
    expect(nextFixAction(q({ ...OLD_NATIVE, installMethod: undefined }), new Set())).toBeNull()
    expect(nextFixAction(q({ ...NATIVE, auth: 'not-logged-in', versionOk: true }), new Set())).toBeNull()
    expect(fixActionFor('claude_not_logged_in', q(NATIVE))).toBeNull()
    expect(fixActionFor('claude_outdated', q({ ...OLD_NATIVE, installMethod: undefined, kind: 'npm' }))).toBe('install-claude-native')
  })

  it('withFixState attaches a running install to an outdated npm line (its fix is install-claude-native)', () => {
    const q = { claude: { ...OLD_NATIVE, kind: 'npm', installMethod: 'npm' }, compiler: { found: true }, dtach: { found: true } } as never
    const line = { kind: 'claude_outdated' as const, message: 'm', commands: ['x'] }
    expect(withFixState([line], q, { action: 'install-claude-native', startedAt: 1, text: 'Installing Claude Code' }, [])[0])
      .toMatchObject({ fix: { action: 'install-claude-native', state: 'running' } })
    expect(withFixState([line], q, { action: 'update-claude', startedAt: 1, text: 'Updating Claude Code' }, [])[0]!.fix).toBeUndefined()
  })

  it('describeFixOutcome words every update-claude answer', () => {
    const d = (result: Record<string, unknown>) => describeFixOutcome('update-claude', { result }, 5)
    expect(d({ ok: true, skipped: true, claude: { path: 'p', kind: 'native', version: '2.1.281' } }).text).toBe('Claude Code 2.1.281 is up to date')
    expect(d({ ok: false, error: 'unmanaged-install' }).text).toBe('Could not update Claude Code automatically (it was not installed by the native installer)')
    expect(d({ ok: false, error: 'updates-disabled', manualCommand: 'claude update' })).toMatchObject({
      text: 'Could not update Claude Code automatically (updates are turned off with DISABLE_UPDATES)', command: 'claude update',
    })
    expect(d({ ok: false, error: 'unknown-action' }).text).toBe('Could not update Claude Code automatically (the session daemon there is too old for this fix)')
  })
})

describe('planning and wording', () => {
  const p = (x: Partial<HostState>) => ({ claude: NATIVE, compiler: { found: true }, dtach: { found: true }, ...x }) as never

  it('nextFixAction follows the documented order and skips what was tried', () => {
    expect(nextFixAction(p({ claude: { found: false } }), new Set())).toBe('install-claude-native')
    expect(nextFixAction(p({ claude: NPM_NO_NODE, compiler: { found: false }, dtach: { found: false } }), new Set(['install-claude-native']))).toBe('install-compiler')
    expect(nextFixAction(p({ compiler: { found: true }, dtach: { found: false } }), new Set())).toBe('build-dtach')
    expect(nextFixAction(p({ compiler: { found: false }, dtach: { found: true } }), new Set())).toBeNull()
    expect(nextFixAction(p({ compiler: { found: false }, dtach: { found: false }, platform: 'darwin' }), new Set())).toBeNull()
    // A usable prebuilt replaces the compiler: dtach directly, on a Mac too.
    expect(nextFixAction(p({ compiler: { found: false }, dtach: { found: false } }), new Set(), { prebuiltDtach: true })).toBe('build-dtach')
    expect(nextFixAction(p({ compiler: { found: false }, dtach: { found: false }, platform: 'darwin' }), new Set(), { prebuiltDtach: true })).toBe('build-dtach')
    // A claude that is installed but crashes is not something a reinstall is guessed to fix.
    expect(nextFixAction(p({ claude: { ...NATIVE, error: 'claude --version exited with code 1' } }), new Set())).toBeNull()
  })

  it('describeFixOutcome turns daemon codes into one sentence', () => {
    expect(describeFixOutcome('build-dtach', { result: { ok: false, error: 'build-failed', log: 'a\nmaster.c:1: error: pty.h\n' } }, 5))
      .toMatchObject({ text: 'Could not install dtach automatically (the compiler failed)', detail: 'master.c:1: error: pty.h' })
    expect(describeFixOutcome('install-claude-native', { result: { ok: true, skipped: true, claude: { path: 'p', kind: 'native' } } }, 5).text).toBe('Claude Code is installed')
    expect(describeFixOutcome('install-compiler', { result: null, transportError: 'daemon command timeout: host.fix' }, 5)).toMatchObject({ ok: false, error: 'connection-lost' })
    // What the daemon SAID is the reason, not "the connection dropped".
    expect(describeFixOutcome('install-compiler', { result: null, daemonError: 'unknown command: host.fix' }, 5))
      .toMatchObject({ ok: false, error: 'daemon-error', text: 'Could not install gcc automatically (the host said: unknown command: host.fix)' })
  })

  it('a shadowing claude names its path and says to remove it or reorder PATH, with rm as the command', () => {
    const r = describeFixOutcome('install-claude-native', { result: { ok: false, error: 'shadowed', shadowedBy: '/usr/local/bin/claude', manualCommand: 'curl -fsSL https://claude.ai/install.sh | bash' } }, 5)
    expect(r.text).toBe('Installed the native Claude Code, but the claude at /usr/local/bin/claude comes first on PATH (remove it, or put ~/.local/bin first on PATH)')
    expect(r.command).toBe('rm /usr/local/bin/claude')
    expect(describeFixOutcome('install-claude-native', { result: { ok: false, error: 'shadowed', shadowedBy: "/opt/my tools/claude's" } }, 5).command)
      .toBe("rm '/opt/my tools/claude'\\''s'")
  })

  it('isTransportError: only a host that never answered', () => {
    for (const m of ['connection closed', 'DaemonConnection not connected to devbox', 'DaemonConnection: ws not open for devbox', 'daemon command timeout: host.fix (330000ms) [traceId=ab]']) {
      expect(isTransportError(m), m).toBe(true)
    }
    for (const m of ['host.fix failed: EACCES', 'Daemon is shutting down; retry after reconnecting', 'unknown command: host.fix', 'command not permitted over the bridge']) {
      expect(isTransportError(m), m).toBe(false)
    }
  })

  it('autofixDisabledReason: env first, then the host entry', () => {
    expect(autofixDisabledReason({}, undefined)).toBeNull()
    expect(autofixDisabledReason({ WALNUT_HOST_AUTOFIX: '1' }, { autofix: true })).toBeNull()
    for (const v of ['0', 'false', 'off', 'NO']) expect(autofixDisabledReason({ WALNUT_HOST_AUTOFIX: v }, {})).toBe('env')
    expect(autofixDisabledReason({}, { autofix: false })).toBe('config')
  })
})

afterEach(() => { vi.restoreAllMocks() })
