/**
 * A plugin whose manifest says `taskVisibility: "plugin"` keeps the tasks its agents run in to
 * its own view (Task.plugin_only), through a REAL server with two real plugins installed in the
 * data home: `keeper` declares the option, `plain` does not.
 *
 * 2026-10-26, the user: the tasks an interview practice plugin made for its AI partner showed on
 * the board, in the Org page and as three "needs you", although nobody can use them outside the
 * plugin. Checked here: the create stamp (op and direct create), every general list leaving the
 * row out (web list, v1 list, the phone's snapshot, Org counts, project counts, search), the
 * plugin's own reads still seeing it, keepInPlugin bringing an older task in and giving it back,
 * and a plugin without the option keeping today's behaviour.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WebSocket } from 'ws'

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

let server: HttpServer
let port: number
let ws: WebSocket
const frames: Array<{ type?: string; name?: string; data?: unknown }> = []

const PROJECT = 'Practice Room'

async function api(method: string, route: string, body?: unknown) {
  const r = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, data: text ? JSON.parse(text) : null }
}

async function op<T = any>(pluginId: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await api('POST', `/api/plugin-runtime/${pluginId}/ops/${pluginId}_${name}`, args)
  if (!r.data?.ok) throw new Error(`${pluginId}_${name}: ${JSON.stringify(r.data)}`)
  return r.data.result as T
}

async function until<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  let v = await probe()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    v = await probe()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 400)}`)
  return v
}

/** Both plugins carry the same ops; only the manifest differs. */
const PLUGIN_SERVER = `
export function activate(walnut) {
  const op = (name, handler) => walnut.registry.op({
    name, title: name, description: 'Plugin-only tasks probe: ' + name, readonly: false, remote: 'deny',
    inputSchema: { type: 'object', properties: {
      title: { type: 'string' }, project: { type: 'string' }, id: { type: 'string' },
      ids: { type: 'array', items: { type: 'string' } }, keep: { type: 'boolean' },
    } }, handler,
  })
  op('make', async (args) => {
    const r = walnut.ops.unwrap(await walnut.ops.call('task_create', { title: args.title, project: args.project, record_only: true }))
    return { id: r.id ?? r.taskId ?? r.task?.id }
  })
  op('create', async (args) => (await walnut.tasks.create({ title: args.title, project: args.project })))
  op('keep', async (args) => walnut.tasks.keepInPlugin(args.ids, args.keep))
  op('list', async (args) => walnut.tasks.list({ project: args.project }))
  op('get', async (args) => walnut.tasks.get(args.id))
}
`

async function installPlugin(id: string, manifestExtra: Record<string, unknown>) {
  const dir = path.join(WALNUT_HOME, 'plugins', id)
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: id, version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs', ...manifestExtra,
  }))
  await fs.writeFile(path.join(dir, 'dist', 'server.mjs'), PLUGIN_SERVER)
}

const listIds = async (query = 'fields=list') => ((await api('GET', `/api/tasks?${query}`)).data.tasks as Array<{ id: string }>).map((t) => t.id)
const v1Ids = async () => ((await api('GET', '/api/v1/tasks')).data.tasks as Array<{ id: string }>).map((t) => t.id)

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await installPlugin('keeper', { taskVisibility: 'plugin' })
  await installPlugin('plain', {})
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  ws = new WebSocket(`ws://localhost:${port}/ws`)
  ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  // Plugins activate after the server listens.
  for (const id of ['keeper', 'plain']) {
    await until(`${id} ops`, async () => (await api('POST', `/api/plugin-runtime/${id}/ops/${id}_list`, { project: PROJECT })).data, (v) => v?.ok === true, 30_000)
  }
}, 90_000)

afterAll(async () => {
  ws?.close()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('tasks a plugin keeps to its own view', () => {
  let kept: string
  let direct: string
  let plain: string

  it('stamps what a keeping plugin creates, through the task_create op and walnut.tasks.create', async () => {
    kept = (await op<{ id: string }>('keeper', 'make', { title: 'Partner zebra-quartz', project: PROJECT })).id
    direct = (await op<{ id: string }>('keeper', 'create', { title: 'Observer zebra-quartz', project: PROJECT })).id
    plain = (await op<{ id: string }>('plain', 'make', { title: 'Ticket zebra-quartz', project: PROJECT })).id
    for (const id of [kept, direct]) {
      const task = (await api('GET', `/api/tasks/${id}`)).data.task
      expect(task).toMatchObject({ id, project: PROJECT, plugin_only: 'keeper', source: 'local' })
      expect(task.pinned).toBeFalsy()
    }
    const plainTask = (await api('GET', `/api/tasks/${plain}`)).data.task
    expect(plainTask.plugin_only).toBeUndefined()
  })

  it('leaves them out of the web list and an agent\'s list, but a read by id still finds them', async () => {
    const ids = await listIds()
    expect(ids).toContain(plain)
    expect(ids).not.toContain(kept)
    expect(ids).not.toContain(direct)
    expect(await listIds(`project=${encodeURIComponent(PROJECT)}`)).toEqual([plain])
    expect(await listIds(`ids=${kept}`)).toEqual([kept])
    // Left out before the limit: a capped page still fills, and total counts what it may show.
    const page = (await api('GET', `/api/tasks?project=${encodeURIComponent(PROJECT)}&limit=1`)).data
    expect(page).toMatchObject({ total: 1, truncated: false })
    expect(page.tasks.map((t: { id: string }) => t.id)).toEqual([plain])
  })

  it('leaves them out of the phone\'s list and its events snapshot', async () => {
    const ids = await v1Ids()
    expect(ids).toContain(plain)
    expect(ids).not.toContain(kept)
    const ctrl = new AbortController()
    const res = await fetch(`http://localhost:${port}/api/v1/events`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    let text = ''
    while (!/event: snapshot\ndata: .*\n/.test(text)) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    ctrl.abort()
    const snapshot = JSON.parse(/event: snapshot\ndata: (.*)\n/.exec(text)![1])
    const snapIds = (snapshot.tasks as Array<{ id: string }>).map((t) => t.id)
    expect(snapIds).toContain(plain)
    expect(snapIds).not.toContain(kept)
  })

  it('counts them nowhere: not in Org, not in needs-you, not in project counts', async () => {
    for (const id of [kept, direct, plain]) {
      expect((await api('PATCH', `/api/tasks/${id}`, { phase: 'NEED_ACTION' })).status).toBe(200)
    }
    const tree = (await api('GET', '/api/v1/org')).data.tree
    const room = tree.projects.find((p: { project: string }) => p.project === PROJECT)
    expect(room.teams.map((t: { id: string }) => t.id)).toEqual([plain])
    expect(room.needsLead).toBe(false)
    expect(room.counts.needsYou).toBe(1)
    const row = (await api('GET', '/api/projects')).data.projects.find((p: { name: string }) => p.name === PROJECT)
    expect(row.counts).toEqual({ todo: 0, active: 1, done: 0 })
  })

  it('keeps them out of search', async () => {
    const hits = async () => ((await api('GET', '/api/search?q=zebra-quartz&types=task')).data.results as Array<{ taskId?: string }>).map((r) => r.taskId)
    const found = await until('the plain task in search', hits, (ids) => ids.includes(plain))
    expect(found).not.toContain(kept)
    expect(found).not.toContain(direct)
  })

  it('still answers the plugin\'s own reads', async () => {
    const own = await op<Array<{ id: string; pluginOnly?: boolean }>>('keeper', 'list', { project: PROJECT })
    expect(own.filter((t) => t.pluginOnly).map((t) => t.id).sort()).toEqual([kept, direct].sort())
    expect(await op('keeper', 'get', { id: kept })).toMatchObject({ id: kept, pluginOnly: true })
    // Another plugin does not list them.
    const theirs = await op<Array<{ id: string }>>('plain', 'list', { project: PROJECT })
    expect(theirs.map((t) => t.id)).toEqual([plain])
  })

  it('keepInPlugin brings in a task made before, unpinned, and gives it back', async () => {
    const before = (await api('POST', '/api/tasks', { title: 'Earlier partner', project: PROJECT, pinned: true })).data.task.id
    expect(await listIds()).toContain(before)
    frames.length = 0
    expect(await op('keeper', 'keep', { ids: [before, 'nope-0000'] })).toEqual({ changed: [before], skipped: [{ id: 'nope-0000', reason: 'missing' }] })
    const task = (await api('GET', `/api/tasks/${before}`)).data.task
    expect(task).toMatchObject({ plugin_only: 'keeper' })
    expect(task.pinned).toBeFalsy()
    // An open window hears it from the task itself, and drops the row.
    const frame = await until('the update frame', async () => frames.find((f) => f.name === 'task:updated' && (f.data as any)?.task?.id === before), (f) => !!f)
    expect((frame!.data as any).task.plugin_only).toBe('keeper')
    expect(await listIds()).not.toContain(before)
    // Idempotent, and another plugin cannot take it.
    expect(await op('keeper', 'keep', { ids: [before] })).toEqual({ changed: [], skipped: [] })
    // Given back: an ordinary task again.
    expect(await op('keeper', 'keep', { ids: [before], keep: false })).toEqual({ changed: [before], skipped: [] })
    expect((await api('GET', `/api/tasks/${before}`)).data.task.plugin_only).toBeUndefined()
    expect(await listIds()).toContain(before)
  })

  it('gives a removed plugin\'s tasks back to the board, never a present one\'s', async () => {
    const orphan = (await api('POST', '/api/tasks', { title: 'Left by a removed plugin', project: PROJECT })).data.task.id
    const { setTasksPluginOnly } = await import('../../src/core/task-manager.js')
    await setTasksPluginOnly([orphan], 'removed-plugin', true)
    expect(await listIds()).not.toContain(orphan)
    const { releaseTasksOfPluginsNotKeeping } = await import('../../src/core/plugins/plugin-task-visibility.js')
    expect(await releaseTasksOfPluginsNotKeeping(new Set(['keeper']))).toEqual([orphan])
    expect((await api('GET', `/api/tasks/${orphan}`)).data.task.plugin_only).toBeUndefined()
    expect(await listIds()).toContain(orphan)
    expect((await api('GET', `/api/tasks/${kept}`)).data.task.plugin_only).toBe('keeper')
  })

  it('a plugin without the option keeps today\'s behaviour and cannot keep tasks', async () => {
    const r = await api('POST', '/api/plugin-runtime/plain/ops/plain_keep', { ids: [plain] })
    expect(r.data.ok).toBe(false)
    expect(String(r.data.message ?? r.data.error)).toMatch(/taskVisibility/)
    const other = await api('POST', '/api/plugin-runtime/plain/ops/plain_keep', { ids: [kept], keep: false })
    expect(other.data).toMatchObject({ ok: true, result: { changed: [], skipped: [{ id: kept, reason: 'other-plugin' }] } })
  })
})
