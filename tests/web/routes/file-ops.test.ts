/**
 * File mutations (POST /api/files/{mkdir,create,rename,duplicate,delete}) through
 * the real HTTP edge, plus the remote branch of `performFileOp` with an injected
 * reader.
 *
 * The contract being pinned, in one line each:
 *   - a mutation NEVER clobbers (create/rename/duplicate answer 409 instead),
 *   - a folder is never deleted by accident (400 is_directory without recursive),
 *   - symlinks are moved/removed as the LINK, never followed,
 *   - the input floor refuses `/`, the home directory, one-segment paths, `..`
 *     segments and relative paths BEFORE any fs call happens,
 *   - a credential path (~/.ssh, ~/.aws, auth.json, Walnut's OWN config.yaml) is
 *     403 for both `path` and `newPath` — but an ordinary repo's `config.yaml` is
 *     NOT, because the read denylist's blanket rule made every one of them a dead
 *     end,
 *   - an old daemon is 501 daemon_needs_upgrade, not a generic failure,
 *   - a slow delete/duplicate answers 202 pending and keeps running; a timeout is
 *     never reported as a failure,
 *   - the local and remote error mappers read ONE errno table, so they cannot
 *     drift (an ENOSPC is 507 on both paths, not 507 here and 502 there).
 *
 * SAFETY: every mutating request in this file targets a path inside the mkdtemp
 * directory created in beforeEach. The few requests that name a real location
 * (`/`, the home directory, `/tmp`, `~/.ssh/...`) are all asserted to be REFUSED,
 * and each one is deliberately shaped so that a regression in the guard still
 * cannot write anything: they are `mkdir`/`rename` against a non-existent parent,
 * never a delete.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import request from 'supertest'

const {
  fileOpsRouter, performFileOp, withinMutateFloor, isProtectedStatePath,
  isSecretForMutation, raceDeadline,
} = await import('../../../src/web/routes/file-ops.js')
const { FILE_OP_ERRNO_TABLE, STATUS_BY_CODE, mapErrno, mapRemoteError } =
  await import('../../../src/web/routes/file-ops-errors.js')
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js')
const { DaemonNeedsUpgradeError } = await import('../../../src/core/daemon-file-reader.js')

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/files', fileOpsRouter)
  app.use(errorHandler)
  return app
}

let tmp: string
let app: express.Express

const at = (rel: string) => path.join(tmp, rel)
const post = (op: string, body: Record<string, unknown>) =>
  request(app).post(`/api/files/${op}`).send(body)

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-file-ops-')))
  app = createApp()
})

afterEach(async () => {
  // `tmp` is always the mkdtemp directory from beforeEach — nothing else is removed.
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('POST /api/files/mkdir', () => {
  it('creates a directory and reports its path', async () => {
    const res = await post('mkdir', { path: at('newdir') })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, path: at('newdir') })
    expect((await fs.lstat(at('newdir'))).isDirectory()).toBe(true)
  })

  it('answers 409 exists when the directory is already there', async () => {
    await fs.mkdir(at('newdir'))
    const res = await post('mkdir', { path: at('newdir') })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('exists')
  })

  it('answers 404 when the parent does not exist (no surprise tree)', async () => {
    const res = await post('mkdir', { path: at('missing/child') })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('not_found')
    expect(await exists(at('missing'))).toBe(false)
  })
})

describe('POST /api/files/create', () => {
  it('creates an EMPTY file', async () => {
    const res = await post('create', { path: at('fresh.ts') })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, path: at('fresh.ts') })
    expect((await fs.stat(at('fresh.ts'))).size).toBe(0)
  })

  it('answers 409 and never truncates an existing file', async () => {
    await fs.writeFile(at('fresh.ts'), 'precious')
    const res = await post('create', { path: at('fresh.ts') })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('exists')
    expect(await fs.readFile(at('fresh.ts'), 'utf-8')).toBe('precious')
  })
})

describe('POST /api/files/rename', () => {
  it('renames a file and reports the new path', async () => {
    await fs.writeFile(at('a.ts'), 'x')
    const res = await post('rename', { path: at('a.ts'), newPath: at('b.ts') })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, path: at('b.ts') })
    expect(await exists(at('a.ts'))).toBe(false)
    expect(await fs.readFile(at('b.ts'), 'utf-8')).toBe('x')
  })

  it('answers 404 for a missing source', async () => {
    const res = await post('rename', { path: at('gone.ts'), newPath: at('b.ts') })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('not_found')
  })

  it('answers 409 for an existing target and leaves BOTH files intact', async () => {
    await fs.writeFile(at('a.ts'), 'source')
    await fs.writeFile(at('b.ts'), 'victim')
    const res = await post('rename', { path: at('a.ts'), newPath: at('b.ts') })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('exists')
    expect(await fs.readFile(at('a.ts'), 'utf-8')).toBe('source')
    expect(await fs.readFile(at('b.ts'), 'utf-8')).toBe('victim')
  })

  it('renames a symlink as the LINK, never through it', async () => {
    await fs.writeFile(at('target.ts'), 'keep me')
    await fs.symlink(at('target.ts'), at('link.ts'))
    const res = await post('rename', { path: at('link.ts'), newPath: at('moved.ts') })
    expect(res.status).toBe(200)
    expect((await fs.lstat(at('moved.ts'))).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(at('moved.ts'))).toBe(at('target.ts'))
    expect(await fs.readFile(at('target.ts'), 'utf-8')).toBe('keep me')
    expect(await exists(at('link.ts'))).toBe(false)
  })

  it('refuses a destination inside the directory being moved', async () => {
    await fs.mkdir(at('dir/inner'), { recursive: true })
    const res = await post('rename', { path: at('dir'), newPath: at('dir/inner/dir') })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid')
  })

  it('refuses an over-long final name', async () => {
    await fs.writeFile(at('a.ts'), 'x')
    const res = await post('rename', { path: at('a.ts'), newPath: at('n'.repeat(256)) })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid')
  })
})

describe('POST /api/files/duplicate', () => {
  it('duplicates a file', async () => {
    await fs.writeFile(at('a.ts'), 'x')
    const res = await post('duplicate', { path: at('a.ts'), newPath: at('a copy.ts') })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, path: at('a copy.ts') })
    expect(await fs.readFile(at('a.ts'), 'utf-8')).toBe('x')
    expect(await fs.readFile(at('a copy.ts'), 'utf-8')).toBe('x')
  })

  it('duplicates a directory with its contents', async () => {
    await fs.mkdir(at('dir/inner'), { recursive: true })
    await fs.writeFile(at('dir/inner/deep.ts'), 'deep')
    await fs.writeFile(at('dir/top.ts'), 'top')
    const res = await post('duplicate', { path: at('dir'), newPath: at('dir copy') })
    expect(res.status).toBe(200)
    expect(await fs.readFile(at('dir copy/inner/deep.ts'), 'utf-8')).toBe('deep')
    expect(await fs.readFile(at('dir copy/top.ts'), 'utf-8')).toBe('top')
  })

  it('answers 409 for an existing target', async () => {
    await fs.writeFile(at('a.ts'), 'source')
    await fs.writeFile(at('b.ts'), 'victim')
    const res = await post('duplicate', { path: at('a.ts'), newPath: at('b.ts') })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('exists')
    expect(await fs.readFile(at('b.ts'), 'utf-8')).toBe('victim')
  })

  it('refuses copying a directory into itself', async () => {
    await fs.mkdir(at('dir'))
    const res = await post('duplicate', { path: at('dir'), newPath: at('dir/copy') })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid')
  })
})

describe('POST /api/files/delete', () => {
  it('deletes a file', async () => {
    await fs.writeFile(at('a.ts'), 'x')
    const res = await post('delete', { path: at('a.ts') })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(await exists(at('a.ts'))).toBe(false)
  })

  it('refuses a directory without recursive and keeps its contents', async () => {
    await fs.mkdir(at('dir/inner'), { recursive: true })
    await fs.writeFile(at('dir/inner/a.ts'), 'x')
    const res = await post('delete', { path: at('dir') })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('is_directory')
    expect(await exists(at('dir/inner/a.ts'))).toBe(true)
  })

  it('deletes a directory tree with recursive:true', async () => {
    await fs.mkdir(at('dir/inner'), { recursive: true })
    await fs.writeFile(at('dir/inner/a.ts'), 'x')
    const res = await post('delete', { path: at('dir'), recursive: true })
    expect(res.status).toBe(200)
    expect(await exists(at('dir'))).toBe(false)
  })

  it('answers 404 for a missing path', async () => {
    const res = await post('delete', { path: at('gone.ts') })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('not_found')
  })

  it('deletes a symlink as the LINK, leaving the target alone', async () => {
    await fs.writeFile(at('target.ts'), 'keep me')
    await fs.symlink(at('target.ts'), at('link.ts'))
    const res = await post('delete', { path: at('link.ts') })
    expect(res.status).toBe(200)
    expect(await exists(at('link.ts'))).toBe(false)
    expect(await fs.readFile(at('target.ts'), 'utf-8')).toBe('keep me')
  })
})

describe('file-ops validation (refused before any fs call)', () => {
  it('rejects a missing path', async () => {
    for (const op of ['mkdir', 'create', 'delete']) {
      const res = await post(op, {})
      expect(res.status, op).toBe(400)
      expect(res.body.code).toBe('invalid')
    }
  })

  it('rejects a missing newPath on rename and duplicate', async () => {
    await fs.writeFile(at('a.ts'), 'x')
    for (const op of ['rename', 'duplicate']) {
      const res = await post(op, { path: at('a.ts') })
      expect(res.status, op).toBe(400)
      expect(res.body.code).toBe('invalid')
    }
    expect(await exists(at('a.ts'))).toBe(true)
  })

  it('rejects a ".." segment and a relative path', async () => {
    // Built by string concat, NOT path.join — join normalizes `a/../b` to `b`
    // and the request would never carry a traversal segment at all.
    const traversal = await post('mkdir', { path: `${tmp}/a/../b` })
    expect(traversal.status).toBe(400)
    expect(traversal.body.code).toBe('invalid')
    expect(await exists(at('b'))).toBe(false)

    const relative = await post('mkdir', { path: 'relative/dir' })
    expect(relative.status).toBe(400)
    expect(relative.body.code).toBe('invalid')
  })

  it('withinMutateFloor is the same floor the daemon enforces', () => {
    // Direct unit coverage: at the HTTP edge the shared sandbox rejects `..`
    // first, so the floor's own segment rule needs its own assertions.
    expect(withinMutateFloor('/a/b')).toBe(true)
    expect(withinMutateFloor('/a/mod..old/thing.ts')).toBe(true)
    for (const bad of ['/', '/tmp', '/usr', os.homedir(), `${os.homedir()}/`, '/a/../b', '/a/./b', '/a/b/..', 'relative/x', '']) {
      expect(withinMutateFloor(bad), bad).toBe(false)
    }
  })

  it('rejects the root, the home directory, and one-segment paths', async () => {
    // mkdir on purpose: even if the floor regressed, mkdir on an existing path
    // cannot destroy anything (it answers EEXIST).
    for (const p of ['/', os.homedir(), '/tmp', '/usr']) {
      const res = await post('mkdir', { path: p })
      expect(res.status, p).toBe(400)
      expect(res.body.code).toBe('invalid')
    }
  })

  it('rejects a NUL byte in either path', async () => {
    const res = await post('rename', { path: at("a" + String.fromCharCode(0) + ".ts"), newPath: at('b.ts') })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid')
  })

  it('rejects a secret path as the source (403)', async () => {
    // A non-existent parent under ~/.ssh: the assertion is 403, and if the
    // denylist ever regressed the fs call still could not create anything.
    const res = await post('mkdir', { path: '~/.ssh/walnut-guard-probe/inner' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('forbidden')
  })

  it('rejects a secret path as the destination (403)', async () => {
    await fs.writeFile(at('a.ts'), 'x')
    const res = await post('rename', {
      path: at('a.ts'),
      newPath: '~/.aws/walnut-guard-probe/inner',
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('forbidden')
    expect(await exists(at('a.ts'))).toBe(true)
  })

  it('rejects an unknown operation at the core (the router only mounts five)', async () => {
    const res = await performFileOp({ op: 'chmod' as never, path: at('a.ts') })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'invalid' })

    const http = await post('chmod', { path: at('a.ts') })
    expect(http.status).toBe(404)
  })
})

describe('performFileOp remote branch (injected reader)', () => {
  const REMOTE = '/home/acme/project/notes.md'

  function fakeReader(overrides: Partial<Record<string, unknown>> = {}) {
    const calls: Array<[string, unknown[]]> = []
    const record = (name: string) => async (...args: unknown[]) => {
      calls.push([name, args])
    }
    const reader = {
      renamePath: record('renamePath'),
      removePath: record('removePath'),
      copyPath: record('copyPath'),
      mkdirExclusive: record('mkdirExclusive'),
      createEmptyFile: record('createEmptyFile'),
      ...overrides,
    }
    return { reader, calls }
  }

  it('routes a rename to the daemon reader and reports the new path', async () => {
    const { reader, calls } = fakeReader()
    const res = await performFileOp(
      { op: 'rename', path: REMOTE, newPath: '/home/acme/project/renamed.md', host: 'marina' },
      { createReader: () => reader as never },
    )
    expect(res).toEqual({ status: 200, body: { ok: true, path: '/home/acme/project/renamed.md' } })
    expect(calls).toEqual([['renamePath', [REMOTE, '/home/acme/project/renamed.md']]])
  })

  it('passes recursive through to the daemon delete, with a timeout past 30s', async () => {
    const { reader, calls } = fakeReader()
    const res = await performFileOp(
      { op: 'delete', path: REMOTE, host: 'marina', recursive: true },
      { createReader: () => reader as never },
    )
    expect(res).toEqual({ status: 200, body: { ok: true } })
    const [name, args] = calls[0] as [string, [string, boolean, number]]
    expect(name).toBe('removePath')
    expect(args.slice(0, 2)).toEqual([REMOTE, true])
    // The RPC must NOT reject on conn.send's 30s default while the daemon is
    // still deleting — that rejection is what used to become a lying 502.
    expect(args[2]).toBeGreaterThan(60_000)
  })

  it('gives duplicate the same long RPC timeout (it walks a tree too)', async () => {
    const { reader, calls } = fakeReader()
    const res = await performFileOp(
      { op: 'duplicate', path: REMOTE, newPath: '/home/acme/project/copy.md', host: 'marina' },
      { createReader: () => reader as never },
    )
    expect(res.status).toBe(200)
    const args = (calls[0] as [string, [string, string, number]])[1]
    expect(args[2]).toBeGreaterThan(60_000)
  })

  it('maps a daemon that lacks fs-mutate-v1 to 501 daemon_needs_upgrade', async () => {
    const { reader } = fakeReader({
      mkdirExclusive: async () => { throw new DaemonNeedsUpgradeError('marina') },
    })
    const res = await performFileOp(
      { op: 'mkdir', path: '/home/acme/project/sub', host: 'marina' },
      { createReader: () => reader as never },
    )
    expect(res.status).toBe(501)
    expect(res.body).toMatchObject({ code: 'daemon_needs_upgrade' })
    expect((res.body as { error: string }).error).toMatch(/upgrade/i)
  })

  it('maps the daemon error codes onto the HTTP contract', async () => {
    const cases: Array<[string, number, string]> = [
      ['fs.rename failed: target already exists (EEXIST)', 409, 'exists'],
      ['fs.rename failed: no such file (ENOENT)', 404, 'not_found'],
      ['fs.rm failed: target is a directory (EISDIR)', 400, 'is_directory'],
      ['fs.rename refused: path outside the mutation floor (EDENIED)', 403, 'forbidden'],
    ]
    for (const [message, status, code] of cases) {
      const { reader } = fakeReader({
        renamePath: async () => { throw new Error(message) },
      })
      const res = await performFileOp(
        { op: 'rename', path: REMOTE, newPath: '/home/acme/project/renamed.md', host: 'marina' },
        { createReader: () => reader as never },
      )
      expect(res.status, message).toBe(status)
      expect(res.body).toMatchObject({ code })
    }
  })

  it('maps any other remote failure to 502 with a plain-language prefix', async () => {
    const { reader } = fakeReader({
      renamePath: async () => { throw new Error('ssh tunnel died') },
    })
    const res = await performFileOp(
      { op: 'rename', path: REMOTE, newPath: '/home/acme/project/renamed.md', host: 'marina' },
      { createReader: () => reader as never },
    )
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ code: 'remote' })
    expect((res.body as { error: string }).error).toBe(
      'Could not complete on the remote host: ssh tunnel died',
    )
  })

  it('applies the same floor to remote paths (no fs call, no RPC)', async () => {
    const { reader, calls } = fakeReader()
    const res = await performFileOp(
      { op: 'delete', path: '/tmp', host: 'marina', recursive: true },
      { createReader: () => reader as never },
    )
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'invalid' })
    expect(calls).toEqual([])
  })
})

/**
 * The string floor is not a floor on its own. Every rule in `withinMutateFloor`
 * and `isSecretPath` reads the path as TEXT, but the kernel walks it as a chain of
 * directories — so one symlinked ancestor carries any target past all of them.
 * `/tmp/link/.ssh` is three segments deep, holds no `..`, is not `/`, is not the
 * home directory, and does not string-match the secret denylist; with `link`
 * pointing at the home directory, a recursive delete destroys the real `~/.ssh`.
 *
 * SAFETY: every fixture below lives inside the mkdtemp dir, and the "protected"
 * location is a FAKE data dir pointed at by WALNUT_HOME, so the denylist under
 * test resolves entirely within `tmp`. Nothing here can name a real secret, and
 * a regression can only delete this test's own fixture file.
 */
describe('the floor is enforced against the RESOLVED path, not the string', () => {
  let priorWalnutHome: string | undefined

  beforeEach(() => {
    priorWalnutHome = process.env.WALNUT_HOME
  })

  afterEach(() => {
    if (priorWalnutHome === undefined) delete process.env.WALNUT_HOME
    else process.env.WALNUT_HOME = priorWalnutHome
  })

  it('refuses a delete whose symlinked ancestor resolves onto protected state', async () => {
    const dataDir = at('fake-data-dir')
    await fs.mkdir(dataDir)
    const victim = path.join(dataDir, 'tasks.json')
    await fs.writeFile(victim, '{"tasks":[]}')
    process.env.WALNUT_HOME = dataDir

    // The laundering step: a link whose name says nothing about where it goes.
    await fs.symlink(dataDir, at('innocent'))

    const res = await post('delete', { path: at('innocent/tasks.json') })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('forbidden')
    // The point of the test: the task database is still there.
    expect(await exists(victim)).toBe(true)
  })

  it('refuses a rename whose symlinked ancestor resolves onto protected state', async () => {
    const dataDir = at('fake-data-dir')
    await fs.mkdir(dataDir)
    const victim = path.join(dataDir, 'sessions.json')
    await fs.writeFile(victim, '{}')
    process.env.WALNUT_HOME = dataDir
    await fs.symlink(dataDir, at('innocent'))

    const res = await post('rename', {
      path: at('innocent/sessions.json'),
      newPath: at('innocent/gone.json'),
    })
    expect(res.status).toBe(403)
    expect(await exists(victim)).toBe(true)
  })

  it('refuses when the symlink launders the DESTINATION of a rename', async () => {
    const dataDir = at('fake-data-dir')
    await fs.mkdir(dataDir)
    process.env.WALNUT_HOME = dataDir
    await fs.symlink(dataDir, at('innocent'))
    await fs.writeFile(at('ordinary.txt'), 'hi')

    // Source is unremarkable; only the target resolves into protected state.
    const res = await post('rename', {
      path: at('ordinary.txt'),
      newPath: at('innocent/tasks.json'),
    })
    expect(res.status).toBe(403)
    expect(await exists(path.join(dataDir, 'tasks.json'))).toBe(false)
    expect(await exists(at('ordinary.txt'))).toBe(true)
  })

  it('still allows an ordinary delete reached THROUGH a symlinked directory', async () => {
    // Over-blocking would be its own bug: navigating a project via a symlink is
    // normal, and the resolved path here breaks no rule.
    const real = at('real-dir')
    await fs.mkdir(real)
    await fs.writeFile(path.join(real, 'notes.txt'), 'hello')
    await fs.symlink(real, at('via'))

    const res = await post('delete', { path: at('via/notes.txt') })
    expect(res.status).toBe(200)
    expect(await exists(path.join(real, 'notes.txt'))).toBe(false)
  })

  it('deletes a symlink as the LINK even when its target is protected', async () => {
    // Removing a link never touches what it points at, so this must succeed —
    // and the target must survive.
    const dataDir = at('fake-data-dir')
    await fs.mkdir(dataDir)
    const target = path.join(dataDir, 'tasks.json')
    await fs.writeFile(target, '{"tasks":[]}')
    process.env.WALNUT_HOME = dataDir
    await fs.symlink(target, at('shortcut.json'))

    const res = await post('delete', { path: at('shortcut.json') })
    expect(res.status).toBe(200)
    expect(await exists(at('shortcut.json'))).toBe(false)
    expect(await exists(target)).toBe(true)
  })
})

describe('isProtectedStatePath', () => {
  const dataDir = '/somewhere/.open-walnut'
  let priorWalnutHome: string | undefined

  beforeEach(() => {
    priorWalnutHome = process.env.WALNUT_HOME
    process.env.WALNUT_HOME = dataDir
  })

  afterEach(() => {
    if (priorWalnutHome === undefined) delete process.env.WALNUT_HOME
    else process.env.WALNUT_HOME = priorWalnutHome
  })

  it('protects the data dir and the state files Walnut owns', () => {
    expect(isProtectedStatePath(dataDir)).toBe(true)
    expect(isProtectedStatePath(`${dataDir}/tasks.json`)).toBe(true)
    expect(isProtectedStatePath(`${dataDir}/sessions.json`)).toBe(true)
  })

  it('protects the stream JSONLs, which ARE the conversation history', () => {
    expect(isProtectedStatePath('/tmp/open-walnut-streams')).toBe(true)
    expect(isProtectedStatePath('/tmp/open-walnut-streams/abc-123.jsonl')).toBe(true)
    expect(isProtectedStatePath('/tmp/open-walnut/sessions.json')).toBe(true)
    // Streams moved to <dataDir>/tmp/streams in 2026-08; a denylist that only
    // knew the legacy /tmp roots left the CURRENT history deletable.
    expect(isProtectedStatePath(`${dataDir}/tmp`)).toBe(true)
    expect(isProtectedStatePath(`${dataDir}/tmp/streams/abc-123.jsonl`)).toBe(true)
    expect(isProtectedStatePath(`${dataDir}/tmp/file-history/ab/cd.blob`)).toBe(true)
  })

  it('resolves the data dir from OPEN_WALNUT_HOME when the test seam is unset', () => {
    // WALNUT_HOME is only a test seam; production sets OPEN_WALNUT_HOME (constants.ts
    // writes it back into the env). Reading only the seam meant prod protected a
    // data dir nobody used.
    const prior = process.env.OPEN_WALNUT_HOME
    delete process.env.WALNUT_HOME
    process.env.OPEN_WALNUT_HOME = '/elsewhere/.open-walnut'
    try {
      expect(isProtectedStatePath('/elsewhere/.open-walnut/tasks.json')).toBe(true)
      expect(isProtectedStatePath('/elsewhere/.open-walnut/tmp/streams/x.jsonl')).toBe(true)
      expect(isProtectedStatePath(`${dataDir}/tasks.json`)).toBe(false)
    } finally {
      if (prior === undefined) delete process.env.OPEN_WALNUT_HOME
      else process.env.OPEN_WALNUT_HOME = prior
    }
  })

  it('leaves the user\'s own files alone, including notes inside the data dir', () => {
    // Editing notes and skills from the Files panel is the point of the feature —
    // a blanket ban on the data dir would break it.
    expect(isProtectedStatePath(`${dataDir}/notes/groceries.md`)).toBe(false)
    expect(isProtectedStatePath(`${dataDir}/skills/acme/SKILL.md`)).toBe(false)
    expect(isProtectedStatePath('/Users/me/repo/tasks.json')).toBe(false)
    expect(isProtectedStatePath('/Users/me/repo/src/index.ts')).toBe(false)
  })
})

/**
 * A slow operation must never be reported as a failed one.
 *
 * SAFETY: the fake reader here performs NO filesystem work at all — the paths are
 * remote-looking strings on a host that does not exist, and the "operation" is a
 * promise this test controls.
 */
describe('a delete/duplicate past the deadline answers 202 pending', () => {
  const REMOTE = '/home/acme/project/big-tree'

  it('answers 202 while the delete keeps running (never a fake failure)', async () => {
    let release: (() => void) | undefined
    const stillRunning = new Promise<void>((resolve) => { release = resolve })
    const started = Date.now()
    const res = await performFileOp(
      { op: 'delete', path: REMOTE, host: 'marina', recursive: true },
      { createReader: () => ({ removePath: () => stillRunning }) as never, pendingAfterMs: 50 },
    )
    // The number that matters is "far below the RPC's own timeout", not a precise
    // duration — a loaded machine must not turn this into a flake.
    expect(Date.now() - started).toBeLessThan(1000)
    expect(res.status).toBe(202)
    expect(res.body).toEqual({
      pending: true,
      message: 'Still working — this is taking longer than usual. The tree will refresh when it finishes.',
    })
    release?.()
    await stillRunning
  })

  it('answers 202 for a slow duplicate as well', async () => {
    let release: (() => void) | undefined
    const stillRunning = new Promise<void>((resolve) => { release = resolve })
    const res = await performFileOp(
      { op: 'duplicate', path: REMOTE, newPath: '/home/acme/project/copy', host: 'marina' },
      { createReader: () => ({ copyPath: () => stillRunning }) as never, pendingAfterMs: 50 },
    )
    expect(res.status).toBe(202)
    expect((res.body as { pending: boolean }).pending).toBe(true)
    release?.()
    await stillRunning
  })

  it('still reports a real failure that arrives before the deadline', async () => {
    const res = await performFileOp(
      { op: 'delete', path: REMOTE, host: 'marina', recursive: true },
      {
        createReader: () => ({
          removePath: async () => { throw new Error('fs.rm failed: no such file (ENOENT)') },
        }) as never,
        pendingAfterMs: 5000,
      },
    )
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ code: 'not_found' })
  })
})

/**
 * The local half of the same guarantee. A local `fsp.rm` of a genuinely huge tree
 * can't be simulated without being slow, so the race itself is tested directly.
 */
describe('raceDeadline', () => {
  it('reports the value when the work wins', async () => {
    expect(await raceDeadline(Promise.resolve('done'), 1000)).toEqual({ done: true, value: 'done' })
  })

  it('reports not-done when the clock wins, and does NOT cancel the work', async () => {
    let finished = false
    const work = new Promise<string>((resolve) => {
      setTimeout(() => { finished = true; resolve('late') }, 80)
    })
    expect(await raceDeadline(work, 5)).toEqual({ done: false })
    expect(finished).toBe(false)
    // The point of the whole design: the operation is still on its way.
    await expect(work).resolves.toBe('late')
    expect(finished).toBe(true)
  })

  it('propagates a rejection that lands before the deadline', async () => {
    await expect(raceDeadline(Promise.reject(new Error('nope')), 1000)).rejects.toThrow('nope')
  })

  it('a rejection that lands AFTER the deadline is not the request outcome', async () => {
    const work = new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error('late boom')), 40)
    })
    expect(await raceDeadline(work, 5)).toEqual({ done: false })
    await expect(work).rejects.toThrow('late boom')
  })
})

/**
 * ONE errno table, two mappers. They were independent switch statements and
 * drifted: the same ENOSPC was a 507 locally and a generic 502 remotely.
 */
describe('error mapping agrees on every errno in the shared table', () => {
  const target = '/home/acme/project/notes.md'

  it('gives the same code AND the same message on both paths', () => {
    for (const errno of Object.keys(FILE_OP_ERRNO_TABLE)) {
      const local = mapErrno(Object.assign(new Error('local failure'), { code: errno }), target)
      const remote = mapRemoteError(
        new Error(`fs.rm failed: /var/lib/other-host/secret-layout (${errno})`),
        target,
      )
      expect(remote.code, errno).toBe(local.code)
      expect(remote.message, errno).toBe(local.message)
      // The daemon's raw text carries THAT host's absolute paths. A recognised
      // code answers from the table only — the user sees the path they typed.
      expect(remote.message, errno).not.toContain('other-host')
    }
  })

  it('never turns a user-caused condition into a 500', () => {
    for (const errno of Object.keys(FILE_OP_ERRNO_TABLE)) {
      const { code } = mapErrno(Object.assign(new Error('x'), { code: errno }), target)
      expect(STATUS_BY_CODE[code], errno).toBeDefined()
      expect(STATUS_BY_CODE[code], errno).not.toBe(500)
    }
  })

  it('places the new codes where the contract says', () => {
    expect(STATUS_BY_CODE.no_space).toBe(507)
    expect(STATUS_BY_CODE.unsupported).toBe(400)
    expect(mapErrno(Object.assign(new Error('x'), { code: 'ENOSPC' }), target).code).toBe('no_space')
    expect(mapErrno(Object.assign(new Error('x'), { code: 'EXDEV' }), target).code).toBe('unsupported')
    expect(mapErrno(Object.assign(new Error('x'), { code: 'ERR_FS_CP_SOCKET' }), target).code)
      .toBe('unsupported')
    expect(mapErrno(Object.assign(new Error('x'), { code: 'ELOOP' }), target).code).toBe('invalid')
    expect(mapErrno(Object.assign(new Error('x'), { code: 'EROFS' }), target).code).toBe('forbidden')
    expect(mapErrno(Object.assign(new Error('x'), { code: 'ENAMETOOLONG' }), target).code).toBe('invalid')
    expect(mapErrno(Object.assign(new Error('x'), { code: 'ENOTEMPTY' }), target).code).toBe('exists')
  })

  it('re-throws an unmapped errno, so a genuine bug is still a 500', () => {
    expect(() => mapErrno(Object.assign(new Error('boom'), { code: 'EWEIRD' }), target))
      .toThrow('boom')
  })

  it('maps a cp-family code the table does not list to unsupported', () => {
    const mapped = mapRemoteError(new Error('fs.copy failed: (ERR_FS_CP_SOMETHING_NEW)'), target)
    expect(mapped.code).toBe('unsupported')
  })

  it('maps a daemon that does not know the command to daemon_needs_upgrade', () => {
    const mapped = mapRemoteError(new Error('fs.rm failed: unknown command: fs.rm'), target)
    expect(mapped.code).toBe('daemon_needs_upgrade')
    expect(mapped.message).toMatch(/too old/i)
  })

  it('surfaces no_space as 507 through the route', async () => {
    const res = await performFileOp(
      { op: 'create', path: '/home/acme/project/new.md', host: 'marina' },
      {
        createReader: () => ({
          createEmptyFile: async () => { throw new Error('fs.write failed: (ENOSPC)') },
        }) as never,
      },
    )
    expect(res.status).toBe(507)
    expect(res.body).toMatchObject({ code: 'no_space', error: 'Not enough disk space' })
  })
})

/**
 * Mutations use their OWN secret list. The read denylist refuses `config.yaml`
 * anywhere, which made every repo's own config un-renameable with a bare 403.
 *
 * SAFETY: WALNUT_HOME points at a directory inside the mkdtemp dir, so every
 * "protected" path under test resolves within `tmp`. The refusal cases are
 * `create`/`mkdir` against paths that do not exist, so a regression in the guard
 * could only create a file inside this test's own temp dir.
 */
describe('isSecretForMutation (the mutation denylist, not the read one)', () => {
  let priorWalnutHome: string | undefined

  beforeEach(async () => {
    priorWalnutHome = process.env.WALNUT_HOME
    await fs.mkdir(at('fake-data-dir'))
    process.env.WALNUT_HOME = at('fake-data-dir')
  })

  afterEach(() => {
    if (priorWalnutHome === undefined) delete process.env.WALNUT_HOME
    else process.env.WALNUT_HOME = priorWalnutHome
  })

  it('allows an ordinary repo config.yaml (this used to be a bare 403)', async () => {
    const res = await post('create', { path: at('config.yaml') })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, path: at('config.yaml') })
  })

  it("still refuses Walnut's OWN config.yaml", async () => {
    const own = path.join(at('fake-data-dir'), 'config.yaml')
    const res = await post('create', { path: own })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('forbidden')
    expect(res.body.error).toMatch(/credentials/)
    expect(await exists(own)).toBe(false)
  })

  it('refuses credential stores by SEGMENT and credential files by basename', async () => {
    for (const p of [at('.ssh/probe'), at('.aws/probe'), at('.gnupg/probe'), at('.kube/probe'), at('secrets/probe')]) {
      const res = await post('mkdir', { path: p })
      expect(res.status, p).toBe(403)
      expect(res.body.code).toBe('forbidden')
      expect(await exists(p)).toBe(false)
    }
    for (const p of [at('auth.json'), at('bridge-tokens.json')]) {
      const res = await post('create', { path: p })
      expect(res.status, p).toBe(403)
      expect(await exists(p)).toBe(false)
    }
  })

  it('matches segments, never substrings — an ordinary file named my.ssh.notes is fine', async () => {
    const res = await post('create', { path: at('my.ssh.notes') })
    expect(res.status).toBe(200)
    expect(isSecretForMutation(at('my.ssh.notes'))).toBe(false)
    expect(isSecretForMutation(at('.ssh/config'))).toBe(true)
    expect(isSecretForMutation(at('nested/secrets/token.txt'))).toBe(true)
    expect(isSecretForMutation(at('deep/dir/auth.json'))).toBe(true)
  })

  it('refuses a credential path as the DESTINATION too', async () => {
    await fs.writeFile(at('a.ts'), 'x')
    const res = await post('rename', { path: at('a.ts'), newPath: at('.aws/credentials') })
    expect(res.status).toBe(403)
    expect(await exists(at('a.ts'))).toBe(true)
  })
})

describe('the `..` substring rule at the HTTP edge', () => {
  it('refuses `mod..old.ts` even though the floor itself allows the name', async () => {
    // The floor's own rule is segment-wise, so it says yes; assertPathAllowed runs
    // first and rejects any `..` SUBSTRING, so the HTTP answer is a bare 400.
    // Over-strict is the safe direction for a destructive edge — this test exists
    // so that loosening it has to be a deliberate change, not a side effect.
    expect(withinMutateFloor(at('mod..old.ts'))).toBe(true)
    const res = await post('create', { path: at('mod..old.ts') })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'invalid', error: 'Invalid path' })
    expect(await exists(at('mod..old.ts'))).toBe(false)
  })
})
