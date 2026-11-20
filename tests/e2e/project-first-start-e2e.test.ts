/**
 * A new task started from a project (src/core/workspaces/project-source.ts): the project says
 * where its code comes from, and a start names only the project.
 *
 *   - PUT /api/projects/:name/metadata takes a good `workspace_source` and refuses a bad one;
 *   - GET /api/projects and GET /api/v1/projects carry `start_source` per row (null without one);
 *   - POST /api/sessions/quick-start `fromProject` files the task with a workspace request from
 *     the project's source (`preparing: true`, no session id), its session then starts inside the
 *     made workspace, and the array values used are counted on the project;
 *   - a project with no source answers 400 no-project-source, on both routes;
 *   - POST /api/v1/sessions `fromProject` does the same through the workspace step;
 *   - an agent's task_create in such a project, naming no folder, starts from the source while
 *     `project_first_start` is on, and in the folder as before while it is off;
 *   - a start without `fromProject` is unchanged.
 *
 * What's real: the server, the task store, the workspace manager, the daemon's workspace core
 * (MockDaemon runs it: git worktrees and a plugin provider's script run for real). Mocked: the
 * constants and the Claude CLI (mock-claude.mjs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-project-first-start'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getProjectMetadata, getTask } from '../../src/core/task-manager.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { __setWorkspaceConnectionForTesting } from '../../src/core/workspaces/daemon-client.js'
import { __setWorkspacePluginSourceForTesting } from '../../src/core/workspaces/registry.js'
import { resolveProjectStart } from '../../src/core/workspaces/project-source.js'
import { getDirectDaemonConnection } from '../../src/providers/daemon-connection.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: Server
let daemon: MockDaemon
let port: number
let scratch: string
let repo: string
let pluginAnchor: string

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

async function makeRepo(name: string): Promise<string> {
  const dir = path.join(scratch, name)
  await fs.mkdir(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

/** A plugin workspace provider whose create makes a folder (one git repo) under the scratch root. */
async function makePlugin(): Promise<string> {
  const dir = path.join(scratch, 'plugin')
  await fs.mkdir(dir, { recursive: true })
  const roots = path.join(scratch, 'plugin-workspaces')
  await fs.mkdir(roots, { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    apiVersion: 1, id: 'monorepo-test', name: 'Monorepo test', version: '1.0.0',
    capabilities: { workspace: { providers: [{
      id: 'monorepo-test', displayName: 'Monorepo workspace', priority: 50, markers: ['workspace.toml'],
      command: ['node', '{script}'], script: 'provider.js', roots: [roots],
      inputSchema: { type: 'object', properties: { packages: { type: 'array', title: 'Packages' } }, required: ['packages'] },
    }] } },
  }))
  await fs.writeFile(path.join(dir, 'provider.js'), `
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
let input = ''
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  const req = JSON.parse(input), a = req.arguments || {}
  const reply = (result) => process.stdout.write(JSON.stringify({ version: 1, ok: true, result }) + '\\n')
  if (req.operation === 'detect') return reply({ claimed: true, root: a.anchor })
  if (req.operation === 'create') {
    const root = path.join(${JSON.stringify(roots)}, a.name)
    fs.mkdirSync(root, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    fs.writeFileSync(path.join(root, 'packages.txt'), (a.inputs.packages || []).join(','))
    return reply({ root, cwd: root, repos: [{ path: root, name: 'main' }] })
  }
  if (req.operation === 'listRepos') return reply({ repos: [{ path: a.root, name: 'main' }] })
  if (req.operation === 'remove') { fs.rmSync(a.root, { recursive: true, force: true }); return reply({ removed: true }) }
  reply({})
})
`)
  return dir
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-project-start-')))
  repo = await makeRepo('marina')
  pluginAnchor = path.join(scratch, 'acme-base')
  await fs.mkdir(pluginAnchor, { recursive: true })
  await fs.writeFile(path.join(pluginAnchor, 'workspace.toml'), '')
  const pluginDir = await makePlugin()
  __setWorkspacePluginSourceForTesting(async () => [{ id: 'monorepo-test', pluginDir, capabilities: ['workspace'] }])
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  __setWorkspaceConnectionForTesting(async () => getDirectDaemonConnection('__local__', `ws://127.0.0.1:${daemon.port}`))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
}, 120_000)

afterAll(async () => {
  __setWorkspaceConnectionForTesting(null)
  __setWorkspacePluginSourceForTesting(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
})

/** The task's session started, inside its made workspace. */
async function startedIn(taskId: string): Promise<string> {
  let cwd = ''
  await vi.waitFor(async () => {
    const ws = (await getTask(taskId)).workspace
    expect(ws?.state).toBe('ready')
    const start = daemon.getCommandHistoryFor('start').find((c) => String(c.payload.cwd ?? '').startsWith(ws!.root!))
    expect(start).toBeDefined()
    cwd = String(start!.payload.cwd)
  }, { timeout: 45_000 })
  return cwd
}

describe('a project says where its code comes from', () => {
  it('the settings take a good source and refuse a bad one', async () => {
    const ok = await call('PUT', '/api/projects/Marina/metadata', { default_cwd: repo, workspace_source: { provider: 'git-worktree', anchor: repo } })
    expect(ok.status).toBe(200)
    expect(ok.json.workspace_source).toEqual({ provider: 'git-worktree', anchor: repo })
    const acme = await call('PUT', '/api/projects/Acme/metadata', {
      workspace_source: { provider: 'monorepo-test', anchor: pluginAnchor, inputs: { packages: ['Alpha'] } },
    })
    expect(acme.status).toBe(200)
    expect((await call('PUT', '/api/projects/Plain/metadata', { default_cwd: repo })).status).toBe(200)

    for (const bad of [{ provider: 3 }, { provider: 'git-worktree', anchor: 'relative' }, { provider: 'git-worktree', inputs: [1] }, 'git-worktree']) {
      const r = await call('PUT', '/api/projects/Marina/metadata', { workspace_source: bad })
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect(String(r.json.error)).toMatch(/workspace_source/)
    }
    // A refused write changed nothing.
    expect((await getProjectMetadata('Marina'))?.workspace_source).toEqual({ provider: 'git-worktree', anchor: repo })
  })

  it('the project lists carry start_source, null without a source', async () => {
    for (const route of ['/api/projects', '/api/v1/projects']) {
      const { json } = await call('GET', route)
      const rows = json.projects as Array<{ name: string; start_source: unknown }>
      const row = (name: string) => rows.find((r) => r.name === name)?.start_source
      expect(row('Marina'), route).toMatchObject({ provider: 'git-worktree', provider_name: 'Git worktree', anchor: repo, host: '__local__', inputs: {}, suggestions: {} })
      expect(row('Acme'), route).toMatchObject({
        provider: 'monorepo-test', provider_name: 'Monorepo workspace', anchor: pluginAnchor, inputs: { packages: ['Alpha'] },
        suggestions: { packages: ['Alpha'] }, input_schema: { properties: { packages: { type: 'array' } } },
      })
      expect(row('Plain'), route).toBeNull()
    }
  })
})

describe('starting a new task from a project', () => {
  it('quick-start files the task with a git worktree from the project\'s checkout, then starts in it', async () => {
    const r = await call('POST', '/api/sessions/quick-start', { fromProject: true, project: 'marina', cwd: '/ignored', message: 'Fix the parser' })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json).toMatchObject({ taskId: expect.any(String), preparing: true })
    expect(r.json.sessionId).toBeUndefined()
    const taskId = r.json.taskId as string
    const task = await getTask(taskId)
    expect(task.project).toBe('Marina')
    expect(task.workspace).toMatchObject({ provider: 'git-worktree', host: '__local__', anchor: repo })
    const cwd = await startedIn(taskId)
    expect(cwd).not.toBe(repo)
  })

  it('a plugin source makes its workspace with the ticked values, and counts them on the project', async () => {
    const r = await call('POST', '/api/sessions/quick-start', {
      fromProject: true, project: 'Acme', message: 'Tidy both', workspaceInputs: { packages: ['Alpha', 'Beta'], junk: ['Unknown'] },
    })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json).toMatchObject({ preparing: true })
    const taskId = r.json.taskId as string
    expect((await getTask(taskId)).workspace).toMatchObject({ provider: 'monorepo-test', inputs: { packages: ['Alpha', 'Beta'] } })
    const cwd = await startedIn(taskId)
    expect(await fs.readFile(path.join(cwd, 'packages.txt'), 'utf8')).toBe('Alpha,Beta')
    // Only what the start used, in the provider's own fields: the unknown field is not counted.
    await vi.waitFor(async () => {
      expect((await getProjectMetadata('Acme'))?.workspace_source_usage).toEqual({ packages: { Alpha: 1, Beta: 1 } })
    }, { timeout: 10_000 })
    // The suggestions follow the counts: the favourite first, then the used values.
    const { json } = await call('GET', '/api/projects')
    const row = (json.projects as Array<{ name: string; start_source: { suggestions: Record<string, string[]> } }>).find((p) => p.name === 'Acme')
    expect(row?.start_source.suggestions.packages).toEqual(['Alpha', 'Beta'])
  })

  it('host: absent or "" is the project\'s own host, "__local__" this machine (both routes resolve it here)', async () => {
    const put = await call('PUT', '/api/projects/Remote/metadata', { default_host: 'devbox', workspace_source: { provider: 'git-worktree', anchor: '/src/remote' } })
    expect(put.status, JSON.stringify(put.json)).toBe(200)
    expect((await resolveProjectStart('Remote')).host).toBe('devbox')
    expect((await resolveProjectStart('Remote', { host: '' })).host).toBe('devbox')
    expect((await resolveProjectStart('Remote', { host: '__local__' })).host).toBe('__local__')
    expect((await resolveProjectStart('Remote', { host: 'other' })).host).toBe('other')
    // The remote folder stays as written: its own host expands a `~`.
    expect((await resolveProjectStart('Remote', { host: '' })).cwd).toBe('/src/remote')
  })

  it('a project without a source answers 400 no-project-source, and files nothing', async () => {
    const before = (await call('GET', '/api/projects')).json.projects as Array<{ name: string; counts: { todo: number; active: number } }>
    const r = await call('POST', '/api/sessions/quick-start', { fromProject: true, project: 'Plain', message: 'x' })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('no-project-source')
    const v1 = await call('POST', '/api/v1/sessions', { fromProject: true, project: 'Plain', message: 'x' })
    expect(v1.status).toBe(400)
    expect(v1.json.error).toMatchObject({ code: 'no-project-source' })
    const after = (await call('GET', '/api/projects')).json.projects as typeof before
    expect(after.find((p) => p.name === 'Plain')?.counts).toEqual(before.find((p) => p.name === 'Plain')?.counts)
    expect((await call('POST', '/api/sessions/quick-start', { fromProject: true, project: 'Nowhere', message: 'x' })).json.code).toBe('unknown-project')
  })

  it('the phone\'s launch does the same through the workspace step, answering preparing', async () => {
    const r = await call('POST', '/api/v1/sessions', { fromProject: true, project: 'Marina', message: 'From the phone' })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    expect(r.json).toMatchObject({ taskId: expect.any(String), title: expect.any(String), preparing: true })
    expect(r.json.sessionId).toBeUndefined()
    const taskId = r.json.taskId as string
    expect((await getTask(taskId)).workspace).toMatchObject({ provider: 'git-worktree', anchor: repo })
    await startedIn(taskId)
  })

  it('an agent\'s new task in the project starts from its source only while project_first_start is on', async () => {
    const create = async (title: string) => {
      const made = await call('POST', '/api/tasks', { title, project: 'Marina' })
      expect(made.status, JSON.stringify(made.json)).toBeLessThan(300)
      const id = (made.json.task as { id: string }).id
      return { id, start: await call('POST', `/api/v1/tasks/${id}/start`, { message: title }) }
    }
    const off = await create('Agent start, experiment off')
    expect(off.start.status, JSON.stringify(off.start.json)).toBeLessThan(300)
    expect((await getTask(off.id)).workspace).toBeUndefined()

    await updateConfig({ experimental: { project_first_start: true } })
    try {
      const on = await create('Agent start, experiment on')
      expect(on.start.status, JSON.stringify(on.start.json)).toBeLessThan(300)
      expect((await getTask(on.id)).workspace).toMatchObject({ provider: 'git-worktree', anchor: repo, host: '__local__' })
      await startedIn(on.id)
    } finally {
      await updateConfig({ experimental: { project_first_start: false } })
    }
  })

  it('a start without fromProject is unchanged', async () => {
    const r = await call('POST', '/api/sessions/quick-start', { cwd: repo, project: 'Marina', message: 'In the folder' })
    expect(r.status).toBe(200)
    expect(r.json.preparing).toBeUndefined()
    expect(r.json.sessionId).toEqual(expect.any(String))
    expect((await getTask(r.json.taskId as string)).workspace).toBeUndefined()
    const v1 = await call('POST', '/api/v1/sessions', { cwd: repo, message: 'Phone, in the folder' })
    expect(v1.status).toBe(201)
    expect(v1.json).toMatchObject({ sessionId: expect.any(String), taskId: expect.any(String) })
    expect(v1.json.preparing).toBeUndefined()
    // The phone's old shape still needs its folder.
    expect((await call('POST', '/api/v1/sessions', { message: 'no folder' })).status).toBe(400)
  })
})
