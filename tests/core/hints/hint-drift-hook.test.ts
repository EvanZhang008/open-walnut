/**
 * The drift sensor (src/core/hints/hint-drift.ts) judges a reply the user reads: Main's, a
 * lead's (its chat is on the Org page; 2026-10-29 leads answered Walnut notices in English
 * there) and an ask's whoever started the turn, a worker's only when a person did.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionRecord } from '../../../src/core/types.js'

const records = new Map<string, SessionRecord>()
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ session: { reply_language: 'Talk to the user in Chinese; code stays English.' } }),
}))
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (sid: string) => records.get(sid),
  updateSessionRecordConditionally: async (sid: string, patch: Partial<SessionRecord>) => {
    records.set(sid, { ...records.get(sid)!, ...patch })
    return true
  },
}))

import { hintDriftHook } from '../../../src/core/hints/hint-drift.js'

const ENGLISH = 'The worker finished the daemon timeout fix and it is deployed; nothing needs you right now.'
const told = { sends: 3, told: { 'reply-language': { send: 1, hash: 'x', at: '2026-10-29T00:00:00Z' } }, lastSendBy: 'agent' as const }

beforeEach(() => records.clear())

async function turn(sid: string, task: Record<string, unknown>, lastSendBy: 'agent' | 'person' = 'agent') {
  records.set(sid, { claudeSessionId: sid, hintState: { ...told, lastSendBy } } as unknown as SessionRecord)
  await hintDriftHook.handler({ sessionId: sid, result: ENGLISH, task } as never, {} as never)
  return records.get(sid)!.hintState?.drift?.['reply-language']
}

describe('which replies the drift sensor judges', () => {
  it('a lead\'s and Main\'s English reply to a notice is drift', async () => {
    expect(await turn('lead', { org_role: 'lead' })).toBeTruthy()
    expect(await turn('main', { org_role: 'main' })).toBeTruthy()
  })
  it('a worker answering its lead is not; answering a person is', async () => {
    expect(await turn('w1', { parent_task_id: 'p' })).toBeUndefined()
    expect(await turn('w2', { parent_task_id: 'p' }, 'person')).toBeTruthy()
  })
})
