/**
 * A host repairs its own rows whose process is gone (src/core/session-channel/host-stale-repair.ts):
 * the leader's monitor skips a host-run session and no monitor runs on a replica, so without this a
 * CLI killed without a turn end reads `running` forever. Dead on two sweeps in a row, quiet, of an
 * engine whose liveness its id answers: written stopped. Anything else is left alone.
 */
import { describe, expect, it } from 'vitest'
import { createHostStaleRepair } from '../../../src/core/session-channel/host-stale-repair.js'
import type { SessionRecord } from '../../../src/core/types.js'

const NOW = Date.parse('2026-11-22T12:00:00.000Z')
const old = new Date(NOW - 60 * 60_000).toISOString()
const row = (sid: string, over: Partial<SessionRecord> = {}): SessionRecord =>
  ({ claudeSessionId: sid, process_status: 'running', lastActiveAt: old, engine: 'claude', ...over }) as SessionRecord

function harness(rows: SessionRecord[], dead: Set<string>) {
  const writes: Array<{ sid: string; patch: Partial<SessionRecord> }> = []
  const repair = createHostStaleRepair({
    ownRows: async () => rows,
    alive: async (r) => !dead.has(r.claudeSessionId),
    probes: (r) => r.engine !== 'codex',
    write: async (sid, patch) => { writes.push({ sid, patch }) },
    now: () => NOW,
  })
  return { repair, writes }
}

describe('the stale repair of a host\'s own rows', () => {
  it('writes stopped a row dead on two sweeps in a row, and only that one', async () => {
    const rows = [
      row('dead'), row('alive'), row('idle-dead', { process_status: 'idle' }),
      row('fresh-dead', { lastActiveAt: new Date(NOW - 30_000).toISOString() }),
      row('acp-dead', { engine: 'codex' as never }), row('stopped', { process_status: 'stopped' }),
      row('archived-dead', { archived: true }),
    ]
    const { repair, writes } = harness(rows, new Set(['dead', 'idle-dead', 'fresh-dead', 'acp-dead', 'stopped', 'archived-dead']))
    expect(await repair.sweep()).toEqual([])
    expect(writes).toEqual([])
    expect((await repair.sweep()).sort()).toEqual(['dead', 'idle-dead'])
    expect(writes.find((w) => w.sid === 'dead')!.patch).toMatchObject({ process_status: 'stopped', status_reason: 'liveness_check_failed', status_changed_by: 'system' })
  })

  it('a row alive again between two sweeps starts over', async () => {
    const dead = new Set(['flaky'])
    const { repair, writes } = harness([row('flaky')], dead)
    await repair.sweep()
    dead.clear()
    await repair.sweep()
    dead.add('flaky')
    await repair.sweep()
    expect(writes).toEqual([])
    await repair.sweep()
    expect(writes.map((w) => w.sid)).toEqual(['flaky'])
  })
})
