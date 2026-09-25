/**
 * Host readiness (src/core/hosts/host-readiness.ts): shaping the daemon's
 * host.preflight answer into user-facing problems, and the per-host probe
 * store (capability gate, one probe at a time, healthy-host throttle).
 * Only the daemon connection is faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-readiness'))

import {
  clearHostReadiness,
  getHostReadiness,
  onHostReadinessChange,
  parsePreflight,
  readinessProblems,
  refreshHostReadiness,
  sshTargetText,
  wireHostReadiness,
  type PreflightConnection,
} from '../../src/core/hosts/host-readiness.js'
import { applyClaudeFloor } from '../../src/core/hosts/host-readiness-problems.js'
import { claudeCliFloorFor, claudeVersionAtLeast } from '../../src/core/hosts/claude-version-floor.js'

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'

const NPM_NO_NODE = {
  ok: true,
  claude: { found: true, path: '/home/dev/.local/bin/claude', kind: 'npm', needsNode: true, nodeFound: false, error: 'needs node' },
  compiler: { found: false },
  dtach: { found: false },
}
const READY = {
  ok: true,
  claude: { found: true, path: '/home/dev/.local/bin/claude', kind: 'native', needsNode: false, version: '2.1.280' },
  compiler: { found: true, name: 'gcc' },
  dtach: { found: false },
}

function fakeConn(reply: Record<string, unknown>, caps = ['preflight-v1']) {
  const send = vi.fn(async (_cmd: string) => reply as { ok: boolean })
  const conn: PreflightConnection = { hasCapability: (c) => caps.includes(c), send }
  return { conn, send }
}

beforeEach(() => clearHostReadiness())

describe('parsePreflight + readinessProblems', () => {
  it('npm claude without node, no compiler, no dtach: two lines, each with its command', () => {
    const p = parsePreflight(NPM_NO_NODE)!
    expect(readinessProblems(p)).toEqual([
      { kind: 'claude_needs_node', message: expect.stringContaining('npm build'), commands: [INSTALL] },
      { kind: 'compiler_missing', message: expect.stringContaining('will not survive a disconnect'), commands: ['sudo yum install -y gcc', 'sudo apt-get install -y gcc'] },
    ])
  })

  it('claude missing', () => {
    const p = parsePreflight({ claude: { found: false }, compiler: { found: true, name: 'cc' }, dtach: { found: false } })!
    expect(readinessProblems(p)).toEqual([{ kind: 'claude_missing', message: 'Claude Code is not installed on this host.', commands: [INSTALL] }])
  })

  it('a ready host has no problems at all (the UI then shows nothing)', () => {
    expect(readinessProblems(parsePreflight(READY)!)).toEqual([])
  })

  it('a missing compiler is no problem once dtach is already there', () => {
    const p = parsePreflight({ ...READY, compiler: { found: false }, dtach: { found: true, path: '/usr/bin/dtach' } })!
    expect(readinessProblems(p)).toEqual([])
  })

  it('a claude that is installed but crashes on --version says so', () => {
    const p = parsePreflight({ ...READY, claude: { ...READY.claude, error: 'claude --version exited with code 1: SyntaxError' } })!
    expect(readinessProblems(p)).toEqual([expect.objectContaining({ kind: 'claude_error', message: 'Claude Code did not start: claude --version exited with code 1: SyntaxError' })])
  })

  it('drops junk fields and rejects an answer with no claude block', () => {
    expect(parsePreflight({ ok: true })).toBeNull()
    expect(parsePreflight({ claude: { found: 'yes', kind: 'weird', path: 7 }, compiler: 'x' })).toEqual({
      claude: { found: false }, compiler: { found: false }, dtach: { found: false },
    })
  })
})

describe('refreshHostReadiness', () => {
  it('stores the shaped answer and notifies', async () => {
    const { conn, send } = fakeConn(NPM_NO_NODE)
    const seen: string[] = []
    const off = onHostReadinessChange((h) => seen.push(h))
    const r = await refreshHostReadiness('devbox', { getConnection: () => conn, now: () => 1000 })
    off()
    // The default context reads config: its model (Opus 5.5 by default) sets the floor.
    expect(send).toHaveBeenCalledWith('host.preflight', { minClaudeVersion: '2.1.280' }, expect.any(Number))
    expect(r?.checkedAt).toBe(1000)
    expect(r?.problems.map((p) => p.kind)).toEqual(['claude_needs_node', 'compiler_missing'])
    expect(getHostReadiness('devbox')).toEqual(r)
    expect(seen).toEqual(['devbox'])
  })

  it('an old daemon without preflight-v1 is never asked and leaves no readiness', async () => {
    const { conn, send } = fakeConn(READY, [])
    expect(await refreshHostReadiness('devbox', { getConnection: () => conn })).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(getHostReadiness('devbox')).toBeUndefined()
  })

  it('a failed re-check keeps the previous answer, stamps the attempt with checkError, pushes, and never throws', async () => {
    let t = 1000
    const now = () => t
    await refreshHostReadiness('devbox', { getConnection: () => fakeConn(NPM_NO_NODE).conn, now })
    const before = getHostReadiness('devbox')!
    const seen: string[] = []
    const off = onHostReadinessChange((h) => seen.push(h))
    const broken: PreflightConnection = { hasCapability: () => true, send: async () => { throw new Error('daemon command timeout') } }
    t = 2000
    expect(await refreshHostReadiness('devbox', { getConnection: () => broken, now })).toBeNull()
    expect(getHostReadiness('devbox')).toEqual({ ...before, checkedAt: 2000, checkError: 'daemon command timeout' })
    t = 3000
    expect(await refreshHostReadiness('devbox', { getConnection: () => { throw new Error('pool gone') }, now })).toBeNull()
    t = 4000
    expect(await refreshHostReadiness('devbox', { getConnection: () => fakeConn({ ok: false, error: 'unknown command' }).conn, now })).toBeNull()
    off()
    expect(getHostReadiness('devbox')).toMatchObject({ problems: before.problems, claude: before.claude, checkedAt: 4000, checkError: 'unknown command' })
    expect(seen).toEqual(['devbox', 'devbox', 'devbox'])
    // The next good answer clears the error.
    t = 5000
    await refreshHostReadiness('devbox', { getConnection: () => fakeConn(READY).conn, now })
    expect(getHostReadiness('devbox')).toMatchObject({ checkedAt: 5000, problems: [] })
    expect(getHostReadiness('devbox')!.checkError).toBeUndefined()
  })

  it('a failure with no previous answer stores nothing (nothing on screen to update)', async () => {
    const broken: PreflightConnection = { hasCapability: () => true, send: async () => { throw new Error('boom') } }
    expect(await refreshHostReadiness('devbox', { getConnection: () => broken })).toBeNull()
    expect(getHostReadiness('devbox')).toBeUndefined()
  })

  it('never probes __local__ or a disconnected host', async () => {
    expect(await refreshHostReadiness('__local__', { getConnection: () => fakeConn(READY).conn })).toBeNull()
    expect(await refreshHostReadiness('devbox', { getConnection: () => null })).toBeNull()
  })

  it('two callers share one probe', async () => {
    const { conn, send } = fakeConn(READY)
    const [a, b] = await Promise.all([
      refreshHostReadiness('devbox', { getConnection: () => conn }),
      refreshHostReadiness('devbox', { getConnection: () => conn }),
    ])
    expect(a).toBe(b)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a healthy host is re-probed at most every 10 minutes unless forced; a host with problems every time', async () => {
    let t = 0
    const now = () => t
    const healthy = fakeConn(READY)
    await refreshHostReadiness('devbox', { getConnection: () => healthy.conn, now })
    t = 60_000
    await refreshHostReadiness('devbox', { getConnection: () => healthy.conn, now })
    expect(healthy.send).toHaveBeenCalledTimes(1)
    await refreshHostReadiness('devbox', { getConnection: () => healthy.conn, now, force: true })
    expect(healthy.send).toHaveBeenCalledTimes(2)

    const sick = fakeConn(NPM_NO_NODE)
    await refreshHostReadiness('marina', { getConnection: () => sick.conn, now })
    await refreshHostReadiness('marina', { getConnection: () => sick.conn, now })
    expect(sick.send).toHaveBeenCalledTimes(2)
  })
})

describe('wireHostReadiness', () => {
  it('probes a known host after its handshake, ignores __local__ and unknown keys, and re-pushes on change', async () => {
    let fire: ((host: string) => void) | null = null
    const onConnected = vi.fn((cb: (host: string) => void) => { fire = cb; return () => { fire = null } })
    const emit = vi.fn()
    const conn = fakeConn(READY).conn
    const refresh = vi.fn((host: string) => refreshHostReadiness(host, { getConnection: () => conn }))
    const off = wireHostReadiness({ onConnected, isKnownHost: (h) => h === 'devbox', emit, refresh })
    fire!('__local__')
    fire!('direct:ws://127.0.0.1:1')
    fire!('devbox')
    expect(refresh.mock.calls).toEqual([['devbox']])
    await refresh.mock.results[0].value
    expect(emit).toHaveBeenCalledWith('devbox')
    off()
    expect(fire).toBeNull()
  })
})

// ── Claude Code sign-in and the model's version floor ───────────────────────

const OPUS_55 = { minVersion: '2.1.280', model: 'Opus 5.5' }
const REMOTE = { hostLabel: 'devbox', sshTarget: 'dev@devbox.example.test', floorModel: 'Opus 5.5' }
const claude = (over: Record<string, unknown>) => parsePreflight({ ...READY, claude: { ...READY.claude, ...over } })!

describe('claude_outdated and claude_not_logged_in', () => {
  it('an outdated native build names both versions and offers `claude update`', () => {
    const p = claude({ version: '2.1.258', versionOk: false, minVersion: '2.1.280', installMethod: 'native', auth: 'ok' })
    expect(readinessProblems(p, REMOTE)).toEqual([{
      kind: 'claude_outdated', message: 'Claude Code on devbox is 2.1.258, but Opus 5.5 needs 2.1.280 or newer.', commands: ['claude update'],
    }])
  })

  it('each install method gets its own way to update, and an unknown one is never guessed at', () => {
    const line = (installMethod: string, extra: Record<string, unknown> = {}) =>
      readinessProblems(claude({ version: '2.1.258', versionOk: false, minVersion: '2.1.280', installMethod, ...extra }), REMOTE)[0]!
    expect(line('npm')).toMatchObject({ message: expect.stringContaining('It is the npm build'), commands: [INSTALL] })
    expect(line('homebrew').commands).toEqual(['brew upgrade claude-code'])
    const other = line('other', { path: '/home/dev/.wrappers/bin/claude' })
    expect(other.message).toBe('Claude Code on devbox is 2.1.258, but Opus 5.5 needs 2.1.280 or newer. It was not installed by the native installer,'
      + ' so update it the way it was installed (/home/dev/.wrappers/bin/claude).')
    expect(other.commands).toEqual([])
  })

  it('not signed in names the host and the exact ssh line (with -t: sign-in needs a terminal)', () => {
    expect(readinessProblems(claude({ auth: 'not-logged-in', versionOk: true }), { ...REMOTE, sshTarget: '-p 2222 dev@devbox.example.test' })).toEqual([{
      kind: 'claude_not_logged_in',
      message: 'Claude Code on devbox is not signed in. Run `ssh -t -p 2222 dev@devbox.example.test claude` once and sign in, then Check again.',
      commands: ['ssh -t -p 2222 dev@devbox.example.test claude'],
    }])
  })

  it('outdated and signed out at once: both lines, outdated first; an unknown sign-in says nothing', () => {
    const both = claude({ version: '2.1.258', versionOk: false, minVersion: '2.1.280', installMethod: 'native', auth: 'not-logged-in' })
    expect(readinessProblems(both, REMOTE).map((x) => x.kind)).toEqual(['claude_outdated', 'claude_not_logged_in'])
    expect(readinessProblems(claude({ auth: 'unknown', versionOk: true }), REMOTE)).toEqual([])
    // A claude that does not start is its own line: no sign-in or version guess on top.
    expect(readinessProblems(claude({ error: 'claude --version exited with code 1', auth: 'not-logged-in', versionOk: false }), REMOTE).map((x) => x.kind)).toEqual(['claude_error'])
  })

  it('this computer (the setup banner): its own wording, and no terminal lines', () => {
    const local = { local: true, floorModel: 'Opus 5.5' }
    const noCompiler = { compiler: { found: false }, dtach: { found: false } }
    expect(readinessProblems({ ...parsePreflight(READY)!, ...noCompiler, claude: { found: false } }, local))
      .toEqual([{ kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: [INSTALL] }])
    expect(readinessProblems({ ...claude({ auth: 'not-logged-in' }), ...noCompiler }, local)).toEqual([{
      kind: 'claude_not_logged_in', message: 'Claude Code is not signed in. Run `claude` once in a terminal and sign in.', commands: ['claude'],
    }])
    expect(readinessProblems(claude({ version: '2.1.258', versionOk: false, minVersion: '2.1.280', installMethod: 'native' }), local)[0]!.message)
      .toBe('Claude Code on this computer is 2.1.258, but Opus 5.5 needs 2.1.280 or newer.')
  })

  it('parsePreflight keeps the new fields and drops junk in them', () => {
    expect(claude({ auth: 'not-logged-in', authDetail: 'claude auth status: not logged in', versionOk: false, minVersion: '2.1.280', installMethod: 'native' }).claude)
      .toMatchObject({ auth: 'not-logged-in', authDetail: 'claude auth status: not logged in', versionOk: false, minVersion: '2.1.280', installMethod: 'native' })
    const junk = claude({ auth: 'maybe', versionOk: 'no', minVersion: '2.1.280; rm', installMethod: 'curl' }).claude
    for (const k of ['auth', 'versionOk', 'minVersion', 'installMethod']) expect(junk, k).not.toHaveProperty(k)
  })

  it('a daemon from before the floor check still gets compared, by the server', () => {
    const old = parsePreflight({ ...READY, claude: { ...READY.claude, version: '2.1.258' } })!
    expect(applyClaudeFloor(old, OPUS_55).claude).toMatchObject({ versionOk: false, minVersion: '2.1.280' })
    // The daemon's own answer wins, and no floor or no version changes nothing.
    expect(applyClaudeFloor(claude({ versionOk: true }), OPUS_55).claude.versionOk).toBe(true)
    expect(applyClaudeFloor(old, null)).toBe(old)
    expect(applyClaudeFloor(claude({ version: undefined }), OPUS_55).claude.versionOk).toBeUndefined()
  })

  it('the floor table: Opus 5.5 by any provider id needs 2.1.280; other models need nothing', () => {
    for (const id of ['global.anthropic.claude-opus-5-5', 'claude-opus-5-5', 'us.anthropic.claude-opus-5-5[1m]', 'anthropic/claude-opus-5.5']) {
      expect(claudeCliFloorFor(id), id).toEqual(OPUS_55)
    }
    for (const id of ['global.anthropic.claude-opus-5', 'claude-opus-4-8', 'claude-opus-5-50', 'fable', '', undefined]) expect(claudeCliFloorFor(id), String(id)).toBeNull()
    expect(claudeVersionAtLeast('2.1.280', '2.1.280')).toBe(true)
    expect(claudeVersionAtLeast('2.1.258', '2.1.280')).toBe(false)
    expect(claudeVersionAtLeast(undefined, '2.1.280')).toBeNull()
  })

  it('refreshHostReadiness sends the floor, words the lines with the host context, and logs nothing secret', async () => {
    const { conn, send } = fakeConn({ ...READY, claude: { ...READY.claude, version: '2.1.258', auth: 'not-logged-in', installMethod: 'native' } })
    const r = await refreshHostReadiness('devbox', {
      getConnection: () => conn,
      hostContext: async () => ({ label: 'Dev box', sshTarget: 'dev@devbox.example.test', floor: OPUS_55 }),
    })
    expect(send).toHaveBeenCalledWith('host.preflight', { minClaudeVersion: '2.1.280' }, expect.any(Number))
    // An old daemon answered without versionOk: the server compared 2.1.258 itself.
    expect(r?.claude).toMatchObject({ versionOk: false, minVersion: '2.1.280' })
    expect(r?.problems.map((x) => x.message)).toEqual([
      'Claude Code on Dev box is 2.1.258, but Opus 5.5 needs 2.1.280 or newer.',
      'Claude Code on Dev box is not signed in. Run `ssh -t dev@devbox.example.test claude` once and sign in, then Check again.',
    ])
    // No floor: nothing is sent, nothing is compared.
    const plain = fakeConn(READY)
    await refreshHostReadiness('marina', { getConnection: () => plain.conn, hostContext: async () => ({ label: 'marina', sshTarget: 'marina', floor: null }) })
    expect(plain.send).toHaveBeenCalledWith('host.preflight', {}, expect.any(Number))
  })

  it('sshTargetText is what the user types after ssh', () => {
    expect(sshTargetText({ hostname: 'devbox.example.test', user: 'dev', port: 2222 }, 'devbox')).toBe('-p 2222 dev@devbox.example.test')
    expect(sshTargetText({ hostname: 'devbox.example.test', port: 22 }, 'devbox')).toBe('devbox.example.test')
    expect(sshTargetText(undefined, 'devbox')).toBe('devbox')
  })
})
