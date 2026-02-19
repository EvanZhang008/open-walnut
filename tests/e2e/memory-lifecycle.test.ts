/**
 * E2E tests for memory lifecycle — real server + search + file I/O.
 *
 * What's real: Express server, search function (brute-force), memory file I/O.
 * What's mocked: constants.js (temp dir).
 *
 * Tests verify:
 *   1. Task search — create task via REST, search finds it
 *   2. Memory file search — write .md file, search finds it
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, MEMORY_DIR, SESSIONS_DIR } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

// ── Helpers ──

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── Task search ──

describe('Search finds tasks by title', () => {
  it('create task then search by keyword', async () => {
    // Create a task with a unique keyword
    const createRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Implement quantum flux capacitor', category: 'work' }),
    })
    expect(createRes.status).toBe(201)

    // Search for it
    const searchRes = await fetch(apiUrl('/api/search?q=quantum+flux'))
    expect(searchRes.status).toBe(200)
    const body = (await searchRes.json()) as { results: Array<{ type: string; title: string; taskId: string }> }
    expect(body.results.length).toBeGreaterThanOrEqual(1)

    const found = body.results.find((r) => r.title.includes('quantum'))
    expect(found).toBeDefined()
    expect(found!.type).toBe('task')
  })

  it('search by note content', async () => {
    // Create task and add a note
    const createRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Research project' }),
    })
    const { task } = (await createRes.json()) as { task: { id: string } }

    await fetch(apiUrl(`/api/tasks/${task.id}/notes`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Discovered xylophone algorithm for sorting' }),
    })

    const searchRes = await fetch(apiUrl('/api/search?q=xylophone+algorithm'))
    expect(searchRes.status).toBe(200)
    const body = (await searchRes.json()) as { results: Array<{ type: string; taskId: string; matchField: string }> }

    const found = body.results.find((r) => r.taskId === task.id)
    expect(found).toBeDefined()
    expect(found!.matchField).toBe('note')
  })

  it('search returns empty results for non-matching query', async () => {
    const searchRes = await fetch(apiUrl('/api/search?q=nonexistentxyzzy'))
    expect(searchRes.status).toBe(200)
    const body = (await searchRes.json()) as { results: Array<unknown> }
    expect(body.results.length).toBe(0)
  })

  it('search with empty query returns empty results', async () => {
    const searchRes = await fetch(apiUrl('/api/search?q='))
    expect(searchRes.status).toBe(200)
    const body = (await searchRes.json()) as { results: Array<unknown> }
    expect(body.results.length).toBe(0)
  })
})

// ── Memory file search ──

describe('Memory file search', () => {
  it('write memory file then search finds it', async () => {
    // Write a session memory file directly to the mocked SESSIONS_DIR
    await fs.mkdir(SESSIONS_DIR, { recursive: true })
    await fs.writeFile(
      path.join(SESSIONS_DIR, 'test-session.md'),
      '# Test Session\n\nFixed the thermodynamic inverter bug in the widget module.\nDecision: Use backpressure instead of buffering.\n',
    )

    // Verify the file is on disk
    const exists = await fs.stat(path.join(SESSIONS_DIR, 'test-session.md')).catch(() => null)
    expect(exists).not.toBeNull()

    // List memories to confirm the file is discoverable
    const memRes = await fetch(apiUrl('/api/memory?category=session'))
    expect(memRes.status).toBe(200)
    const memBody = (await memRes.json()) as { memories: Array<{ title: string; path: string }> }
    const memFound = memBody.memories.find((m) => m.path.includes('test-session'))
    expect(memFound).toBeDefined()

    // Search using memory type — brute-force search over listed memories
    const searchRes = await fetch(apiUrl('/api/search?q=thermodynamic+inverter&types=memory'))
    expect(searchRes.status).toBe(200)
    const body = (await searchRes.json()) as { results: Array<{ type: string; title: string; snippet: string }> }

    const found = body.results.find((r) => r.type === 'memory')
    expect(found).toBeDefined()
    expect(found!.snippet).toContain('thermodynamic')
  })

  it('write knowledge article then search finds it', async () => {
    const knowledgeDir = path.join(MEMORY_DIR, 'knowledge')
    await fs.mkdir(knowledgeDir, { recursive: true })
    await fs.writeFile(
      path.join(knowledgeDir, 'architecture-decisions.md'),
      '# Architecture Decisions\n\nWe chose PostgreSQL over MongoDB for transactional integrity.\nThe event bus uses pub/sub with destination routing.\n',
    )

    const searchRes = await fetch(apiUrl('/api/search?q=PostgreSQL+transactional&types=memory'))
    expect(searchRes.status).toBe(200)
    const body = (await searchRes.json()) as { results: Array<{ type: string; title: string }> }

    const found = body.results.find((r) => r.type === 'memory')
    expect(found).toBeDefined()
    expect(found!.title).toContain('Architecture')
  })
})

// ── Memory REST API ──

describe('Memory REST API', () => {
  it('list memories returns session and knowledge files', async () => {
    const res = await fetch(apiUrl('/api/memory'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { memories: Array<{ title: string; path: string }> }
    expect(body.memories.length).toBeGreaterThanOrEqual(1)
  })

  it('list memories filtered by category', async () => {
    const res = await fetch(apiUrl('/api/memory?category=session'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { memories: Array<{ path: string }> }
    // All returned memories should be from sessions
    for (const mem of body.memories) {
      expect(mem.path).toContain('sessions')
    }
  })
})

// ── Cross-feature: task + search persistence ──

describe('Cross-feature: task creation persists and is searchable', () => {
  it('POST task → GET confirms → search finds it', async () => {
    const title = 'Unique platypus migration task'

    // Create
    const createRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, category: 'life', priority: 'backlog' }),
    })
    const { task } = (await createRes.json()) as { task: { id: string; title: string } }
    expect(task.title).toBe(title)

    // GET confirms persistence
    const getRes = await fetch(apiUrl(`/api/tasks/${task.id}`))
    expect(getRes.status).toBe(200)
    const getBody = (await getRes.json()) as { task: { title: string; category: string } }
    expect(getBody.task.title).toBe(title)
    expect(getBody.task.category).toBe('life')

    // Search finds it
    const searchRes = await fetch(apiUrl('/api/search?q=platypus+migration'))
    const searchBody = (await searchRes.json()) as { results: Array<{ title: string }> }
    expect(searchBody.results.length).toBeGreaterThanOrEqual(1)
    expect(searchBody.results[0].title).toContain('platypus')
  })
})
