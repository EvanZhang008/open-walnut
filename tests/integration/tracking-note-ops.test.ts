/**
 * The tracking-note ops against a REAL vault and a REAL server
 * (startServer({ port: 0, dev: true }) over a temp home): project_tracking_ensure,
 * project_tracking_get, and the note_edit rules an agent has to follow to share
 * the note with a human.
 *
 * What is real: the express routes, the SQLite project registry, the notes vault
 * on disk, the notes index, and the ops registry's own HTTP executor — so this
 * exercises the same path `walnut tools call` and the MCP server take.
 * Nothing is mocked except the search index (WALNUT_DISABLE_SEARCH=1, the
 * product's own switch) so no embedding model is downloaded.
 *
 * The five contracts pinned here, each one a way this could go wrong:
 *
 *  1. ONE note per project. Ensure writes the skeleton once, records the path in
 *     `task_projects.metadata.tracking_note`, and a second call changes nothing.
 *  2. An existing `Tracking.md` is ADOPTED, never overwritten — the user may have
 *     written that note themselves.
 *  3. Appending to `## Log` cannot lose another writer's line (heading anchor);
 *     editing the Workstreams table on a stale hash loses the race with a
 *     conflict that names BOTH hashes, so nobody is silently clobbered.
 *  4. Inbox is refused, and refused BEFORE anything is written: no orphan note.
 *  5. Renaming a project does NOT move the note. The metadata key follows the
 *     rename and keeps pointing at the original path. Pinned so nobody "fixes"
 *     this into a note move — notes are the user's vault, not project-scoped
 *     storage, and moving one would break every inbound link to it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

// No embedding model, no search.sqlite: the notes INDEX (notes-index.ts) is a
// different thing and stays real, because "the note shows up in the vault" is
// part of what acceptance 1 means.
const prevDisableSearch = process.env.WALNUT_DISABLE_SEARCH
process.env.WALNUT_DISABLE_SEARCH = '1'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-tracking-note-ops'))

import { NOTES_DIR, WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { closeDb } from '../../src/core/task-db.js'
import { executeOp } from '../../src/ops/index.js'
import { TRACKING_LOG_ANCHOR, TRACKING_SKELETON } from '../../src/core/tracking-note.js'

let server: HttpServer
let port = 0

const url = (p: string): string => `http://127.0.0.1:${port}${p}`
const apiBase = (): string => `http://127.0.0.1:${port}`

/** Run one registry op against the test server, exactly as a CLI would. */
async function op(name: string, args: Record<string, unknown>) {
  return executeOp(name, args, { apiBase: apiBase() })
}

/** Run an op and fail loudly with its own message when it did not succeed. */
async function okOp(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await op(name, args)
  expect(out.ok, `${name} failed: ${out.ok ? '' : out.message}`).toBe(true)
  return (out as { result: unknown }).result as Record<string, unknown>
}

async function request(method: string, p: string, body?: unknown): Promise<Response> {
  return fetch(url(p), {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

/** A project registry row exists as soon as a task names it. */
async function seedProject(name: string): Promise<void> {
  const res = await request('POST', '/api/projects', { name })
  expect([200, 201]).toContain(res.status)
}

async function projectMetadata(name: string): Promise<Record<string, unknown>> {
  const res = await request('GET', `/api/projects/${encodeURIComponent(name)}/metadata`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { metadata?: Record<string, unknown> }).metadata ?? {}
}

async function noteOnDisk(relPath: string): Promise<string> {
  return fs.readFile(path.join(NOTES_DIR, relPath), 'utf-8')
}

/** Vault tree paths, flattened — what the Notes page would list. */
async function vaultPaths(): Promise<string[]> {
  const res = await request('GET', '/api/notes-v2')
  expect(res.status).toBe(200)
  const out: string[] = []
  const walk = (nodes: Array<{ path?: string; children?: unknown }>): void => {
    for (const node of nodes) {
      if (typeof node.path === 'string') out.push(node.path)
      if (Array.isArray(node.children)) walk(node.children as Array<{ path?: string; children?: unknown }>)
    }
  }
  walk(((await res.json()) as { tree?: unknown }).tree as Array<{ path?: string }> ?? [])
  return out
}

/** Wait for the debounced indexer to pick a note up (it reconciles ~300ms later). */
async function indexedId(relPath: string, timeoutMs = 5_000): Promise<string | undefined> {
  const { getNoteIdByPath } = await import('../../src/core/notes-index.js')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const id = getNoteIdByPath(relPath)
    if (id) return id
    if (Date.now() > deadline) return undefined
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  expect(port).toBeGreaterThan(0)
})

afterAll(async () => {
  const { stopNotesIndexer, resetNotesIndexer } = await import('../../src/core/notes-indexer.js')
  stopNotesIndexer()
  resetNotesIndexer()
  const { closeNotesIndexDb } = await import('../../src/core/notes-index.js')
  closeNotesIndexDb()
  await stopServer().catch(() => {})
  closeDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  if (prevDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH
  else process.env.WALNUT_DISABLE_SEARCH = prevDisableSearch
})

// Each case works in its own project + its own note, so the suite needs no
// cross-case cleanup and a failure cannot cascade.
let caseSeq = 0
let project = ''
beforeEach(() => {
  project = `Marina ${++caseSeq}`
})

describe('project_tracking_ensure — one note per project, written once', () => {
  it('writes the skeleton, records the path, and shows up in the vault', async () => {
    await seedProject(project)
    const ensured = await okOp('project_tracking_ensure', { project })

    const notePath = `Projects/${project}/Tracking.md`
    expect(ensured).toMatchObject({ project, path: notePath, created: true, adopted: false })

    // The registry is the authority on where the note lives.
    expect((await projectMetadata(project)).tracking_note).toBe(notePath)

    // The bytes are the skeleton. The server stamps a frontmatter `id` at create
    // time (its identity contract), so the note is the skeleton PLUS that line —
    // strip it and the rest must match byte for byte.
    const onDisk = await noteOnDisk(notePath)
    const withoutId = onDisk.replace(/^id: n_[a-z0-9]+\n/m, '')
    const skeleton = TRACKING_SKELETON(project, new Date().toISOString())
    // Only the `updated` stamp may differ (this test's clock vs the server's).
    expect(withoutId.replace(/^updated: .*$/m, 'U')).toBe(skeleton.replace(/^updated: .*$/m, 'U'))
    expect(onDisk).toMatch(/^---\nid: n_[a-z0-9]+\n/)

    // Visible to the humans' surfaces: the tree, and the notes index (which is
    // what makes backlinks and wikilink resolution work).
    expect(await vaultPaths()).toContain(notePath)
    expect(await indexedId(notePath)).toMatch(/^n_/)
    const { findNoteIdsByName } = await import('../../src/core/notes-index.js')
    expect(findNoteIdsByName('Tracking').map((n) => n.path)).toContain(notePath)
  })

  it('is idempotent — a second call creates nothing and re-points nothing', async () => {
    await seedProject(project)
    const first = await okOp('project_tracking_ensure', { project })
    const before = await noteOnDisk(String(first.path))

    const second = await okOp('project_tracking_ensure', { project })
    expect(second).toMatchObject({ path: first.path, created: false, adopted: false })
    expect(await noteOnDisk(String(first.path))).toBe(before)
  })

  it('ADOPTS a note the human already wrote at that path, byte for byte', async () => {
    await seedProject(project)
    const notePath = `Projects/${project}/Tracking.md`
    const mine = '# My own tracking note\n\nI keep this by hand.\n'
    // The route the Notes page itself writes through (PUT creates; there is no
    // POST create in notes-v2), so this is a note the HUMAN could have made.
    const created = await request('PUT', `/api/notes-v2/content/${notePath}`, { content: mine })
    expect(created.status).toBe(200)
    const beforeBytes = await noteOnDisk(notePath)

    const ensured = await okOp('project_tracking_ensure', { project })
    expect(ensured).toMatchObject({ path: notePath, created: false, adopted: true })
    expect((await projectMetadata(project)).tracking_note).toBe(notePath)
    // The whole point of adoption: not one byte of the human's note changed.
    expect(await noteOnDisk(notePath)).toBe(beforeBytes)
    expect(await noteOnDisk(notePath)).toContain('I keep this by hand.')
  })

  it('refuses Inbox, and writes nothing on the way to refusing', async () => {
    const before = await vaultPaths()
    const refused = await op('project_tracking_ensure', { project: '   ' })
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.message).toMatch(/Inbox/i)
    // No orphan note: the refusal happens before any write.
    expect(await vaultPaths()).toEqual(before)
  })
})

describe('project_tracking_get — the shape an agent reads', () => {
  it('answers path + content + contentHash + updatedAt', async () => {
    await seedProject(project)
    const ensured = await okOp('project_tracking_ensure', { project })

    const got = await okOp('project_tracking_get', { project })
    expect(got.path).toBe(ensured.path)
    expect(got.project).toBe(project)
    expect(String(got.content)).toContain('## Workstreams')
    expect(got.contentHash).toEqual(expect.any(String))
    expect(String(got.contentHash).length).toBeGreaterThan(0)
    expect(got.updatedAt).toEqual(expect.any(String))
    // The hash is the lock a later note_edit presents, so it must be the CURRENT
    // one, not a stale echo.
    const reread = await okOp('note_read', { path: String(ensured.path) })
    expect(got.contentHash).toBe(reread.contentHash)
  })

  it('answers { path: null } for a project that has no tracking note', async () => {
    await seedProject(project)
    const got = await okOp('project_tracking_get', { project })
    expect(got.path).toBeNull()
    // …and says what to do about it, instead of looking like a failure.
    expect(String(got.reason)).toContain('project_tracking_ensure')
  })

  it('answers { path: null } for Inbox', async () => {
    const got = await okOp('project_tracking_get', { project: '  ' })
    expect(got.path).toBeNull()
  })

  it('says the note is GONE when the key points at a deleted note', async () => {
    await seedProject(project)
    const ensured = await okOp('project_tracking_ensure', { project })
    const del = await request('DELETE', `/api/notes-v2/content/${String(ensured.path)}`)
    expect(del.status).toBeLessThan(400)

    const got = await okOp('project_tracking_get', { project })
    expect(got.path).toBeNull()
    // Names the path it was told to read: a dead end with no path is not a
    // diagnosis, and the human needs to see what the project points at.
    expect(String(got.reason)).toContain(String(ensured.path))

    // …and ensure repairs it in place, at the SAME path.
    const again = await okOp('project_tracking_ensure', { project })
    expect(again).toMatchObject({ path: ensured.path, created: true })
  })
})

describe('concurrent writers — the Log anchor is safe, a Workstreams edit is not', () => {
  /** Append one line under the `## Log` heading — no prior read needed. */
  async function appendLog(notePath: string, line: string) {
    return op('note_edit', {
      path: notePath,
      old_str: TRACKING_LOG_ANCHOR,
      new_str: `${TRACKING_LOG_ANCHOR}- ${line}\n`,
    })
  }

  /**
   * A fresh skeleton's Workstreams table holds ONLY its header (it may not state
   * work that does not exist), so a test about editing a row has to add the rows
   * first — the same way the agent does, anchored on the separator line.
   */
  async function seedWorkstreamRows(notePath: string): Promise<void> {
    const separator = '| --- | --- | --- | --- | --- |\n'
    const rows = separator
      + '| Design review | in progress | [[task:ab12cd34]] | Sep 21 | mail: RFC v3 |\n'
      + '| Implementation | blocked | [[task:7f0c91de]] | Sep 19 | slack: #design-review |\n'
    const added = await op('note_edit', { path: notePath, old_str: separator, new_str: rows })
    expect(added.ok, added.ok ? '' : added.message).toBe(true)
  }

  it('two Log appends both land, even when one writer read the note first', async () => {
    await seedProject(project)
    const { path: notePath } = await okOp('project_tracking_ensure', { project })
    const notePathStr = String(notePath)

    // Writer A reads (as it would before a table edit) and then goes away for a
    // while. Writer B appends in the meantime.
    const aRead = await okOp('note_read', { path: notePathStr })
    expect((await appendLog(notePathStr, 'B: newsletter, no action')).ok).toBe(true)

    // A appends WITHOUT its stale hash. The anchor is still there, so its line
    // lands under the heading and B's line is untouched.
    expect((await appendLog(notePathStr, 'A: RFC v3 arrived')).ok).toBe(true)

    const after = await okOp('note_read', { path: notePathStr })
    const content = String(after.content)
    expect(content).toContain('- A: RFC v3 arrived')
    expect(content).toContain('- B: newsletter, no action')
    // Newest first, directly under the heading.
    expect(content.indexOf('- A: RFC v3 arrived')).toBeLessThan(content.indexOf('- B: newsletter, no action'))
    expect(after.contentHash).not.toBe(aRead.contentHash)
  })

  it('parallel Log appends never lose a line that reported success', async () => {
    await seedProject(project)
    const { path: notePath } = await okOp('project_tracking_ensure', { project })
    const notePathStr = String(notePath)

    const lines = ['P1: first', 'P2: second', 'P3: third']
    const results = await Promise.all(lines.map((l) => appendLog(notePathStr, l)))

    const content = String((await okOp('note_read', { path: notePathStr })).content)
    // A racing writer may lose on the internal read→write hash and that is fine:
    // what must NEVER happen is a success whose line is not in the note.
    expect(results.some((r) => r.ok)).toBe(true)
    for (const [i, result] of results.entries()) {
      if (result.ok) expect(content, `${lines[i]} reported success`).toContain(`- ${lines[i]}`)
      else expect(result.message).toMatch(/conflict|modified externally|changed since/i)
    }
  })

  it('two Workstreams edits: one wins, the loser is told both hashes', async () => {
    await seedProject(project)
    const { path: notePath } = await okOp('project_tracking_ensure', { project })
    const notePathStr = String(notePath)
    await seedWorkstreamRows(notePathStr)

    // Both writers read the same version.
    const shared = await okOp('note_read', { path: notePathStr })
    const staleHash = String(shared.contentHash)

    // B lands its row edit first, under the hash they both hold.
    expect((await op('note_edit', {
      path: notePathStr,
      old_str: '| Design review | in progress |',
      new_str: '| Design review | done |',
      expectedHash: staleHash,
    })).ok).toBe(true)

    // A now tries ITS row, still holding the old hash. It must lose.
    const loser = await op('note_edit', {
      path: notePathStr,
      old_str: '| Implementation | blocked |',
      new_str: '| Implementation | in progress |',
      expectedHash: staleHash,
    })
    expect(loser.ok).toBe(false)
    const message = loser.ok === false ? loser.message : ''
    expect(message).toMatch(/conflict/i)
    // Both hashes: the one the loser held, and the one on disk now. Without both,
    // the model cannot tell "I am stale" from "the note is broken".
    expect(message).toContain(staleHash)
    const current = await okOp('note_read', { path: notePathStr })
    expect(message).toContain(String(current.contentHash))

    // B's edit survived; A's never landed.
    expect(String(current.content)).toContain('| Design review | done |')
    expect(String(current.content)).toContain('| Implementation | blocked |')
  })

  it('a human editing the note in the vault is not clobbered by the agent', async () => {
    await seedProject(project)
    const { path: notePath } = await okOp('project_tracking_ensure', { project })
    const notePathStr = String(notePath)
    await seedWorkstreamRows(notePathStr)

    // The agent reads, intending to update the table.
    const agentRead = await okOp('note_read', { path: notePathStr })

    // The human edits the same note through the Notes page in the meantime.
    const humanText = String(agentRead.content).replace(
      '## Status',
      '## Status\n\nHUMAN: hold off, the review slipped a week.',
    )
    const saved = await request('PUT', `/api/notes-v2/content/${notePathStr}`, {
      content: humanText,
      expectedHash: agentRead.contentHash,
    })
    expect(saved.status).toBe(200)

    // The agent's edit, on its now-stale hash, must fail rather than overwrite.
    const clobber = await op('note_edit', {
      path: notePathStr,
      old_str: '| Design review | in progress |',
      new_str: '| Design review | done |',
      expectedHash: agentRead.contentHash,
    })
    expect(clobber.ok).toBe(false)
    expect(await noteOnDisk(notePathStr)).toContain('HUMAN: hold off, the review slipped a week.')
    expect(await noteOnDisk(notePathStr)).toContain('| Design review | in progress |')
  })
})

describe('rename — the key follows the project, the note stays put', () => {
  it('does NOT move the note (pinned: notes are the vault, not project storage)', async () => {
    await seedProject(project)
    const ensured = await okOp('project_tracking_ensure', { project })
    const originalPath = String(ensured.path)

    const renamed = `${project} Bay`
    const res = await request('PATCH', `/api/projects/${encodeURIComponent(project)}`, { name: renamed })
    expect(res.status).toBe(200)

    // The metadata key came along with the row and still names the OLD path.
    expect((await projectMetadata(renamed)).tracking_note).toBe(originalPath)
    // The file did not move, and no second note was minted under the new name.
    expect(await vaultPaths()).toContain(originalPath)
    expect(await vaultPaths()).not.toContain(`Projects/${renamed}/Tracking.md`)

    // And the note is still reachable under the new project name.
    const got = await okOp('project_tracking_get', { project: renamed })
    expect(got.path).toBe(originalPath)

    // Ensure under the new name adopts nothing and moves nothing.
    const again = await okOp('project_tracking_ensure', { project: renamed })
    expect(again).toMatchObject({ path: originalPath, created: false, adopted: false })
  })
})
