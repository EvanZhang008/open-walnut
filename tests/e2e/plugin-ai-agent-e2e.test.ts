/**
 * The agent route of ai.run, end to end on the real session stack: aiRun → runLaneTurn → a lane
 * session record (no task) → SESSION_START → claude-code-session → a daemon → a CLI process.
 *
 * What it proves: the run lands on the daemon as a hidden lane session in the caller's folder, in
 * dontAsk mode with the plugin's prompt replacing the CLI's and only the named tools; a one-shot
 * run's session is stopped and archived after its answer; a conversation keeps ONE session across
 * calls until ai.end archives it; a second caller never shares that lane.
 *
 * Substituted, and only this: the daemon is the in-process mock daemon, and the CLI is
 * tests/providers/mock-claude.mjs (its answer echoes the message and its spawn flags). Nothing
 * here can run the real `claude`: HOME has no rc files and a shim `claude` on PATH refuses to run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-plugin-ai-agent-e2e'))
// The agent route requires an installed `claude`; here the mock CLI stands in for it.
vi.mock('../../src/model/providers/default-provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/model/providers/default-provider.js')>()),
  claudeCliAvailable: () => true,
}))

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { aiEnd, aiRun } from '../../src/core/ai/ai-run.js'
import { conversationLanes } from '../../src/core/ai/ai-conversations.js'
import { getSessionByClaudeId, getSessionByLane } from '../../src/core/session-tracker.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { AiCaller } from '../../src/core/ai/ai-types.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let daemon: MockDaemon
let base = ''
let workdir = ''
const savedEnv = { HOME: process.env.HOME, SHELL: process.env.SHELL, PATH: process.env.PATH }
const caller: AiCaller = { kind: 'plugin', id: 'tickets', name: 'Tickets' }

function stopDaemonIn(dir: string | undefined): void {
  if (!dir) return
  try {
    const pid = Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf-8').trim())
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM')
  } catch { /* not running */ }
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-ai-e2e-'))
  const home = path.join(base, 'home')
  const shim = path.join(base, 'bin')
  workdir = path.join(base, 'ticket-folder')
  await fsp.mkdir(home, { recursive: true })
  await fsp.mkdir(shim, { recursive: true })
  await fsp.mkdir(workdir, { recursive: true })
  await fsp.writeFile(path.join(shim, 'claude'), '#!/bin/sh\necho "claude is disabled in this test" >&2\nexit 1\n', { mode: 0o755 })
  process.env.HOME = home
  process.env.SHELL = '/bin/sh'
  process.env.PATH = `${shim}${path.delimiter}${savedEnv.PATH ?? ''}`

  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fsp.writeFile(CONFIG_FILE, yaml.dump({
    version: 1, user: { name: 'Ada' }, defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' }, agent: { provider: 'claude-code' },
  }), 'utf-8')
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  try { await stopServer() } catch { /* already down */ }
  await daemon?.stop()
  stopDaemonIn(process.env.WALNUT_DAEMON_DIR)
  process.env.HOME = savedEnv.HOME
  process.env.SHELL = savedEnv.SHELL
  process.env.PATH = savedEnv.PATH
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  if (base) await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('ai.run agent route on the daemon', () => {
  it('a one-shot run answers from a hidden dontAsk lane session in the caller folder, then archives it', async () => {
    const starts: Array<{ lane?: string; preassignedSessionId?: string }> = []
    bus.subscribe('test-ai-starts', (event) => {
      if (event.name === EventNames.SESSION_START) starts.push(event.data as { lane?: string; preassignedSessionId?: string })
    }, { global: true, interest: [EventNames.SESSION_START] })
    const result = await aiRun(caller, {
      prompt: 'Summarize ticket T-1 with its comments',
      system: 'You summarize tickets.',
      needs: { cwd: workdir, ops: ['task_get'] },
    })
    bus.unsubscribe('test-ai-starts')
    expect(result.route).toBe('agent')
    expect(result.text).toContain('Summarize ticket T-1 with its comments')
    expect(result.text).toContain('[permission-mode:dontAsk]')
    expect(result.text).toContain(`[cwd:${fs.realpathSync(workdir)}]`)

    // The lane record: no task, the plugin's prompt replacing the CLI's, only the named tools.
    expect(starts).toHaveLength(1)
    const { lane, preassignedSessionId } = starts[0]
    expect(lane).toMatch(/^ai:plugin%3Atickets:run-/)
    const record = await waitFor(async () => {
      const r = await getSessionByClaudeId(preassignedSessionId!)
      return r?.archived ? r : null
    }, 30_000, 'the one-shot lane to be archived')
    expect(record.taskId).toBe('')
    expect(record.mode).toBe('dontAsk')
    expect(record.profile?.systemPromptMode).toBe('replace')
    expect(record.profile?.systemPrompt).toContain('You summarize tickets.')
    expect(record.profile?.tools?.sort()).toEqual(['Bash', 'Glob', 'Grep', 'Read'])
    expect(record.profile?.allowedTools).toContain('Bash(walnut tools call task_get:*)')
    expect(record.profile?.allowedTools).not.toContain('Grep')
    expect(record.profile?.slim).toBe(true)
  }, 120_000)

  it('a conversation keeps one session across calls; ai.end archives it; another caller has its own', async () => {
    const first = await aiRun(caller, { prompt: 'first question', conversation: 'ticket:T-2', needs: { cwd: workdir } })
    const [lane] = await conversationLanes(caller, 'ticket:T-2')
    expect(lane).toMatch(/^ai:plugin%3Atickets:ticket:T-2\|[0-9a-f]{12}$/)
    const sessionId = (await getSessionByLane(lane))!.claudeSessionId
    const second = await aiRun(caller, { prompt: 'second question', conversation: 'ticket:T-2', needs: { cwd: workdir } })
    expect(first.text).toContain('first question')
    expect(second.text).toContain('second question')
    expect((await getSessionByLane(lane))!.claudeSessionId).toBe(sessionId)

    const other: AiCaller = { kind: 'plugin', id: 'other-plugin' }
    await aiRun(other, { prompt: 'their question', conversation: 'ticket:T-2', needs: { cwd: workdir } })
    const [otherLane] = await conversationLanes(other, 'ticket:T-2')
    expect(otherLane).not.toBe(lane)
    expect((await getSessionByLane(otherLane))!.claudeSessionId).not.toBe(sessionId)

    // Other needs on the same conversation: a session of their own, which reads the turns so far.
    const wider = await aiRun(caller, { prompt: 'third question', conversation: 'ticket:T-2', needs: { cwd: workdir, files: 'edit' } })
    expect(wider.text).toContain('first question')
    expect(await conversationLanes(caller, 'ticket:T-2')).toHaveLength(2)

    const lanes = await conversationLanes(caller, 'ticket:T-2')
    expect((await aiEnd(caller, 'ticket:T-2')).ended).toBe(true)
    for (const used of lanes) expect(await getSessionByLane(used)).toBeNull()
    expect((await getSessionByClaudeId(sessionId))?.archived).toBe(true)
  }, 180_000)
})
