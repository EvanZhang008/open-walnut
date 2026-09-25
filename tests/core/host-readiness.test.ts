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
  wireHostReadiness,
  type PreflightConnection,
} from '../../src/core/hosts/host-readiness.js'

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
    expect(send).toHaveBeenCalledWith('host.preflight', {}, expect.any(Number))
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
