/**
 * What rides a session's next message about the tasks it follows (src/core/sessions/status-riding.ts):
 * one item per task (the newest turn notice, a completion kept past a later stop, the newest status
 * line inside the notice), only what a message carried is taken off it, and the items survive a
 * restart. Guard: every org edge and every status line goes through this one store, so no node hears
 * the same change twice, and org-follow.ts never writes into a session queue itself.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-riding'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { clearRiding, flushRidingForTest, loadRiding, noticeKeysSince, noticeToldSince, pendingRiding, rideLine, rideNotice, ridingKeys, stopRiding } from '../../../src/core/sessions/status-riding.js'
import { orgNoticeText, reportsToOrgNode, STOP_QUOTE_MAX } from '../../../src/core/sessions/org-follow.js'

const notice = (word: string) => `<walnut-message kind="notification">${word}\n\nNext:\n  walnut tools call task_get</walnut-message>`

beforeEach(async () => {
  clearRiding()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})
afterAll(async () => { clearRiding(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

describe('one item per task', () => {
  it('a newer stop replaces the older, a completion stays, and the status line sits inside the notice', () => {
    rideNotice('s', 't1', 'stopped', notice('STOP-1'), 1_000)
    rideNotice('s', 't1', 'stopped', notice('STOP-2'), 2_000)
    rideLine('s', 't1', '- "A" (t1): Working → Waiting at 10:00 UTC.', 2_500)
    rideLine('s', 't2', '- "B" (t2): Waiting → Needs you at 10:01 UTC.', 2_600)
    const text = pendingRiding('s', 3_000)!.text
    expect(text).not.toContain('STOP-1')
    expect(text.match(/STOP-2/g)).toHaveLength(1)
    // t1's line rides inside its notice, before Next:, never in the plain list too.
    expect(text).toContain('Its status now (Walnut\'s record): "A" (t1): Working → Waiting')
    expect(text.indexOf('Its status now')).toBeLessThan(text.lastIndexOf('Next:'))
    expect(text.match(/\(t1\)/g)).toHaveLength(1)
    expect(text).toContain('"B" (t2)')
    rideNotice('s', 't3', 'completed', notice('DONE'), 4_000)
    rideNotice('s', 't3', 'stopped', notice('REOPENED-STOP'), 5_000)
    const both = pendingRiding('s', 6_000)!.text
    expect(both).toContain('DONE')
    expect(both.indexOf('DONE')).toBeLessThan(both.indexOf('REOPENED-STOP'))
  })

  it('a message takes off only what it carried', () => {
    rideNotice('s', 't1', 'stopped', notice('OLD'), 1_000)
    const pending = pendingRiding('s', 1_500)!
    rideLine('s', 't1', '- "A" (t1): moved later.', 2_000)
    pending.markTold()
    expect(ridingKeys('s')).toEqual(['t1'])
    const next = pendingRiding('s', 3_000)!.text
    expect(next).not.toContain('OLD')
    expect(next).toContain('moved later')
  })

  it('survives a restart and drops what is days old', async () => {
    rideNotice('s', 't1', 'completed', notice('KEPT'), Date.now())
    rideLine('s', 'old', '- old', Date.now() - 4 * 24 * 60 * 60_000)
    await flushRidingForTest()
    // Queue state lives in cache/, which git sync never carries to the companion.
    expect(JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'cache', 'status-riding.json'), 'utf8')).sessions.s.t1.end.text).toContain('KEPT')
    clearRiding()
    expect(await loadRiding()).toBe(1)
    expect(pendingRiding('s')!.text).toContain('KEPT')
  })
})

describe('a move a notice told is not told again', () => {
  it('a status line after a told notice of the same move is dropped; one of a later move rides', () => {
    rideNotice('s', 't1', 'completed', notice('DONE'), 10_000)
    pendingRiding('s', 11_000)!.markTold()
    expect(noticeToldSince('s', 't1', 9_000)).toBe(true)
    // The status move behind that completion settles 90 s later: no news.
    expect(rideLine('s', 't1', '- "A" (t1): Working → Done at 10:00 UTC.', 100_000, 10_500)).toBe(false)
    expect(pendingRiding('s', 100_000)).toBeNull()
    // A move long after the notice is news.
    expect(rideLine('s', 't1', '- "A" (t1): Done → Working at 11:00 UTC.', 4_000_000, 3_900_000)).toBe(true)
    // The team note reads which tasks the session heard by notice since its last note.
    expect([...noticeKeysSince('s', 0)]).toEqual(['t1'])
    expect(noticeKeysSince('s', 20_000).size).toBe(0)
  })

  it('past the cap a status line goes before a notice, and a completion last', () => {
    rideNotice('s', 'done', 'completed', notice('DONE'), 1)
    rideNotice('s', 'stop', 'stopped', notice('STOP'), 2)
    for (let i = 0; i < 25; i++) rideLine('s', `l${i}`, `- line ${i}`, 10 + i)
    const keys = ridingKeys('s')
    expect(keys).toHaveLength(20)
    expect(keys).toContain('done')
    expect(keys).toContain('stop')
  })

  it('a stop writes the save still waiting before it clears', async () => {
    rideNotice('s', 't9', 'completed', notice('LAST'), Date.now())
    // The stop's save is the one still waiting: it is on disk once the stop's promise resolves.
    await stopRiding()
    expect(await loadRiding()).toBe(1)
    expect(pendingRiding('s')!.text).toContain('LAST')
  })
})

describe('who reports to an org node, and in what words', () => {
  it('a top-level task and a VP do; a worker, Main, an ask, a plugin task and a snoozed task do not', () => {
    expect(reportsToOrgNode({})).toBe(true)
    expect(reportsToOrgNode({ org_role: 'lead' })).toBe(true)
    expect(reportsToOrgNode({ parent_task_id: 'p' })).toBe(false)
    expect(reportsToOrgNode({ org_role: 'main' })).toBe(false)
    expect(reportsToOrgNode({ walnut_agent: true })).toBe(false)
    expect(reportsToOrgNode({ plugin_only: '@test-run' })).toBe(false)
    expect(reportsToOrgNode({ user_status: { state: 'waiting', snoozed: { until: '2026-12-01' } } as never })).toBe(false)
    expect(orgNoticeText('Your subtask "X" (t) stopped.')).toBe('A task you follow, "X" (t) stopped.')
    expect(STOP_QUOTE_MAX).toBeLessThan(4_000)
  })
})

describe('guard: one store, no queue writes of its own', () => {
  it('org-follow.ts rides through status-riding.ts and never writes into a session itself', async () => {
    const src = await fs.readFile(path.join(process.cwd(), 'src/core/sessions/org-follow.ts'), 'utf8')
    expect(src).toMatch(/rideNotice\(/)
    expect(src).not.toMatch(/deliverToSession|sendMessageToSession|enqueueMessage/)
  })

  it('status-riding.ts holds the only ride-along map; status-push.ts writes through it', async () => {
    const push = await fs.readFile(path.join(process.cwd(), 'src/core/sessions/status-push.ts'), 'utf8')
    expect(push).not.toMatch(/const riding = new Map/)
    expect(push).toMatch(/rideLine\(/)
    expect(push).toMatch(/return pendingRiding\(sessionId, now\)/)
  })
})
