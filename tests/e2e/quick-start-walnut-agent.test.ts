/** "Ask Walnut" launches on POST /api/sessions/quick-start (walnutAgent: true).
 *
 *  The draft's second tab starts an ORDINARY task session that spawns with the
 *  Personal AI profile. Contract pinned here:
 *   - no cwd required; the server runs the session in WALNUT_HOME
 *   - the task is a normal task, pre-filled: project 'Ask Walnut' (its own
 *     project, NOT the user's 'Walnut' dev project), tier Focus (an explicit
 *     client tier still wins)
 *   - the session record carries the Personal AI profile (persona + walnut MCP
 *     mount) so a cold --resume re-applies it
 *   - ACP engines are rejected (the profile rides the CLI's system-prompt
 *     flags, which ACP lacks), and so is a remote host (the Personal AI runs
 *     where the server runs)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-qs-walnut-agent'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

interface QuickStartResult {
  status: number
  taskId?: string
  sessionId?: string
  task?: { project?: string; pinned?: boolean; focus_tier?: string; cwd?: string; walnut_agent?: boolean }
  error?: string
}

async function quickStart(body: Record<string, unknown>): Promise<QuickStartResult> {
  const res = await fetch(apiUrl('/api/sessions/quick-start'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({})) as Omit<QuickStartResult, 'status'>
  return { status: res.status, ...json }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('quick-start walnutAgent', () => {
  it('starts without a cwd: normal task under Ask Walnut/Focus, session in WALNUT_HOME with the Personal AI profile', async () => {
    const res = await quickStart({ walnutAgent: true, message: 'which task fixed the dedup bug?' })
    expect(res.status).toBe(200)
    expect(res.sessionId).toBeTruthy()

    // A completely normal task — just pre-filled fields.
    expect(res.task?.project).toBe('Ask Walnut')
    expect(res.task?.pinned).toBe(true)
    expect(res.task?.focus_tier).toBe('focus')
    expect(res.task?.cwd).toBe(WALNUT_HOME)
    // The per-task Personal-AI marker — task lists key the amber title on THIS,
    // never on the project name (a dev task filed under 'Walnut' must not light up).
    expect(res.task?.walnut_agent).toBe(true)

    // The record carries the persona so a cold --resume re-applies it.
    const record = await getSessionByClaudeId(res.sessionId!)
    expect(record).toBeTruthy()
    expect(record!.cwd).toBe(WALNUT_HOME)
    expect(record!.profile?.systemPromptMode).toBe('append')
    expect(record!.profile?.systemPrompt).toContain('Personal AI')
    // Persona rides ON TOP of the CLI default prompt (append keeps env/date,
    // CLI skill discovery, MCP instructions); the header settles precedence.
    expect(record!.profile?.systemPrompt).toContain('## Persona override')
    expect(Object.keys(record!.profile?.mcpServers ?? {})).toContain('walnut')
    // NOT a hidden chat lane — this is a visible, ordinary task session.
    expect(record!.lane).toBeFalsy()
  })

  it('honors an explicit client tier over the Focus default', async () => {
    const res = await quickStart({
      walnutAgent: true,
      message: 'plan my week',
      taskMeta: { pinTier: 'backlog' },
    })
    expect(res.status).toBe(200)
    expect(res.task?.focus_tier).toBe('backlog')
  })

  it('rejects ACP engines (profile rides the CLI system-prompt flags)', async () => {
    const res = await quickStart({ walnutAgent: true, message: 'hi', engine: 'codex' })
    expect(res.status).toBe(400)
    expect(res.error).toMatch(/claude engine/i)
  })

  it('rejects a remote host (the Personal AI runs where the server runs)', async () => {
    const res = await quickStart({ walnutAgent: true, message: 'hi', host: 'clouddev' })
    expect(res.status).toBe(400)
    expect(res.error).toMatch(/server host/i)
  })

  it('still requires cwd on a normal (non-walnut) launch', async () => {
    const res = await quickStart({ message: 'hi' })
    expect(res.status).toBe(400)
    expect(res.error).toMatch(/cwd/i)
  })

  it('drift repair: a stale persisted persona is refreshed to the current build', async () => {
    const res = await quickStart({ walnutAgent: true, message: 'note something' })
    expect(res.status).toBe(200)
    const sid = res.sessionId!

    // Simulate a session minted before a personalAiProfile upgrade.
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const record = await getSessionByClaudeId(sid)
    await updateSessionRecord(sid, {
      profile: { ...record!.profile!, systemPrompt: 'OLD PERSONA (pre-upgrade)' },
    })

    const { refreshWalnutSessionProfile } = await import('../../src/core/sessions/personal-ai-lane.js')
    await refreshWalnutSessionProfile(sid)

    const refreshed = await getSessionByClaudeId(sid)
    expect(refreshed!.profile?.systemPrompt).toContain('Personal AI')
    expect(refreshed!.profile?.systemPrompt).toContain('## Persona override')
    expect(refreshed!.profile?.systemPromptMode).toBe('append')
  })
})
