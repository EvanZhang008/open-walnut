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
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
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
  task?: { project?: string; title?: string; pinned?: boolean; focus_tier?: string; cwd?: string; walnut_agent?: boolean; agent_id?: string }
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

  it("agentId names another console agent: its persona, its own 'Ask <name>' project + placeholder, and an agent_id stamp", async () => {
    const res = await quickStart({ walnutAgent: true, agentId: 'mentor', message: 'help me reflect on this week' })
    expect(res.status, res.error).toBe(200)
    // Same task shape as an Ask Walnut — marker on, filed under the agent's own
    // project, titled after it until auto-titling names it — plus whose ask it is.
    expect(res.task?.walnut_agent).toBe(true)
    expect(res.task?.agent_id).toBe('mentor')
    expect(res.task?.project).toBe('Ask Mentor')
    expect(res.task?.title).toBe('Ask Mentor')
    expect(res.task?.cwd).toBe(WALNUT_HOME)

    const record = await getSessionByClaudeId(res.sessionId!)
    expect(record!.profile?.systemPromptMode).toBe('append')
    expect(record!.profile?.systemPrompt).toContain('You are Mentor')
    expect(record!.profile?.systemPrompt).not.toContain('You are Walnut,')
    expect(record!.profile?.systemPrompt).toContain('## Persona override')
    expect(Object.keys(record!.profile?.mcpServers ?? {})).toContain('walnut')

    // The placeholder gate knows the per-agent form, so this task gets titled
    // like an Ask Walnut one does.
    const { matchPlaceholderTitle } = await import('../../src/core/sessions/quick-start.js')
    expect(matchPlaceholderTitle({ title: 'Ask Mentor', walnut_agent: true, project: 'Ask Mentor' }, [WALNUT_HOME])).toBe('Ask Mentor')
    // addTask canonicalises the project's casing to the registry row while the
    // title keeps the launch's spelling — the match must not care.
    expect(matchPlaceholderTitle({ title: 'Ask mentor', walnut_agent: true, project: 'Ask Mentor' }, [WALNUT_HOME])).toBe('Ask mentor')
    expect(matchPlaceholderTitle({ title: 'Ask Mentor', walnut_agent: true, project: 'Dev work' }, [WALNUT_HOME])).toBeUndefined()
    expect(matchPlaceholderTitle({ title: 'Ask Mentor', project: 'Ask Mentor' }, [WALNUT_HOME])).toBeUndefined()
  })

  it('a retry on an existing Mentor ask that names no agent keeps the Mentor persona (the task stamp decides)', async () => {
    const first = await quickStart({ walnutAgent: true, agentId: 'mentor', message: 'first' })
    expect(first.status, first.error).toBe(200)
    const retry = await quickStart({ walnutAgent: true, taskId: first.taskId, message: 'again' })
    expect(retry.status, retry.error).toBe(200)
    expect(retry.taskId).toBe(first.taskId)
    const record = await getSessionByClaudeId(retry.sessionId!)
    expect(record!.profile?.systemPrompt).toContain('You are Mentor')
    expect(record!.profile?.systemPrompt).not.toContain('You are Walnut,')
  })

  it('the general agent is the default and stamps no agent_id; an explicit general is the same launch', async () => {
    const res = await quickStart({ walnutAgent: true, agentId: 'general', message: 'hi' })
    expect(res.status, res.error).toBe(200)
    expect(res.task?.project).toBe('Ask Walnut')
    expect(res.task?.agent_id).toBeUndefined()
  })

  it('rejects an unknown agent, a background-only agent, and agentId without walnutAgent — before anything is written', async () => {
    const { listTasks } = await import('../../src/core/task-manager.js')
    const before = (await listTasks()).length
    for (const body of [
      { walnutAgent: true, agentId: 'no-such-agent', message: 'hi' },
      { walnutAgent: true, agentId: 'life-tracker', message: 'hi' },
      { agentId: 'mentor', message: 'hi', cwd: WALNUT_HOME },
      { walnutAgent: true, agentId: 42, message: 'hi' },
    ]) {
      const res = await quickStart(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.error, JSON.stringify(body)).toMatch(/agent/i)
    }
    expect((await listTasks()).length).toBe(before)
  })

  it('drift repair rebuilds the persona the task was launched with, not the Personal AI', async () => {
    const res = await quickStart({ walnutAgent: true, agentId: 'mentor', message: 'journal' })
    expect(res.status, res.error).toBe(200)
    const sid = res.sessionId!
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const record = await getSessionByClaudeId(sid)
    await updateSessionRecord(sid, { profile: { ...record!.profile!, systemPrompt: 'OLD MENTOR (pre-upgrade)' } })

    const { refreshWalnutSessionProfile } = await import('../../src/core/sessions/personal-ai-lane.js')
    await refreshWalnutSessionProfile(sid)

    const refreshed = await getSessionByClaudeId(sid)
    expect(refreshed!.profile?.systemPrompt).toContain('You are Mentor')
    expect(refreshed!.profile?.systemPrompt).not.toContain('You are Walnut,')
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

/** Ask Walnut launch memory: medium/Auto are FIRST-RUN defaults; a pick made
 *  for an Ask Walnut session (in its picker, or on the draft at launch) is what
 *  the next Ask Walnut starts on. The SERVER applies it: a launch that names no
 *  model gets the remembered one and cannot erase it; only an explicit
 *  'default' (the picker's Auto row) clears it. Sessions off Ask Walnut never
 *  touch it. */
describe('quick-start walnutAgent — launch memory (model + effort follow the last pick)', () => {
  async function launchMemory(): Promise<{ model?: string; effort?: string }> {
    const res = await fetch(apiUrl('/api/sessions/ask-walnut-launch'))
    expect(res.status).toBe(200)
    return res.json() as Promise<{ model?: string; effort?: string }>
  }
  async function post(p: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(apiUrl(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  async function remember(pick: { model?: string | null; effort?: import('../../src/core/types.js').SessionEffort | null }): Promise<void> {
    const { rememberAskWalnutLaunch } = await import('../../src/core/sessions/ask-walnut-launch.js')
    await rememberAskWalnutLaunch(pick)
  }
  /** The spawn persists cliModel asynchronously (its own createSessionRecord
   *  updates the pre-seeded row) — poll rather than read once. */
  async function spawnedCliModel(sessionId: string): Promise<string | undefined> {
    let seen: string | undefined
    await vi.waitFor(async () => {
      const record = await getSessionByClaudeId(sessionId)
      expect(record).toBeTruthy()
      // pid arrives with the same persist as cliModel — it is the "spawned" signal.
      expect(record!.pid).toBeTruthy()
      seen = record!.cliModel
    }, { timeout: 10_000 })
    return seen
  }

  // Every test states its own precondition; none may lean on a sibling's leftovers.
  beforeEach(async () => { await remember({ model: undefined, effort: undefined }) })

  it('first run: medium effort, no --model, empty memory', async () => {
    const res = await quickStart({ walnutAgent: true, message: 'what is on my plate?' })
    expect(res.status).toBe(200)
    expect((await getSessionByClaudeId(res.sessionId!))!.effort).toBe('medium')
    expect(await spawnedCliModel(res.sessionId!)).toBeUndefined()
    expect(await launchMemory()).toEqual({})
  })

  it("an effort switched in a running Ask Walnut session becomes the next Ask Walnut's effort", async () => {
    const first = await quickStart({ walnutAgent: true, message: 'plan my week' })
    expect(first.status).toBe(200)
    expect((await post(`/api/sessions/${first.sessionId}/effort`, { effort: 'high' })).status).toBe(200)
    // The write is fire-and-forget behind the switch — settle it.
    await vi.waitFor(async () => expect((await launchMemory()).effort).toBe('high'))

    const next = await quickStart({ walnutAgent: true, message: 'and next week?' })
    expect(next.status).toBe(200)
    expect((await getSessionByClaudeId(next.sessionId!))!.effort).toBe('high')
  })

  it('a model picked on the draft at launch is remembered, and a launch naming no model spawns on it', async () => {
    const picked = await quickStart({ walnutAgent: true, message: 'summarize today', model: 'sonnet' })
    expect(picked.status).toBe(200)
    expect(await spawnedCliModel(picked.sessionId!)).toBe('sonnet')
    await vi.waitFor(async () => expect((await launchMemory()).model).toBe('sonnet'))

    // No `model` key at all: the client never saw the memory (a retry, a draft
    // opened before the pick). The server applies it — and does NOT clear it.
    const silent = await quickStart({ walnutAgent: true, message: 'summarize today again' })
    expect(silent.status).toBe(200)
    expect(await spawnedCliModel(silent.sessionId!)).toBe('sonnet')
    expect((await launchMemory()).model).toBe('sonnet')
  })

  it("an explicit 'default' (the picker's Auto row) spawns on Auto and forgets the model, keeping the effort", async () => {
    await remember({ model: 'sonnet', effort: 'high' })
    const auto = await quickStart({ walnutAgent: true, message: 'back to auto', model: 'default' })
    expect(auto.status).toBe(200)
    expect(await spawnedCliModel(auto.sessionId!)).toBeUndefined()
    await vi.waitFor(async () => expect((await launchMemory()).model).toBeUndefined())
    expect((await launchMemory()).effort).toBe('high')
  })

  it('a model switched in a running Ask Walnut session is remembered as the raw picker value', async () => {
    const res = await quickStart({ walnutAgent: true, message: 'tidy my inbox' })
    expect(res.status).toBe(200)
    expect((await post(`/api/sessions/${res.sessionId}/model`, { model: 'sonnet-1m' })).status).toBe(200)
    await vi.waitFor(async () => expect((await launchMemory()).model).toBe('sonnet-1m'))
  })

  it('a remembered effort the launched model cannot take falls back to the default', async () => {
    await remember({ effort: 'max' })
    // Auto: the CLI resolves the model; the level rides through.
    const auto = await quickStart({ walnutAgent: true, message: 'deep question' })
    expect((await getSessionByClaudeId(auto.sessionId!))!.effort).toBe('max')
    // Haiku has no max → medium, not a spawn the CLI would silently downgrade.
    const haiku = await quickStart({ walnutAgent: true, message: 'quick question', model: 'haiku' })
    expect((await getSessionByClaudeId(haiku.sessionId!))!.effort).toBe('medium')
  })

  it('a pick on an ORDINARY session never touches the Ask Walnut memory', async () => {
    await remember({ model: 'sonnet', effort: 'high' })
    const plain = await quickStart({ message: 'refactor the parser', cwd: WALNUT_HOME })
    expect(plain.status).toBe(200)
    expect((await post(`/api/sessions/${plain.sessionId}/effort`, { effort: 'low' })).status).toBe(200)
    expect((await post(`/api/sessions/${plain.sessionId}/model`, { model: 'haiku' })).status).toBe(200)
    // The routes' writes are fire-and-forget; the decision itself is awaitable —
    // run it directly for the same session so a wrong write can't hide behind timing.
    const { rememberAskWalnutSessionPick } = await import('../../src/core/sessions/ask-walnut-launch.js')
    await rememberAskWalnutSessionPick(plain.sessionId!, { model: 'haiku', effort: 'low' })
    expect(await launchMemory()).toEqual({ model: 'sonnet', effort: 'high' })
  })

  it('the persona drift repair keeps the effort the user picked on the record', async () => {
    const res = await quickStart({ walnutAgent: true, message: 'note something else' })
    expect((await post(`/api/sessions/${res.sessionId}/effort`, { effort: 'low' })).status).toBe(200)
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const record = await getSessionByClaudeId(res.sessionId!)
    await updateSessionRecord(res.sessionId!, {
      profile: { ...record!.profile!, systemPrompt: 'OLD PERSONA (pre-upgrade)' },
    })
    const { refreshWalnutSessionProfile } = await import('../../src/core/sessions/personal-ai-lane.js')
    await refreshWalnutSessionProfile(res.sessionId!)
    const refreshed = await getSessionByClaudeId(res.sessionId!)
    expect(refreshed!.profile?.systemPrompt).toContain('Personal AI')
    expect(refreshed!.effort).toBe('low')
  })
})
