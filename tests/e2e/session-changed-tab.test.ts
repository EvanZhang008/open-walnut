/**
 * E2E for the session "Changed" view: the live server's GET /changes endpoint +
 * computeSessionChanges engine, end-to-end over real HTTP.
 *
 * What's real: Express server, the route, the detect engine, the local file
 * reader (reads the edited file's current bytes off disk), repo grouping, and a
 * real persisted session record (createSessionRecord).
 * What's staged: the session JSONL on disk — exactly the shape Claude Code's
 * capture pipeline writes (an Edit tool_use). We stage it ourselves rather than
 * spawn the mock CLI, because the stdout→JSONL capture is not deterministic when
 * a single E2E file runs in isolation; staging keeps this test hermetic while
 * still exercising the full route→engine→reader→grouping→HTTP path live.
 *
 * What's mocked: constants.js (temp dir).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../src/core/session-file-reader.js'

let server: HttpServer
let port: number
let repoDir: string
let editedFile: string
const SID = 'changed-e2e-sid'

function apiUrl(p: string): string { return `http://localhost:${port}${p}` }

/** Stage a canonical session JSONL recording an Edit, at Claude Code's path. */
async function stageJsonl(cwd: string, file: string) {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwd))
  await fs.mkdir(dir, { recursive: true })
  const lines = [
    { type: 'user', cwd, message: { role: 'user', content: 'edit it' } },
    {
      type: 'assistant', cwd, timestamp: '2025-01-01T00:00:00Z',
      message: {
        id: 'a1', role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: file, old_string: 'OLD_LINE', new_string: 'NEW_LINE' } }],
      },
    },
  ]
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'))
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  // Real temp git repo with the post-edit file on disk (the engine reads it as `after`).
  repoDir = path.join(os.tmpdir(), `walnut-changed-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(repoDir, '.git'), { recursive: true })
  editedFile = path.join(repoDir, 'src', 'feature.ts')
  await fs.mkdir(path.dirname(editedFile), { recursive: true })
  await fs.writeFile(editedFile, 'export const NEW_LINE = true;\n')

  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0

  await createSessionRecord(SID, 'changed-task-001', 'TestProject', repoDir)
  await stageJsonl(repoDir, editedFile)
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {})
})

describe('Session Changed view — GET /changes (live server)', () => {
  it('surfaces an edited file with reconstructed before/after, grouped by repo', async () => {
    const res = await fetch(apiUrl(`/api/sessions/${SID}/changes`))
    expect(res.status).toBe(200)
    const body = await res.json() as {
      fileCount: number
      groups: Array<{ kind: string; label: string; files: Array<{ relPath: string; before: string; after: string; status: string }> }>
    }
    expect(body.fileCount).toBe(1)
    const group = body.groups[0]
    expect(group.kind).toBe('cwd')
    const change = group.files[0]
    expect(change.relPath).toBe(path.join('src', 'feature.ts'))
    expect(change.after).toBe('export const NEW_LINE = true;\n')
    // Edit was OLD_LINE → NEW_LINE; reversed `before` restores OLD_LINE.
    expect(change.before).toBe('export const OLD_LINE = true;\n')
    expect(change.status).toBe('modified')
  })

  it('reflects fresh on-disk content with ?refresh=1', async () => {
    // Prime the cache, then mutate the file WITHOUT touching the JSONL.
    await fetch(apiUrl(`/api/sessions/${SID}/changes`))
    await fs.writeFile(editedFile, 'export const NEW_LINE = false;\n')
    const res = await fetch(apiUrl(`/api/sessions/${SID}/changes?refresh=1`))
    const body = await res.json() as { groups: Array<{ files: Array<{ after: string }> }> }
    expect(body.groups[0].files[0].after).toBe('export const NEW_LINE = false;\n')
  })

  it('404 for an unknown session', async () => {
    const res = await fetch(apiUrl('/api/sessions/does-not-exist/changes'))
    expect(res.status).toBe(404)
  })
})
