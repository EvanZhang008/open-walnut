/**
 * E2E for the `walnut mcp` stdio MCP server (src/mcp/), driven IN-PROCESS.
 *
 * Real ephemeral Walnut server (startServer({ port: 0, dev: true }) with an
 * isolated temp home) + a real MCP Client/Server pair over InMemoryTransport.
 * No child processes, no `claude` CLI, no port 3456 — the MCP server is pointed
 * at the ephemeral server's port via the apiBase option.
 *
 * What this pins down:
 *   - task_create really writes (verified by an independent HTTP GET), and its
 *     result carries the `<task-ref .../>` citation string
 *   - task_complete flips status and also carries the ref
 *   - task_list honors the status filter
 *   - --readonly advertises ZERO write tools
 *   - a dead server produces the friendly "not running" tool error
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-mcp-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createWalnutMcpServer, type McpOptions } from '../../src/mcp/server.js'
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../../src/mcp/tools.js'

let server: HttpServer
let port: number

/** Connect a fresh MCP client to a fresh Walnut MCP server over in-memory transports. */
async function connect(options: McpOptions = {}): Promise<{ client: Client; close: () => Promise<void> }> {
  const mcp = createWalnutMcpServer({ apiBase: `http://127.0.0.1:${port}`, ...options })
  const client = new Client({ name: 'walnut-test-client', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    close: async () => {
      await client.close().catch(() => {})
      await mcp.close().catch(() => {})
    },
  }
}

/** First text block of a tool result. */
function textOf(result: { content: unknown }): string {
  const blocks = result.content as Array<{ type: string; text?: string }>
  const first = blocks.find((b) => b.type === 'text')
  return first?.text ?? ''
}

function jsonOf(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>
}

/** An OS-assigned port we open then close — guaranteed to refuse connections. */
async function deadPort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
  const addr = srv.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  const p = addr.port
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return p
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('walnut mcp — tool surface', () => {
  it('advertises all read + write tools by default', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name).sort()
      for (const n of [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]) {
        expect(names, `missing tool ${n}`).toContain(n)
      }
      // Every tool carries a description — it's the model's only affordance.
      for (const t of tools) expect(t.description, `${t.name} has no description`).toBeTruthy()
    } finally {
      await close()
    }
  })

  it('--readonly registers NO write tools', async () => {
    const { client, close } = await connect({ readonly: true })
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names.sort()).toEqual([...READ_TOOL_NAMES].sort())
      for (const w of WRITE_TOOL_NAMES) expect(names).not.toContain(w)
    } finally {
      await close()
    }
  })

  it('readonly mode cannot call a write tool at all', async () => {
    const { client, close } = await connect({ readonly: true })
    try {
      const refused = await client.callTool({
        name: 'task_create',
        arguments: { title: 'should never exist' },
      })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toMatch(/task_create not found/)
      // ...and the task was never created.
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`)
      const { tasks } = await res.json() as { tasks: Array<{ title: string }> }
      expect(tasks.some((t) => t.title === 'should never exist')).toBe(false)
    } finally {
      await close()
    }
  })
})

describe('walnut mcp — task write path', () => {
  it('task_create really creates the task and returns a <task-ref/> citation', async () => {
    const { client, close } = await connect()
    try {
      const result = await client.callTool({
        name: 'task_create',
        arguments: { title: 'Wire up the MCP bridge', priority: 'important' },
      })
      expect(result.isError).toBeFalsy()
      const payload = jsonOf(result)
      const task = payload.task as { id: string; title: string; status: string; priority: string }
      expect(task.title).toBe('Wire up the MCP bridge')
      expect(task.status).toBe('todo')
      expect(task.priority).toBe('important')

      // The citation mechanism: a literal, paste-able tag + an instruction.
      expect(payload.ref).toBe(`<task-ref id="${task.id}" label="Wire up the MCP bridge"/>`)
      expect(String(payload.ref)).toContain('<task-ref')
      expect(String(payload.instruction)).toMatch(/verbatim/i)

      // Independent verification through HTTP — the task really exists.
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${task.id}`)
      expect(res.status).toBe(200)
      const detail = await res.json() as { task: { id: string; title: string } }
      expect(detail.task.id).toBe(task.id)
      expect(detail.task.title).toBe('Wire up the MCP bridge')
    } finally {
      await close()
    }
  })

  it('task_get reads back a created task by unique id prefix', async () => {
    const { client, close } = await connect()
    try {
      const created = jsonOf(await client.callTool({
        name: 'task_create',
        arguments: { title: 'Prefix lookup target', description: 'body text' },
      }))
      const id = (created.task as { id: string }).id
      const got = await client.callTool({ name: 'task_get', arguments: { id: id.slice(0, 8) } })
      expect(got.isError).toBeFalsy()
      const detail = jsonOf(got).task as { id: string; description?: string }
      expect(detail.id).toBe(id)
      // Detail is the FULL row — description reads back here but not in the list.
      expect(detail.description).toBe('body text')
    } finally {
      await close()
    }
  })

  it('task_complete marks the task done and also returns a <task-ref/>', async () => {
    const { client, close } = await connect()
    try {
      const created = jsonOf(await client.callTool({
        name: 'task_create',
        arguments: { title: 'Finish the migration' },
      }))
      const id = (created.task as { id: string }).id

      const done = await client.callTool({ name: 'task_complete', arguments: { id } })
      expect(done.isError).toBeFalsy()
      const payload = jsonOf(done)
      expect(payload.completed).toBe(true)
      expect((payload.task as { status: string }).status).toBe('done')
      expect(payload.ref).toBe(`<task-ref id="${id}" label="Finish the migration"/>`)
      expect(String(payload.instruction)).toMatch(/verbatim/i)

      const res = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${id}`)
      const detail = await res.json() as { task: { status: string } }
      expect(detail.task.status).toBe('done')
    } finally {
      await close()
    }
  })

  it('task_complete auto-unpins (completeTask semantics, not bare PATCH)', async () => {
    const { client, close } = await connect()
    try {
      const created = jsonOf(await client.callTool({
        name: 'task_create',
        arguments: { title: 'Pinned via MCP then completed' },
      }))
      const id = (created.task as { id: string }).id

      const pinRes = await fetch(`http://127.0.0.1:${port}/api/v1/focus/tasks/${id}`, { method: 'POST' })
      expect(pinRes.status).toBe(200)
      const before = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${id}`)
      expect(((await before.json()) as { task: { pinned?: boolean } }).task.pinned).toBe(true)

      const done = await client.callTool({ name: 'task_complete', arguments: { id } })
      expect(done.isError).toBeFalsy()

      const after = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${id}`)
      expect(((await after.json()) as { task: { pinned?: boolean } }).task.pinned).toBeFalsy()
    } finally {
      await close()
    }
  })

  it('task_update patches fields, and rejects an empty change set', async () => {
    const { client, close } = await connect()
    try {
      const created = jsonOf(await client.callTool({
        name: 'task_create',
        arguments: { title: 'Rename me' },
      }))
      const id = (created.task as { id: string }).id

      const patched = await client.callTool({
        name: 'task_update',
        arguments: { id, title: 'Renamed', priority: 'backlog' },
      })
      expect(patched.isError).toBeFalsy()
      const task = jsonOf(patched).task as { title: string; priority: string }
      expect(task.title).toBe('Renamed')
      expect(task.priority).toBe('backlog')

      const empty = await client.callTool({ name: 'task_update', arguments: { id } })
      expect(empty.isError).toBe(true)
      expect(textOf(empty)).toMatch(/at least one field/i)
    } finally {
      await close()
    }
  })

  it('task_delete removes the task', async () => {
    const { client, close } = await connect()
    try {
      const created = jsonOf(await client.callTool({
        name: 'task_create',
        arguments: { title: 'Temporary throwaway' },
      }))
      const id = (created.task as { id: string }).id

      const deleted = await client.callTool({ name: 'task_delete', arguments: { id } })
      expect(deleted.isError).toBeFalsy()
      expect(jsonOf(deleted).deleted).toBe(true)

      const res = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${id}`)
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('surfaces the server error message on a bad request', async () => {
    const { client, close } = await connect()
    try {
      const bad = await client.callTool({
        name: 'task_update',
        arguments: { id: 'definitely-not-a-real-task-id', title: 'nope' },
      })
      expect(bad.isError).toBe(true)
      expect(textOf(bad)).toMatch(/Walnut API error \(not_found\)/)
    } finally {
      await close()
    }
  })
})

describe('walnut mcp — reads', () => {
  it('task_list filters by status', async () => {
    const { client, close } = await connect()
    try {
      const openTask = jsonOf(await client.callTool({
        name: 'task_create',
        arguments: { title: 'Still open work' },
      })).task as { id: string }
      const closedTask = jsonOf(await client.callTool({
        name: 'task_create',
        arguments: { title: 'Already closed work' },
      })).task as { id: string }
      await client.callTool({ name: 'task_complete', arguments: { id: closedTask.id } })

      const todo = jsonOf(await client.callTool({ name: 'task_list', arguments: { status: 'todo' } }))
      const todoTasks = todo.tasks as Array<{ id: string; status: string }>
      expect(todoTasks.every((t) => t.status === 'todo')).toBe(true)
      expect(todoTasks.map((t) => t.id)).toContain(openTask.id)
      expect(todoTasks.map((t) => t.id)).not.toContain(closedTask.id)

      const done = jsonOf(await client.callTool({ name: 'task_list', arguments: { status: 'done' } }))
      const doneTasks = done.tasks as Array<{ id: string; status: string }>
      expect(doneTasks.map((t) => t.id)).toContain(closedTask.id)
      expect(doneTasks.map((t) => t.id)).not.toContain(openTask.id)
    } finally {
      await close()
    }
  })

  it('task_list filters by project, and project_list sees the auto-created row', async () => {
    const { client, close } = await connect()
    try {
      const created = jsonOf(await client.callTool({
        name: 'task_create',
        arguments: { title: 'Scoped to marina', project: 'marina' },
      })).task as { id: string; project: string }
      expect(created.project).toBe('marina')

      const scoped = jsonOf(await client.callTool({
        name: 'task_list',
        arguments: { project: 'marina' },
      }))
      const ids = (scoped.tasks as Array<{ id: string }>).map((t) => t.id)
      expect(ids).toContain(created.id)

      const projects = jsonOf(await client.callTool({ name: 'project_list', arguments: {} }))
      const names = (projects.projects as Array<{ name: string }>).map((p) => p.name)
      expect(names).toContain('marina')
    } finally {
      await close()
    }
  })

  it('walnut_status reports the live server, and session_list answers', async () => {
    const { client, close } = await connect()
    try {
      const status = jsonOf(await client.callTool({ name: 'walnut_status', arguments: {} }))
      expect(status.mode).toBe('LIVE')
      expect(typeof status.version).toBe('string')

      const sessions = jsonOf(await client.callTool({ name: 'session_list', arguments: {} }))
      expect(Array.isArray(sessions.sessions)).toBe(true)
    } finally {
      await close()
    }
  })
})

describe('walnut mcp — server unreachable', () => {
  it('returns the friendly "not running" tool error, not a raw fetch failure', async () => {
    const port404 = await deadPort()
    const base = `http://127.0.0.1:${port404}`
    const mcp = createWalnutMcpServer({ apiBase: base })
    const client = new Client({ name: 'walnut-test-client', version: '1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([mcp.connect(st), client.connect(ct)])
    try {
      const result = await client.callTool({ name: 'walnut_status', arguments: {} })
      expect(result.isError).toBe(true)
      const msg = textOf(result)
      expect(msg).toContain('Walnut server not running at')
      expect(msg).toContain(`${base}/api/v1`)
      expect(msg).toContain('open-walnut web')
    } finally {
      await client.close().catch(() => {})
      await mcp.close().catch(() => {})
    }
  }, 20_000)
})
