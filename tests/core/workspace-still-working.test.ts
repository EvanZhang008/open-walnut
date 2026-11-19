/**
 * Is a completed task's work really over (src/core/workspaces/still-working.ts)?
 * The session store, the host's answers and the request ledger are fakes; the
 * cleanup paths that ask it are in workspace-scripts.test.ts.
 */
import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '../../src/core/types.js'
import { stillWorking as gate, type StillWorkingIo } from '../../src/core/workspaces/still-working.js'

/** The gate's reason, or null (the `soon` flag is checked on its own). */
const stillWorking = async (...a: Parameters<typeof gate>) => (await gate(...a))?.why ?? null

const rec = (sid: string, r: Partial<SessionRecord> = {}): SessionRecord => ({ claudeSessionId: sid, process_status: 'stopped', ...r } as SessionRecord)

function io(o: {
  sessions?: SessionRecord[]
  host?: Record<string, boolean | null>
  requests?: Array<{ id: string; fromSessionId: string; carriedBy?: unknown[] }>
  askers?: Record<string, { id: string; phase: string }>
  notProbeable?: string[]
} = {}): StillWorkingIo & { probed: string[] } {
  const probed: string[] = []
  return {
    probed,
    sessions: async () => o.sessions ?? [],
    probe: async (host, sid) => { probed.push(`${host}:${sid}`); const a = o.host?.[sid]; return a === null ? null : { alive: a === true } },
    probeable: (s) => !(o.notProbeable ?? []).includes(s.claudeSessionId),
    pendingRequests: async () => o.requests ?? [],
    askerTask: async (sid) => o.askers?.[sid] ?? null,
  }
}

const task = { id: 't1' }
const local = { root: '/w/repo/x' }

describe('stillWorking', () => {
  it('over: no sessions, nothing owed', async () => {
    expect(await stillWorking(task, local, io())).toBeNull()
  })

  it('a record that says running or idle is enough, without asking the host', async () => {
    const x = io({ sessions: [rec('a', { process_status: 'idle' })] })
    expect(await stillWorking(task, local, x)).toMatch(/session a is idle/)
    expect(x.probed).toEqual([])
  })

  it('a record that says stopped is checked with the host: alive, or cannot say, both hold it', async () => {
    expect(await stillWorking(task, local, io({ sessions: [rec('a')], host: { a: true } }))).toMatch(/still runs on the host \(its record says stopped\)/)
    expect(await stillWorking(task, local, io({ sessions: [rec('a')], host: { a: null } }))).toMatch(/could not say/)
    expect(await stillWorking(task, local, io({ sessions: [rec('a')], host: { a: false } }))).toBeNull()
  })

  it('asks each session\'s own host (the Mac for none); archived ones and engines it cannot ask about are left to their record', async () => {
    const x = io({
      sessions: [
        rec('here', { host: 'clouddev' }), rec('mac', { host: null as unknown as string }), rec('l', { host: 'local' }),
        rec('old', { host: 'clouddev', archived: true }), rec('acp', { host: 'clouddev' }),
      ],
      notProbeable: ['acp'],
    })
    expect(await stillWorking(task, local, x)).toBeNull()
    expect(x.probed.sort()).toEqual(['__local__:l', '__local__:mac', 'clouddev:here'])
  })

  it('a record that turned stopped moments ago while its process still runs is a stop on its way (look again soon)', async () => {
    const now = Date.parse('2026-11-19T01:33:21Z')
    const fresh = rec('a', { last_status_change: '2026-11-19T01:33:20Z' })
    expect(await gate(task, local, io({ sessions: [fresh], host: { a: true } }), { now })).toMatchObject({ soon: true })
    const old = rec('a', { last_status_change: '2026-11-18T23:46:37Z' })
    expect((await gate(task, local, io({ sessions: [old], host: { a: true } }), { now }))?.soon).toBeUndefined()
    expect((await gate(task, local, io({ sessions: [fresh], host: { a: null } }), { now }))?.soon).toBeUndefined()
  })

  it('a session that moved to another host and still runs there holds it', async () => {
    expect(await stillWorking(task, local, io({ sessions: [rec('moved', { host: 'other-mac' })], host: { moved: true } }))).toMatch(/moved/)
  })

  it('asks about the most recently active sessions first, at most twelve', async () => {
    const sessions = Array.from({ length: 20 }, (_, i) => rec(`s${String(i).padStart(2, '0')}`, { lastActiveAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z` }))
    const x = io({ sessions })
    await stillWorking(task, local, x)
    expect(x.probed).toHaveLength(12)
    expect(x.probed[0]).toBe('__local__:s19')
  })

  it('an unanswered request holds it, unless its asker is done, it was handed on, or the task asked itself', async () => {
    const owed = io({ requests: [{ id: 'rq-1', fromSessionId: 'lead' }], askers: { lead: { id: 'L', phase: 'IN_PROGRESS' } } })
    expect(await stillWorking(task, local, owed)).toBe('it owes an answer to rq-1')
    expect(await stillWorking(task, local, owed, { requests: false })).toBeNull()
    expect(await stillWorking(task, local, io({ requests: [{ id: 'rq-1', fromSessionId: 'lead' }], askers: { lead: { id: 'L', phase: 'COMPLETE' } } }))).toBeNull()
    expect(await stillWorking(task, local, io({ requests: [{ id: 'rq-1', fromSessionId: 'lead', carriedBy: [{ id: 'rq-2' }] }], askers: { lead: { id: 'L', phase: 'IN_PROGRESS' } } }))).toBeNull()
    expect(await stillWorking(task, local, io({ requests: [{ id: 'rq-1', fromSessionId: 'me' }], askers: { me: { id: 't1', phase: 'COMPLETE' } } }))).toBeNull()
    // An asker nobody can place still waits.
    expect(await stillWorking(task, local, io({ requests: [{ id: 'rq-1', fromSessionId: 'ghost' }] }))).toBe('it owes an answer to rq-1')
  })
})
