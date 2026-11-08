/**
 * E2E: a project's launch defaults (src/core/sessions/project-launch-defaults.ts). A new task of a
 * project starts on the project's engine, model and permission mode when its launch names none;
 * the launch's own value wins; a project without defaults launches as before. Full server pipeline
 * with only the Claude CLI faked, so the engine here is Claude Code (the engine choice for another
 * engine is the unit test's, tests/core/sessions/project-launch-defaults.test.ts).
 *
 *   1. settings: the metadata write checks the values (engine, model with its engine, mode)
 *   2. the web's new task (quick-start): project model + mode, the named ones win, the folder's
 *      memory stays the user's, and the task notes where each value came from
 *   3. a task start (task_create / task_start, the web's Start on a task)
 *   4. the phone (POST /api/v1/sessions): an engine that issues its own ids yields for an older client
 *   5. a routine's run and the other launches that resolve none themselves (quickStartSession)
 *   6. Use global defaults: the three keys go, and a launch is the global one again
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId, getSessionsForTask } from '../../src/core/session-tracker.js'
import { getTask, getProjectMetadata, getStoreProjects } from '../../src/core/task-manager.js'
import { SESSION_MODEL_CLI_MAP } from '../../src/core/types.js'
import { getFrequentDirs } from '../../src/core/frequent-dirs.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const SONNET_CLI = SESSION_MODEL_CLI_MAP.sonnet ?? 'sonnet'
const OPUS_CLI = SESSION_MODEL_CLI_MAP.opus ?? 'opus'
const PROJECT = 'Defaults Lab'

let server: HttpServer
let port: number
let daemon: MockDaemon

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs
  let v = await read()
  while (!ok(v) && Date.now() < end) { await delay(150); v = await read() }
  return v
}

async function req(method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`http://localhost:${port}${url}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }
}

const putMeta = (name: string, body: Record<string, unknown>) => req('PUT', `/api/projects/${encodeURIComponent(name)}/metadata`, body)

function seedTask(id: string, title: string, project: string) {
  return {
    id, title, status: 'todo', priority: 'none', category: 'Test', project, cwd: '/tmp',
    session_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    description: '', summary: '', note: '', subtasks: [], phase: 'TODO', source: 'local',
  }
}

/** The session a task's start made, once its CLI reported its model (one that runs on the CLI's
 *  own model reports none: then only a short wait for the record). */
async function sessionOf(sid: string, withModel = true) {
  return until(() => getSessionByClaudeId(sid), (r) => withModel ? !!r?.cliModel : !!r, withModel ? 15_000 : 3_000)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [seedTask('pld-start', 'Started by an agent', PROJECT), seedTask('pld-named', 'Names its mode', PROJECT), seedTask('pld-effort', 'Names an effort', PROJECT)],
  }))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await delay(1500)
}, 30_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await delay(500)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 15_000)

describe('project launch defaults E2E', () => {
  it('the settings write checks each value', async () => {
    expect((await putMeta(PROJECT, { default_engine: 'nope' })).status).toBe(400)
    const noEngine = await putMeta(PROJECT, { default_model: 'sonnet' })
    expect(noEngine.status).toBe(400)
    expect(noEngine.json.error).toMatch(/needs default_engine/)
    expect((await putMeta(PROJECT, { default_mode: 'yolo' })).status).toBe(400)
    expect((await putMeta(PROJECT, { default_engine: 'claude', default_model: 'a b' })).status).toBe(400)
    // The phone's route checks the same way.
    expect((await req('PUT', `/api/v1/projects/${encodeURIComponent(PROJECT)}/metadata`, { default_mode: 'yolo' })).status).toBe(400)
    // Nothing was written by the refusals.
    const meta = await getProjectMetadata(PROJECT)
    expect(meta?.default_engine).toBeUndefined()
    expect(meta?.default_mode).toBeUndefined()
    // A refused write on a project that does not exist yet makes no row either.
    expect((await putMeta('Never Made', { default_engine: 'nope' })).status).toBe(400)
    expect((await putMeta('Never Made Either', { default_model: 'sonnet' })).status).toBe(400)
    expect(Object.keys(await getStoreProjects()).map((n) => n.toLowerCase())).not.toContain('never made')
    expect(Object.keys(await getStoreProjects()).map((n) => n.toLowerCase())).not.toContain('never made either')

    const ok = await putMeta(PROJECT, { default_engine: 'claude', default_model: 'sonnet', default_mode: 'accept' })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json).toMatchObject({ default_engine: 'claude', default_model: 'sonnet', default_mode: 'accept' })
    // The project list carries them (the web's registry store reads them there).
    const list = await req('GET', '/api/projects')
    const row = (list.json.projects as Array<{ name: string; metadata?: Record<string, unknown> }>).find((p) => p.name === PROJECT)
    expect(row?.metadata).toMatchObject({ default_engine: 'claude', default_model: 'sonnet', default_mode: 'accept' })
  })

  it('a project with no defaults launches as before, and says global', async () => {
    const plain = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello', project: 'Plain Project' })
    expect(plain.status, JSON.stringify(plain.json)).toBe(200)
    const rec = await sessionOf(plain.json.sessionId, false)
    expect(rec?.mode).not.toBe('accept')
    expect(rec?.cliModel).not.toBe(SONNET_CLI)
    expect((await getTask(plain.json.taskId)).launch_source).toMatchObject({ engine: 'global', model: 'global', mode: 'global' })
  })

  it("the web's new task takes the project's model and mode; what it names wins; the folder memory stays", async () => {
    const memOf = async () => (await getFrequentDirs()).find((d) => d.cwd === '/tmp' && !d.host)?.lastLaunch
    // The user's own pick first: the folder remembers opus.
    const named = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello', project: PROJECT, model: 'opus', mode: 'plan' })
    expect(named.status, JSON.stringify(named.json)).toBe(200)
    const namedRec = await sessionOf(named.json.sessionId)
    expect(namedRec?.cliModel).toBe(OPUS_CLI)
    expect(namedRec?.mode).toBe('plan')
    expect((await getTask(named.json.taskId)).launch_source).toMatchObject({ engine: 'global', model: 'task', mode: 'task' })
    await until(memOf, (m) => m?.model === 'opus')

    const quick = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello', project: PROJECT })
    expect(quick.status, JSON.stringify(quick.json)).toBe(200)
    const rec = await sessionOf(quick.json.sessionId)
    expect(rec?.cliModel).toBe(SONNET_CLI)
    expect(rec?.mode).toBe('accept')
    expect(rec?.engine ?? 'claude').toBe('claude')
    expect((await getTask(quick.json.taskId)).launch_source).toMatchObject({
      engine: 'project', model: 'project', mode: 'project', project: PROJECT,
      // What it ran on, so a later switch in the session reads as the task's own pick.
      started: { engine: 'claude', model: SONNET_CLI, mode: 'accept' },
    })
    // The project's pick is not the user's: the folder keeps opus.
    await delay(800)
    expect(await memOf()).toMatchObject({ model: 'opus' })

    // Named mode only: the project's model still applies, the mode is the launch's.
    const modeOnly = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello', project: PROJECT, mode: 'default' })
    const modeRec = await sessionOf(modeOnly.json.sessionId)
    expect(modeRec?.cliModel).toBe(SONNET_CLI)
    expect(modeRec?.mode).toBe('default')

    // Ask Walnut keeps its own rules.
    const ask = await req('POST', '/api/sessions/quick-start', { cwd: '', message: 'hello', walnutAgent: true, project: PROJECT })
    expect(ask.status, JSON.stringify(ask.json)).toBe(200)
    expect((await getTask(ask.json.taskId)).launch_source ?? undefined).toBeUndefined()

    // The folder's remembered pick, replayed by a draft of a project with no engine: recorded as the folder's.
    await putMeta('Folder Lab', { default_mode: 'plan' })
    const folder = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello', project: 'Folder Lab', model: 'opus', fromFolder: true })
    expect(folder.status, JSON.stringify(folder.json)).toBe(200)
    expect((await getTask(folder.json.taskId)).launch_source).toMatchObject({ engine: 'global', model: 'folder', mode: 'project' })
  }, 60_000)

  it("a task start (task_create / task_start) of the project's task takes them too; a named mode wins", async () => {
    const started = await req('POST', '/api/v1/tasks/pld-start/start', { message: 'go', cwd: '/tmp' })
    expect([200, 202], JSON.stringify(started.json)).toContain(started.status)
    const sid = await until(async () => (await getSessionsForTask('pld-start'))[0]?.claudeSessionId, (v) => !!v)
    const rec = await sessionOf(sid!)
    expect(rec?.cliModel).toBe(SONNET_CLI)
    expect(rec?.mode).toBe('accept')
    expect((await getTask('pld-start')).launch_source).toMatchObject({
      engine: 'project', model: 'project', mode: 'project', project: PROJECT, started: { engine: 'claude', model: SONNET_CLI, mode: 'accept' },
    })

    const named = await req('POST', '/api/v1/tasks/pld-named/start', { message: 'go', cwd: '/tmp', mode: 'plan' })
    expect([200, 202], JSON.stringify(named.json)).toContain(named.status)
    const namedSid = await until(async () => (await getSessionsForTask('pld-named'))[0]?.claudeSessionId, (v) => !!v)
    const namedRec = await sessionOf(namedSid!)
    expect(namedRec?.mode).toBe('plan')
    expect(namedRec?.cliModel).toBe(SONNET_CLI)
    expect((await getTask('pld-named')).launch_source).toMatchObject({ engine: 'project', model: 'project', mode: 'task' })

    // An effort alone tunes the project's model: still the project's engine and model.
    const effort = await req('POST', '/api/v1/tasks/pld-effort/start', { message: 'go', cwd: '/tmp', effort: 'high' })
    expect([200, 202], JSON.stringify(effort.json)).toContain(effort.status)
    const effortSid = await until(async () => (await getSessionsForTask('pld-effort'))[0]?.claudeSessionId, (v) => !!v)
    expect((await sessionOf(effortSid!))?.cliModel).toBe(SONNET_CLI)
    expect((await getTask('pld-effort')).launch_source).toMatchObject({ engine: 'project', model: 'project', mode: 'project' })
  }, 60_000)

  it('the phone takes them; a project engine that issues its own ids yields for an older client', async () => {
    const phone = await req('POST', '/api/v1/sessions', { cwd: '/tmp', message: 'hello', project: PROJECT })
    expect(phone.status, JSON.stringify(phone.json)).toBe(201)
    const rec = await sessionOf(phone.json.sessionId)
    expect(rec?.cliModel).toBe(SONNET_CLI)
    expect(rec?.mode).toBe('accept')

    // The draft's own "Default" model over the project's: it names Claude Code, so the engine is its own.
    const own = await req('POST', '/api/v1/sessions', { cwd: '/tmp', message: 'hello', project: PROJECT, engine: 'claude' })
    expect(own.status, JSON.stringify(own.json)).toBe(201)
    const ownRec = await sessionOf(own.json.sessionId, false)
    expect(ownRec?.cliModel ?? '').not.toBe(SONNET_CLI)
    expect(ownRec?.mode).toBe('accept')
    // Its model is the engine's own default: no one picked one.
    expect((await getTask(own.json.taskId)).launch_source).toMatchObject({ engine: 'task', model: 'global', mode: 'project' })
    // Only Claude Code can be named from the phone: another engine is ignored, as it always was.
    const other = await req('POST', '/api/v1/sessions', { cwd: '/tmp', message: 'hello', project: PROJECT, engine: 'codex' })
    expect(other.status).toBe(201)
    expect((await getTask(other.json.taskId)).launch_source).toMatchObject({ engine: 'project', model: 'project' })

    await putMeta('Codex Lab', { default_engine: 'codex', default_mode: 'plan' })
    const older = await req('POST', '/api/v1/sessions', { cwd: '/tmp', message: 'hello', project: 'Codex Lab' })
    expect(older.status, JSON.stringify(older.json)).toBe(201)
    expect(typeof older.json.sessionId).toBe('string')
    const olderRec = await sessionOf(older.json.sessionId, false)
    expect(olderRec?.engine ?? 'claude').toBe('claude')
    expect(olderRec?.mode).toBe('plan')
    expect((await getTask(older.json.taskId)).launch_source).toMatchObject({ engine: 'global', mode: 'project' })

    // A client that opens a launch answered without an id (the phone's drafts now): the project's engine runs.
    const newer = await req('POST', '/api/v1/sessions', { cwd: '/tmp', message: 'hello', project: 'Codex Lab', sessionIdOptional: true })
    expect(newer.status, JSON.stringify(newer.json)).toBe(201)
    expect(newer.json.sessionId).toBeUndefined()
    expect((await getTask(newer.json.taskId)).launch_source).toMatchObject({ engine: 'project', mode: 'project', started: { engine: 'codex' } })
  }, 60_000)

  it("a routine's run (and every launch that resolved none itself) takes them; its minted id follows the project's engine", async () => {
    const { quickStartSession } = await import('../../src/core/sessions/quick-start.js')
    const { defaultRunStartDeps } = await import('../../src/core/routines/run-start-deps.js')
    const deps = defaultRunStartDeps()
    // A Claude Code project: an id is minted, and the run starts on the project's model and mode.
    const sid = await deps.mintSessionId(undefined, undefined, PROJECT)
    expect(typeof sid).toBe('string')
    const run = await quickStartSession({ message: 'hello', cwd: '/tmp', project: PROJECT, source: 'routine', taskMeta: { pinTier: null }, preassignedSessionId: sid })
    const rec = await sessionOf(sid!)
    expect(rec?.cliModel).toBe(SONNET_CLI)
    expect(rec?.mode).toBe('accept')
    expect((await getTask(run.id)).launch_source).toMatchObject({ engine: 'project', model: 'project', mode: 'project', project: PROJECT })
    // A Codex project: no id is minted (Codex issues its own), so the run can start Codex.
    expect(await deps.mintSessionId(undefined, undefined, 'Codex Lab')).toBeUndefined()
    // A caller that promised an id keeps it: Claude Code, the project's mode still applies.
    const promised = crypto.randomUUID()
    const kept = await quickStartSession({ message: 'hello', cwd: '/tmp', project: 'Codex Lab', source: 'notification-repair', preassignedSessionId: promised })
    const keptRec = await sessionOf(promised, false)
    expect(keptRec?.engine ?? 'claude').toBe('claude')
    expect(keptRec?.mode).toBe('plan')
    expect((await getTask(kept.id)).launch_source).toMatchObject({ engine: 'global', mode: 'project' })
    // A project with none: exactly as before, no note.
    const plain = await quickStartSession({ message: 'hello', cwd: '/tmp', project: 'Plain Routine', source: 'routine', taskMeta: { pinTier: null } })
    expect((await getTask(plain.id)).launch_source ?? undefined).toBeUndefined()
  }, 60_000)

  it('a launch that names a project by a name it was renamed away from takes the survivor\'s defaults', async () => {
    await req('POST', '/api/tasks', { title: 'Seed before', project: 'Before Lab', pinned: false })
    expect((await putMeta('Before Lab', { default_engine: 'claude', default_model: 'sonnet', default_mode: 'plan' })).status).toBe(200)
    const renamed = await req('PATCH', `/api/projects/${encodeURIComponent('Before Lab')}`, { name: 'After Lab' })
    expect(renamed.status, JSON.stringify(renamed.json)).toBe(200)
    const quick = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello', project: 'Before Lab' })
    expect(quick.status, JSON.stringify(quick.json)).toBe(200)
    const rec = await sessionOf(quick.json.sessionId)
    expect(rec?.mode).toBe('plan')
    expect(rec?.cliModel).toBe(SONNET_CLI)
    const task = await getTask(quick.json.taskId)
    expect(task.project).toBe('After Lab')
    expect(task.launch_source).toMatchObject({ engine: 'project', model: 'project', mode: 'project', project: 'After Lab' })
  }, 30_000)

  it('Use global defaults clears all three, and a launch is the global one again', async () => {
    const cleared = await putMeta(PROJECT, { default_engine: null, default_model: null, default_mode: null })
    expect(cleared.status).toBe(200)
    expect(cleared.json.default_engine).toBeUndefined()
    expect(cleared.json.default_model).toBeUndefined()
    expect(cleared.json.default_mode).toBeUndefined()
    const quick = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello', project: PROJECT })
    const rec = await sessionOf(quick.json.sessionId, false)
    expect(rec?.mode).not.toBe('accept')
    expect((await getTask(quick.json.taskId)).launch_source).toMatchObject({ engine: 'global', model: 'global', mode: 'global' })
  }, 30_000)
})
