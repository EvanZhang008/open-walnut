/**
 * Linked plugin checkouts, against REAL git repositories.
 *
 * The whole feature is a set of claims about a symlink and a work tree, so mocking git
 * here would only test the mock. Everything runs in a temp dir: a bare origin, a
 * publisher clone that moves the remote forward, and the "linked" clone the plugins point
 * into. No network.
 */

import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  checkLinkedCheckout,
  detectLinkedCheckout,
  LinkedCheckoutError,
  listLinkedCheckouts,
  updateLinkedCheckout,
} from '../../../src/core/plugins/linked-checkout.js'

const exec = promisify(execFile)

/** Identity and signing are pinned so the test never depends on the machine's git config. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', [
    '-c', 'user.name=Walnut Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd })
  return stdout.trim()
}

async function writeManifest(dir: string, id: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id, name: id, version: '1.0.0' }, null, 2),
  )
}

let root = ''
let origin = ''
let publisher = ''
let work = ''
let externalDir = ''

/** Move the remote forward by one commit, so a check/update has something to find. */
async function publishCommit(message: string): Promise<string> {
  await fsp.appendFile(path.join(publisher, 'sample', 'index.ts'), `// ${message}\n`)
  await git(['add', '.'], publisher)
  await git(['commit', '-m', message], publisher)
  await git(['push', 'origin', 'main'], publisher)
  return git(['rev-parse', 'HEAD'], publisher)
}

beforeAll(async () => {
  // realpath: on macOS os.tmpdir() is itself a symlink (/var → /private/var), and every
  // assertion here compares canonical paths.
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'linked-checkout-')))
  origin = path.join(root, 'origin.git')
  publisher = path.join(root, 'publisher')
  work = path.join(root, 'work')
  externalDir = path.join(root, 'home', 'plugins')

  await fsp.mkdir(origin, { recursive: true })
  await git(['init', '--bare', '-b', 'main'], origin)

  await git(['clone', origin, publisher], root)
  await writeManifest(path.join(publisher, 'sample'), 'sample')
  await writeManifest(path.join(publisher, 'second'), 'second')
  await fsp.writeFile(path.join(publisher, 'sample', 'index.ts'), '// first\n')
  await git(['add', '.'], publisher)
  await git(['commit', '-m', 'first'], publisher)
  await git(['push', '-u', 'origin', 'main'], publisher)

  await git(['clone', origin, work], root)

  await fsp.mkdir(externalDir, { recursive: true })
  // Two plugins linked out of ONE checkout, which is the case the update route has to
  // reload as a group.
  await fsp.symlink(path.join(work, 'sample'), path.join(externalDir, 'sample'), 'dir')
  await fsp.symlink(path.join(work, 'second'), path.join(externalDir, 'second'), 'dir')
  // A plugin installed the ordinary way: a real directory, not a link.
  await writeManifest(path.join(externalDir, 'plain'), 'plain')
  // A link whose checkout was moved away.
  await fsp.symlink(path.join(root, 'vanished'), path.join(externalDir, 'gone'), 'dir')
})

afterAll(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true })
})

describe('linked plugin checkouts', () => {
  it('describes the checkout a link points into', async () => {
    const info = await detectLinkedCheckout('sample', undefined, { externalDir })

    expect(info).not.toBeNull()
    expect(info!.path).toBe(path.join(work, 'sample'))
    // The plugin dir is INSIDE the work tree, not equal to it, and that distinction is
    // what Check and Update act on (the repo, never just the plugin folder).
    expect(info!.checkout).toBe(work)
    expect(info!.branch).toBe('main')
    expect(info!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(info!.remote).toContain('origin.git')
    expect(info!.dirty).toBe(false)
  })

  it('never reports a plain directory or a dangling link as linked', async () => {
    // `plain` is exactly how a store-installed plugin looks, and offering it an Update
    // button would be a button that cannot work.
    expect(await detectLinkedCheckout('plain', path.join(externalDir, 'plain'), { externalDir })).toBeNull()
    expect(await detectLinkedCheckout('gone', undefined, { externalDir })).toBeNull()
    expect(await detectLinkedCheckout('not-installed', undefined, { externalDir })).toBeNull()
  })

  it('finds a link whose name is not the plugin id, via the recorded directory', async () => {
    const aliased = path.join(externalDir, 'sample-alias')
    await fsp.symlink(path.join(work, 'sample'), aliased, 'dir')
    try {
      // No `~/.open-walnut/plugins/<id>` for this id at all: the only way to it is the
      // dir the loader recorded.
      const info = await detectLinkedCheckout('renamed-id', path.join(work, 'sample'), { externalDir })
      expect(info?.checkout).toBe(work)
    } finally {
      await fsp.rm(aliased, { force: true })
    }
  })

  it('masks credentials embedded in the remote URL', async () => {
    await git(['remote', 'set-url', 'origin', 'https://evan:s3cret@example.invalid/plugins.git'], work)
    try {
      const info = await detectLinkedCheckout('sample', undefined, { externalDir })
      expect(info!.remote).toBe('https://***@example.invalid/plugins.git')
      expect(info!.remote).not.toContain('s3cret')
    } finally {
      await git(['remote', 'set-url', 'origin', origin], work)
    }
  })

  it('reports an uncommitted change as dirty', async () => {
    const scratch = path.join(work, 'sample', 'scratch.ts')
    await fsp.writeFile(scratch, 'export const wip = true\n')
    try {
      expect((await detectLinkedCheckout('sample', undefined, { externalDir }))!.dirty).toBe(true)
    } finally {
      await fsp.rm(scratch, { force: true })
    }
    expect((await detectLinkedCheckout('sample', undefined, { externalDir }))!.dirty).toBe(false)
  })

  it('lists every plugin linked out of the same checkout, and nothing else', async () => {
    const linked = await listLinkedCheckouts({ externalDir })

    // Keyed by the id in the manifest, which is the id the store's rows carry.
    expect([...linked.keys()].sort()).toEqual(['sample', 'second'])
    expect(linked.get('sample')!.checkout).toBe(work)
    expect(linked.get('second')!.checkout).toBe(work)
    expect(linked.has('plain')).toBe(false)
    expect(linked.has('gone')).toBe(false)
  })

  it('counts how far behind the checkout is after the remote moves', async () => {
    await publishCommit('behind by one')
    const info = (await detectLinkedCheckout('sample', undefined, { externalDir }))!

    const status = await checkLinkedCheckout(info)

    expect(status.fetched).toBe(true)
    expect(status.behind).toBe(1)
    expect(status.ahead).toBe(0)
    expect(status.dirty).toBe(false)
    expect(status.branch).toBe('main')
    // A check must never move the working copy.
    expect(await git(['rev-parse', 'HEAD'], work)).toBe(info.sha)
  })

  it('fast-forwards a clean checkout and lands on the published commit', async () => {
    const published = await publishCommit('the update')
    const info = (await detectLinkedCheckout('sample', undefined, { externalDir }))!

    const result = await updateLinkedCheckout(info)

    expect(result.updated).toBe(true)
    expect(result.fromSha).toBe(info.sha)
    expect(result.sha).toBe(published)
    expect(await git(['rev-parse', 'HEAD'], work)).toBe(published)

    const after = await checkLinkedCheckout((await detectLinkedCheckout('sample', undefined, { externalDir }))!)
    expect(after.behind).toBe(0)
  })

  it('says so instead of pulling again when there is nothing new', async () => {
    const info = (await detectLinkedCheckout('sample', undefined, { externalDir }))!

    const result = await updateLinkedCheckout(info)

    expect(result.updated).toBe(false)
    expect(result.sha).toBe(info.sha)
  })

  it('refuses to update a dirty checkout, and leaves HEAD where it was', async () => {
    const published = await publishCommit('must not be pulled')
    expect(published).not.toBe(await git(['rev-parse', 'HEAD'], work))
    await fsp.appendFile(path.join(work, 'sample', 'index.ts'), '// local work in progress\n')
    const before = await git(['rev-parse', 'HEAD'], work)
    const info = (await detectLinkedCheckout('sample', undefined, { externalDir }))!
    expect(info.dirty).toBe(true)

    try {
      await expect(updateLinkedCheckout(info)).rejects.toMatchObject({
        name: 'LinkedCheckoutError',
        code: 'dirty',
      })
      // The refusal is the whole point: uncommitted work is never discarded, and the
      // commit that was waiting is still waiting.
      expect(await git(['rev-parse', 'HEAD'], work)).toBe(before)
    } finally {
      await git(['checkout', '--', 'sample/index.ts'], work)
    }
  })

  it('reports a dirty tree even when git cannot answer, rather than calling it clean', async () => {
    // A directory that is not a repository at all: `status` fails, and the safe reading of
    // an unanswerable status is "there may be work here".
    const notARepo = await fsp.mkdtemp(path.join(root, 'not-a-repo-'))
    await expect(updateLinkedCheckout({
      path: notARepo,
      checkout: notARepo,
      branch: 'main',
      sha: '0'.repeat(40),
      dirty: false,
    })).rejects.toBeInstanceOf(LinkedCheckoutError)
  })

  it('flags a count that came without a fetch, with the one line of git that explains it', async () => {
    // The remote vanishes (no access, offline): the fetch fails, but the last fetch is
    // still on disk, so the count is real and only as fresh as that fetch.
    const originUrl = await git(['remote', 'get-url', 'origin'], work)
    await git(['remote', 'set-url', 'origin', path.join(root, 'no-such-origin.git')], work)
    try {
      const info = (await detectLinkedCheckout('sample', undefined, { externalDir }))!

      const status = await checkLinkedCheckout(info)

      expect(status.fetched).toBe(false)
      expect(status.behind).toBe(0)
      expect(status.reason).toMatch(/^Could not fetch: /)
      // Gist, not the whole transcript: no exit code, no multi-line "please make sure" advice.
      expect(status.reason).not.toMatch(/git exited|\n|please make sure/i)
      expect(status.reason).toMatch(/no-such-origin/)
    } finally {
      await git(['remote', 'set-url', 'origin', originUrl], work)
    }
  })

  it('has no count to give when the branch tracks nothing', async () => {
    await git(['checkout', '-b', 'local-only'], work)
    try {
      const info = (await detectLinkedCheckout('sample', undefined, { externalDir }))!
      expect(info.branch).toBe('local-only')

      const status = await checkLinkedCheckout(info)

      // Not "up to date": there is nothing to be up to date WITH, and saying zero here
      // would be a confident wrong answer.
      expect(status.behind).toBeNull()
      expect(status.ahead).toBeNull()
      expect(status.reason).toContain('local-only')
    } finally {
      await git(['checkout', 'main'], work)
    }
  })
})
