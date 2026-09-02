/**
 * GET /api/file-history and GET /api/file-history/version through the real
 * express edge, plus the remote branch with an injected reader.
 *
 * The contract being pinned, one line each:
 *   - Walnut's own snapshots ALWAYS answer, in order, whether or not git exists
 *     (recorded by the same PUT the editor uses, so the wiring is covered too),
 *   - a version is addressable by snapshot id, and an unknown id is a clean 404,
 *   - a malformed sha is refused BEFORE anything is spawned,
 *   - a directory that is not a repo answers git.available:false / not_a_repo,
 *   - a real repo answers commits newest-first and `?sha=` serves that version,
 *   - an old daemon is 'daemon_needs_upgrade' and a hung daemon is 'timeout' —
 *     both degraded answers WITH the snapshot entries, never a failure.
 *
 * SAFETY: OPEN_WALNUT_HOME and every path written here live under the mkdtemp
 * directories created in beforeEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import express from 'express'
import request from 'supertest'

const execFileAsync = promisify(execFile)

import type { FileHistoryReader } from '../../../src/web/routes/file-history.js'

const { createFileHistoryRouter } = await import('../../../src/web/routes/file-history.js')
const { fileContentRouter } = await import('../../../src/web/routes/file-content.js')
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js')
const { DaemonNeedsUpgradeError } = await import('../../../src/core/daemon-file-reader.js')

type Deps = Parameters<typeof createFileHistoryRouter>[0]

function createApp(deps?: Deps) {
  const app = express()
  app.use(express.json())
  app.use('/api/file-history', createFileHistoryRouter(deps))
  app.use('/api/file-content', fileContentRouter)
  app.use(errorHandler)
  return app
}

let tmpHome: string
let work: string
let prevHome: string | undefined
let app: express.Express

const at = (rel: string) => path.join(work, rel)

/** Save through the editor's own route, which is what records a snapshot. */
const save = (filePath: string, content: string, writer?: string) =>
  request(app).put('/api/file-content').send({ path: filePath, content, ...(writer ? { writer } : {}) })

const history = (filePath: string, extra: Record<string, string> = {}) =>
  request(app).get('/api/file-history').query({ path: filePath, ...extra })

/**
 * Recording is fire-and-forget by design (a read/save must never wait on the
 * history store), so a listing right after a save legitimately races it. Poll
 * instead of sleeping a fixed amount: no flake, and the assertion still fails
 * loudly if the entry never lands.
 */
async function historyWith(filePath: string, minEntries: number) {
  const deadline = Date.now() + 2_000
  let res = await history(filePath)
  while ((res.body.entries?.length ?? 0) < minEntries && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
    res = await history(filePath)
  }
  return res
}

const version = (filePath: string, extra: Record<string, string>) =>
  request(app).get('/api/file-history/version').query({ path: filePath, ...extra })

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd, encoding: 'utf-8' })
}

beforeEach(async () => {
  prevHome = process.env.OPEN_WALNUT_HOME
  tmpHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-fh-home-')))
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-fh-work-')))
  process.env.OPEN_WALNUT_HOME = tmpHome
  app = createApp()
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OPEN_WALNUT_HOME
  else process.env.OPEN_WALNUT_HOME = prevHome
  // Both are mkdtemp dirs from beforeEach — nothing else is removed.
  await fs.rm(tmpHome, { recursive: true, force: true })
  await fs.rm(work, { recursive: true, force: true })
})

describe('GET /api/file-history (snapshots)', () => {
  it('lists the versions two saves recorded, newest last', async () => {
    const file = at('notes.ts')
    expect((await save(file, 'first')).status).toBe(200)
    expect((await save(file, 'second', 'merge')).status).toBe(200)

    const res = await historyWith(file, 2)
    expect(res.status).toBe(200)
    expect(res.body.entries.map((e: { writer: string }) => e.writer)).toEqual(['user', 'merge'])
    expect(res.body.entries[0].at).toBeLessThanOrEqual(res.body.entries[1].at)
    // Not a repo → the git half is absent, the snapshot half still answered.
    expect(res.body.git).toEqual({ available: false, reason: 'not_a_repo' })
  })

  it('records the viewer baseline on a tracked read (?track=baseline)', async () => {
    const file = at('opened.ts')
    await fs.writeFile(file, 'on disk', 'utf-8')
    const read = await request(app).get('/api/file-content').query({ path: file, track: 'baseline' })
    expect(read.status).toBe(200)
    const res = await historyWith(file, 1)
    expect(res.body.entries.map((e: { writer: string }) => e.writer)).toEqual(['baseline'])
  })

  it('answers an empty timeline for a file with no history', async () => {
    const res = await history(at('never-touched.ts'))
    expect(res.status).toBe(200)
    expect(res.body.entries).toEqual([])
  })

  it('refuses a relative path and a secret path', async () => {
    expect((await history('relative/notes.ts')).status).toBe(400)
    const secret = await history(path.join(os.homedir(), '.ssh', 'id_ed25519'))
    expect(secret.status).toBe(403)
    expect(secret.body.code).toBe('forbidden')
  })

  it("has history for a project's own config.yaml but not for Walnut's", async () => {
    // The viewer shows and edits a project's config.yaml, so its History must
    // answer too — the read path's blanket `config.ya?ml` rule is cloud-only here.
    const project = await history(at('config.yaml'))
    expect(project.status).toBe(200)
    // Walnut's own config (under the data dir) stays off-limits on every box.
    const own = await history(path.join(tmpHome, 'config.yaml'))
    expect(own.status).toBe(403)
  })
})

describe('GET /api/file-history/version', () => {
  it('serves a snapshot by id', async () => {
    const file = at('notes.ts')
    await save(file, 'first')
    await save(file, 'second')
    const list = await historyWith(file, 2)
    const [older] = list.body.entries
    const res = await version(file, { id: older.id })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ content: 'first', writer: 'user', hash: older.hash })
  })

  it('answers 404 not_found for an unknown id', async () => {
    const file = at('notes.ts')
    await save(file, 'first')
    await historyWith(file, 1)
    const res = await version(file, { id: '1-deadbeef' })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('not_found')
  })

  it('answers 400 invalid_sha for a malformed sha (before any git runs)', async () => {
    const res = await version(at('notes.ts'), { sha: 'not-a-sha; rm -rf /' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_sha')
  })

  it('answers 400 when neither id nor sha is given', async () => {
    const res = await version(at('notes.ts'), {})
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid')
  })
})

describe('git half (local repo)', () => {
  it('lists the commits that touched the file, newest first, and serves an older version', async () => {
    const file = at('tracked.ts')
    await git(['init'], work)
    await git(['config', 'user.email', 'dev@example.com'], work)
    await git(['config', 'user.name', 'Dev'], work)
    await fs.writeFile(file, 'gen one\n', 'utf-8')
    await git(['add', 'tracked.ts'], work)
    await git(['commit', '-m', 'first commit'], work)
    await fs.writeFile(file, 'gen two\n', 'utf-8')
    await git(['commit', '-am', 'second commit'], work)

    const res = await history(file)
    expect(res.status).toBe(200)
    expect(res.body.git.available).toBe(true)
    expect(res.body.git.repoRoot).toBe(work)
    const commits = res.body.git.commits as Array<{ sha: string; subject: string; at: number; author: string }>
    expect(commits).toHaveLength(2)
    expect(commits.map((c) => c.subject)).toEqual(['second commit', 'first commit'])
    expect(commits[0]!.at).toBeGreaterThanOrEqual(commits[1]!.at)
    expect(commits[0]!.author).toBe('Dev')

    // The OLDER commit's content, by sha.
    const older = await version(file, { sha: commits[1]!.sha })
    expect(older.status).toBe(200)
    expect(older.body).toMatchObject({ content: 'gen one\n', sha: commits[1]!.sha })
  })

  it('answers 404 for a well-formed sha git does not have', async () => {
    const file = at('tracked.ts')
    await git(['init'], work)
    await git(['config', 'user.email', 'dev@example.com'], work)
    await git(['config', 'user.name', 'Dev'], work)
    await fs.writeFile(file, 'gen one\n', 'utf-8')
    await git(['add', 'tracked.ts'], work)
    await git(['commit', '-m', 'first commit'], work)
    const res = await version(file, { sha: 'a'.repeat(40) })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('not_found')
  })

  it('reports not_a_repo for a directory outside any repo, snapshots intact', async () => {
    const file = at('loose.ts')
    await save(file, 'only in walnut')
    const res = await historyWith(file, 1)
    expect(res.body.git).toEqual({ available: false, reason: 'not_a_repo' })
    expect(res.body.entries).toHaveLength(1)
  })
})

describe('git half (remote host via the daemon)', () => {
  const fakeReader = (impl: Partial<FileHistoryReader>): Deps => ({
    createReader: () => ({
      gitFileLog: impl.gitFileLog ?? (async () => ({ repoRoot: null, commits: [] })),
      gitFileShow: impl.gitFileShow ?? (async () => ''),
    }),
  })

  it('reports daemon_needs_upgrade when the host daemon lacks the capability', async () => {
    app = createApp(fakeReader({
      gitFileLog: async () => { throw new DaemonNeedsUpgradeError('marina', 'git-file-history-v1') },
    }))
    const res = await request(app).get('/api/file-history')
      .query({ path: '/home/dev/project/notes.ts', host: 'marina' })
    expect(res.status).toBe(200)
    expect(res.body.git).toEqual({ available: false, reason: 'daemon_needs_upgrade' })
    expect(res.body.entries).toEqual([])
  })

  it('answers 501 daemon_needs_upgrade for a version fetch on an old daemon', async () => {
    app = createApp(fakeReader({
      gitFileShow: async () => { throw new DaemonNeedsUpgradeError('marina', 'git-file-history-v1') },
    }))
    const res = await request(app).get('/api/file-history/version')
      .query({ path: '/home/dev/project/notes.ts', host: 'marina', sha: 'abc1234' })
    expect(res.status).toBe(501)
    expect(res.body.code).toBe('daemon_needs_upgrade')
  })

  it('degrades to timeout (never hangs) when the daemon does not answer', async () => {
    app = createApp({
      ...fakeReader({ gitFileLog: () => new Promise(() => { /* never resolves */ }) }),
      gitDeadlineMs: 200,
    })
    const started = Date.now()
    const res = await request(app).get('/api/file-history')
      .query({ path: '/home/dev/project/notes.ts', host: 'marina' })
    expect(res.status).toBe(200)
    expect(res.body.git).toEqual({ available: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5_500)
  })

  it('returns the remote git log a current daemon answers with', async () => {
    app = createApp(fakeReader({
      gitFileLog: async () => ({
        repoRoot: '/home/dev/project',
        commits: [{ sha: 'aaaaaaa', at: 2_000, author: 'Dev', subject: 'newer' }],
      }),
      gitFileShow: async () => 'remote content',
    }))
    const res = await request(app).get('/api/file-history')
      .query({ path: '/home/dev/project/notes.ts', host: 'marina' })
    expect(res.body.git).toEqual({
      available: true,
      repoRoot: '/home/dev/project',
      commits: [{ sha: 'aaaaaaa', at: 2_000, author: 'Dev', subject: 'newer' }],
    })
    const ver = await request(app).get('/api/file-history/version')
      .query({ path: '/home/dev/project/notes.ts', host: 'marina', sha: 'aaaaaaa' })
    expect(ver.status).toBe(200)
    expect(ver.body).toEqual({ content: 'remote content', sha: 'aaaaaaa' })
  })
})
