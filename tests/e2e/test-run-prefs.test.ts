/**
 * A test run's preference writes land in its own copy (src/core/test-run-prefs.ts), through a
 * REAL server with marking on (`WALNUT_TEST_RUN_MARK=1`).
 *
 * 2026-10-31: the user's synced ui-prefs said the task panel was hidden, so every fresh browser
 * opened on an empty Home; a browser under automation on the user's Walnut sends
 * `x-walnut-test-run`, and the prefs routes wrote the user's files with it. Checked here: the
 * run reads its own layout, favorites and order back; the user's reads and files stay as they
 * were; another run sees none of it; and the user's real writes still land.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import fs from 'node:fs/promises'

import { WALNUT_HOME, UI_PREFS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { _resetTestRunPrefsForTest } from '../../src/core/test-run-prefs.js'

let server: HttpServer
let port: number
const savedMark = process.env.WALNUT_TEST_RUN_MARK

const RUN = { 'x-walnut-test-run': 'prefs-probe' }
const OTHER = { 'x-walnut-test-run': 'prefs-other' }

async function api(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, data: text ? JSON.parse(text) : null }
}

const readFile = (p: string) => fs.readFile(p, 'utf8').catch(() => null)
const configYaml = () => readFile(`${WALNUT_HOME}/config.yaml`)
const prefsOf = async (headers: Record<string, string> = {}) =>
  (await api('GET', '/api/ui-prefs', undefined, headers)).data.prefs as Record<string, { v: string | null; ts: number }>

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  _resetTestRunPrefsForTest()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 90_000)

afterAll(async () => {
  await stopServer()
  _resetTestRunPrefsForTest()
  if (savedMark === undefined) delete process.env.WALNUT_TEST_RUN_MARK
  else process.env.WALNUT_TEST_RUN_MARK = savedMark
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('a test run writes its own prefs copy', () => {
  it('ui-prefs: the run reads its layout back; the user\'s file and reads keep theirs', async () => {
    // The user's own layout first: a real write, the panel shown.
    expect((await api('PUT', '/api/ui-prefs', { prefs: { 'open-walnut-home-todo-visible': { v: 'true', ts: 1000 } } })).status).toBe(200)
    const before = await readFile(UI_PREFS_FILE)
    expect(before).toContain('open-walnut-home-todo-visible')

    // The run hides it, with a newer stamp, and adds a key of its own.
    const put = await api('PUT', '/api/ui-prefs', {
      prefs: { 'open-walnut-home-todo-visible': { v: 'false', ts: 2000 }, 'open-walnut-probe-key': { v: 'x', ts: 2000 } },
    }, RUN)
    expect(put.status).toBe(200)

    const own = await prefsOf(RUN)
    expect(own['open-walnut-home-todo-visible']).toEqual({ v: 'false', ts: 2000 })
    expect(own['open-walnut-probe-key']).toEqual({ v: 'x', ts: 2000 })

    const user = await prefsOf()
    expect(user['open-walnut-home-todo-visible']).toEqual({ v: 'true', ts: 1000 })
    expect(user['open-walnut-probe-key']).toBeUndefined()
    expect(await readFile(UI_PREFS_FILE)).toBe(before)

    // Another run starts from the user's layout, not this run's.
    expect((await prefsOf(OTHER))['open-walnut-home-todo-visible']).toEqual({ v: 'true', ts: 1000 })

    // A run's delete is its own too.
    await api('PUT', '/api/ui-prefs', { prefs: { 'open-walnut-probe-key': { v: null, ts: 3000 } } }, RUN)
    expect((await prefsOf(RUN))['open-walnut-probe-key']).toEqual({ v: null, ts: 3000 })
  })

  it('ui-prefs: a bad body is refused for a run as for the user', async () => {
    expect((await api('PUT', '/api/ui-prefs', { prefs: [] }, RUN)).status).toBe(400)
  })

  it('favorites: web and v1 writes stay in the run, and its project list folds them in', async () => {
    expect((await api('POST', '/api/tasks', { title: 'Real errand', project: 'Real Shelf' })).status).toBe(201)
    expect((await api('POST', '/api/favorites/projects/Real%20Shelf')).status).toBe(200)
    const before = await configYaml()

    expect((await api('DELETE', '/api/favorites/projects/Real%20Shelf', undefined, RUN)).data.projects).toEqual([])
    expect((await api('POST', '/api/v1/favorites/projects/Probe%20Shelf', undefined, RUN)).data.projects).toEqual(['Probe Shelf'])
    expect((await api('POST', '/api/favorites/notes', { path: 'Probe/Note.md' }, RUN)).data.notes).toEqual(['Probe/Note.md'])
    expect((await api('POST', '/api/v1/favorites/notes', { path: 'Probe/Other.md' }, RUN)).status).toBe(200)

    expect((await api('GET', '/api/favorites', undefined, RUN)).data).toEqual({
      projects: ['Probe Shelf'],
      notes: ['Probe/Note.md', 'Probe/Other.md'],
    })
    const user = (await api('GET', '/api/favorites')).data
    expect(user.projects).toEqual(['Real Shelf'])
    expect(user.notes).toEqual([])
    expect(await configYaml()).toBe(before)

    // The project list the web app reads its stars from (GET /api/projects).
    const starred = async (headers: Record<string, string> = {}) =>
      ((await api('GET', '/api/projects', undefined, headers)).data.projects as Array<{ name: string; favorite?: boolean }>)
        .find((p) => p.name === 'Real Shelf')?.favorite
    expect(await starred()).toBe(true)
    expect(await starred(RUN)).toBeFalsy()

    await api('DELETE', '/api/v1/favorites/notes', { path: 'Probe/Note.md' }, RUN)
    expect((await api('GET', '/api/favorites', undefined, RUN)).data.notes).toEqual(['Probe/Other.md'])

    // The run keeps only its changes: a favorite the user adds afterwards shows in its reads too.
    expect((await api('POST', '/api/favorites/notes', { path: 'Real/Later.md' })).status).toBe(200)
    expect((await api('GET', '/api/favorites', undefined, RUN)).data.notes).toEqual(['Real/Later.md', 'Probe/Other.md'])
    expect((await api('GET', '/api/favorites')).data.notes).toEqual(['Real/Later.md'])
  })

  it('ordering: web and v1 writes stay in the run', async () => {
    expect((await api('PUT', '/api/ordering/projects', { order: ['Real Shelf'] })).status).toBe(200)
    const before = await configYaml()

    expect((await api('PUT', '/api/ordering/projects', { order: ['B', 'A'] }, RUN)).status).toBe(200)
    expect((await api('PUT', '/api/v1/ordering/projects', { order: ['C', 'B', 'A'] }, RUN)).status).toBe(200)
    const sep = { id: 'sep_probe', tier: 'focus', mode: 'custom', after: '', before: '' }
    expect((await api('PUT', '/api/ordering/separators', { separators: [sep] }, RUN)).status).toBe(200)

    const own = (await api('GET', '/api/ordering', undefined, RUN)).data
    expect(own.projects).toEqual(['C', 'B', 'A'])
    expect(own.separators.map((s: { id: string }) => s.id)).toEqual(['sep_probe'])
    expect((await api('GET', '/api/v1/ordering', undefined, RUN)).data.projects).toEqual(['C', 'B', 'A'])

    const user = (await api('GET', '/api/ordering')).data
    expect(user.projects).toEqual(['Real Shelf'])
    expect(user.separators).toEqual([])
    expect(await configYaml()).toBe(before)

    // A list the run never set stays the user's, live: another run sets only the order.
    expect((await api('PUT', '/api/ordering/projects', { order: ['Z'] }, OTHER)).status).toBe(200)
    expect((await api('PUT', '/api/ordering/separators', { separators: [{ ...sep, id: 'sep_real' }] })).status).toBe(200)
    expect((await api('GET', '/api/ordering', undefined, OTHER)).data).toMatchObject({ projects: ['Z'], separators: [{ id: 'sep_real' }] })
  })

  it('the user\'s writes still land while a run holds its copy', async () => {
    expect((await api('PUT', '/api/ui-prefs', { prefs: { 'open-walnut-real-key': { v: 'y', ts: 4000 } } })).status).toBe(200)
    expect(await readFile(UI_PREFS_FILE)).toContain('open-walnut-real-key')
    // The run keeps its own copy of what it wrote, and reads the user's other keys live.
    const own = await prefsOf(RUN)
    expect(own['open-walnut-home-todo-visible']).toEqual({ v: 'false', ts: 2000 })
    expect(own['open-walnut-real-key']).toEqual({ v: 'y', ts: 4000 })
  })
})
