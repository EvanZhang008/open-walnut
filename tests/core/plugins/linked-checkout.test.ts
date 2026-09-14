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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  checkLinkedCheckout,
  detectLinkedCheckout,
  LinkedCheckoutError,
  listLinkedCheckouts,
  listLinkedCheckoutsDetailed,
  updateLinkedCheckout,
  type LinkedCheckoutInfo,
} from '../../../src/core/plugins/linked-checkout.js'
import {
  CHECKOUT_MOVED_REASON,
  UNSUPPORTED_HINT_NO_UPSTREAM,
  deriveUpdateState,
  linkedRowKey,
} from '../../../src/core/plugins/update-status.js'
import { UpdateStatusCache, readLocalFacts } from '../../../src/core/plugins/update-status-cache.js'

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

/**
 * The update-status layer on top, against the same real repositories. Its own clone
 * (`lab`) so the sequence above keeps its assumptions about `work`.
 */
describe('update status from a real checkout', () => {
  let lab = ''
  let labExternal = ''
  const labInfo = async (): Promise<LinkedCheckoutInfo> => (await detectLinkedCheckout('sample', undefined, { externalDir: labExternal }))!

  beforeAll(async () => {
    lab = path.join(root, 'lab')
    labExternal = path.join(root, 'lab-home', 'plugins')
    await git(['clone', origin, lab], root)
    await fsp.mkdir(labExternal, { recursive: true })
    await fsp.symlink(path.join(lab, 'sample'), path.join(labExternal, 'sample'), 'dir')
  })

  it('maps a clean checkout that tracks the remote to current, and the fetched upstream sha rides along', async () => {
    const status = await checkLinkedCheckout(await labInfo())
    expect(deriveUpdateState({ kind: 'linked', status })).toEqual({ kind: 'current' })
    expect(status.upstreamSha).toBe(await git(['rev-parse', 'HEAD'], publisher))
  })

  it('maps an uncommitted change to dirty, whatever the counts say', async () => {
    await fsp.appendFile(path.join(lab, 'sample', 'index.ts'), '// scratch\n')
    try {
      const status = await checkLinkedCheckout(await labInfo())
      expect(deriveUpdateState({ kind: 'linked', status })).toEqual({ kind: 'dirty', behind: 0 })
    } finally {
      await git(['checkout', '--', '.'], lab)
    }
  })

  it('maps behind-only to available with the count, ahead-only to current with the count', async () => {
    await publishCommit('lab behind')
    let status = await checkLinkedCheckout(await labInfo())
    expect(deriveUpdateState({ kind: 'linked', status })).toEqual({ kind: 'available', behind: 1 })

    await git(['pull', '--ff-only'], lab)
    await fsp.appendFile(path.join(lab, 'sample', 'index.ts'), '// local only\n')
    await git(['add', '.'], lab)
    await git(['commit', '-m', 'lab ahead'], lab)
    status = await checkLinkedCheckout(await labInfo())
    expect(deriveUpdateState({ kind: 'linked', status })).toEqual({ kind: 'current', ahead: 1 })
  })

  it('maps behind AND ahead to diverged (amber, not an error)', async () => {
    await publishCommit('lab diverge')
    const status = await checkLinkedCheckout(await labInfo())
    expect(deriveUpdateState({ kind: 'linked', status })).toEqual({ kind: 'diverged', behind: 1, ahead: 1 })
    // Back to a clean tracking state for the tests below.
    await git(['reset', '--hard', 'origin/main'], lab)
  })

  it('maps a branch with no upstream to unsupported with the push-or-set hint', async () => {
    await git(['checkout', '-b', 'lab-local'], lab)
    try {
      const status = await checkLinkedCheckout(await labInfo())
      expect(deriveUpdateState({ kind: 'linked', status })).toMatchObject({ kind: 'unsupported', hint: UNSUPPORTED_HINT_NO_UPSTREAM })
    } finally {
      await git(['checkout', 'main'], lab)
    }
  })

  it('passes the env option through to the git child (a config injected by env redirects the fetch)', async () => {
    const info = await labInfo()
    // `url.<x>.insteadOf` is single-valued and env config has command-line precedence, so
    // this rewrites the origin URL for the fetch of THIS call only.
    const status = await checkLinkedCheckout(info, {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${path.join(root, 'env-redirected-origin.git')}.insteadOf`,
        GIT_CONFIG_VALUE_0: origin,
      },
    })
    expect(status.fetched).toBe(false)
    expect(status.reason).toMatch(/env-redirected-origin/)
    // Without the option the same checkout fetches fine: the default path is unchanged.
    expect((await checkLinkedCheckout(info)).fetched).toBe(true)
  })

  it('lists what the budget left out instead of dropping it silently', async () => {
    const listing = await listLinkedCheckoutsDetailed({ externalDir, budgetMs: 0 })
    expect(listing.found.size).toBe(0)
    expect(listing.skipped).toEqual(expect.arrayContaining(['sample', 'second']))
    const full = await listLinkedCheckoutsDetailed({ externalDir })
    expect(full.skipped).toEqual([])
    expect([...full.found.keys()].sort()).toEqual(['sample', 'second'])
  })
})

describe('local facts recomputed on every snapshot (no fetch)', () => {
  let facts = ''
  let factsExternal = ''
  const factsInfo = async (): Promise<LinkedCheckoutInfo> => (await detectLinkedCheckout('sample', undefined, { externalDir: factsExternal }))!

  beforeAll(async () => {
    facts = path.join(root, 'facts')
    factsExternal = path.join(root, 'facts-home', 'plugins')
    await git(['clone', origin, facts], root)
    await fsp.mkdir(factsExternal, { recursive: true })
    await fsp.symlink(path.join(facts, 'sample'), path.join(factsExternal, 'sample'), 'dir')
  })

  it('dirty then commit reads current with zero fetches; pull turns available into current; a reset reads as moved', async () => {
    const checkLinked = vi.fn((info: LinkedCheckoutInfo, env: NodeJS.ProcessEnv) => checkLinkedCheckout(info, { env }))
    const cache = new UpdateStatusCache({
      filePath: path.join(root, 'facts-cache.json'),
      ops: { checkLinked, checkSource: vi.fn(async () => ({ behind: 0 })) },
    })
    const info = await factsInfo()
    const rowKey = linkedRowKey(info.checkout)
    const targets = [{ rowKey, kind: 'linked' as const, info, pluginIds: ['sample'] }]

    await publishCommit('facts behind')
    await cache.refreshAll(targets, { force: true })
    expect(checkLinked).toHaveBeenCalledTimes(1)
    expect((await cache.snapshot(targets)).rows[rowKey].state).toEqual({ kind: 'available', behind: 1 })

    // The user pulls by hand: the next snapshot says current, and nothing was fetched.
    await git(['pull', '--ff-only'], facts)
    expect((await cache.snapshot(targets)).rows[rowKey].state).toEqual({ kind: 'current' })

    // The user edits: dirty. Then commits: current, one ahead. Still no fetch.
    await fsp.appendFile(path.join(facts, 'sample', 'index.ts'), '// wip\n')
    expect((await cache.snapshot(targets)).rows[rowKey].state).toEqual({ kind: 'dirty', behind: 0 })
    await git(['add', '.'], facts)
    await git(['commit', '-m', 'facts local'], facts)
    expect((await cache.snapshot(targets)).rows[rowKey].state).toEqual({ kind: 'current', ahead: 1 })
    expect(checkLinked).toHaveBeenCalledTimes(1)

    // A reset below the HEAD the fetch saw AND below the fetched upstream commit: the
    // cached counts describe nothing real. (HEAD~2 would land exactly on the fetched HEAD,
    // where "1 behind" is still the true answer; the moved rule needs both to differ.)
    await git(['reset', '--hard', 'HEAD~3'], facts)
    const moved = await cache.snapshot(targets, { autoRefresh: false })
    expect(moved.rows[rowKey].state).toEqual({ kind: 'unchecked', reason: CHECKOUT_MOVED_REASON })
    expect(checkLinked).toHaveBeenCalledTimes(1)
    // With auto refresh the moved row is re-checked in the background.
    const kicked = await cache.snapshot(targets)
    expect(kicked.refreshing).toBe(true)
    await cache.refreshRow(rowKey, targets[0])
    expect(checkLinked).toHaveBeenCalledTimes(2)
    // HEAD~3 of (upstream + one local commit) is upstream~2, so two behind.
    expect((await cache.snapshot(targets)).rows[rowKey].state).toEqual({ kind: 'available', behind: 2 })
  })

  it('readLocalFacts answers behind/ahead against the given commit and flags an unknown one as moved', async () => {
    await git(['reset', '--hard', 'origin/main'], facts)
    const upstream = await git(['rev-parse', 'origin/main'], facts)
    const clean = await readLocalFacts(facts, upstream, { headAtFetch: upstream })
    expect(clean).toEqual({ dirty: false, head: upstream, behind: 0, ahead: 0, moved: false })

    const unknown = await readLocalFacts(facts, 'f'.repeat(40), { headAtFetch: upstream })
    expect(unknown.moved).toBe(true)
    expect(unknown.behind).toBeNull()

    // A directory that is not a repository: dirty (the safe direction), nothing counted.
    const notRepo = await readLocalFacts(root, upstream, { deadlineMs: 2_000 })
    expect(notRepo.dirty).toBe(true)
  })
})
