/**
 * What each role's session is actually spawned with, captured where the bytes
 * leave the server: the start command the daemon receives (the CLI argv for
 * Claude Code, the adapter env for an ACP engine). The team charter
 * (src/core/team-charter.ts) must be in every new session's prompt, and a
 * session spawned before it keeps its own prompt on resume, byte for byte.
 *
 * Real server, MockDaemon, mock CLI and no model call. Set CHARTER_PROMPT_DIR
 * to keep each captured prompt as a file for a human to read.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-team-charter'))
// Offline model for the background title refinement.
vi.mock('../../src/model/model.js', () => ({
  sendMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'Charter Task' }], stopReason: 'end_turn' })),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { addTask } from '../../src/core/task-manager.js'
import { getSessionByClaudeId, getSessionsForTask, updateSessionRecord } from '../../src/core/session-tracker.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'
import { TEAM_CHARTER } from '../../src/core/team-charter.js'
import { ensureMainTask } from '../../src/core/org/org-store.js'
import type { OrgRole } from '../../src/core/types.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const MOCK_CLI = path.join(REPO, 'tests/providers/mock-claude.mjs')
const MOCK_AGENT = path.join(REPO, 'tests/providers/mock-acp-agent.mjs')
const OUT = process.env.CHARTER_PROMPT_DIR

let server: HttpServer
let port: number
let daemon: MockDaemon

function keep(name: string, text: string): void {
  if (!OUT) return
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name), text)
}

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as T
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** The prompt flags of one CLI argv: what the model is told before any message. */
function promptsOf(args: string[]): { append?: string; system?: string } {
  const out: { append?: string; system?: string } = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    const value = args[i + 1]
    if (flag === '--append-system-prompt') out.append = value
    else if (flag === '--append-system-prompt-file') out.append = fs.readFileSync(value, 'utf8')
    else if (flag === '--system-prompt') out.system = value
    else if (flag === '--system-prompt-file') out.system = fs.readFileSync(value, 'utf8')
  }
  return out
}

function startsFor(sid: string): Array<{ args: string[]; resume: boolean }> {
  return daemon.getCommandHistoryFor('start')
    .filter((c) => c.payload.sid === sid)
    .map((c) => ({ args: (c.payload.args as string[]) ?? [], resume: c.payload.resume === true }))
}

/** Start a session on a task the way the UI's session:start does, and return its argv. */
async function startOn(role: OrgRole | undefined, title: string): Promise<{ sid: string; args: string[] }> {
  // Main is made the way the org makes it (an ask-like task in "Ask Walnut").
  const task = role === 'main'
    ? await ensureMainTask()
    : (await addTask({ title, project: 'marina', ...(role ? { org_role: role } : {}) })).task
  bus.emit(EventNames.SESSION_START, { taskId: task.id, message: 'hello', cwd: os.tmpdir() }, ['session-runner'], { source: 'web-ui' })
  const sid = await waitFor(async () => (await getSessionsForTask(task.id))[0]?.claudeSessionId, `${title} session`)
  const start = await waitFor(() => startsFor(sid)[0], `${title} start command`)
  return { sid, args: start.args }
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  // A worker bundle lets the ACP start establish; the capture below only needs
  // the start command, so a checkout without a built bundle still runs it.
  const worker = [path.join(REPO, 'dist/daemon-binaries/acp-worker.js'), process.env.CHARTER_ACP_WORKER ?? '']
    .find((p) => p && fs.existsSync(p))
  if (worker) sessionRunner.setTestAcpArtifacts({ workerCmd: [process.execPath, worker], adapterCmd: [process.execPath, MOCK_AGENT] })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  sessionRunner.setTestAcpArtifacts(undefined)
  await stopServer()
  await daemon.stop()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 30_000)

describe('the prompt each role is spawned with (Claude Code)', () => {
  let worker: { sid: string; args: string[] }

  it('a worker', async () => {
    worker = await startOn(undefined, 'Fix the flaky auth test')
    const { append } = promptsOf(worker.args)
    expect(append).toContain(TEAM_CHARTER)
    keep('claude-worker-new.txt', append!)
  }, 60_000)

  it('a project lead', async () => {
    const { args } = await startOn('lead', 'marina lead')
    const { append } = promptsOf(args)
    expect(append).toContain(TEAM_CHARTER)
    expect(append).toMatch(/You assign work, coordinate across teams and unblock/)
    keep('claude-lead-new.txt', append!)
  }, 60_000)

  it('Main', async () => {
    const { args } = await startOn('main', 'Main')
    const { append } = promptsOf(args)
    expect(append).toContain(TEAM_CHARTER)
    expect(append).toMatch(/you run their org as co-CEOs/)
    keep('claude-main-new.txt', append!)
  }, 60_000)

  it('a Personal AI ask: persona with the contract, plus the session context', async () => {
    const res = await fetch(`http://localhost:${port}/api/sessions/quick-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walnutAgent: true, message: 'which task fixed the dedup bug?' }),
    })
    expect(res.status).toBe(200)
    const { sessionId } = await res.json() as { sessionId: string }
    const start = await waitFor(() => startsFor(sessionId)[0], 'ask start command')
    const { append, system } = promptsOf(start.args)
    const whole = [system, append].filter(Boolean).join('\n\n')
    // Two carriers, each once: the persona (the contract inside) and the session
    // context after it. Kept on purpose: an ask started without its persona
    // still gets the charter from the context.
    expect(whole.split(TEAM_CHARTER).length - 1).toBe(2)
    keep('claude-ask-new.txt', `${system ? `--system-prompt:\n${system}\n\n` : ''}--append-system-prompt:\n${append ?? ''}`)
  }, 60_000)

  it('a session spawned before the charter resumes with its own prompt, unchanged', async () => {
    // Stand in for a pre-charter spawn: the record holds the prompt without it.
    const full = promptsOf(worker.args).append!
    const old = full.replace(`\n\n${TEAM_CHARTER}`, '')
    expect(old).not.toContain(TEAM_CHARTER)
    // The runner stores the spawn prompt in the background: wait for it, so the
    // stand-in below is not overwritten by that write.
    await waitFor(async () => (await getSessionByClaudeId(worker.sid))?.appliedAppendSystemPrompt === full, 'stored spawn prompt')
    await updateSessionRecord(worker.sid, { appliedAppendSystemPrompt: old })
    expect((await getSessionByClaudeId(worker.sid))?.appliedAppendSystemPrompt).toBe(old)
    // The next send to a dead CLI answers session_dead, and the runner resumes.
    daemon.simulateDeath(worker.sid, 0)
    await sendMessageToSession(worker.sid, 'continue')
    const resumed = await waitFor(() => startsFor(worker.sid).find((s) => s.resume), 'resume start command', 30_000)
    const { append } = promptsOf(resumed.args)
    expect(append).toBe(old)
    keep('claude-worker-resumed-old.txt', append!)
  }, 60_000)
})

describe('ACP engines', () => {
  async function acpStartFor(engine: string): Promise<Record<string, string>> {
    const before = daemon.getCommandHistoryFor('acpStart').length
    const res = await fetch(`http://localhost:${port}/api/sessions/quick-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: os.tmpdir(), message: 'hello', engine }),
    })
    expect(res.status).toBe(200)
    const cmd = await waitFor(() => daemon.getCommandHistoryFor('acpStart')[before], `${engine} acpStart`)
    return (cmd.payload.env ?? {}) as Record<string, string>
  }

  it('Codex gets the session context, charter included, as developer_instructions', async () => {
    const env = await acpStartFor('codex')
    const config = JSON.parse(env.CODEX_CONFIG ?? '{}') as { developer_instructions?: string }
    expect(config.developer_instructions).toContain(TEAM_CHARTER)
    keep('codex-worker-developer-instructions.txt', config.developer_instructions!)
  }, 60_000)

  it('another ACP engine gets no Walnut prompt (unchanged)', async () => {
    const env = await acpStartFor('opencode')
    expect(env.CODEX_CONFIG).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain('How we work')
    keep('opencode-adapter-env-keys.txt', Object.keys(env).sort().join('\n') + '\n')
  }, 60_000)
})
