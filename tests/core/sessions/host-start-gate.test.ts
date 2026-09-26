/**
 * The Start gate (host-start-gate.ts): C3 (blocking readiness -> 409 whose error
 * is the problem sentence), C46 (a failed host is redialled first and a success
 * goes on), C47 (a failure answers with the NEW attempt's kind, inside ~22s),
 * C53 (the floor and model name come from the launch's own model), C54
 * (allowOverride only for outdated / not signed in; overrideReadiness skips
 * exactly those), C56 (a blocking cached answer is re-checked first), plus
 * removed / off, automation (current frame only), the gate budget, and the
 * CLI-default floor for a launch with no model. Deps are injected; nothing dials.
 */
import { describe, it, expect, vi } from 'vitest'
import { hostStartGate, hostGateSourceFor, GATE_CONNECT_DEADLINE_MS, type HostStartGateDeps } from '../../../src/core/sessions/host-start-gate.js'
import { hostFailureHeadline } from '../../../src/core/hosts/host-problem.js'
import type { HostStatus } from '../../../src/core/hosts/host-status.js'
import type { HostReadiness } from '../../../src/core/hosts/host-readiness.js'

const def = { hostname: 'build.example.com', user: 'alice', label: 'Build box' }
const frame = (over: Partial<HostStatus> = {}): HostStatus => ({
  host: 'buildbox', label: 'Build box', hostname: def.hostname, connected: true, phase: 'connected', phaseLabel: '', steps: [],
  phaseElapsedMs: 0, connectElapsedMs: 0, at: 1, ...over,
} as HostStatus)
const OUTDATED = { kind: 'claude_outdated', message: 'Claude Code on Build box is 2.1.220, but Opus 5.5 needs 2.1.280 or newer.', commands: [] }
const readiness = (problems: Array<{ kind: string; message: string; commands: string[] }>) => ({ problems } as unknown as HostReadiness)

function deps(over: Partial<HostStartGateDeps> = {}): HostStartGateDeps {
  return {
    configDef: async () => def,
    frame: () => frame(),
    connect: vi.fn(async () => ({ httpStatus: 200, body: {}, outcome: 'connected' as const, status: frame() })),
    check: vi.fn(async () => null),
    readinessFor: () => readiness([]),
    cliDefaultModel: async () => undefined,
    ...over,
  }
}
const MISSING = { kind: 'claude_missing', message: 'Claude Code is not installed on Build box.', commands: ['x'] }

describe('hostStartGate', () => {
  it('local and healthy hosts go ahead, and a healthy host is neither redialled nor re-checked', async () => {
    expect(await hostStartGate({ host: '__local__' }, deps())).toBeNull()
    expect(await hostStartGate({ host: undefined }, deps())).toBeNull()
    const d = deps()
    expect(await hostStartGate({ host: 'buildbox' }, d)).toBeNull()
    expect(d.connect).not.toHaveBeenCalled()
    expect(d.check).not.toHaveBeenCalled()
  })

  it('Start anyway skips only the overridable kind: a later hard block still refuses', async () => {
    const d = deps({ readinessFor: () => readiness([OUTDATED, MISSING]) })
    expect(await hostStartGate({ host: 'buildbox', overrideReadiness: true }, d)).toMatchObject({ code: 'host_not_ready', kind: 'claude_missing' })
    expect((await hostStartGate({ host: 'buildbox' }, d))?.kind).toBe('claude_outdated')
  })

  it('no explicit model: the floor is the CLI\'s own default on that host, or no floor when unknown', async () => {
    const seen: Array<string | null> = []
    const readinessFor = (_h: string, m: string | null) => { seen.push(m); return readiness([]) }
    await hostStartGate({ host: 'buildbox' }, deps({ readinessFor, cliDefaultModel: async () => 'global.anthropic.claude-opus-5-5' }))
    await hostStartGate({ host: 'buildbox' }, deps({ readinessFor }))
    expect(seen).toEqual(['global.anthropic.claude-opus-5-5', null])
  })

  it('automation never redials a failed host: it is refused on the current frame, with no state reset', async () => {
    const d = deps({ frame: () => frame({ connected: false, phase: 'failed', kind: 'cert_expired', hint: 'Log in again.' }) })
    const body = await hostStartGate({ host: 'buildbox', source: 'automation' }, d)
    expect(body).toMatchObject({ code: 'host_unreachable', kind: 'cert_expired', headline: hostFailureHeadline('cert_expired', 'Build box'), hint: 'Log in again.' })
    expect(d.connect).not.toHaveBeenCalled()
  })

  it('automation reads a blocking readiness answer as it stands: no re-check', async () => {
    const d = deps({ readinessFor: () => readiness([OUTDATED]) })
    expect(await hostStartGate({ host: 'buildbox', source: 'automation' }, d)).toMatchObject({ code: 'host_not_ready', kind: 'claude_outdated' })
    expect(d.check).not.toHaveBeenCalled()
  })

  it('only a person\'s launch sources are human; every other source (and a new one) is automation', () => {
    for (const s of ['quick-start', 'mobile-launch', 'mobile-launch-bridge', 'cloud-exec-launch', 'notification-fix']) expect(hostGateSourceFor(s)).toBe('human')
    for (const s of ['routine', 'routine-watcher', 'routine-trigger', 'cron-isolated', 'subagent', 'something-new']) expect(hostGateSourceFor(s)).toBe('automation')
  })

  it('a caller budget caps the redial and leaves the re-check only what is left', async () => {
    let t = 0
    const connect = vi.fn(async () => { t += 9_000; return { httpStatus: 200, body: {}, outcome: 'connected' as const, status: frame() } })
    const d = deps({ now: () => t, connect, frame: () => frame({ connected: false, phase: 'failed', kind: 'auth' }), readinessFor: () => readiness([OUTDATED]) })
    await hostStartGate({ host: 'buildbox', deadlineMs: 10_000 }, d)
    expect(connect).toHaveBeenCalledWith('buildbox', { deadlineMs: 10_000 })
    expect(d.check).toHaveBeenCalledWith('buildbox', { deadlineMs: 1_000, force: true })
    // Budget spent: the cached answer decides, no re-check at all.
    t = 0
    const spent = deps({ now: () => t, connect: vi.fn(async () => { t += 10_000; return { httpStatus: 200, body: {}, outcome: 'connected' as const, status: frame() } }), frame: () => frame({ connected: false, phase: 'failed', kind: 'auth' }), readinessFor: () => readiness([OUTDATED]) })
    expect(await hostStartGate({ host: 'buildbox', deadlineMs: 10_000 }, spent)).toMatchObject({ code: 'host_not_ready' })
    expect(spent.check).not.toHaveBeenCalled()
  })

  it('C3 + C56: blocking readiness is re-checked once, then refused with the problem sentence', async () => {
    const d = deps({ readinessFor: () => readiness([OUTDATED]) })
    const body = await hostStartGate({ host: 'buildbox' }, d)
    expect(d.check).toHaveBeenCalledTimes(1)
    expect(d.check).toHaveBeenCalledWith('buildbox', { deadlineMs: 5_000, force: true })
    expect(body).toEqual({ error: OUTDATED.message, code: 'host_not_ready', kind: 'claude_outdated', host: 'buildbox', headline: OUTDATED.message, hint: '', allowOverride: true })
  })

  it('C56: a re-check that clears the problem lets the Start through', async () => {
    let answer = readiness([OUTDATED])
    const d = deps({ readinessFor: () => answer, check: vi.fn(async () => { answer = readiness([]); return null }) })
    expect(await hostStartGate({ host: 'buildbox' }, d)).toBeNull()
  })

  it('C54: claude_missing has no allowOverride and overrideReadiness does not skip it; outdated is skipped', async () => {
    const hard = await hostStartGate({ host: 'buildbox', overrideReadiness: true }, deps({ readinessFor: () => readiness([MISSING]) }))
    expect(hard).toMatchObject({ code: 'host_not_ready', kind: 'claude_missing' })
    expect(hard?.allowOverride).toBeUndefined()
    expect(await hostStartGate({ host: 'buildbox', overrideReadiness: true }, deps({ readinessFor: () => readiness([OUTDATED]) }))).toBeNull()
  })

  it('C53: the readiness is judged for the launch model', async () => {
    const seen: Array<string | null> = []
    await hostStartGate({ host: 'buildbox', model: 'claude-sonnet-4-5' }, deps({ readinessFor: (_h, m) => { seen.push(m); return readiness([]) } }))
    expect(seen).toEqual(['claude-sonnet-4-5'])
  })

  it('C46: a failed host is redialled with the 20s deadline, and a success goes on', async () => {
    const d = deps({ frame: () => frame({ connected: false, phase: 'failed', kind: 'cert_expired' }) })
    expect(await hostStartGate({ host: 'buildbox' }, d)).toBeNull()
    expect(d.connect).toHaveBeenCalledWith('buildbox', { deadlineMs: GATE_CONNECT_DEADLINE_MS })
    expect(GATE_CONNECT_DEADLINE_MS).toBe(20_000)
  })

  it('C47: a redial that fails answers with the NEW attempt kind, headline and hint', async () => {
    const fresh = frame({ connected: false, phase: 'failed', kind: 'timeout', hint: 'Connecting to Build box took too long.' })
    const d = deps({
      frame: () => frame({ connected: false, phase: 'failed', kind: 'auth', hint: 'old hint' }),
      connect: vi.fn(async () => ({ httpStatus: 200, body: {}, outcome: 'failed' as const, status: fresh })),
    })
    const body = await hostStartGate({ host: 'buildbox' }, d)
    expect(body).toMatchObject({ code: 'host_unreachable', kind: 'timeout', headline: hostFailureHeadline('timeout', 'Build box'), hint: 'Connecting to Build box took too long.' })
    expect(body?.error).toBe(`${hostFailureHeadline('timeout', 'Build box')}. Connecting to Build box took too long.`)
    expect(GATE_CONNECT_DEADLINE_MS).toBeLessThanOrEqual(22_000)
  })

  it('a removed or disabled host is host_removed; an off host is host_off with no dial', async () => {
    expect(await hostStartGate({ host: 'gone' }, deps({ configDef: async () => undefined }))).toMatchObject({ code: 'host_removed', error: 'This host is no longer in Settings.' })
    expect(await hostStartGate({ host: 'x' }, deps({ configDef: async () => ({ ...def, enabled: false }) }))).toMatchObject({ code: 'host_removed' })
    const d = deps({ frame: () => frame({ connected: false, phase: 'off' }) })
    expect(await hostStartGate({ host: 'buildbox' }, d)).toMatchObject({ code: 'host_off', error: 'Remote hosts are off on this test server.' })
    expect(d.connect).not.toHaveBeenCalled()
  })

  it('C75: no hint means no dangling punctuation in error', async () => {
    const fresh = frame({ connected: false, phase: 'failed', kind: 'auth', hint: '' })
    const body = await hostStartGate({ host: 'buildbox' }, deps({
      frame: () => fresh, connect: vi.fn(async () => ({ httpStatus: 200, body: {}, outcome: 'failed' as const, status: fresh })),
    }))
    expect(body?.error).toBe('Could not connect to Build box')
  })
})

// ── C49: quickStartSession runs the gate before ANY write ──

const spies = vi.hoisted(() => ({
  ensureProject: vi.fn(async () => ({ created: true })),
  addTask: vi.fn(async () => ({ task: { id: 't-new' } })),
  getTask: vi.fn(async () => ({ id: 't-old' })),
  updateTask: vi.fn(async () => ({})),
  setProjectMetadata: vi.fn(async () => ({})),
  emit: vi.fn(),
}))
vi.mock('../../../src/constants.js', async () => (await import('../../helpers/mock-constants.js')).createMockConstants())
vi.mock('../../../src/core/task-manager.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureProject: spies.ensureProject, addTask: spies.addTask, getTask: spies.getTask, updateTask: spies.updateTask,
  setProjectMetadata: spies.setProjectMetadata,
}))
vi.mock('../../../src/core/event-bus.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/event-bus.js')>()
  return { ...real, bus: new Proxy(real.bus, { get: (t, k) => (k === 'emit' ? spies.emit : Reflect.get(t, k)) }) }
})
vi.mock('../../../src/core/hosts/host-connect-action.js', () => ({
  configHostDef: async () => ({ hostname: 'build.example.com', user: 'alice', label: 'Build box' }),
  hostStatusFrame: () => ({ host: 'buildbox', connected: true, phase: 'connected' }),
  connectHostNow: vi.fn(),
  checkHostNow: vi.fn(async () => null),
}))
vi.mock('../../../src/core/hosts/host-readiness.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hostReadinessForLaunch: () => ({ problems: [OUTDATED] }),
}))

describe('C49: a refused Start writes nothing', () => {
  it.each([
    ['a new task', {}],
    ['a retry on an existing task', { existingTaskId: 't-old' }],
  ])('%s: 409 before ensureProject, addTask, getTask and TASK_CREATED', async (_name, extra) => {
    const { quickStartSession, QuickStartError } = await import('../../../src/core/sessions/quick-start.js')
    for (const s of Object.values(spies)) s.mockClear()
    const err = await quickStartSession({ message: 'hi', cwd: '/home/alice/work', host: 'buildbox', project: 'Work', source: 'test', ...extra } as never).catch((e) => e)
    expect(err).toBeInstanceOf(QuickStartError)
    expect(err.statusCode).toBe(409)
    expect(err.message).toBe(OUTDATED.message)
    expect(err.body).toMatchObject({ code: 'host_not_ready', kind: 'claude_outdated', host: 'buildbox', allowOverride: true })
    expect(spies.ensureProject).not.toHaveBeenCalled()
    expect(spies.addTask).not.toHaveBeenCalled()
    expect(spies.getTask).not.toHaveBeenCalled()
    expect(spies.setProjectMetadata).not.toHaveBeenCalled()
    expect(spies.emit.mock.calls.filter((c) => c[0] === 'task:created')).toHaveLength(0)
  })
})
