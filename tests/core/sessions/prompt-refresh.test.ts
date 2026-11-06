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
}))
import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { buildSessionContext } from '../../../src/core/sessions/session-context.js'
import {
  TASK_CONTEXT_JOIN, freshResumePrompt, promptDebtBytes, refreshOnResume, replayBuysNothing,
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
