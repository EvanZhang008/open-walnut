import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants())
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { enginesRouter } from '../../../src/web/routes/engines.js'

const SID = 'classifier-refusal-test'
let app: express.Express
beforeEach(async () => {
  app = express(); app.use(express.json()); app.use('/api/engines', enginesRouter)
  await createSessionRecord(SID, '', 'Test', '/work/repo', { mode: 'auto' })
  await updateSessionRecord(SID, { mode: 'auto', autoPermissionDenial: { tools: ['Bash'], at: new Date().toISOString() } })
})
afterEach(() => vi.restoreAllMocks())

describe('classifier recovery only persists a confirmed mode', () => {
  it('retains Auto and the notice when the actual CLI refuses, then recovers', async () => {
    const change = vi.spyOn(sessionRunner, 'changePermissionMode').mockRejectedValueOnce(new Error('CLI refused the mode'))
      .mockResolvedValueOnce('applied')
    const denied = await request(app).post('/api/engines/claude/recover-permission').send({ sessionId: SID })
    expect(denied.status).toBe(409)
    expect((await getSessionByClaudeId(SID))?.mode).toBe('auto')
    expect((await getSessionByClaudeId(SID))?.autoPermissionDenial).toBeTruthy()
    const recovered = await request(app).post('/api/engines/claude/recover-permission').send({ sessionId: SID })
    expect(recovered.status).toBe(200)
    expect(change).toHaveBeenLastCalledWith(SID, 'default')
    expect((await getSessionByClaudeId(SID))).toMatchObject({ mode: 'default', modeChosen: true, autoPermissionDenial: null })
  })
  it('refuses a dead session and never converts a generic failure to full trust', async () => {
    vi.spyOn(sessionRunner, 'changePermissionMode').mockResolvedValue('not-live')
    expect((await request(app).post('/api/engines/claude/recover-permission').send({ sessionId: SID })).status).toBe(409)
    expect((await getSessionByClaudeId(SID))?.mode).toBe('auto')
    await updateSessionRecord(SID, { autoPermissionDenial: null })
    expect((await request(app).post('/api/engines/claude/recover-permission').send({ sessionId: SID })).status).toBe(409)
  })
})
