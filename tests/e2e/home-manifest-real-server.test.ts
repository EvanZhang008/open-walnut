/**
 * The data-location manifest (src/core/home-manifest/) against what a real server
 * writes: boot one on its own home, make a task and a note through the API so their
 * stores appear, stop it, and walk the home. Every path it created must be named by
 * an entry: the unknown default (leader-data, for the user's own files in the vault)
 * and a mixed dir's fallback (cache/, local/, sync/, tmp/) do not count. It walks the
 * home twice, while the server runs (its lock is there) and after the stop flushed. The source ratchet
 * (tests/core/home-manifest/home-manifest-sources.test.ts) covers the paths the code
 * names; this one catches the ones it builds at run time.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('home-manifest-e2e'))

import { IMAGES_DIR, PASTES_DIR, SESSION_STREAMS_DIR, WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { homePathClass, isUnnamedHomePath } from '../../src/core/home-manifest/index.js'

/**
 * The test constants put these runtime dirs inside the home (tests/helpers/mock-constants.ts);
 * a real server keeps them in the runtime dir outside it, where the outside entries name them.
 */
const MOCK_ONLY = [IMAGES_DIR, PASTES_DIR, SESSION_STREAMS_DIR].map((d) => path.relative(WALNUT_HOME, d).split(path.sep).join('/'))
const mockOnly = (rel: string) => MOCK_ONLY.some((d) => rel === d || rel.startsWith(`${d}/`) || d.startsWith(`${rel}/`))

let server: HttpServer
let port = 0

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

/** Every file and dir under `root`, relative and '/'-separated (links are not followed). */
async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name
    out.push(child)
    if (e.isDirectory()) out.push(...await walk(root, child))
  }
  return out
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  await stopServer().catch(() => {})
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a real server\'s home', () => {
  it('holds only paths the manifest names', async () => {
    const task = await call('POST', '/api/tasks', { title: 'manifest check task', project: 'Manifest e2e' })
    expect(task.status, JSON.stringify(task.json)).toBeLessThan(300)
    const note = await call('PUT', '/api/notes-v2/content/manifest-check.md', { content: '# Manifest check' })
    expect(note.status, JSON.stringify(note.json)).toBeLessThan(300)
    // Give the debounced writers (task store, notes index, usage) a moment before the stop flushes them.
    await new Promise((r) => setTimeout(r, 1500))
    const running = await walk(WALNUT_HOME)
    await stopServer()
    const paths = [...new Set([...running, ...await walk(WALNUT_HOME)])].sort()
    const listing = paths.join('\n')

    // The class of a few places it made, one per class.
    for (const [rel, cls] of [
      ['tasks/tasks.sqlite', 'leader-data'],
      ['server.lock.json', 'machine'],
      ['search.sqlite', 'rebuildable'],
    ] as const) {
      expect(paths, listing).toContain(rel)
      expect(homePathClass(rel), rel).toBe(cls)
    }
    expect(paths.some((p) => p.endsWith('manifest-check.md')), listing).toBe(true)

    const unnamed = paths.filter((rel) => !mockOnly(rel) && isUnnamedHomePath(rel))
    expect(unnamed, 'add an entry to src/core/home-manifest/ for each').toEqual([])
  }, 60_000)
})
