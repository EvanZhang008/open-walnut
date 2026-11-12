/**
 * A VP or lead runs in its own task directory, never in its project's repository
 * (src/core/sessions/org-own-folder.ts), through the real server (mock daemon + mock CLI).
 * 2026-11-12, the user: the Walnut VP ran in the repository, so every request carried the
 * repository's instruction files (about 62K tokens).
 *
 * Pinned: a lead's start lands in its task directory although its project names a repository; a
 * person's own folder for a start is kept; a lead already running in a repository is moved by its
 * post-compaction respawn even with its prompt current, keeping its conversation (`--resume`, the
 * transcript and its sidecar moved to the new folder's project dir), the record points there
 * (the task keeps its folder for its subtasks), and its next message says so once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-own-folder-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'
import { addTask, getTask, setProjectMetadata, updateTaskRaw } from '../../src/core/task-manager.js'
import { taskDirForHost } from '../../src/core/sessions/task-dir-place.js'
import { localClaudeProjectsDir } from '../../src/core/claude-config-dir.js'
import { encodeProjectPath } from '../../src/core/session-file-reader.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
let repo: string

async function req(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function until<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await probe()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    v = await probe()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 400)}`)
  return v
}

const starts = (sid: string) => daemon.getCommandHistoryFor('start').filter((c) => c.payload.sid === sid)
const sentTexts = (sid: string) => daemon.getCommandHistoryFor('send')
  .filter((c) => c.payload.sid === sid)
  .map((c) => String(c.payload.text ?? c.payload.message ?? ''))
const real = (p: string) => { try { return realpathSync(p) } catch { return p } }
const transcriptIn = (cwd: string, sid: string) => path.join(localClaudeProjectsDir(), encodeProjectPath(real(cwd)), `${sid}.jsonl`)

async function newLead(title: string): Promise<string> {
  return (await addTask({ title, project: 'Acme', source: 'local', org_role: 'lead' } as never)).task.id
}

async function startLead(id: string, body: Record<string, unknown> = {}): Promise<string> {
  const started = await req('POST', `/api/v1/tasks/${id}/start`, { message: 'big-context-turn:60000:1h', ...body })
  expect(started.status, JSON.stringify(started.json)).toBeLessThan(300)
  const sid = await until('session', async () => (await getTask(id)).session_id, (s) => !!s)
  await until('first turn ended', () => getSessionByClaudeId(sid!), (r) => r?.process_status === 'idle' && !!r.appliedAppendSystemPrompt)
  return sid!
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  process.env.WALNUT_PROMPT_REFRESH_QUIET_MS = '4000'
  process.env.MOCK_COMPACT_MS = '500'
  process.env.MOCK_CLAUDE_TRANSCRIPT_DIR = localClaudeProjectsDir()
  // A repository with instruction files of its own: the project's default folder.
  repo = path.join(WALNUT_HOME, 'repos', 'acme')
  await fs.mkdir(repo, { recursive: true })
  await fs.writeFile(path.join(repo, 'CLAUDE.md'), '# Acme\nlong repository instructions\n')
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await setProjectMetadata('Acme', { default_cwd: repo })
}, 120_000)

afterAll(async () => {
  delete process.env.WALNUT_PROMPT_REFRESH_QUIET_MS
  delete process.env.MOCK_COMPACT_MS
  delete process.env.MOCK_CLAUDE_TRANSCRIPT_DIR
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a VP or lead runs in its own folder', () => {
  it('starts in its task directory although its project names a repository', async () => {
    const id = await newLead('Acme lead')
    const sid = await startLead(id)
    const own = (await taskDirForHost(id, '__local__'))!
    expect((await getSessionByClaudeId(sid))!.cwd).toBe(own)
    expect(starts(sid)[0].payload.cwd).toBe(own)
    expect(existsSync(own)).toBe(true)
  }, 120_000)

  it('a lead already in a repository is moved by its post-compaction respawn, prompt current, conversation kept', async () => {
    const id = await newLead('Acme lead from before')
    // A person names the repository for this start: kept for it (and, while marked, by its spawns).
    const sid = await startLead(id, { cwd: repo })
    const rec0 = (await getSessionByClaudeId(sid))!
    expect(rec0.cwd).toBe(repo)
    expect(rec0.cwdByPerson).toBe(repo)
    // As a lead started before this rule: no person's mark, the task records the repository.
    await updateSessionRecord(sid, { cwdByPerson: undefined })
    await updateTaskRaw(id, { cwd: repo })
    const from = transcriptIn(repo, sid)
    expect(existsSync(from), from).toBe(true)
    // Subagent transcripts live beside it, under <sid>/.
    await fs.mkdir(path.join(path.dirname(from), sid, 'subagents'), { recursive: true })
    await fs.writeFile(path.join(path.dirname(from), sid, 'subagents', 'agent-1.jsonl'), '{}\n')
    const startsBefore = starts(sid).length

    await sendMessageToSession(sid, '/compact', { source: 'ui', taskId: id })
    const rec = await until('respawned in its own folder', () => getSessionByClaudeId(sid),
      (r) => r?.promptRefresh?.outcome === 'respawned' && starts(sid).length > startsBefore, 40_000)
    const own = (await taskDirForHost(id, '__local__'))!
    // Its prompt lacked nothing: only the folder made the respawn pay.
    expect(rec!.promptRefresh!.debtBytes).toBe(0)
    const respawn = starts(sid).at(-1)!
    expect(respawn.payload.cwd).toBe(own)
    const args = respawn.payload.args as string[]
    expect(args[args.indexOf('--resume') + 1]).toBe(sid)
    expect(rec!.cwd).toBe(own)
    expect(rec!.folderMoved).toMatchObject({ from: repo, to: own, why: 'own-folder' })
    // The task keeps its folder: its subtasks with none of their own inherit it and work there.
    expect((await getTask(id)).cwd).toBe(repo)
    // The conversation moved where a resume in the new folder finds it, sidecar included.
    const to = transcriptIn(own, sid)
    expect(existsSync(to), to).toBe(true)
    expect(existsSync(from)).toBe(false)
    expect(existsSync(path.join(path.dirname(to), sid, 'subagents', 'agent-1.jsonl'))).toBe(true)
    await until('idle again', () => getSessionByClaudeId(sid), (r) => r?.process_status === 'idle')

    // The next message says so, once.
    const sendsBefore = sentTexts(sid).length
    await sendMessageToSession(sid, 'big-context-turn:30000:1h', { source: 'ui', taskId: id })
    const texts = await until('next line sent', async () => sentTexts(sid), (t) => t.length > sendsBefore)
    expect(texts.at(-1)).toContain('outcome="folder-moved"')
    expect(texts.at(-1)).toContain(`from ${repo} to ${own}`)
    expect((await getSessionByClaudeId(sid))!.folderMoved!.told).toBe(true)
  }, 150_000)

  it('a person\'s own folder is kept by later spawns', async () => {
    const id = await newLead('Acme lead the user placed')
    const sid = await startLead(id, { cwd: repo })
    const startsBefore = starts(sid).length
    await sendMessageToSession(sid, '/compact', { source: 'ui', taskId: id })
    const rec = await until('decided', () => getSessionByClaudeId(sid), (r) => !!r?.promptRefresh, 30_000)
    expect(rec!.promptRefresh!.outcome).toBe('current')
    expect(starts(sid).length).toBe(startsBefore)
    expect(rec!.cwd).toBe(repo)
  }, 120_000)
})
