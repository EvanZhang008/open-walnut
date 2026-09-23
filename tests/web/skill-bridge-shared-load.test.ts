/**
 * The "/" palette's skill list is one 1.2MB GET. A page load used to ask for it
 * three times (commands/index.ts, the plugin loader's first run, the first socket
 * connect), each holding one of the browser's six connections for up to 11s while
 * the task list and the draft's quick folders queued behind them (2026-09-23).
 *
 * skill-bridge now shares reads: callers that arrive while a read is still queued
 * join it (it has not been answered yet, so it sees their change too); callers
 * that arrive once it is on the wire get ONE shared read after it. A caller can
 * say WHEN its change happened (`changedAt`, the plugin loader stamps the socket
 * connect): a read that left after that moment already covers it, so the first
 * connect of a page load reuses index.ts's read instead of adding one. The read also
 * asks for the low-priority admission lane (see tests/web/api-client-admission).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/skills', () => ({ fetchSkills: vi.fn() }))

import { fetchSkills, type SkillInfo } from '../../web/src/api/skills.js'
import { loadSkillCommands, refreshSkillCommands, resetSkillBridgeForTesting } from '../../web/src/commands/skill-bridge.js'
import { getCommand, removeOwner } from '../../web/src/commands/registry.js'

function skill(name: string): SkillInfo {
  return {
    dirName: name, name, description: `${name} skill`, source: 'walnut',
    location: `/skills/${name}/SKILL.md`, content: '', eligible: true, enabled: true, hasReferences: false,
  }
}

interface Call { opts?: { priority?: 'low'; onDispatch?: () => void }; resolve: (s: SkillInfo[]) => void; reject: (e: Error) => void }
let calls: Call[] = []

beforeEach(() => {
  // A fresh page: no answer installed, nothing in flight, no recorded requests.
  resetSkillBridgeForTesting()
  calls = []
  vi.mocked(fetchSkills).mockImplementation((opts) => new Promise<SkillInfo[]>((resolve, reject) => {
    calls.push({ opts, resolve, reject })
  }))
})

afterEach(async () => {
  // Settle anything still open so no load leaks into the next test.
  while (calls.some((c) => c.resolve)) {
    for (const c of calls.splice(0)) c.resolve([])
    await flush()
  }
  removeOwner('skill')
  vi.clearAllMocks()
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('skill-bridge shared reads', () => {
  it('asks for the low-priority lane', async () => {
    const done = loadSkillCommands()
    expect(calls).toHaveLength(1)
    expect(calls[0].opts?.priority).toBe('low')
    expect(typeof calls[0].opts?.onDispatch).toBe('function')
    calls[0].resolve([skill('alpha')])
    await done
    expect(getCommand('alpha')?.source).toBe('skill')
  })

  it('callers that arrive while the read is still queued share that one read', async () => {
    const a = loadSkillCommands()
    const b = refreshSkillCommands()
    const c = loadSkillCommands()
    expect(calls).toHaveLength(1)

    calls[0].opts!.onDispatch!()
    calls[0].resolve([skill('alpha')])
    await Promise.all([a, b, c])
    await flush()
    // No trailing read: nobody asked after the request left.
    expect(calls).toHaveLength(1)
    expect(getCommand('alpha')?.source).toBe('skill')
  })

  it('callers that arrive once the read is on the wire get ONE shared read after it', async () => {
    const first = loadSkillCommands()
    calls[0].opts!.onDispatch!()

    // Three callers (e.g. a plugin install + two socket reconnects) while the
    // first read is in flight: its answer may predate their change.
    const late = [refreshSkillCommands(), refreshSkillCommands(), loadSkillCommands()]
    expect(calls).toHaveLength(1)

    calls[0].resolve([skill('old')])
    await first
    await flush()
    // Exactly one more read, started only after the first one finished.
    expect(calls).toHaveLength(2)
    expect(getCommand('old')?.source).toBe('skill')

    calls[1].opts!.onDispatch!()
    calls[1].resolve([skill('new')])
    await Promise.all(late)
    await flush()
    expect(calls).toHaveLength(2)
    // The later read replaced the entries atomically.
    expect(getCommand('new')?.source).toBe('skill')
    expect(getCommand('old')).toBeUndefined()
  })

  it('a failed read keeps the entries the palette already has, and the next load asks again', async () => {
    const ok = loadSkillCommands()
    calls[0].resolve([skill('kept')])
    await ok
    await flush()

    const failing = refreshSkillCommands()
    calls[1].reject(new Error('pool saturated'))
    await failing
    await flush()
    expect(getCommand('kept')?.source).toBe('skill')

    const retry = loadSkillCommands()
    await flush()
    expect(calls).toHaveLength(3)
    calls[2].resolve([skill('fresh')])
    await retry
    expect(getCommand('fresh')?.source).toBe('skill')
    expect(getCommand('kept')).toBeUndefined()
  })

  it('a change stamped BEFORE the installed read left needs no read at all', async () => {
    // Page load: the socket connects at `connectedAt`, index.ts's read leaves after it.
    const connectedAt = performance.now()
    const boot = loadSkillCommands()
    calls[0].opts!.onDispatch!()
    calls[0].resolve([skill('alpha')])
    await boot
    await flush()

    // The plugin loader's first-connect refresh arrives with the connect's stamp.
    await refreshSkillCommands({ changedAt: connectedAt })
    await flush()
    expect(calls).toHaveLength(1)
    // An unstamped refresh (a plugin install happening now) still reads.
    const now = refreshSkillCommands()
    expect(calls).toHaveLength(2)
    calls[1].resolve([skill('alpha')])
    await now
  })

  it('a stamped change joins an in-flight read that left after it, and trails one that left before it', async () => {
    const before = performance.now()
    const first = loadSkillCommands()
    calls[0].opts!.onDispatch!()
    // Left after `before`: joining it is enough.
    const joined = refreshSkillCommands({ changedAt: before })
    expect(calls).toHaveLength(1)

    // Stamped after the read left: that read may predate the change.
    await new Promise((r) => setTimeout(r, 2))
    const trailed = refreshSkillCommands({ changedAt: performance.now() })
    calls[0].resolve([skill('old')])
    await Promise.all([first, joined])
    await flush()
    expect(calls).toHaveLength(2)
    calls[1].resolve([skill('new')])
    await trailed
    expect(getCommand('new')?.source).toBe('skill')
  })

  it('a stamped change after a FAILED read still reads (nothing covers it)', async () => {
    const connectedAt = performance.now()
    const boot = loadSkillCommands()
    calls[0].opts!.onDispatch!()
    calls[0].reject(new Error('server down'))
    await boot
    await flush()

    const retry = refreshSkillCommands({ changedAt: connectedAt })
    expect(calls).toHaveLength(2)
    calls[1].resolve([skill('alpha')])
    await retry
    expect(getCommand('alpha')?.source).toBe('skill')
  })
})
