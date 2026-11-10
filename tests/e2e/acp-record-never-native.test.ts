/**
 * A session whose record runs on an ACP engine is never run as a Claude Code CLI
 * (providers/acp-native-guard.ts). 2026-11-10: a server shut down while it re-attached a Codex
 * session; the attach came back empty, the queue's drain went on down the Claude path and started
 * a Claude CLI under the Codex session's id, which then took a lead's request on its host and said
 * it had touched nothing. Through a REAL server and the mock daemon: the attach is made to come
 * back empty, a message is sent, and no daemon start or send names the session; the row waits.
 *
 * Mocked: constants, the daemon (MockDaemon), the CLI (mock-claude.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-never-native'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { AcpSessionNotNativeError, refuseNativeSpawnOnAcpRecord } from '../../src/providers/acp-native-guard.js'
import { classifyDeliveryFailure } from '../../src/providers/delivery-failure.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const SID = '0a1c4230-33ec-4e41-95f5-ec68c31ec822'
let server: HttpServer
let port: number
let daemon: MockDaemon

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('an ACP session is never run as a Claude Code CLI', () => {
  it('a message to an ACP session whose attach comes back empty is parked for Retry, and nothing starts a CLI under its id', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Codex task', priority: 'none', project: 'Marina' }),
    })
    const taskId = (await r.json()).task.id as string
    await createSessionRecord(SID, taskId, 'Marina', WALNUT_HOME, { engine: 'codex', acpRuntimeId: 'acp-test-never-native', initialProcessStatus: 'stopped' })
    const runner = sessionRunner as unknown as { maybeAttachAcpSession: (sid: string) => Promise<unknown>; acpDestroyed: boolean }
    const real = runner.maybeAttachAcpSession
    let asked = 0
    runner.maybeAttachAcpSession = async () => { asked++; return undefined }
    try {
      // A server stopping while it re-attached: the attach answers nothing, and the row waits for the next server.
      runner.acpDestroyed = true
      await sendMessageToSession(SID, 'Please fix the 7 findings', { source: 'agent', taskId })
      await expect.poll(() => asked, { timeout: 20_000 }).toBeGreaterThan(0)
      await new Promise((res) => setTimeout(res, 500))
      expect((await getQueue(SID)).map((m) => m.status)).toEqual(['pending'])
      // Any other miss (an archived record, one that changed mid-attach): parked with the reason, never a CLI.
      runner.acpDestroyed = false
      const before = asked
      await sendMessageToSession(SID, 'And the eighth', { source: 'agent', taskId })
      await expect.poll(() => asked, { timeout: 20_000 }).toBeGreaterThan(before)
      await expect.poll(async () => (await getQueue(SID)).map((m) => m.status), { timeout: 20_000 }).toEqual(['parked', 'parked'])
      expect((await getQueue(SID))[0].parkedReason ?? '').toContain('never starts Claude Code under its id')
      const named = daemon.getCommandHistory().filter((c) => JSON.stringify(c.payload).includes(SID))
      expect(named.filter((c) => c.cmd === 'start' || c.cmd === 'send').map((c) => c.cmd)).toEqual([])
    } finally {
      runner.maybeAttachAcpSession = real
      runner.acpDestroyed = false
    }
  }, 60_000)

  it('the native spawn itself refuses an ACP session id, and the queue parks it, not retries it', async () => {
    await expect(refuseNativeSpawnOnAcpRecord(SID)).rejects.toBeInstanceOf(AcpSessionNotNativeError)
    await expect(refuseNativeSpawnOnAcpRecord('ffffffff-0000-4000-8000-000000000000')).resolves.toBeUndefined()
    await expect(refuseNativeSpawnOnAcpRecord(undefined)).resolves.toBeUndefined()
    const verdict = classifyDeliveryFailure(new AcpSessionNotNativeError(SID, 'codex'))
    expect(verdict).toMatchObject({ kind: 'permanent', code: 'acp_session' })
    expect(verdict.reason).toContain('never starts Claude Code under its id')
  })
})
