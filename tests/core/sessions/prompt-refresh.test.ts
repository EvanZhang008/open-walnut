/**
 * A cold resume runs on the current prompt when the stored one is far behind and replaying it
 * buys nothing (src/core/sessions/prompt-refresh.ts). 2026-11-06, the org reflection: a VP
 * spawned on a 3 KB prompt got 28 KB of "changed default instructions" after every compaction.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-prompt-refresh'))
// Each session prompt starts a background fleet read (hosts/fleet-prompt.ts) that opens the session
// store whenever it gets there; one landing while beforeEach wipes the data home failed that store's
// open for the rest of this file (2026-11-06, 3 of 4 batch runs).
process.env.WALNUT_FLEET_PROMPT_REFRESH = '0'
const role = vi.hoisted(() => ({ companion: false }))
vi.mock('../../../src/core/server-role.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/server-role.js')>()),
  isCompanion: () => role.companion,
  isFollower: () => role.companion, // the companion is a replica
}))
import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { buildSessionContext } from '../../../src/core/sessions/session-context.js'
import {
  MIN_REFRESH_DEBT_BYTES, ORG_NODE_REFRESH_HORIZON, TASK_CONTEXT_JOIN, freshResumePrompt, nothingReadSinceCompaction,
  promptDebtBytes, refreshHorizon, refreshOnResume, refreshPays, replayBuysNothing,
} from '../../../src/core/sessions/prompt-refresh.js'
import { instructionNoticeFor } from '../../../src/core/sessions/instruction-notice.js'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()
const expired = { tokens: 400_000, ttlMs: 3_600_000, requestAt: at(-2 * 3_600_000), expiresAt: at(-3_600_000) }
const warmBig = { tokens: 400_000, ttlMs: 3_600_000, requestAt: at(-60_000), expiresAt: at(3_540_000) }
const warmSmall = { tokens: 20_000, ttlMs: 3_600_000, requestAt: at(-60_000), expiresAt: at(3_540_000) }

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

/** A task session whose stored prompt is today's with most of its lines gone: spawned long ago. */
async function seed(keep = 0.25) {
  const { task } = await addTask({ title: 'Work', project: 'marina' })
  const sid = randomUUID()
  await createSessionRecord(sid, task.id, task.project, WALNUT_HOME)
  const current = (await buildSessionContext(task.id)).systemPrompt
  const lines = current.split('\n')
  const old = lines.slice(0, Math.max(3, Math.round(lines.length * keep))).join('\n')
  await updateSessionRecord(sid, { appliedAppendSystemPrompt: old })
  return { sid, task, current, old }
}

describe('replayBuysNothing', () => {
  it('an expired cache: yes; a warm one, large or small (the prompt and tools are cached too), or none known: no', () => {
    expect(replayBuysNothing(expired, NOW)).toBe(true)
    expect(replayBuysNothing(warmSmall, NOW)).toBe(false)
    expect(replayBuysNothing(warmBig, NOW)).toBe(false)
    expect(replayBuysNothing(undefined, NOW)).toBe(false)
    // A request that wrote some 5-minute entries reads as 5 minutes; its 1-hour ones still hold.
    const fiveMin = { tokens: 400_000, ttlMs: 300_000, requestAt: at(-10 * 60_000), expiresAt: at(-5 * 60_000) }
    expect(replayBuysNothing(fiveMin, NOW)).toBe(false)
    expect(replayBuysNothing({ ...fiveMin, requestAt: at(-3_600_000), expiresAt: at(-3_300_000) }, NOW)).toBe(true)
  })
})

describe('refreshOnResume', () => {
  it('a prompt behind, with nothing to replay: refresh; a warm cache, a lane, a current prompt: replay', async () => {
    const { sid, task, current } = await seed()
    const rec = (await getSessionByClaudeId(sid))!
    expect(promptDebtBytes(rec, task)).toBeGreaterThan(0)
    expect(refreshOnResume({ ...rec, promptCache: expired }, task, NOW)).toBe(true)
    expect(refreshOnResume({ ...rec, promptCache: warmBig }, task, NOW)).toBe(false)
    expect(refreshOnResume({ ...rec, promptCache: warmSmall }, task, NOW)).toBe(false)
    expect(refreshOnResume({ ...rec, promptCache: expired, lane: 'chat' }, task, NOW)).toBe(false)
    // A companion builds a thinner prompt (no Reply language, no fleet): the Mac's stays.
    role.companion = true
    try { expect(refreshOnResume({ ...rec, promptCache: expired }, task, NOW)).toBe(false) } finally { role.companion = false }
    expect(promptDebtBytes({ appliedAppendSystemPrompt: current }, task)).toBe(0)
    expect(refreshOnResume({ ...rec, appliedAppendSystemPrompt: current, promptCache: expired }, task, NOW)).toBe(false)
  })
})

describe('freshResumePrompt', () => {
  it('rebuilds the current prompt, a caller\'s own prompt in front kept', async () => {
    const { sid, current } = await seed()
    const rec = { ...(await getSessionByClaudeId(sid))!, promptCache: { ...expired, expiresAt: new Date(Date.now() - 1000).toISOString() } }
    expect(await freshResumePrompt(rec)).toBe(current)
    const withCaller = { ...rec, appliedAppendSystemPrompt: `Persona words.${TASK_CONTEXT_JOIN}${rec.appliedAppendSystemPrompt}` }
    expect(await freshResumePrompt(withCaller)).toBe(`Persona words.${TASK_CONTEXT_JOIN}${current}`)
    // A prompt Walnut did not build is never rebuilt.
    expect(await freshResumePrompt({ ...rec, appliedAppendSystemPrompt: 'Some other prompt.' })).toBeNull()
  })

  it('a warm large cache replays the stored prompt', async () => {
    const { sid } = await seed()
    await updateSessionRecord(sid, { promptCache: { ...warmBig, expiresAt: new Date(Date.now() + 3_000_000).toISOString() } })
    expect(await freshResumePrompt((await getSessionByClaudeId(sid))!)).toBeNull()
  })
})

describe('the instruction notice', () => {
  it('still goes to a stopped session the next spawn refreshes: a spawn may still replay (a host-side resume, a prompt too large)', async () => {
    const { sid, task } = await seed()
    const rec = (await getSessionByClaudeId(sid))!
    const cache = { ...expired, expiresAt: new Date(Date.now() - 1000).toISOString() }
    expect(instructionNoticeFor({ ...rec, promptCache: cache, process_status: 'stopped' } as typeof rec, task)).toContain('Walnut changed your default instructions')
  })
})

describe('refreshPays (2026-11-11, the Walnut VP: about 33 KB restated after each compaction, 4 to 6 a day)', () => {
  // The VP's own numbers: a 3,171-byte prompt from 2026-10-24, 33 KB behind, 192K tokens at the
  // turn end after its 11-11 18:32 compaction, a 1-hour cache.
  const vp = { debtBytes: 33_000, storedPromptBytes: 3_171, now: NOW }
  const afterCompaction = { tokens: 192_036, ttlMs: 3_600_000, requestAt: at(-60_000), expiresAt: at(3_540_000) }

  it('an org node right after its compaction: the rewrite pays back within its horizon; any other session: not', () => {
    expect(refreshPays({ ...vp, facts: afterCompaction, horizon: ORG_NODE_REFRESH_HORIZON })).toBe(true)
    expect(refreshPays({ ...vp, facts: afterCompaction, horizon: 1 })).toBe(false)
  })

  it('a big warm conversation (the VP\'s natural cold resumes came at 245K to 450K): replay', () => {
    expect(refreshPays({ ...vp, facts: { ...afterCompaction, tokens: 300_000 }, horizon: ORG_NODE_REFRESH_HORIZON })).toBe(false)
  })

  it('nothing read since the compaction (Walnut\'s idle /compact): only the old prompt is written again, so even one compaction pays', () => {
    const compacted = { tokens: 18_000, ttlMs: 3_600_000, requestAt: at(-5_000), expiresAt: at(3_595_000), compactedAt: at(-5_000) }
    expect(nothingReadSinceCompaction(compacted)).toBe(true)
    expect(refreshPays({ debtBytes: 9_000, storedPromptBytes: 2_000, facts: compacted, horizon: 1, now: NOW })).toBe(true)
    // A request after it read the summary: that is a conversation to write again.
    expect(nothingReadSinceCompaction({ ...compacted, requestAt: at(-1_000) })).toBe(false)
  })

  it('a small debt waits on a warm cache; an expired cache refreshes any debt; no debt or no facts never', () => {
    const tiny = { tokens: 1_000, ttlMs: 3_600_000, requestAt: at(-5_000), expiresAt: at(3_595_000), compactedAt: at(-5_000) }
    expect(refreshPays({ debtBytes: MIN_REFRESH_DEBT_BYTES - 1, storedPromptBytes: 100, facts: tiny, horizon: 30, now: NOW })).toBe(false)
    expect(refreshPays({ debtBytes: 200, storedPromptBytes: 100, facts: expired, horizon: 1, now: NOW })).toBe(true)
    expect(refreshPays({ debtBytes: 0, storedPromptBytes: 100, facts: expired, horizon: 30, now: NOW })).toBe(false)
    expect(refreshPays({ ...vp, facts: undefined, horizon: 30 })).toBe(false)
  })

  it('a 5-minute cache writes at 1.25x, a 1-hour one at 2x: both sides scale, and the read the rewrite gives up weighs more at 1.25x', () => {
    const fiveMin = { ...afterCompaction, ttlMs: 300_000, expiresAt: at(240_000) }
    // 265K: (265K + 0.8K) x 1.15 = 306K <= 30 x 8.25K x 1.25 = 309K, while x 1.9 = 505K > 495K.
    expect(refreshPays({ ...vp, facts: { ...fiveMin, tokens: 265_000 }, horizon: 30 })).toBe(true)
    expect(refreshPays({ ...vp, facts: { ...afterCompaction, tokens: 265_000 }, horizon: 30 })).toBe(false)
  })

  it('every org node kind counts on the long horizon (fails when a new role is added without a horizon)', async () => {
    const src = await fs.readFile(new URL('../../../src/core/types.ts', import.meta.url), 'utf8')
    const roles = [...(src.match(/export type OrgRole = ([^;]+);/)?.[1] ?? '').matchAll(/'([a-z_-]+)'/g)].map((m) => m[1])
    expect(roles.length).toBeGreaterThanOrEqual(3)
    for (const org_role of roles) expect(refreshHorizon({ org_role }), org_role).toBe(ORG_NODE_REFRESH_HORIZON)
    expect(refreshHorizon({})).toBe(1)
  })

  it('a warm cache right after a compaction refreshes an org node at its cold resume', async () => {
    const { sid } = await seed(0.05)
    const { getTask } = await import('../../../src/core/task-manager.js')
    const rec = (await getSessionByClaudeId(sid))!
    const task = (await getTask(rec.taskId!))!
    expect(promptDebtBytes(rec, task)).toBeGreaterThanOrEqual(MIN_REFRESH_DEBT_BYTES)
    const facts = { tokens: 60_000, ttlMs: 3_600_000, requestAt: at(-60_000), expiresAt: at(3_540_000) }
    expect(refreshOnResume({ ...rec, promptCache: facts }, task, NOW)).toBe(false)
    expect(refreshOnResume({ ...rec, promptCache: facts }, { ...task, org_role: 'lead' }, NOW)).toBe(true)
    // The live runner's newer facts win over the record's.
    expect(refreshOnResume({ ...rec, promptCache: facts }, { ...task, org_role: 'lead' }, NOW, { ...facts, tokens: 400_000 })).toBe(false)
  })
})

describe('every resume spawn that replays a stored prompt asks for the current one (fails on a new spawn path that skips it)', () => {
  it('each function that reads resolveResumeArgs passes its prompt through resumeSpawnPrompt', async () => {
    const src = await fs.readFile(new URL('../../../src/providers/claude-code-session.ts', import.meta.url), 'utf8')
    // Split into top-level class members by their two-space indent.
    const members = src.split(/\n  (?=(?:private |async |public |static )*[A-Za-z_]+\s*\()/)
    const readers = members.filter((m) => /await this\.resolveResumeArgs\(/.test(m))
    expect(readers.length).toBeGreaterThanOrEqual(2)
    for (const m of readers) expect(m, m.slice(0, 80)).toMatch(/this\.resumeSpawnPrompt\(/)
  })
})
