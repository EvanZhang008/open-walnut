/**
 * The `boards` copy kind (docs/plan/walnut-replica-servers-impl.md, WP4): every
 * Board on a host replica, the whole document per key in the same layout
 * (`boards/<taskId>.json`), a board past the cap never copied, and the leader
 * reading a board file again only when it changed. The leader's boards live in
 * their own dir here (this process is the follower too).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'
import { startCopyHarness, stepsSince, type CopyHarness } from '../../../helpers/copy-kind-harness.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-boards', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { buildCopyManifest, runCopyRound, syncCopyKinds, type CopyKind } from '../../../../src/core/replication/kinds/copy-kind.js'
import { BOARDS_KIND, BOARDS_REMOVAL_FLOOR, BOARD_COPY_MAX_BYTES, leaderBoards, _resetBoardsCopyForTesting } from '../../../../src/core/replication/kinds/boards.js'
import { _resetReplicaStatusForTesting, peekKindState } from '../../../../src/core/replication/replica-status.js'
import type { BoardFile } from '../../../../src/core/boards/board-store.js'

const T0 = '2026-10-15T08:00:00.000Z'
const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
let leaderDir = ''
const kind: CopyKind<BoardFile> = { ...BOARDS_KIND, rows: () => leaderBoards(leaderDir), watch: () => () => {} }
const copyFile = (id: string) => path.join(WALNUT_HOME, 'boards', `${id}.json`)

function board(id: string, html: string): BoardFile {
  return {
    task_id: id, html, version: 3, updated_at: T0, updated_by: 'task:lead', threads: { t1: [{ id: 'bm-aaaaaa', author: 'user', text: 'Ship it?', ts: T0 }] },
    marks: {}, projects: {}, checks: {}, choices: {}, reminders: {}, section_seen: {}, lanes: null, cards: {}, kanban_seen: null,
  }
}

async function writeLeader(b: BoardFile): Promise<void> {
  await fsp.writeFile(path.join(leaderDir, `${b.task_id}.json`), JSON.stringify(b, null, 2))
}

/** One round as syncCopyKinds runs it: the manifest with the boards it could not read in `keep`. */
async function round() {
  return runCopyRound(kind, await buildCopyManifest(kind), h.target, { asOf: Date.now() })
}

const copiedIds = () => fs.readdirSync(path.join(WALNUT_HOME, 'boards')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort()
const copiedVersion = (id: string) => (JSON.parse(fs.readFileSync(copyFile(id), 'utf8')) as BoardFile).version

/** A file the Mac lists but cannot open: a link to itself (ELOOP, as root too), standing in for EACCES or EMFILE. */
async function unreadableLeader(id: string): Promise<void> {
  const file = path.join(leaderDir, `${id}.json`)
  await fsp.rm(file, { force: true })
  await fsp.symlink(`${id}.json`, file)
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
  h = await startCopyHarness()
})

afterAll(async () => {
  await h.close()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(leaderDir, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  _resetBoardsCopyForTesting()
  _resetReplicaStatusForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  if (leaderDir) await fsp.rm(leaderDir, { recursive: true, force: true })
  leaderDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-leader-boards-'))
  h.calls.length = 0
  await writeLeader(board('task-lead', '<h1>Release</h1>'))
  await writeLeader(board('task-marina', '<p>Marina</p>'))
})

describe('the boards copy', () => {
  it('copies each board whole, in the same layout, at 0600 in a 0700 dir', async () => {
    expect(await round()).toMatchObject({ action: 'synced', entries: 2, sent: 2 })
    const got = JSON.parse(await fsp.readFile(copyFile('task-lead'), 'utf8')) as BoardFile
    expect(got).toEqual(board('task-lead', '<h1>Release</h1>'))
    expect(fs.statSync(copyFile('task-lead')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(copyFile('task-lead'))).mode & 0o777).toBe(0o700)
  })

  it('reads a board again only when its file changed, and sends only that board', async () => {
    await round()
    const before = await leaderBoards(leaderDir)
    const again = await leaderBoards(leaderDir)
    expect(again[0]).toBe(before.find((b) => b.task_id === again[0].task_id)) // same object: not read again
    await new Promise((r) => setTimeout(r, 20))
    await writeLeader({ ...board('task-lead', '<h1>Release, moved to Monday</h1>'), version: 4 })
    const from = h.calls.length
    expect(await round()).toMatchObject({ action: 'synced', sent: 1 })
    expect(stepsSince(h.calls, from)).toEqual(['sync:boards', 'put:boards:1'])
    expect((JSON.parse(await fsp.readFile(copyFile('task-lead'), 'utf8')) as BoardFile).version).toBe(4)
  })

  it('a board the Mac deleted goes; a board past the cap is never copied', async () => {
    await round()
    await fsp.rm(path.join(leaderDir, 'task-marina.json'))
    await writeLeader(board('task-huge', 'x'.repeat(BOARD_COPY_MAX_BYTES + 10)))
    expect(await round()).toMatchObject({ action: 'synced', removed: 1, entries: 1 })
    expect(fs.existsSync(copyFile('task-marina'))).toBe(false)
    expect(fs.existsSync(copyFile('task-huge'))).toBe(false)
  })

  it('a board copy is replaced whole: a new file at 0600 whatever the old one was, no temp file left', async () => {
    await round()
    fs.chmodSync(copyFile('task-lead'), 0o644)
    const ino = fs.statSync(copyFile('task-lead')).ino
    await new Promise((r) => setTimeout(r, 20))
    await writeLeader({ ...board('task-lead', '<h1>Release, moved to Tuesday</h1>'), version: 5 })
    expect(await round()).toMatchObject({ action: 'synced', sent: 1 })
    const st = fs.statSync(copyFile('task-lead'))
    expect(st.ino).not.toBe(ino)
    expect(st.mode & 0o777).toBe(0o600)
    expect(copiedVersion('task-lead')).toBe(5)
    expect(fs.readdirSync(path.join(WALNUT_HOME, 'boards')).filter((n) => !n.endsWith('.json'))).toEqual([])
  })
})

describe('a board the Mac lists but cannot read', () => {
  it('stays on the host (named in keep, not removed), and is copied again once it reads', async () => {
    await round()
    expect(copiedIds()).toEqual(['task-lead', 'task-marina'])
    // A file that does not parse (damaged on the Mac), and one that does not open.
    await writeLeader(board('task-acme', '<p>Acme</p>'))
    await round()
    await fsp.writeFile(path.join(leaderDir, 'task-marina.json'), '{"task_id": "task-marina", "html": ')
    await unreadableLeader('task-acme')
    const manifest = await buildCopyManifest(kind)
    expect([manifest.entries.map((e) => e.k), manifest.keep]).toEqual([['task-lead'], ['task-acme', 'task-marina']])
    const from = h.calls.length
    expect(await round()).toMatchObject({ action: 'synced', entries: 1, removed: 0 })
    expect(stepsSince(h.calls, from)).toEqual(['sync:boards'])
    expect(copiedIds()).toEqual(['task-acme', 'task-lead', 'task-marina'])
    expect(copiedVersion('task-marina')).toBe(3)
    // The same failure next round: the same manifest, no step at all.
    const quiet = h.calls.length
    expect((await round()).action).toBe('unchanged')
    expect(h.calls.length).toBe(quiet)
    // It reads again: the board comes as it is now.
    await writeLeader({ ...board('task-marina', '<p>Marina, fixed</p>'), version: 9 })
    expect(await round()).toMatchObject({ action: 'synced', sent: 1, removed: 0 })
    expect(copiedVersion('task-marina')).toBe(9)
  })

  it('goes once the Mac deletes it: a key leaving keep is a new manifest', async () => {
    await round()
    await unreadableLeader('task-marina')
    expect(await round()).toMatchObject({ action: 'synced', removed: 0 })
    expect(copiedIds()).toEqual(['task-lead', 'task-marina'])
    await fsp.rm(path.join(leaderDir, 'task-marina.json'))
    // Same entries as the round before (task-lead alone): only `keep` changed, and that runs the round.
    expect(await round()).toMatchObject({ action: 'synced', removed: 1 })
    expect(copiedIds()).toEqual(['task-lead'])
  })

  it('syncCopyKinds sends the kept keys on the sync, and a follower that gets a malformed keep refuses the step', async () => {
    const sent: Array<Record<string, unknown>> = []
    const post = h.target.post
    const watched = { ...h.target, post: async (p: Record<string, unknown>, o?: { timeoutMs?: number }) => { if (p.op === 'sync') sent.push(p); return post(p, o) } }
    await syncCopyKinds([kind], { targets: () => [watched] })
    await unreadableLeader('task-marina')
    await syncCopyKinds([kind], { targets: () => [watched] })
    expect(sent.map((s) => s.keep)).toEqual([undefined, ['task-marina']])
    expect(copiedIds()).toEqual(['task-lead', 'task-marina'])
    const { boardsFollower } = await import('../../../../src/core/replication/kinds/boards.js')
    for (const keep of ['task-marina', [7], ['']]) {
      expect(await boardsFollower().sync({ op: 'sync', kind: 'boards', entries: [], asOf: 1, keep })).toEqual({ ok: false, status: 400, error: 'bad_keep' })
    }
    expect(copiedIds()).toEqual(['task-lead', 'task-marina'])
  })
})

describe('the boards half rule', () => {
  it(`removes most boards freely below ${BOARDS_REMOVAL_FLOOR}; from ${BOARDS_REMOVAL_FLOOR} on it refuses more than half, and half still go`, async () => {
    expect(BOARDS_REMOVAL_FLOOR).toBe(20)
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `task-b${String(i).padStart(2, '0')}`)
    // 19 on the host: below the floor, the Mac removing 18 of them is taken.
    for (const id of ids(17)) await writeLeader(board(id, `<p>${id}</p>`))
    expect(await round()).toMatchObject({ action: 'synced', entries: 19 })
    for (const id of ids(17)) await fsp.rm(path.join(leaderDir, `${id}.json`))
    await fsp.rm(path.join(leaderDir, 'task-marina.json'))
    expect(await round()).toMatchObject({ action: 'synced', entries: 1, removed: 18 })
    expect(copiedIds()).toEqual(['task-lead'])
    // 20 on the host: removing 18 of them is refused, the copy stays whole.
    for (const id of ids(19)) await writeLeader(board(id, `<p>${id}</p>`))
    expect(await round()).toMatchObject({ action: 'synced', entries: 20 })
    for (const id of ids(18)) await fsp.rm(path.join(leaderDir, `${id}.json`))
    await expect(round()).rejects.toThrow(/manifest_removes_most_rows/)
    expect(copiedIds()).toHaveLength(20)
    expect(peekKindState('host:devbox', 'boards')?.lastRefusal).toMatchObject({ entries: 2, local: 20, removing: 18 })
    // Half of them may go: 10 of the 20.
    for (const id of ids(19).slice(10)) await writeLeader(board(id, `<p>${id}</p>`))
    expect(await round()).toMatchObject({ action: 'synced', entries: 10, removed: 10 })
    expect(copiedIds()).toHaveLength(10)
  })
})

describe('the host turned the boards copy off', () => {
  it('drops what it kept and keeps an off marker; on again, a full manifest', async () => {
    let choice: Record<string, boolean> = {}
    const host = await startCopyHarness({ id: 'host:boards-off', copies: async () => choice })
    const marker = () => JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'cache', 'replica', 'boards.json'), 'utf8')) as Record<string, unknown>
    try {
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(fs.readdirSync(path.join(WALNUT_HOME, 'boards')).filter((n) => n.endsWith('.json')).length).toBeGreaterThan(0)
      choice = { boards: false }
      let from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['purge:boards'])
      expect(fs.readdirSync(path.join(WALNUT_HOME, 'boards')).filter((n) => n.endsWith('.json'))).toEqual([])
      expect(marker()).toMatchObject({ v: 1, off: true })
      choice = {}
      from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)[0]).toBe('sync:boards')
      expect(fs.readdirSync(path.join(WALNUT_HOME, 'boards')).filter((n) => n.endsWith('.json')).length).toBeGreaterThan(0)
      expect(marker().off).toBeUndefined()
    } finally { await host.close() }
  })
})
