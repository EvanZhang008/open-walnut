import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('request-still-working', { IS_EPHEMERAL: true }))
import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { createSessionRequest, getSessionRequest } from '../../src/core/session-requests.js'
import { notifyRequesterFallback } from '../../src/core/sessions/session-request-notify.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

let daemon: MockDaemon
beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  await startServer({ port: 0, dev: true })
})
afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function startOn(title: string): Promise<{ taskId: string; sid: string }> {
  const taskId = (await addTask({ title, project: 'Orchard' })).task.id
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project: 'Orchard', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
  return { taskId, sid }
}

function noticesFor(sid: string, id: string): string[] {
  return [...new Set([...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
    .filter((c) => c.payload.sid === sid)
    .map((c) => String(c.payload.message ?? ''))
    .filter((m) => m.includes(`request="${id}"`) && m.includes('kind="notification"')))]
}

describe('a real request stays open when its target carries on', () => {
  it('sends no fallback at turn end while Working or parked on its own land, then settles at a real stop', async () => {
    const asker = await startOn('Release lead')
    const target = await startOn('Release build')
    await updateTaskRaw(target.taskId, { phase: 'NEED_ACTION', user_status: { state: 'working', carriesOn: 'watch' } })
    const r = await createSessionRequest({ fromSessionId: asker.sid, toTaskId: target.taskId, toSessionId: target.sid, text: 'Build and report when landed.' })
    expect(await notifyRequesterFallback(r, 'completed')).toBe(false)
    expect((await getSessionRequest(r.id))?.status).toBe('pending')
    expect(noticesFor(asker.sid, r.id)).toEqual([])
    await updateTaskRaw(target.taskId, { phase: 'WAITING', user_status: { state: 'waiting', kind: 'watch', waitingOn: 'its land result' } })
    expect(await notifyRequesterFallback(r, 'completed')).toBe(false)
    expect((await getSessionRequest(r.id))?.status).toBe('pending')
    expect(noticesFor(asker.sid, r.id)).toEqual([])
    await updateTaskRaw(target.taskId, { phase: 'COMPLETE', user_status: { state: 'done' } })
    await notifyRequesterFallback(r, 'completed', { phase: 'COMPLETE', lastMessage: 'The build landed.' })
    expect((await getSessionRequest(r.id))?.status).toBe('notified')
    await vi.waitFor(() => {
      expect(noticesFor(asker.sid, r.id)).toHaveLength(1)
      expect(noticesFor(asker.sid, r.id)[0]).toContain('Current state: Completed.')
    }, { timeout: 20_000 })
    expect(await notifyRequesterFallback(r, 'completed', { phase: 'COMPLETE' })).toBe(false)
  }, 60_000)
})
