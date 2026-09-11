/**
 * GET /api/v1/sessions — `scope` + `you`: where the CALLER stands.
 *
 * The bug this closes is a discovery bug, not a data bug: an agent that cannot
 * find "the sessions near me" reaches for its harness's own cross-session
 * messaging instead of session_send. So the list has to be able to narrow itself
 * to the caller's folder, then its project, and it has to say which row IS the
 * caller (the one target session_send always refuses).
 *
 * Real startServer({ port: 0, dev: true }) with an isolated temp home, real
 * tasks/folders/session records — the projection is built by the route itself,
 * so a field that never reaches ProjectedSession fails here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-session-scope'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'

let server: HttpServer
let port: number

const SID = {
  inFolder: 'sess-scope-folder-a',
  folderPeer: 'sess-scope-folder-b',
  projectOnly: 'sess-scope-project-c',
  otherProject: 'sess-scope-other-d',
}
let folderId = ''

interface ListBody {
  sessions: Array<Record<string, unknown>>
  you?: Record<string, unknown>
  scope: string
  syncedAt: string
}

async function list(query: string, callerSid?: string): Promise<{ status: number; body: ListBody & { error?: { code: string; message: string } } }> {
  const res = await fetch(`http://localhost:${port}/api/v1/sessions${query}`, {
    headers: callerSid ? { 'x-walnut-caller-sid': callerSid } : {},
  })
  return { status: res.status, body: await res.json() as ListBody & { error?: { code: string; message: string } } }
}

const ids = (body: ListBody): string[] => body.sessions.map((s) => String(s.id))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port

  const tm = await import('../../../src/core/task-manager.js')
  const st = await import('../../../src/core/session-tracker.js')
  await tm.ensureProject('marina', 'local')
  await tm.ensureProject('acme', 'local')

  const mk = async (title: string, project: string) => (await tm.addTask({
    title, project, priority: 'important', description: '', status: 'todo',
  } as Parameters<typeof tm.addTask>[0])).task

  const a = await mk('Auth fixture refactor', 'marina')
  const b = await mk('Auth fixture callers', 'marina')
  const c = await mk('Unrelated marina work', 'marina')
  const d = await mk('Another project entirely', 'acme')

  const folder = await tm.createFolder('Auth cleanup', 'marina')
  folderId = folder.group_id
  await tm.addToGroup(folderId, [a.id, b.id])

  await st.createSessionRecord(SID.inFolder, a.id, 'marina', '/tmp/marina', { title: 'Refactor the fixture' })
  await st.createSessionRecord(SID.folderPeer, b.id, 'marina', '/tmp/marina', { title: 'Update the callers' })
  await st.createSessionRecord(SID.projectOnly, c.id, 'marina', '/tmp/marina', { title: 'Something else' })
  await st.createSessionRecord(SID.otherProject, d.id, 'acme', '/tmp/acme', { title: 'Far away' })
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/sessions — default behaviour is untouched', () => {
  it('lists everything with no caller and no scope, and reports scope=all', async () => {
    const { status, body } = await list('')
    expect(status).toBe(200)
    expect(ids(body)).toEqual(expect.arrayContaining(Object.values(SID)))
    expect(body.scope).toBe('all')
    // No caller header means Walnut cannot place anyone, and it must not guess.
    expect(body.you).toBeUndefined()
  })

  it('stamps the owning task folder on every row (additive projection fields)', async () => {
    const { body } = await list('')
    const row = body.sessions.find((s) => s.id === SID.inFolder)!
    expect(row.group_id).toBe(folderId)
    expect(row.group_label).toBe('Auth cleanup')
    expect(row.project).toBe('marina')
    // A task in no folder carries neither key rather than an empty string.
    const loose = body.sessions.find((s) => s.id === SID.projectOnly)!
    expect(loose).not.toHaveProperty('group_id')
    expect(loose).not.toHaveProperty('group_label')
  })
})

describe('GET /api/v1/sessions — the caller own row (you)', () => {
  it('answers with the caller row, folder label included', async () => {
    const { body } = await list('', SID.inFolder)
    expect(body.you?.id).toBe(SID.inFolder)
    expect(body.you?.group_id).toBe(folderId)
    expect(body.you?.group_label).toBe('Auth cleanup')
    expect(body.you?.project).toBe('marina')
    expect(body.you?.task_title).toBe('Auth fixture refactor')
    // scope=all still lists everything: `you` is orientation, not a filter.
    expect(ids(body)).toEqual(expect.arrayContaining(Object.values(SID)))
  })

  it('has no `you` for a caller sid Walnut does not know', async () => {
    const { status, body } = await list('', 'sess-not-a-real-session')
    expect(status).toBe(200)
    expect(body.you).toBeUndefined()
  })
})

describe('GET /api/v1/sessions — scope rings', () => {
  it('scope=folder keeps only the sessions in the caller folder', async () => {
    const { status, body } = await list('?scope=folder', SID.inFolder)
    expect(status).toBe(200)
    expect(body.scope).toBe('folder')
    expect(ids(body).sort()).toEqual([SID.inFolder, SID.folderPeer].sort())
  })

  it('scope=project keeps the whole project and drops the rest', async () => {
    const { body } = await list('?scope=project', SID.inFolder)
    expect(body.scope).toBe('project')
    expect(ids(body).sort()).toEqual([SID.inFolder, SID.folderPeer, SID.projectOnly].sort())
    expect(ids(body)).not.toContain(SID.otherProject)
  })

  it('degrades scope=folder to the project ring for a caller in no folder, and says so', async () => {
    // Answering "no sessions" to a question that had an answer is the failure
    // mode: a folder-less caller still has a project.
    const { body } = await list('?scope=folder', SID.projectOnly)
    expect(body.scope).toBe('project')
    expect(ids(body).sort()).toEqual([SID.inFolder, SID.folderPeer, SID.projectOnly].sort())
  })

  it('keeps the status filter working alongside a scope', async () => {
    const { body: all } = await list('?scope=project', SID.inFolder)
    const someStatus = String(all.sessions[0].process_status)
    const { body } = await list(`?scope=project&status=${someStatus}`, SID.inFolder)
    expect(body.sessions.length).toBeGreaterThan(0)
    expect(body.sessions.every((s) => s.process_status === someStatus)).toBe(true)
    expect(ids(body)).not.toContain(SID.otherProject)
  })
})

describe('GET /api/v1/sessions — refusals are loud', () => {
  it('400s a narrowing scope with no session caller instead of silently listing everything', async () => {
    const { status, body } = await list('?scope=folder')
    expect(status).toBe(400)
    expect(body.error?.code).toBe('bad_request')
    expect(body.error?.message).toContain('x-walnut-caller-sid')
    // The message must name the call that DOES work.
    expect(body.error?.message).toContain('scope=all')
  })

  it('400s an unknown scope word', async () => {
    const { status, body } = await list('?scope=host', SID.inFolder)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('bad_request')
    expect(body.error?.message).toContain('folder, project, or all')
  })
})
