/**
 * Plugin update status: the pure derivation and the cache around it.
 *
 * `deriveUpdateState` is pinned rule by rule (spec section 4, rules 0..6 in that order),
 * the failure classifier one pattern at a time, and the cache with fake ops so a test
 * can count fetches: the whole point of the cache is how few of them happen.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinkedCheckoutInfo, LinkedCheckoutStatus } from '../../../src/core/plugins/linked-checkout.js'
import {
  CHECKOUT_MOVED_REASON,
  ROW_TIMEOUT_REASON,
  UNSUPPORTED_HINT_DETACHED,
  UNSUPPORTED_HINT_NO_UPSTREAM,
  classifyGitFailure,
  deriveUpdateState,
  describeGitFailure,
  fetchEnv,
  gitFailureSentence,
  linkedRowKey,
  npmToVersion,
  scrubGitReason,
  sourceRowKey,
  withDeadline,
} from '../../../src/core/plugins/update-status.js'
import {
  DEFAULT_CACHE_FILE,
  UpdateStatusCache,
  type LocalFacts,
  type UpdatableTarget,
  type UpdateCheckOps,
} from '../../../src/core/plugins/update-status-cache.js'
import { TMP_DIR, WALNUT_HOME } from '../../../src/constants.js'

function linked(over: Partial<LinkedCheckoutStatus> = {}): LinkedCheckoutStatus {
  return { behind: 0, ahead: 0, dirty: false, sha: 'a'.repeat(40), branch: 'main', fetched: true, upstreamSha: 'b'.repeat(40), ...over }
}

describe('deriveUpdateState (rules 0..6, fixed order)', () => {
  it('rule 0: a source that is not cloned here is missing, never unreachable', () => {
    expect(deriveUpdateState({ kind: 'git', result: { behind: 0, error: 'Could not resolve hostname' }, cloned: false })).toEqual({ kind: 'missing' })
    expect(deriveUpdateState({ kind: 'git', result: { behind: 0, error: 'ENOENT: no such file or directory' }, cloned: true })).toEqual({ kind: 'missing' })
    expect(deriveUpdateState({ kind: 'git', result: { behind: 0, error: 'fatal: not a git repository' }, cloned: true })).toEqual({ kind: 'missing' })
    expect(deriveUpdateState({ kind: 'linked', status: linked({ fetched: false }), missing: true })).toEqual({ kind: 'missing' })
  })

  it('rule 1: a failed fetch is unreachable with the cause classified and lastKnown from the previous state', () => {
    const state = deriveUpdateState(
      { kind: 'git', result: { behind: 0, error: 'fatal: Could not resolve hostname example.invalid' }, cloned: true },
      { kind: 'available', behind: 3 },
    )
    expect(state).toMatchObject({ kind: 'unreachable', cause: 'network', lastKnown: 'available' })
    expect(state.kind === 'unreachable' && state.reason).toMatch(/Could not resolve hostname/)
  })

  it('rule 1 (linked): fetched:false still computes lastKnown from the counts it carries', () => {
    expect(deriveUpdateState({ kind: 'linked', status: linked({ fetched: false, behind: 0, reason: 'Could not fetch: Connection refused' }) }))
      .toMatchObject({ kind: 'unreachable', cause: 'network', lastKnown: 'current' })
    expect(deriveUpdateState({ kind: 'linked', status: linked({ fetched: false, behind: 2, reason: 'Could not fetch: Permission denied (publickey)' }) }))
      .toMatchObject({ kind: 'unreachable', cause: 'auth', lastKnown: 'available' })
    expect(deriveUpdateState({ kind: 'linked', status: linked({ fetched: false, behind: 2, dirty: true, reason: 'x' }) }))
      .toMatchObject({ kind: 'unreachable', cause: 'unknown', lastKnown: 'dirty' })
  })

  it('rule 1 carries the last known counts and version into unreachable, so a stale chip keeps its number (N2)', () => {
    // linked: the counts rode along with the failed fetch.
    expect(deriveUpdateState({ kind: 'linked', status: linked({ fetched: false, behind: 3, reason: 'Could not fetch: Connection refused' }) }))
      .toEqual({ kind: 'unreachable', cause: 'network', lastKnown: 'available', reason: 'Could not fetch: Connection refused', behind: 3 })
    expect(deriveUpdateState({ kind: 'linked', status: linked({ fetched: false, behind: 1, ahead: 1, reason: 'x' }) }))
      .toMatchObject({ kind: 'unreachable', lastKnown: 'diverged', behind: 1, ahead: 1 })
    expect(deriveUpdateState({ kind: 'linked', status: linked({ fetched: false, behind: 0, ahead: 2, reason: 'x' }) }))
      .toMatchObject({ kind: 'unreachable', lastKnown: 'current', ahead: 2 })
    // git source: from the previous state; a second failure keeps what the first remembered.
    const first = deriveUpdateState({ kind: 'git', result: { behind: 0, error: 'Could not resolve hostname h' }, cloned: true }, { kind: 'available', behind: 2 })
    expect(first).toMatchObject({ kind: 'unreachable', lastKnown: 'available', behind: 2 })
    expect(deriveUpdateState({ kind: 'git', result: { behind: 0, error: 'Could not resolve hostname h' }, cloned: true }, first))
      .toMatchObject({ kind: 'unreachable', lastKnown: 'available', behind: 2 })
    // npm: the version an update would move to.
    expect(deriveUpdateState({ kind: 'npm', result: { behind: 0, error: 'ETIMEDOUT: request timed out' }, cloned: true }, { kind: 'available', toVersion: '1.3.0' }))
      .toMatchObject({ kind: 'unreachable', cause: 'network', lastKnown: 'available', toVersion: '1.3.0' })
    // Nothing known before: no counts invented.
    const fresh = deriveUpdateState({ kind: 'git', result: { behind: 0, error: 'Could not resolve hostname h' }, cloned: true })
    expect(fresh).not.toHaveProperty('behind')
    expect(fresh).not.toHaveProperty('lastKnown')
  })

  it('rule 2: behind null after a real fetch is unsupported, with the hint that matches the reason', () => {
    const noUpstream = deriveUpdateState({ kind: 'linked', status: linked({ behind: null, ahead: null, reason: 'No upstream branch is set for main, so there is nothing to compare against.' }) })
    expect(noUpstream).toMatchObject({ kind: 'unsupported', hint: UNSUPPORTED_HINT_NO_UPSTREAM })
    const detached = deriveUpdateState({ kind: 'linked', status: linked({ behind: null, ahead: null, branch: 'HEAD', reason: 'This checkout is on a detached HEAD, so there is no branch to compare.' }) })
    expect(detached).toMatchObject({ kind: 'unsupported', hint: UNSUPPORTED_HINT_DETACHED })
  })

  it('rule 3: dirty wins over any count (dirty and behind 5 is dirty, with the count kept)', () => {
    expect(deriveUpdateState({ kind: 'linked', status: linked({ dirty: true, behind: 5, ahead: 2 }) })).toEqual({ kind: 'dirty', behind: 5 })
    expect(deriveUpdateState({ kind: 'linked', status: linked({ dirty: true }) })).toEqual({ kind: 'dirty', behind: 0 })
  })

  it('rule 4: behind and ahead both positive is diverged', () => {
    expect(deriveUpdateState({ kind: 'linked', status: linked({ behind: 3, ahead: 2 }) })).toEqual({ kind: 'diverged', behind: 3, ahead: 2 })
  })

  it('rule 5: behind alone is available; npm updateAvailable is available with toVersion', () => {
    expect(deriveUpdateState({ kind: 'linked', status: linked({ behind: 3 }) })).toEqual({ kind: 'available', behind: 3 })
    expect(deriveUpdateState({ kind: 'git', result: { behind: 1, updateAvailable: true }, cloned: true })).toEqual({ kind: 'available', behind: 1 })
    expect(deriveUpdateState({ kind: 'npm', result: { behind: 1, updateAvailable: true, resolved: '@acme/plugin@1.3.0' }, cloned: true }))
      .toEqual({ kind: 'available', toVersion: '1.3.0' })
  })

  it('rule 6: the rest is current; a linked row keeps its ahead count', () => {
    expect(deriveUpdateState({ kind: 'linked', status: linked() })).toEqual({ kind: 'current' })
    expect(deriveUpdateState({ kind: 'linked', status: linked({ behind: 0, ahead: 3 }) })).toEqual({ kind: 'current', ahead: 3 })
    expect(deriveUpdateState({ kind: 'git', result: { behind: 0, updateAvailable: false }, cloned: true })).toEqual({ kind: 'current' })
    expect(deriveUpdateState({ kind: 'npm', result: { behind: 0, updateAvailable: false, resolved: 'acme-plugin@2.0.0' }, cloned: true })).toEqual({ kind: 'current' })
  })
})

describe('classifyGitFailure and scrubGitReason', () => {
  const cases: Array<[string, string]> = [
    ['user@host: Permission denied (keyboard-interactive,publickey)', 'auth'],
    ['fatal: Authentication failed for \'https://example.invalid/acme/plugins.git/\'', 'auth'],
    ['fatal: could not read Username for \'https://example.invalid\': terminal prompts disabled', 'auth'],
    ['Host key verification failed.', 'auth'],
    ['remote: invalid credentials', 'auth'],
    ['ssh: Could not resolve hostname example.invalid: nodename nor servname provided', 'network'],
    ['ssh: connect to host example.invalid port 22: Operation timed out', 'network'],
    ['ssh: connect to host example.invalid port 22: Network is unreachable', 'network'],
    ['ssh: connect to host example.invalid port 22: Connection refused', 'network'],
    ['fatal: unable to access: Could not connect to server', 'network'],
    ['error: cannot lock ref \'refs/remotes/origin/main\': is at abc but expected def', 'lock'],
    ['fatal: Unable to create \'/repo/.git/index.lock\': File exists.', 'lock'],
    ['fatal: Unable to create \'/repo/.git/FETCH_HEAD.lock\': File exists.', 'lock'],
    ['error: something nobody has seen before', 'unknown'],
  ]
  for (const [stderr, cause] of cases) {
    it(`classifies "${stderr.slice(0, 40)}" as ${cause}`, () => {
      expect(classifyGitFailure(stderr).cause).toBe(cause)
    })
  }

  it('scrubs the user@host prefix and the auth-method list from the reason', () => {
    const { cause, reason } = classifyGitFailure('user@host: Permission denied (keyboard-interactive,publickey)')
    expect(cause).toBe('auth')
    expect(reason).toBe('Permission denied')
    expect(reason).not.toMatch(/@|\(|\)/)
  })

  it('scrubs URLs, hostnames and absolute paths (N1: a private remote is never named in row copy)', () => {
    expect(scrubGitReason('fatal: unable to access https://someone@example.invalid/acme/plugins.git')).toBe('unable to access the remote')
    expect(scrubGitReason('git exited 128: fatal: Could not resolve hostname example.invalid\nPlease make sure you have the correct access rights.')).toBe('Could not resolve hostname the remote')
    expect(scrubGitReason("git exited 1: fatal: '/var/folders/zz/T/linked-origin.git' does not appear to be a git repository")).toBe("'linked-origin.git' does not appear to be a git repository")
    expect(scrubGitReason('ssh: connect to host example.invalid port 22: Connection refused')).toBe('ssh: connect to host the remote port 22: Connection refused')
    expect(scrubGitReason('Could not fetch: git@example.invalid:acme/plugins.git: Permission denied')).toBe('Could not fetch: the remote: Permission denied')
    // File names keep their dots; only host-shaped tokens go.
    expect(scrubGitReason("Unable to create '/repo/.git/index.lock': File exists.")).toBe("Unable to create 'index.lock': File exists")
    for (const out of [
      scrubGitReason('fatal: unable to access https://someone@example.invalid/acme/plugins.git'),
      scrubGitReason("fatal: '/Users/someone/code/plugins' does not appear to be a git repository"),
    ]) {
      expect(out).not.toMatch(/(^|\s|')\/(Users|home|private|var|tmp|opt)\//)
      expect(out).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i)
      expect(out).not.toMatch(/^fatal:|git exited/)
    }
  })

  it('caps at 120 characters on a word boundary and ends with an ellipsis (N1: no half word before a suffix)', () => {
    const long = scrubGitReason(`${'word '.repeat(40)}tail`)
    expect(long.length).toBeLessThanOrEqual(120)
    expect(long.endsWith('…')).toBe(true)
    expect(long).toMatch(/word…$/)
    expect(scrubGitReason('x'.repeat(300))).toHaveLength(120)
    expect(scrubGitReason('x'.repeat(300)).endsWith('…')).toBe(true)
    expect(scrubGitReason('short')).toBe('short')
  })

  it('gitFailureSentence: one sentence per cause, the unknown one from the scrubbed reason', () => {
    expect(gitFailureSentence('network')).toBe('the remote could not be reached.')
    expect(gitFailureSentence('timeout')).toBe('the remote could not be reached.')
    expect(gitFailureSentence('auth')).toBe('your credentials for the remote were refused.')
    expect(gitFailureSentence('lock')).toBe('another git command was running; try again.')
    expect(gitFailureSentence('unknown', 'Not possible to fast-forward, aborting')).toBe('not possible to fast-forward, aborting.')
    expect(gitFailureSentence('unknown', '')).toBe('git did not finish.')
    const described = describeGitFailure("git exited 1: fatal: '/var/folders/zz/linked-origin.git' does not appear to be a git repository")
    expect(described.cause).toBe('unknown')
    expect(described.sentence).toBe("'linked-origin.git' does not appear to be a git repository.")
  })

  it('classifies an empty or undefined stderr as unknown without throwing', () => {
    expect(classifyGitFailure('')).toEqual({ cause: 'unknown', reason: '' })
    expect(classifyGitFailure(undefined as unknown as string).cause).toBe('unknown')
  })
})

describe('row keys, versions, env, deadlines', () => {
  it('npmToVersion takes the part after the LAST @ (scoped packages have two)', () => {
    expect(npmToVersion('@acme/plugin@1.3.0')).toBe('1.3.0')
    expect(npmToVersion('acme-plugin@2.0.0')).toBe('2.0.0')
    expect(npmToVersion('1.0.0')).toBe('1.0.0')
  })

  it('linkedRowKey is stable for a realpath and different for another; sourceRowKey is the slug', () => {
    const a = linkedRowKey('/tmp/acme/plugins')
    expect(a).toBe(linkedRowKey('/tmp/acme/plugins'))
    expect(a).toMatch(/^linked:[0-9a-f]{12}$/)
    expect(a).not.toBe(linkedRowKey('/tmp/acme/other'))
    expect(a).not.toContain('/tmp')
    expect(sourceRowKey('acme-plugins')).toBe('source:acme-plugins')
  })

  it('fetchEnv injects the unattended knobs and BatchMode only when GIT_SSH_COMMAND is unset', () => {
    const plain = fetchEnv({ PATH: '/usr/bin' })
    expect(plain).toMatchObject({ PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/true', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' })
    const custom = fetchEnv({ GIT_SSH_COMMAND: 'my-ssh --flag' })
    expect(custom.GIT_SSH_COMMAND).toBe('my-ssh --flag')
    expect(custom.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('withDeadline answers the fallback on time and swallows the late rejection', async () => {
    const late = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late')), 30))
    await expect(withDeadline(late, 5, () => 'fallback')).resolves.toBe('fallback')
    await expect(withDeadline(Promise.resolve('fast'), 50, () => 'fallback')).resolves.toBe('fast')
    await expect(withDeadline(Promise.reject(new Error('boom')), 50, () => 'fallback')).rejects.toThrow('boom')
    await new Promise((r) => setTimeout(r, 40))
  })
})

// ── Cache ──

const warns: Array<[string, unknown]> = []
vi.mock('../../../src/logging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/logging/index.js')>()
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const real = actual.createSubsystemLogger(name)
      return { ...real, warn: (message: string, meta?: unknown) => { warns.push([message, meta]) } }
    },
  }
})

// The cache stats the checkout before fetching (a gone directory is `missing`), so it must exist.
const checkoutDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acme-checkout-')))
const info: LinkedCheckoutInfo = { path: path.join(checkoutDir, 'plugin'), checkout: checkoutDir, branch: 'main', sha: 'a'.repeat(40), dirty: false }
const KEY = linkedRowKey(info.checkout)
const linkedTarget = (ids: string[] = ['acme-tracker']): UpdatableTarget => ({ rowKey: KEY, kind: 'linked', info, pluginIds: ids })
const gitTarget = (slug = 'acme-plugins'): UpdatableTarget => ({ rowKey: sourceRowKey(slug), kind: 'git', slug, cloned: true, pluginIds: [slug] })

const factsOk: LocalFacts = { dirty: false, head: 'a'.repeat(40), behind: 3, ahead: 0, moved: false }

function fakeOps(over: Partial<UpdateCheckOps> = {}): UpdateCheckOps & { clock: { now: number } } {
  const clock = { now: Date.parse('2026-09-13T10:00:00Z') }
  return {
    checkLinked: vi.fn(async () => linked({ behind: 3 })),
    checkSource: vi.fn(async () => ({ behind: 0, updateAvailable: false })),
    readLocalFacts: vi.fn(async () => factsOk),
    now: () => clock.now,
    ...over,
    clock,
  }
}

let tmpRoot = ''
async function tmpFile(name = 'cache.json'): Promise<string> {
  if (!tmpRoot) tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'update-status-'))
  return path.join(tmpRoot, name)
}

afterEach(() => {
  warns.length = 0
})

describe('UpdateStatusCache', () => {
  it('lives under the data tmp dir by default (git-sync ignores tmp/)', () => {
    expect(TMP_DIR).toBe(path.join(WALNUT_HOME, 'tmp'))
    expect(DEFAULT_CACHE_FILE.startsWith(path.join(WALNUT_HOME, 'tmp'))).toBe(true)
  })

  it('does not fetch again inside the minimum interval, and does once it has passed', async () => {
    const ops = fakeOps()
    const cache = new UpdateStatusCache({ filePath: await tmpFile('interval.json'), ops, minIntervalMs: 600_000 })
    await cache.refreshAll([linkedTarget()], { force: true })
    expect(ops.checkLinked).toHaveBeenCalledTimes(1)
    expect(cache.isStale()).toBe(false)

    const snap = await cache.snapshot([linkedTarget()])
    expect(snap.rows[KEY].state).toEqual({ kind: 'available', behind: 3 })
    expect(snap.rowKeyOf['acme-tracker']).toBe(KEY)
    expect(snap.refreshing).toBe(false)
    await cache.refreshAll([linkedTarget()])
    expect(ops.checkLinked).toHaveBeenCalledTimes(1)

    ops.clock.now += 600_001
    expect(cache.isStale()).toBe(true)
    const stale = await cache.snapshot([linkedTarget()])
    expect(stale.refreshing).toBe(true)
    await cache.refreshAll([linkedTarget()])
    expect(ops.checkLinked).toHaveBeenCalledTimes(2)
  })

  it('passes the unattended fetch env to the linked check', async () => {
    const ops = fakeOps()
    const cache = new UpdateStatusCache({ filePath: await tmpFile('env.json'), ops })
    await cache.refreshAll([linkedTarget()], { force: true })
    const env = (ops.checkLinked as ReturnType<typeof vi.fn>).mock.calls[0][1] as NodeJS.ProcessEnv
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_ASKPASS).toBe('/usr/bin/true')
  })

  it('dedupes: two concurrent refreshes of a row and two targets sharing a rowKey cost ONE fetch', async () => {
    const ops = fakeOps()
    const cache = new UpdateStatusCache({ filePath: await tmpFile('dedupe.json'), ops })
    await Promise.all([cache.refreshRow(KEY, linkedTarget()), cache.refreshRow(KEY, linkedTarget())])
    expect(ops.checkLinked).toHaveBeenCalledTimes(1)

    const siblings = [linkedTarget(['acme-tracker']), linkedTarget(['acme-notes'])]
    await cache.refreshAll(siblings, { force: true })
    expect(ops.checkLinked).toHaveBeenCalledTimes(2)
    const snap = await cache.snapshot(siblings)
    expect(snap.rowKeyOf['acme-tracker']).toBe(snap.rowKeyOf['acme-notes'])
    expect(Object.keys(snap.rows)).toEqual([KEY])
    expect(snap.attempted).toBe(1)
  })
})

describe('UpdateStatusCache deadlines and failures', () => {
  it('a row past its deadline is unreachable (timeout) with lastKnown kept, while the other row is fine', async () => {
    const ops = fakeOps({
      checkLinked: vi.fn(() => new Promise<LinkedCheckoutStatus>(() => undefined)),
    })
    const cache = new UpdateStatusCache({ filePath: await tmpFile('timeout.json'), ops, rowDeadlineMs: 40, batchDeadlineMs: 2_000 })
    // Seed a previous good answer so lastKnown has something to keep.
    cache.recordCheck(KEY, { kind: 'linked', status: linked({ behind: 2 }) })
    const t0 = Date.now()
    await cache.refreshAll([linkedTarget(), gitTarget()], { force: true })
    expect(Date.now() - t0).toBeLessThan(1_500)
    const snap = await cache.snapshot([linkedTarget(), gitTarget()], { autoRefresh: false })
    expect(snap.rows[KEY].state).toMatchObject({ kind: 'unreachable', cause: 'timeout', lastKnown: 'available', reason: ROW_TIMEOUT_REASON })
    expect(snap.rows[KEY].checkedAt).not.toBeNull()
    expect(snap.rows[sourceRowKey('acme-plugins')].state).toEqual({ kind: 'current' })
    expect(snap.failed).toBe(1)
    expect(snap.attempted).toBe(2)
  })

  it('the batch deadline bounds the whole run and writes off rows still pending', async () => {
    const ops = fakeOps({
      checkSource: vi.fn(() => new Promise<never>(() => undefined)),
    })
    const cache = new UpdateStatusCache({ filePath: await tmpFile('batch.json'), ops, rowDeadlineMs: 5_000, batchDeadlineMs: 60, concurrency: 1 })
    const targets = [gitTarget('one'), gitTarget('two'), gitTarget('three'), gitTarget('four')]
    const t0 = Date.now()
    await cache.refreshAll(targets, { force: true })
    expect(Date.now() - t0).toBeLessThan(1_000)
    const snap = await cache.snapshot(targets, { autoRefresh: false })
    for (const t of targets) expect(snap.rows[t.rowKey].state).toMatchObject({ kind: 'unreachable', cause: 'timeout' })
    expect(snap.failed).toBe(4)
  })

  it('a lock collision keeps the previous entry and flags the row transient', async () => {
    const ops = fakeOps()
    const cache = new UpdateStatusCache({ filePath: await tmpFile('lock.json'), ops })
    const good = cache.recordCheck(sourceRowKey('acme-plugins'), { kind: 'git', result: { behind: 3, updateAvailable: true }, cloned: true })
    const row = cache.recordCheck(sourceRowKey('acme-plugins'), {
      kind: 'git',
      result: { behind: 0, error: 'fatal: Unable to create \'/x/.git/index.lock\': File exists.' },
      cloned: true,
    })
    expect(row.state).toEqual({ kind: 'available', behind: 3 })
    expect(row.transient).toBe(true)
    expect(row.checkedAt).toBe(good.checkedAt)
    const snap = await cache.snapshot([gitTarget()], { autoRefresh: false })
    expect(snap.rows[sourceRowKey('acme-plugins')].transient).toBe(true)
  })

  it('a stored fetch error keeps its cause when local facts are recomputed (a timeout is not re-read as network)', async () => {
    const ops = fakeOps({ readLocalFacts: vi.fn(async () => ({ ...factsOk, behind: 3 })) })
    const cache = new UpdateStatusCache({ filePath: await tmpFile('cause.json'), ops, rowDeadlineMs: 20 })
    cache.recordCheck(KEY, { kind: 'linked', status: linked({ behind: 3 }) })
    ;(ops.checkLinked as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => undefined))
    await cache.refreshRow(KEY, linkedTarget())
    const snap = await cache.snapshot([linkedTarget()], { autoRefresh: false })
    expect(snap.rows[KEY].state).toMatchObject({ kind: 'unreachable', cause: 'timeout', lastKnown: 'available' })
    expect(snap.rows[KEY].detail).toBe(ROW_TIMEOUT_REASON)
  })

  it('a check that throws becomes unreachable with a masked reason, never a crash', async () => {
    const ops = fakeOps({ checkSource: vi.fn(async () => { throw new Error('git exited 128: fatal: unable to access https://someone:tok@example.invalid/x.git: Could not resolve host') }) })
    const cache = new UpdateStatusCache({ filePath: await tmpFile('throw.json'), ops })
    const row = await cache.refreshRow(sourceRowKey('acme-plugins'), gitTarget())
    expect(row.state).toMatchObject({ kind: 'unreachable', cause: 'network' })
    expect(row.detail).not.toContain('tok@')
    expect(row.detail).toContain('***@')
  })

  it('snapshot never waits on the network: hanging ops, rows still answer at once as unchecked', async () => {
    const ops = fakeOps({ checkLinked: vi.fn(() => new Promise<LinkedCheckoutStatus>(() => undefined)) })
    const cache = new UpdateStatusCache({ filePath: await tmpFile('nowait.json'), ops, rowDeadlineMs: 10_000 })
    const t0 = Date.now()
    const snap = await cache.snapshot([linkedTarget()])
    expect(Date.now() - t0).toBeLessThan(500)
    expect(snap.rows[KEY]).toMatchObject({ state: { kind: 'unchecked' }, checkedAt: null, target: { kind: 'linked' } })
    expect(snap.refreshing).toBe(true)
    expect(snap.checkedAt).toBeNull()
  })
})

describe('UpdateStatusCache persistence and bookkeeping', () => {
  it('persists only network results (no checkout path), and loads them back with checkedAt', async () => {
    const ops = fakeOps()
    const file = await tmpFile('persist.json')
    const cache = new UpdateStatusCache({ filePath: file, ops })
    await cache.refreshAll([linkedTarget(), gitTarget()], { force: true })
    const text = await fsp.readFile(file, 'utf-8')
    expect(text).not.toContain(checkoutDir)
    expect(text).not.toContain('acme-checkout-')
    const parsed = JSON.parse(text) as { entries: Record<string, Record<string, unknown>> }
    expect(Object.keys(parsed.entries).sort()).toEqual([KEY, sourceRowKey('acme-plugins')].sort())
    expect(parsed.entries[KEY]).toMatchObject({ remoteRef: 'b'.repeat(40), headAtFetch: 'a'.repeat(40) })

    const reloaded = new UpdateStatusCache({ filePath: file, ops: fakeOps() })
    await reloaded.load()
    expect(reloaded.isStale()).toBe(false)
    const snap = await reloaded.snapshot([linkedTarget(), gitTarget()], { autoRefresh: false })
    expect(snap.rows[KEY].state).toEqual({ kind: 'available', behind: 3 })
    expect(snap.rows[KEY].target).toEqual({ kind: 'linked', toRef: 'b'.repeat(7) })
    expect(snap.checkedAt).toBe('2026-09-13T10:00:00.000Z')
  })

  it('a persist failure (read-only dir) only warns; a corrupt file only warns on load', async () => {
    const dir = path.join(await tmpFile(''), 'readonly')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.chmod(dir, 0o555)
    const cache = new UpdateStatusCache({ filePath: path.join(dir, 'nested', 'cache.json'), ops: fakeOps() })
    cache.recordCheck(sourceRowKey('acme-plugins'), { kind: 'git', result: { behind: 0 }, cloned: true })
    await expect(cache.persist()).resolves.toBeUndefined()
    expect(warns.some(([m]) => m === 'plugin update cache not persisted')).toBe(true)
    await fsp.chmod(dir, 0o755)

    const corrupt = await tmpFile('corrupt.json')
    await fsp.writeFile(corrupt, '{not json')
    const other = new UpdateStatusCache({ filePath: corrupt, ops: fakeOps() })
    await expect(other.load()).resolves.toBeUndefined()
    expect(warns.some(([m]) => m === 'plugin update cache corrupt, ignoring')).toBe(true)
  })

  it('a moved checkout reads unchecked with the moved reason and kicks a background refresh of that row', async () => {
    const ops = fakeOps()
    const cache = new UpdateStatusCache({ filePath: await tmpFile('moved.json'), ops })
    await cache.refreshAll([linkedTarget()], { force: true })
    ;(ops.readLocalFacts as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...factsOk, head: 'c'.repeat(40), moved: true })
    const snap = await cache.snapshot([linkedTarget()])
    expect(snap.rows[KEY].state).toEqual({ kind: 'unchecked', reason: CHECKOUT_MOVED_REASON })
    expect(snap.refreshing).toBe(true)
    await cache.refreshRow(KEY, linkedTarget())
    expect(ops.checkLinked).toHaveBeenCalledTimes(2)
  })

  it('local facts win over the cached state on every snapshot (dirty, then clean, with no fetch)', async () => {
    const ops = fakeOps()
    const cache = new UpdateStatusCache({ filePath: await tmpFile('local.json'), ops })
    await cache.refreshAll([linkedTarget()], { force: true })
    ;(ops.readLocalFacts as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...factsOk, dirty: true })
    expect((await cache.snapshot([linkedTarget()])).rows[KEY].state).toEqual({ kind: 'dirty', behind: 3 })
    ;(ops.readLocalFacts as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...factsOk, behind: 0, ahead: 2 })
    expect((await cache.snapshot([linkedTarget()])).rows[KEY].state).toEqual({ kind: 'current', ahead: 2 })
    expect(ops.checkLinked).toHaveBeenCalledTimes(1)
  })

  it('recordUpdated makes the row current at toRef; recordRefusal makes it dirty or diverged; setBusy rides the row', async () => {
    const ops = fakeOps({ readLocalFacts: undefined })
    const cache = new UpdateStatusCache({ filePath: await tmpFile('record.json'), ops })
    cache.recordCheck(KEY, { kind: 'linked', status: linked({ behind: 3, ahead: 1 }) })
    expect(cache.recordRefusal(KEY, 'diverged').state).toEqual({ kind: 'diverged', behind: 3, ahead: 1 })
    expect(cache.recordRefusal(KEY, 'dirty').state).toEqual({ kind: 'dirty', behind: 3 })
    const updated = cache.recordUpdated(KEY, 'd'.repeat(40))
    expect(updated.state).toEqual({ kind: 'current' })
    expect(updated.checkedAt).toBe('2026-09-13T10:00:00.000Z')
    expect(cache.entry(KEY)).toMatchObject({ remoteRef: 'd'.repeat(40), headAtFetch: 'd'.repeat(40), lastKnown: 'current' })
    cache.setBusy(KEY, true)
    const busy = cache.recordUpdated(sourceRowKey('acme-npm'), '1.3.0')
    expect(busy.busy).toBeUndefined()
    expect(cache.recordRefusal(KEY, 'dirty').busy).toBe(true)
    cache.setBusy(KEY, false)
    expect(cache.recordRefusal(KEY, 'dirty').busy).toBeUndefined()
  })

  it('reports allNetworkFailed only when every attempted row failed with cause network', async () => {
    const ops = fakeOps({
      checkSource: vi.fn(async () => ({ behind: 0, error: 'ssh: Could not resolve hostname example.invalid' })),
      checkLinked: vi.fn(async () => linked({ fetched: false, behind: 1, reason: 'Could not fetch: Network is unreachable' })),
    })
    const cache = new UpdateStatusCache({ filePath: await tmpFile('offline.json'), ops })
    const targets = [linkedTarget(), gitTarget()]
    await cache.refreshAll(targets, { force: true })
    const snap = await cache.snapshot(targets, { autoRefresh: false })
    expect(snap).toMatchObject({ attempted: 2, failed: 2, allNetworkFailed: true })
    expect(snap.rows[KEY].state).toMatchObject({ kind: 'unreachable', cause: 'network', lastKnown: 'available' })
    expect(snap.rows[KEY].checkedAt).toBeNull()
  })
})

describe('UpdateStatusCache keeps network results only (C45)', () => {
  const gitDirTarget = (dir: string, slug = 'acme-plugins'): UpdatableTarget =>
    ({ rowKey: sourceRowKey(slug), kind: 'git', slug, cloned: true, pluginIds: [slug], dir })
  const npmTarget = (resolved: string, slug = 'npm-acme'): UpdatableTarget =>
    ({ rowKey: sourceRowKey(slug), kind: 'npm', slug, cloned: true, pluginIds: [slug], resolved })

  it('the persisted entry is exactly remoteRef / fetchedAt / headAtFetch / fetchError; state, lastKnown, toRef, detail and transient never reach the file', async () => {
    const ops = fakeOps({
      checkSource: vi.fn(async (slug: string) => slug === 'acme-plugins'
        ? { behind: 3, updateAvailable: true, upstreamSha: 'c'.repeat(40), sha: 'a'.repeat(40) }
        : { behind: 0, error: 'ssh: Could not resolve hostname example.invalid' }),
    })
    const file = await tmpFile('shape.json')
    const cache = new UpdateStatusCache({ filePath: file, ops })
    await cache.refreshAll([linkedTarget(), gitTarget('acme-plugins'), gitTarget('offline-plugins')], { force: true })
    const parsed = JSON.parse(await fsp.readFile(file, 'utf-8')) as { entries: Record<string, Record<string, unknown>> }
    const allowed = ['fetchError', 'fetchedAt', 'headAtFetch', 'remoteRef']
    for (const [key, entry] of Object.entries(parsed.entries)) {
      for (const field of Object.keys(entry)) expect(allowed, `${key}.${field} is not a network result`).toContain(field)
    }
    expect(parsed.entries[sourceRowKey('acme-plugins')]).toEqual({ remoteRef: 'c'.repeat(40), fetchedAt: '2026-09-13T10:00:00.000Z', headAtFetch: 'a'.repeat(40) })
    expect(parsed.entries[sourceRowKey('offline-plugins')]).toMatchObject({ remoteRef: null, fetchedAt: null, fetchError: { cause: 'network' } })
    // (`detail` is allowed INSIDE fetchError, which is the spec's own shape for a remembered failure.)
    expect(JSON.stringify(parsed)).not.toMatch(/"state"|"lastKnown"|"toRef"|"transient"/)
    // The in-memory view still carries the derived facts for routes and tests.
    expect(cache.entry(sourceRowKey('acme-plugins'))).toMatchObject({ remoteRef: 'c'.repeat(40), state: { kind: 'available', behind: 3 }, lastKnown: 'available' })
  })

  it('a git source with a clone dir is re-read from local facts on every snapshot, like a linked row (a manual pull turns available into current)', async () => {
    const facts = vi.fn(async () => ({ ...factsOk, behind: 3 }))
    const ops = fakeOps({
      checkSource: vi.fn(async () => ({ behind: 3, updateAvailable: true, upstreamSha: 'c'.repeat(40), sha: 'a'.repeat(40) })),
      readLocalFacts: facts,
    })
    const cache = new UpdateStatusCache({ filePath: await tmpFile('gitlocal.json'), ops })
    const target = gitDirTarget('/clones/acme-plugins')
    await cache.refreshAll([target], { force: true })
    let snap = await cache.snapshot([target], { autoRefresh: false })
    expect(snap.rows[target.rowKey].state).toEqual({ kind: 'available', behind: 3 })
    expect(snap.rows[target.rowKey].target).toEqual({ kind: 'git', toRef: 'c'.repeat(7) })
    expect(facts).toHaveBeenCalledWith('/clones/acme-plugins', 'c'.repeat(40), expect.objectContaining({ headAtFetch: 'a'.repeat(40) }))
    // The user pulled by hand: HEAD is at the upstream now. No fetch, the chip says so.
    facts.mockResolvedValue({ ...factsOk, head: 'c'.repeat(40), behind: 0, ahead: 0 })
    snap = await cache.snapshot([target], { autoRefresh: false })
    expect(snap.rows[target.rowKey].state).toEqual({ kind: 'current' })
    expect(ops.checkSource).toHaveBeenCalledTimes(1)
    // A dirty source clone is not a state: only linked checkouts are edited by hand.
    facts.mockResolvedValue({ ...factsOk, dirty: true, behind: 3 })
    snap = await cache.snapshot([target], { autoRefresh: false })
    expect(snap.rows[target.rowKey].state).toEqual({ kind: 'available', behind: 3 })
  })

  it('an npm row compares the cached resolved version with what is on disk, no memo needed after a restart', async () => {
    const ops = fakeOps({ checkSource: vi.fn(async () => ({ behind: 1, updateAvailable: true, resolved: '@acme/plugin@1.3.0' })) })
    const file = await tmpFile('npm.json')
    const cache = new UpdateStatusCache({ filePath: file, ops })
    await cache.refreshAll([npmTarget('@acme/plugin@1.2.0')], { force: true })
    const reloaded = new UpdateStatusCache({ filePath: file, ops: fakeOps() })
    await reloaded.load()
    let snap = await reloaded.snapshot([npmTarget('@acme/plugin@1.2.0')], { autoRefresh: false })
    expect(snap.rows[sourceRowKey('npm-acme')].state).toEqual({ kind: 'available', toVersion: '1.3.0' })
    expect(snap.rows[sourceRowKey('npm-acme')].target).toEqual({ kind: 'npm', toRef: '1.3.0' })
    // Installed by hand (or through Update): the same cache now reads current.
    snap = await reloaded.snapshot([npmTarget('@acme/plugin@1.3.0')], { autoRefresh: false })
    expect(snap.rows[sourceRowKey('npm-acme')].state).toEqual({ kind: 'current' })
  })

  it('a git row without local facts after a restart is honest: unchecked with its checkedAt, and refreshed in the background', async () => {
    const ops = fakeOps({ checkSource: vi.fn(async () => ({ behind: 2, updateAvailable: true })) })
    const file = await tmpFile('restart-git.json')
    const cache = new UpdateStatusCache({ filePath: file, ops })
    await cache.refreshAll([gitTarget()], { force: true })
    const later = fakeOps({ checkSource: vi.fn(async () => ({ behind: 2, updateAvailable: true })) })
    const reloaded = new UpdateStatusCache({ filePath: file, ops: later })
    await reloaded.load()
    const snap = await reloaded.snapshot([gitTarget()])
    expect(snap.rows[sourceRowKey('acme-plugins')].state).toEqual({ kind: 'unchecked' })
    expect(snap.rows[sourceRowKey('acme-plugins')].checkedAt).toBe('2026-09-13T10:00:00.000Z')
    expect(snap.refreshing).toBe(true)
    await reloaded.refreshRow(sourceRowKey('acme-plugins'), gitTarget())
    expect((await reloaded.snapshot([gitTarget()], { autoRefresh: false })).rows[sourceRowKey('acme-plugins')].state).toEqual({ kind: 'available', behind: 2 })
  })

  it('a timed-out or failed re-check keeps the numbers under the stale chip (N2), through local facts too', async () => {
    const ops = fakeOps({ readLocalFacts: vi.fn(async () => ({ ...factsOk, behind: 3 })) })
    const cache = new UpdateStatusCache({ filePath: await tmpFile('stale-counts.json'), ops, rowDeadlineMs: 20 })
    cache.recordCheck(KEY, { kind: 'linked', status: linked({ behind: 3 }) })
    ;(ops.checkLinked as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => undefined))
    const row = await cache.refreshRow(KEY, linkedTarget())
    expect(row.state).toMatchObject({ kind: 'unreachable', cause: 'timeout', lastKnown: 'available', behind: 3 })
    const snap = await cache.snapshot([linkedTarget()], { autoRefresh: false })
    expect(snap.rows[KEY].state).toMatchObject({ kind: 'unreachable', cause: 'timeout', lastKnown: 'available', behind: 3 })
    expect(snap.rows[KEY].target).toEqual({ kind: 'linked', toRef: 'b'.repeat(7) })
  })
})
