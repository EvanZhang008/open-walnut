/**
 * After a compaction, a session whose stored prompt is far behind is respawned on its current
 * prompt once it is quiet, when that costs less than restating it (src/core/sessions/prompt-refresh-respawn.ts).
 * 2026-11-11, the org review: the Walnut VP was restated about 33 KB after each compaction for weeks.
 * The deps are fakes: no CLI, no daemon, no clock but the fake one.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventNames } from '../../../src/core/event-bus.js'
import { PromptRefreshRespawn, respawnSkipReason, type PromptRefreshRespawnDeps } from '../../../src/core/sessions/prompt-refresh-respawn.js'
import { beginQuietTurn, noteQuietTurnSettled, resetQuietTurnsForTest } from '../../../src/core/sessions/quiet-turn.js'
import type { SessionRecord, Task } from '../../../src/core/types.js'

const SID = 'aaaaaaaa-1111-4222-8333-444444444444'
const NOW = Date.parse('2026-11-11T18:33:00Z')
const iso = (ms: number) => new Date(NOW + ms).toISOString()
const DEBT = 33_000

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: SID, taskId: 'mvm0n3bu-6910', project: 'Walnut', process_status: 'idle', engine: 'claude',
    appliedAppendSystemPrompt: 'old prompt', lastCompactUuid: 'boundary-1', lastCompactAt: iso(-60_000),
    ...over,
  } as SessionRecord
}
const vpTask = { id: 'mvm0n3bu-6910', title: 'Walnut VP', phase: 'IN_PROGRESS', org_role: 'lead' } as unknown as Task

function harness(over: Partial<PromptRefreshRespawnDeps> = {}, rec: SessionRecord = record()) {
  let current: SessionRecord | null = rec
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const saved: Array<Partial<SessionRecord>> = []
  const live = { promptCache: { tokens: 192_036, ttlMs: 3_600_000, requestAt: iso(-30_000), expiresAt: iso(3_570_000) } as SessionRecord['promptCache'], inTurn: false as boolean | null, outliving: 0, asking: 0 }
  const deps: PromptRefreshRespawnDeps = {
    now: () => NOW,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t as never },
    clearTimer: (t) => { (t as unknown as { cleared: boolean }).cleared = true },
    quietMs: 20_000,
    getSession: async () => current,
    saveSession: async (_id, updates) => { saved.push(updates); current = { ...current!, ...updates } },
    getTask: async () => vpTask,
    live: () => live,
    queued: async () => 0,
    statusQuestion: () => false,
    idleCompactionArmed: () => false,
    orgOffFor: async () => false,
    respawn: vi.fn(async () => 'respawned' as const),
    emitNote: vi.fn(),
    refreshInputs: async () => {},
    debtBytes: () => debt,
    folderDue: async () => false,
    ...over,
  }
  const pr = new PromptRefreshRespawn(deps)
  const fireAll = async () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  }
  return { pr, deps, saved, live, timers, fireAll, set: (r: SessionRecord | null) => { current = r }, get: () => current }
}

const result = (extra: Record<string, unknown> = {}) => ({ name: EventNames.SESSION_RESULT, data: { sessionId: SID, ...extra }, source: 'session-runner' }) as never

let debt = DEBT
beforeEach(() => {
  resetQuietTurnsForTest()
  debt = DEBT
})

describe('a clean turn end after a compaction', () => {
  it('respawns the session on its current prompt once it stayed quiet, and records it for that boundary', async () => {
    const h = harness()
    await h.pr.onTurnEnd(SID)
    expect(h.timers.map((t) => t.ms)).toEqual([20_000])
    await h.fireAll()
    expect(h.deps.respawn).toHaveBeenCalledTimes(1)
    expect(h.get()!.promptRefresh).toMatchObject({ compactUuid: 'boundary-1', outcome: 'respawned', debtBytes: DEBT, rewriteTokens: 192_036 })
    expect(h.deps.emitNote).toHaveBeenCalledWith(SID, 'mvm0n3bu-6910', expect.stringContaining('current instructions'))
    // The same boundary is never tried again.
    await h.pr.onTurnEnd(SID)
    expect(h.timers).toEqual([])
  })

  it('a session that never compacted, or a boundary already decided, arms nothing', async () => {
    const h = harness({}, record({ lastCompactUuid: undefined, lastCompactAt: undefined }))
    h.live.promptCache = { ...h.live.promptCache!, compactedAt: undefined }
    await h.pr.onTurnEnd(SID)
    expect(h.timers).toEqual([])
    const d = harness({}, record({ promptRefresh: { compactUuid: 'boundary-1', at: iso(0), outcome: 'not-worth', debtBytes: DEBT } }))
    await d.pr.onTurnEnd(SID)
    expect(d.timers).toEqual([])
  })

  it('a compaction the record has not learnt yet (a /compact turn: the boundary lands after the result) still arms; it is read at fire', async () => {
    const h = harness({}, record({ lastCompactUuid: 'boundary-0', lastCompactAt: iso(-3_600_000), promptRefresh: { compactUuid: 'boundary-0', at: iso(-3_600_000), outcome: 'current', debtBytes: 0 } }))
    h.live.promptCache = { tokens: 18_000, ttlMs: 3_600_000, requestAt: iso(-1_000), expiresAt: iso(3_599_000), compactedAt: iso(-1_000) }
    await h.pr.onTurnEnd(SID)
    expect(h.timers).toHaveLength(1)
    h.set(record({ lastCompactUuid: 'boundary-2', lastCompactAt: iso(0) }))
    await h.fireAll()
    // Nothing read since the compaction: free, so it respawns.
    expect(h.get()!.promptRefresh).toMatchObject({ compactUuid: 'boundary-2', outcome: 'respawned', rewriteTokens: 0 })
  })

  it('a rewrite that would cost more than the restatements it saves is recorded as not worth it, and not asked again', async () => {
    const h = harness()
    h.live.promptCache = { ...h.live.promptCache!, tokens: 300_000 }
    await h.pr.onTurnEnd(SID)
    await h.fireAll()
    expect(h.deps.respawn).not.toHaveBeenCalled()
    expect(h.get()!.promptRefresh).toMatchObject({ outcome: 'not-worth', compactUuid: 'boundary-1' })
    await h.pr.onTurnEnd(SID)
    expect(h.timers).toEqual([])
  })

  it('a prompt that lacks nothing is recorded as current, so later turn ends cost nothing', async () => {
    debt = 0
    const h = harness()
    await h.pr.onTurnEnd(SID)
    await h.fireAll()
    expect(h.deps.respawn).not.toHaveBeenCalled()
    expect(h.get()!.promptRefresh).toMatchObject({ outcome: 'current' })
  })

  it('a turn that did not end clean arms nothing and disarms a timer', async () => {
    const h = harness()
    await h.pr.onTurnEnd(SID)
    for (const extra of [{ isError: true }, { interrupted: true }, { backgroundActive: true }, { teamActive: true }]) {
      h.pr.handleEvent(result(extra))
    }
    expect(h.timers[0].cleared).toBe(true)
  })
})

describe('a VP or lead still running in a repository (org-own-folder.ts)', () => {
  /** Outside its own folder until a respawn has run (the spawn moves it). */
  const outside = (h: () => { deps: PromptRefreshRespawnDeps }) => vi.fn(async () => (h().deps.respawn as ReturnType<typeof vi.fn>).mock.calls.length === 0)

  it('respawns where the cost rule alone says it is not worth it (2026-11-12: 429K of context, 31 KB of prompt debt), and says it moved', async () => {
    let ref: ReturnType<typeof harness>
    const h = ref = harness({ folderDue: outside(() => ref) })
    h.live.promptCache = { ...h.live.promptCache!, tokens: 429_000 }
    await h.pr.onTurnEnd(SID)
    await h.fireAll()
    expect(h.deps.respawn).toHaveBeenCalledWith(SID, expect.any(Function), { folder: true })
    expect(h.get()!.promptRefresh).toMatchObject({ outcome: 'respawned', compactUuid: 'boundary-1' })
    expect(h.deps.emitNote).toHaveBeenCalledWith(SID, 'mvm0n3bu-6910', expect.stringContaining('its own folder'))
  })

  it('respawns with its prompt current too, since the folder alone pays', async () => {
    debt = 0
    let ref: ReturnType<typeof harness>
    const h = ref = harness({ folderDue: outside(() => ref) })
    await h.pr.onTurnEnd(SID)
    await h.fireAll()
    expect(h.deps.respawn).toHaveBeenCalledWith(SID, expect.any(Function), { folder: true })
    expect(h.get()!.promptRefresh).toMatchObject({ outcome: 'respawned', debtBytes: 0 })
  })

  it('keeps every quiet-moment guard: a queued message or a running background command holds it, nothing decided', async () => {
    const q = harness({ folderDue: async () => true, queued: async () => 1 })
    await q.pr.onTurnEnd(SID)
    await q.fireAll()
    expect(q.deps.respawn).not.toHaveBeenCalled()
    expect(q.get()!.promptRefresh).toBeUndefined()
    const b = harness({ folderDue: async () => true })
    b.live.outliving = 1
    await b.pr.onTurnEnd(SID)
    await b.fireAll()
    expect(b.deps.respawn).not.toHaveBeenCalled()
    expect(b.get()!.promptRefresh).toBeUndefined()
  })

  it('a spawn that left it in place (its host did not answer) is not told as moved', async () => {
    const h = harness({ folderDue: async () => true })
    h.live.promptCache = { ...h.live.promptCache!, tokens: 429_000 }
    await h.pr.onTurnEnd(SID)
    await h.fireAll()
    expect(h.deps.respawn).toHaveBeenCalledTimes(1)
    expect(h.deps.emitNote).toHaveBeenCalledWith(SID, 'mvm0n3bu-6910', expect.not.stringContaining('its own folder'))
  })

  it('a respawn that changed neither the prompt nor the folder writes no note (never "lacked 0 KB")', async () => {
    debt = 0
    const h = harness({ folderDue: async () => true })
    await h.pr.onTurnEnd(SID)
    await h.fireAll()
    expect(h.deps.respawn).toHaveBeenCalledTimes(1)
    expect(h.deps.emitNote).not.toHaveBeenCalled()
  })
})

describe('nothing is cut by the respawn', () => {
  it('a send in the quiet time disarms it; nothing is recorded, so the next turn end asks again', async () => {
    const h = harness()
    await h.pr.onTurnEnd(SID)
    h.pr.handleEvent({ name: EventNames.SESSION_SEND, data: { sessionId: SID }, source: 'ui' } as never)
    expect(h.timers[0].cleared).toBe(true)
    expect(h.get()!.promptRefresh).toBeUndefined()
  })

  it('a send while the respawn is on its way makes it give way; the context stays undecided', async () => {
    let wanted: (() => boolean) | undefined
    const h = harness({
      respawn: vi.fn(async (_id: string, stillWanted: () => boolean) => {
        wanted = stillWanted
        h.pr.handleEvent({ name: EventNames.SESSION_SEND, data: { sessionId: SID }, source: 'ui' } as never)
        return stillWanted() ? 'respawned' as const : 'gave-way' as const
      }),
    })
    await h.pr.onTurnEnd(SID)
    await h.fireAll()
    expect(wanted?.()).toBe(false)
    expect(h.get()!.promptRefresh).toBeUndefined()
    expect(h.deps.emitNote).not.toHaveBeenCalled()
  })

  it('a failed respawn is recorded for that boundary and never retried on it', async () => {
    const h = harness({ respawn: vi.fn(async () => { throw new Error('host gone') }) })
    await h.pr.onTurnEnd(SID)
    await h.fireAll()
    expect(h.get()!.promptRefresh).toMatchObject({ outcome: 'failed', error: 'host gone' })
    await h.pr.onTurnEnd(SID)
    expect(h.timers).toEqual([])
  })

  it.each([
    ['turn-running', (h: ReturnType<typeof harness>) => { h.live.inTurn = true }],
    ['no-runner', (h: ReturnType<typeof harness>) => { h.live.inTurn = null }],
    ['work-outlives-turn', (h: ReturnType<typeof harness>) => { h.live.outliving = 1 }],
  ])('%s: skipped, nothing recorded', async (why, setup) => {
    const h = harness()
    setup(h)
    await h.pr.onTurnEnd(SID)
    expect(await h.pr.fire(SID, String(NOW))).toBe(why)
    expect(h.deps.respawn).not.toHaveBeenCalled()
    expect(h.get()!.promptRefresh).toBeUndefined()
  })

  it('queued messages, an open prompt, a quiet turn, an armed idle compaction, a completed task, an org that is off: skipped', async () => {
    const base = {
      rec: record(), task: vpTask, boundary: 'boundary-1', live: { inTurn: false, outliving: 0, asking: 0 },
      queued: 0, quietTurn: false, idleCompactionArmed: false, orgOff: false, statusQuestion: false,
    }
    expect(respawnSkipReason(base)).toBeNull()
    expect(respawnSkipReason({ ...base, queued: 1 })).toBe('messages-queued')
    expect(respawnSkipReason({ ...base, rec: record({ pendingPermission: { requestId: 'x' } } as never) })).toBe('prompt-open')
    expect(respawnSkipReason({ ...base, quietTurn: true })).toBe('quiet-turn')
    expect(respawnSkipReason({ ...base, statusQuestion: true })).toBe('asking')
    expect(respawnSkipReason({ ...base, live: { ...base.live, asking: 1 } })).toBe('asking')
    expect(respawnSkipReason({ ...base, idleCompactionArmed: true })).toBe('idle-compaction-armed')
    expect(respawnSkipReason({ ...base, task: { ...vpTask, phase: 'COMPLETE' } as Task })).toBe('task-complete')
    expect(respawnSkipReason({ ...base, orgOff: true })).toBe('org-off')
    expect(respawnSkipReason({ ...base, rec: record({ process_status: 'stopped' }) })).toBe('status-stopped')
    expect(respawnSkipReason({ ...base, rec: record({ lane: 'chat' } as never) })).toBe('not-refreshable')
    expect(respawnSkipReason({ ...base, rec: record({ engine: 'codex' } as never) })).toBe('not-refreshable')
    expect(respawnSkipReason({ ...base, rec: record({ stopRequest: { state: 'pending' } } as never) })).toBe('stop-pending')
    expect(respawnSkipReason({ ...base, boundary: 'boundary-0' })).toBe('newer-boundary')
  })

  it('the turn-end status question still on its way is waited for (it has no turn end of its own), a few times at most', async () => {
    let asking = true
    const h = harness({ statusQuestion: () => asking })
    await h.pr.onTurnEnd(SID)
    await h.fireAll()
    expect(h.deps.respawn).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(1)
    asking = false
    await h.fireAll()
    expect(h.deps.respawn).toHaveBeenCalledTimes(1)
    // One that never ends gives up after its retries, with nothing recorded.
    const stuck = harness({ statusQuestion: () => true })
    await stuck.pr.onTurnEnd(SID)
    for (let i = 0; i < 6; i++) await stuck.fireAll()
    expect(stuck.timers).toEqual([])
    expect(stuck.deps.respawn).not.toHaveBeenCalled()
    expect(stuck.get()!.promptRefresh).toBeUndefined()
  })

  it('a quiet turn running (an idle /compact) holds it; once its result came it does not (the free case)', async () => {
    const h = harness()
    await h.pr.onTurnEnd(SID)
    beginQuietTurn(SID, 'idle-compact', 'idle-compact', Date.now())
    expect(await h.pr.fire(SID, String(NOW))).toBe('quiet-turn')
    // Its result: the quiet turn stays known for 60 s of readers, but it no longer runs.
    noteQuietTurnSettled(SID)
    await h.pr.onTurnEnd(SID)
    expect(await h.pr.fire(SID, String(NOW))).toBe('respawned')
  })

  it('a send that comes while the turn end reads the record still cancels it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const h = harness()
    const getSession = h.deps.getSession
    h.deps.getSession = async (id) => { await gate; return getSession(id) }
    h.pr.handleEvent(result())
    h.pr.handleEvent({ name: EventNames.SESSION_SEND, data: { sessionId: SID }, source: 'context-recovery' } as never)
    release()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.timers).toEqual([])
  })

  it('a context-full recovery compacting holds it', () => {
    expect(respawnSkipReason({
      rec: record({ contextRecovery: { state: 'compacting', at: iso(0), attempts: [] } } as never), task: vpTask, boundary: 'boundary-1',
      live: { inTurn: false, outliving: 0, asking: 0 }, queued: 0, quietTurn: false, idleCompactionArmed: false, orgOff: false, statusQuestion: false,
    })).toBe('context-recovery')
  })

  it('WALNUT_PROMPT_REFRESH_RESPAWN=0 turns it off', async () => {
    process.env.WALNUT_PROMPT_REFRESH_RESPAWN = '0'
    try {
      const h = harness()
      await h.pr.onTurnEnd(SID)
      expect(h.timers).toEqual([])
    } finally { delete process.env.WALNUT_PROMPT_REFRESH_RESPAWN }
  })
})
