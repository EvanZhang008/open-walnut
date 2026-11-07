/**
 * A test that wipes WALNUT_HOME starts on empty stores, whatever the test before it left.
 *
 * Tests remove the data home with fs.rm between cases, while the stores keep one SQLite
 * handle per process. On Linux the open handle kept the deleted file, so the next test read
 * and wrote the previous test's rows through it (2026-11-07: in
 * tests/web/routes/api-v1-session-lifecycle.test.ts a stop one test left pending was retried
 * 5 s later inside a later test, and that test's fake daemon received it). Each store now
 * hands its handle out through `reopenIfWiped` (src/lib/sqlite-wiped.ts), and the session and
 * task caches carry the handle's generation, since a reopened handle starts its own
 * `data_version` count.
 *
 * The reopen opens the fresh handle first and closes the old one only once that worked: a write
 * that ends while a test's afterEach is still removing the home must not trade a working handle
 * for a failed open (2026-11-07: closing first left the store failed, and four later tests of
 * tests/providers/turn-speed-edges.test.ts failed with "unable to open database file").
 *
 * The last block is the class guard: every module that opens a SQLite file is listed here,
 * either as one that keeps a handle (and whose getter must go through `reopenIfWiped`) or as
 * exempt with the reason. A new `new Database(` fails until it is listed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-home-wipe-isolation'))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  createSessionRecord, getSessionByClaudeId, listPendingSessionStops,
  updateSessionRecord, updateSessionRecordConditionally,
} from '../../src/core/session-tracker.js'
import { addTask, getTask, listTasks } from '../../src/core/task-manager.js'
import { dbGeneration as sessionDbGeneration } from '../../src/core/session-db.js'
import { dbGeneration as taskDbGeneration } from '../../src/core/task-db.js'
import { SessionStopCoordinator, type SessionStopConnection } from '../../src/core/sessions/session-stop.js'
import { reopenIfWiped } from '../../src/lib/sqlite-wiped.js'

/** What the tests in this repo do between cases. */
async function wipeHome(): Promise<void> {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
}

beforeEach(wipeHome)

describe('a wiped data home', () => {
  it('holds no session, task or pending stop of the test before it', async () => {
    await createSessionRecord('wipe-s1', 'task-w1', 'proj', '/tmp', { initialProcessStatus: 'running' })
    await updateSessionRecord('wipe-s1', {
      stopRequest: { id: 'stop-1', requestedAt: new Date().toISOString(), state: 'pending' },
    })
    const { task } = await addTask({ title: 'Wipe probe' })
    // Warm both caches, as a running test does.
    expect(await getSessionByClaudeId('wipe-s1')).not.toBeNull()
    expect((await getTask(task.id)).id).toBe(task.id)
    expect(await listPendingSessionStops()).toHaveLength(1)
    const sessionGen = sessionDbGeneration()
    const taskGen = taskDbGeneration()

    await wipeHome()

    expect(await getSessionByClaudeId('wipe-s1')).toBeNull()
    expect(await listPendingSessionStops()).toEqual([])
    await expect(getTask(task.id)).rejects.toThrow()
    expect((await listTasks()).map((t) => t.id)).not.toContain(task.id)
    // Each store opened its file afresh, once.
    expect(sessionDbGeneration()).toBe(sessionGen + 1)
    expect(taskDbGeneration()).toBe(taskGen + 1)
    // And what is written now lands in the new file.
    await createSessionRecord('wipe-s2', 'task-w2', 'proj', '/tmp', { initialProcessStatus: 'stopped' })
    expect((await getSessionByClaudeId('wipe-s2'))?.claudeSessionId).toBe('wipe-s2')
    expect(fs.existsSync(path.join(WALNUT_HOME, 'sessions.sqlite'))).toBe(true)
  })

  it('a stop left pending before the wipe sends nothing to a daemon installed after it', async () => {
    await createSessionRecord('wipe-stop', 'task-ws', 'proj', '/tmp', { initialProcessStatus: 'running' })
    const timers: Array<() => void> = []
    const sent: string[] = []
    let connection: SessionStopConnection | null = null
    // The real store behind every dep, as sessionStops has; the clock and the daemon are the test's.
    const stops = new SessionStopCoordinator({
      get: getSessionByClaudeId,
      save: updateSessionRecord,
      confirm: (sid, request) => updateSessionRecordConditionally(
        sid, { stopRequest: request },
        (current) => current.stopRequest?.id === request.id && current.stopRequest.state === 'pending',
      ),
      pending: (host) => listPendingSessionStops(host),
      park: async () => {},
      connection: async () => connection,
      changed: () => {},
      schedule: (fn) => { timers.push(fn); return () => {} },
    })

    // Host offline: the stop stays pending and its retry is armed.
    expect((await stops.request('wipe-stop')).state).toBe('pending')
    expect(timers).toHaveLength(1)

    await wipeHome()
    connection = {
      connected: true,
      send: async (_command, args) => { sent.push(String(args.sid)); return { ok: true, stopped: true } },
    }
    timers[0]!()
    // The retry runs on the session's serial chain: a dispatch behind it waits for it.
    await stops.dispatch('wipe-stop', null, async () => undefined)

    expect(sent).toEqual([])
    expect(await getSessionByClaudeId('wipe-stop')).toBeNull()
  })
})

describe('a store reached while the wipe is still going on', () => {
  it('keeps the handle it has when a fresh open fails, and opens afresh once the home is back', async () => {
    await createSessionRecord('race-s1', 'task-r1', 'proj', '/tmp', { initialProcessStatus: 'stopped' })
    const { task } = await addTask({ title: 'Race probe' })
    const sessionGen = sessionDbGeneration()
    const taskGen = taskDbGeneration()

    // The step between the rm and the reopen, made deterministic: the files are gone and no
    // folder can be made where the home was, so every fresh open fails.
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
    await fsp.writeFile(WALNUT_HOME, 'not a folder')

    // The handles there were serve on, and the stores are not left failed.
    expect((await getSessionByClaudeId('race-s1'))?.claudeSessionId).toBe('race-s1')
    expect((await getTask(task.id)).id).toBe(task.id)
    expect(sessionDbGeneration()).toBe(sessionGen)
    expect(taskDbGeneration()).toBe(taskGen)

    // The next test's home: both stores open it afresh.
    await fsp.rm(WALNUT_HOME, { force: true })
    await fsp.mkdir(WALNUT_HOME, { recursive: true })
    expect(await getSessionByClaudeId('race-s1')).toBeNull()
    await expect(getTask(task.id)).rejects.toThrow()
    expect(sessionDbGeneration()).toBe(sessionGen + 1)
    expect(taskDbGeneration()).toBe(taskGen + 1)
  })

  it('opens and recreates nothing once the home is gone (the test is over)', async () => {
    await createSessionRecord('race-s2', 'task-r2', 'proj', '/tmp', { initialProcessStatus: 'stopped' })
    const sessionGen = sessionDbGeneration()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })

    expect((await getSessionByClaudeId('race-s2'))?.claudeSessionId).toBe('race-s2')
    expect(sessionDbGeneration()).toBe(sessionGen)
    expect(fs.existsSync(WALNUT_HOME)).toBe(false)
  })
})

describe('reopenIfWiped', () => {
  const file = () => path.join(WALNUT_HOME, 'probe.sqlite')

  it('opens the fresh handle before it closes the old one', () => {
    const steps: string[] = []
    const got = reopenIfWiped(file(), 'old', () => { steps.push('open'); return 'new' }, (old) => { steps.push(`close ${old}`) })
    expect(got).toBe('new')
    expect(steps).toEqual(['open', 'close old'])
  })

  it('keeps the old handle, unclosed, when the fresh open fails', () => {
    const steps: string[] = []
    const got = reopenIfWiped(file(), 'old', () => { steps.push('open'); throw new Error('unable to open database file') }, (old) => { steps.push(`close ${old}`) })
    expect(got).toBe('old')
    expect(steps).toEqual(['open'])
  })

  it('touches nothing while the file is there, or once the home is gone', async () => {
    const steps: string[] = []
    const open = () => { steps.push('open'); return 'new' }
    const close = () => { steps.push('close') }
    await fsp.writeFile(file(), '')
    expect(reopenIfWiped(file(), 'old', open, close)).toBe('old')
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
    expect(reopenIfWiped(file(), 'old', open, close)).toBe('old')
    expect(steps).toEqual([])
  })
})

// ── Class guard ────────────────────────────────────────────────────────────

const REPO = path.resolve(import.meta.dirname, '../..')
const OPENS_SQLITE = /\bnew Database\(/

/**
 * Modules that open a SQLite file under the data home and keep the handle in a long-lived
 * singleton: the file with the `new Database(` → the module whose getter hands the handle out
 * through `reopenIfWiped` (the same file, or the one holding the singleton).
 */
const KEEPS_A_HANDLE: Record<string, string> = {
  'src/core/session-db.ts': 'src/core/session-db.ts',
  'src/core/task-db.ts': 'src/core/task-db.ts',
  'src/core/notes-index.ts': 'src/core/notes-index.ts',
  'src/core/health/db.ts': 'src/core/health/db.ts',
  'src/core/places/db.ts': 'src/core/places/db.ts',
  'src/core/companion-bases.ts': 'src/core/companion-bases.ts',
  'src/core/offline-merge/ledger.ts': 'src/core/offline-merge/ledger.ts',
  'src/core/usage/tracker.ts': 'src/core/usage/tracker.ts',
  'src/core/usage/response-store.ts': 'src/core/usage/collection.ts',
  'src/lib/hybrid-search/db.ts': 'src/core/search/wiring.ts',
}

/** Modules that open a SQLite file but keep no handle a wiped home could leave behind. */
const EXEMPT: Record<string, string> = {
  'src/hooks/on-compact.ts': 'a hook child process: opens the file, writes, closes it in the same call',
  'src/hooks/on-stop.ts': 'a hook child process: opens the file read-only, reads, closes it in the same call',
  'src/hooks/shared.ts': 'hook helpers: each call opens the file and closes it before returning',
  'src/hooks/session-status-store.ts': 'opens the path it is given and closes it in the same call',
  'src/lib/sqlite.ts': 'the VACUUM INTO worker: one read-only connection per copy, ended with the copy',
  'src/lib/hybrid-search/embed-worker.ts': 'an embedding worker\'s read-only connection, ended with the worker',
  'src/commands/ephemeral-snapshot.ts': 'copies a database once for an ephemeral server and closes it',
  'src/core/diagnostics/local-probes.ts': 'an in-memory database (`:memory:`), no file',
  'src/core/plugins/plugin-storage.ts': 'a worker per plugin database, ended with the plugin (a test\'s server stop ends it)',
  'src/core/backup/sqlite-snapshot.ts': 'a one-shot read-only snapshot, closed when it is taken',
  'src/core/pre-ledger-owners.ts': 'a read-only worker for one pass, ended with the pass',
  'src/binary/selftest.ts': 'the compiled file\'s self test, on files in its own temp dir',
  'src/replica/copy-guard.ts': 'the apply connection, kept by session-db and task-db and closed by their closeDb (which the reopen calls)',
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full)
  }
  return out
}

describe('every SQLite opener under src/ is classified', () => {
  const openers = sourceFiles(path.join(REPO, 'src'))
    .filter((file) => OPENS_SQLITE.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(REPO, file).split(path.sep).join('/'))
    .sort()

  it('finds the openers it knows (the scan itself works)', () => {
    expect(openers).toContain('src/core/session-db.ts')
    expect(openers).toContain('src/core/task-db.ts')
  })

  it('lists each one as keeping a handle or as exempt with a reason', () => {
    const unlisted = openers.filter((file) => !(file in KEEPS_A_HANDLE) && !(file in EXEMPT))
    expect(unlisted, [
      'A module opens a SQLite file and is not listed in tests/core/test-home-wipe-isolation.test.ts.',
      'If it keeps the handle in a long-lived singleton on a file under the data home, make its getter',
      'hand the kept handle out through reopenIfWiped(path, handle, open, close) from src/lib/sqlite-wiped.ts',
      '(it opens the fresh handle before closing the old one), then add it to KEEPS_A_HANDLE.',
      'Otherwise add it to EXEMPT with why.',
    ].join(' ')).toEqual([])
  })

  it('each module that keeps a handle reopens it through reopenIfWiped, never by closing first', () => {
    const missing = Object.entries(KEEPS_A_HANDLE)
      .filter(([, holder]) => !/\breopenIfWiped\(/.test(fs.readFileSync(path.join(REPO, holder), 'utf8')))
      .map(([file, holder]) => `${file} (checked in ${holder})`)
    expect(missing).toEqual([])
    // The close-then-open check this replaced may not come back anywhere.
    const closeFirst = sourceFiles(path.join(REPO, 'src'))
      .filter((file) => /\bsqliteFileGone\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO, file))
    expect(closeFirst).toEqual([])
  })

  it('no entry outlives its opener', () => {
    const stale = [...Object.keys(KEEPS_A_HANDLE), ...Object.keys(EXEMPT)].filter((file) => !openers.includes(file))
    expect(stale, 'Remove the entries whose file no longer opens a SQLite database.').toEqual([])
  })
})
