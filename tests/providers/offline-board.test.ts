/**
 * A team's Board on the host while the Walnut server is away
 * (src/providers/offline-board-core.ts through the offline host): read from the
 * copy, written with the server's checks, journaled for the server to replay.
 *
 * Real files in a temp dir; delivery is a recorder. The limits are compared
 * with the server's own constants, so the two cannot drift apart.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createOfflineHost, type HostSlice, type OfflineHostDeps, type OfflineRecord } from '../../src/providers/offline-host-core.js'
import { createBoardOffline, type OfflineSliceBoard } from '../../src/providers/offline-board-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { BOARD_HTML_MAX_BYTES, BOARD_MESSAGE_MAX_BYTES, BOARD_PROJECT_STATUSES, BOARD_ITEM_ID_RE } from '../../src/core/boards/board-store.js'
import { BOARD_PROJECT_TEXT_FIELDS, BOARD_PROJECT_TITLE_MAX } from '../../src/core/boards/board-items.js'

const HOME = '/fixture/walnut-home'
const LEAD = 'aaaaaaaa-1111-4111-8111-111111111111'
const WORKER = 'bbbbbbbb-2222-4222-8222-222222222222'
const OUTSIDER = 'cccccccc-3333-4333-8333-333333333333'
const LEAD_TASK = 'mlead000-0001'
const WORKER_TASK = 'mworker0-0002'
const OUT_TASK = 'mother00-0003'

const BOARD: OfflineSliceBoard = {
  taskId: LEAD_TASK,
  html: '<h1>Team</h1><p id="api">API: red</p><p id="ui">UI: green</p>',
  version: 3,
  updated_at: '2026-10-05T09:00:00.000Z',
  updated_by: `task:${LEAD_TASK}`,
  threads: { api: [{ id: 'bm-1', author: 'user', text: 'Why red?', ts: '2026-10-05T09:01:00.000Z' }] },
  projects: {
    api: { title: 'API', status: 'decide', status_by: 'human', status_at: '2026-10-05T09:02:00.000Z' },
    ui: { title: 'UI', status: 'wip', status_by: `task:${LEAD_TASK}` },
  },
}

function slice(over: Partial<HostSlice> = {}): HostSlice {
  return {
    v: 1, home: HOME, hash: 'h1', asOf: Date.parse('2026-10-05T10:00:00Z'), host: 'devbox',
    sessions: [
      { sid: LEAD, taskId: LEAD_TASK, title: 'Leader' },
      { sid: WORKER, taskId: WORKER_TASK, title: 'Worker: API' },
      { sid: OUTSIDER, taskId: OUT_TASK, title: 'Other work' },
    ],
    tasks: [
      { id: LEAD_TASK, title: 'Leader', phase: 'IN_PROGRESS', project: 'Acme' },
      { id: WORKER_TASK, title: 'Worker: API', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: LEAD_TASK },
      { id: OUT_TASK, title: 'Other work', phase: 'IN_PROGRESS', project: 'Acme' },
    ],
    requests: [],
    boards: [BOARD],
    boardOf: { [LEAD_TASK]: LEAD_TASK, [WORKER_TASK]: LEAD_TASK, [OUT_TASK]: OUT_TASK },
    ...over,
  }
}

let dirs: string[] = []
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs = [] })

function harness(opts: { boards?: boolean; dir?: string } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'offline-board-'))
  if (!opts.dir) dirs.push(dir)
  const deps: OfflineHostDeps = {
    fs, path, dir,
    now: () => Date.parse('2026-10-05T12:00:00Z'),
    randomHex: (n) => randomBytes(n).toString('hex'),
    keyOf: (home) => createHash('sha1').update(home).digest('hex').slice(0, 12),
    kit: createEnvelopeKit(),
    log: () => {},
    isLive: () => true,
    turnActive: () => false,
    streamOffset: () => 0,
    deliver: async () => ({ ok: true }),
    ...(opts.boards === false ? {} : { boards: createBoardOffline() }),
  }
  const host = createOfflineHost(deps)
  if (!opts.dir) host.configure(slice())
  const call = (sid: string, name: string, args: Record<string, unknown> = {}) => host.handle(HOME, sid, 'tools.call', { name, args })
  return { host, call, dir }
}

type Ok = { ok: true; result: Record<string, any> }
type Err = { ok: false; error: { code: string; message: string; detail?: any } }

describe('board on the host: reads', () => {
  it('a worker reads its team\'s board (the leader\'s) from the copy', async () => {
    const { call } = harness()
    const r = await call(WORKER, 'board_get') as Ok
    expect(r.ok).toBe(true)
    expect(r.result).toMatchObject({ task_id: LEAD_TASK, offline: true, board: { html: BOARD.html, version: 3 } })
    expect(r.result.threads.api).toHaveLength(1)
    expect(r.result.projects.api.status).toBe('decide')
  })

  it('a board this host does not keep needs the server', async () => {
    const { call } = harness()
    const r = await call(WORKER, 'board_get', { task: 'mnothere-0009' }) as Err
    expect(r).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
  })

  it('a team with no board yet reads as empty, and board_set makes it', async () => {
    const { call } = harness()
    const empty = await call(OUTSIDER, 'board_get') as Ok
    expect(empty.result).toMatchObject({ task_id: OUT_TASK, board: null })
    const made = await call(OUTSIDER, 'board_set', { html: '<h1>Other</h1>' }) as Ok
    expect(made.result).toMatchObject({ queued: true, version: 1 })
    const read = await call(OUTSIDER, 'board_get') as Ok
    expect(read.result.board).toMatchObject({ html: '<h1>Other</h1>', version: 1, updated_by: `task:${OUT_TASK}` })
  })

  it('tools.list names the board ops only when the daemon keeps boards', async () => {
    const withBoards = await harness().host.handle(HOME, WORKER, 'tools.list', {}) as Ok
    expect(withBoards.result.ops.map((o: { name: string }) => o.name)).toEqual(expect.arrayContaining(['board_get', 'board_edit', 'board_post']))
    const h = harness({ boards: false })
    const without = await h.host.handle(HOME, WORKER, 'tools.list', {}) as Ok
    expect(without.result.ops.map((o: { name: string }) => o.name)).not.toContain('board_get')
    expect(await h.call(WORKER, 'board_get')).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
  })
})

describe('board on the host: writes', () => {
  it('an edit is applied to the copy, the next read agrees, and the journal holds the op for the server', async () => {
    const h = harness()
    const r = await h.call(WORKER, 'board_edit', { edits: [{ old: 'API: red', new: 'API: green' }], version: 3 }) as Ok
    expect(r.result).toMatchObject({ queued: true, offline: true, task_id: LEAD_TASK, version: 4 })
    const read = await h.call(LEAD, 'board_get') as Ok
    expect(read.result.board.html).toContain('API: green')
    expect(read.result.board).toMatchObject({ version: 4, updated_by: `task:${WORKER_TASK}` })
    const recs = h.host.drain(HOME).records as Array<Extract<OfflineRecord, { kind: 'op' }>>
    expect(recs).toHaveLength(1)
    // `version` is dropped: the server judges the text itself on replay.
    expect(recs[0]).toMatchObject({ kind: 'op', op: 'board_edit', callerSid: WORKER, args: { task: LEAD_TASK, edits: [{ old: 'API: red', new: 'API: green' }] } })
    expect(recs[0].args.version).toBeUndefined()
  })

  it('edits follow the server\'s rules: exactly once, in order, all or none, at the version read', async () => {
    const { call } = harness()
    expect(await call(WORKER, 'board_edit', { edits: [{ old: 'nowhere', new: 'x' }] })).toMatchObject({ ok: false, error: { code: 'board_edit_not_found' } })
    expect(await call(WORKER, 'board_edit', { edits: [{ old: '<p id=', new: 'x' }] })).toMatchObject({ ok: false, error: { code: 'board_edit_not_unique', detail: { count: 2 } } })
    // The second edit fails: the first is not applied either.
    expect(await call(WORKER, 'board_edit', { edits: [{ old: 'API: red', new: 'API: amber' }, { old: 'missing', new: 'y' }] })).toMatchObject({ ok: false, error: { code: 'board_edit_not_found', detail: { index: 1 } } })
    expect(await call(WORKER, 'board_edit', { edits: [{ old: 'API: red', new: 'API: amber' }], version: 2 })).toMatchObject({ ok: false, error: { code: 'board_version_conflict', detail: { version: 3 } } })
    expect(await call(WORKER, 'board_edit', { edits: [] })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    const read = await call(WORKER, 'board_get') as Ok
    expect(read.result.board).toMatchObject({ html: BOARD.html, version: 3 })
  })

  it('a second edit sees the first (the overlay is the copy plus every write made here)', async () => {
    const { call } = harness()
    await call(WORKER, 'board_edit', { edits: [{ old: 'API: red', new: 'API: amber' }] })
    const second = await call(LEAD, 'board_edit', { edits: [{ old: 'API: amber', new: 'API: green' }], version: 4 }) as Ok
    expect(second.result.version).toBe(5)
    expect(await call(LEAD, 'board_edit', { edits: [{ old: 'API: red', new: 'x' }] })).toMatchObject({ ok: false, error: { code: 'board_edit_not_found' } })
  })

  it('only the board task and the tasks below it write; anyone may read', async () => {
    const { call } = harness()
    expect((await call(OUTSIDER, 'board_get', { task: LEAD_TASK }) as Ok).result.task_id).toBe(LEAD_TASK)
    expect(await call(OUTSIDER, 'board_edit', { task: LEAD_TASK, edits: [{ old: 'API: red', new: 'mine' }] })).toMatchObject({ ok: false, error: { code: 'not_in_team' } })
  })

  it('a thread post is appended with the writer\'s task as author', async () => {
    const { call } = harness()
    const r = await call(WORKER, 'board_post', { thread: 'api', text: 'Red because the deploy failed; retrying.' }) as Ok
    expect(r.ok).toBe(true)
    const read = await call(WORKER, 'board_get') as Ok
    expect(read.result.threads.api).toHaveLength(2)
    expect(read.result.threads.api[1]).toMatchObject({ author: `task:${WORKER_TASK}`, text: 'Red because the deploy failed; retrying.' })
    expect(await call(WORKER, 'board_post', { thread: '../x', text: 'hi' })).toMatchObject({ ok: false, error: { code: 'bad_id' } })
    expect(await call(WORKER, 'board_post', { thread: 'api', text: 'x'.repeat(BOARD_MESSAGE_MAX_BYTES + 1) })).toMatchObject({ ok: false, error: { code: 'message_too_long' } })
  })

  it('a project status the user picked stays theirs unless the write says override_user', async () => {
    const { call } = harness()
    const refused = await call(WORKER, 'board_project_set', { id: 'api', status: 'done' }) as Err
    expect(refused).toMatchObject({ ok: false, error: { code: 'status_set_by_user', detail: { project: 'api', status: 'decide' } } })
    // Changing other fields keeps the user's pick.
    expect((await call(WORKER, 'board_project_set', { id: 'api', latest: 'Retrying the deploy.' })).ok).toBe(true)
    // So does a delete, which would remove it.
    expect(await call(WORKER, 'board_project_set', { id: 'api', delete: true })).toMatchObject({ ok: false, error: { code: 'status_set_by_user' } })
    expect((await call(WORKER, 'board_project_set', { id: 'api', status: 'done', override_user: true })).ok).toBe(true)
    const read = await call(WORKER, 'board_get') as Ok
    expect(read.result.projects.api).toMatchObject({ status: 'done', status_by: `task:${WORKER_TASK}`, latest: 'Retrying the deploy.', title: 'API' })
    // A session-set status is the session's to change.
    expect((await call(WORKER, 'board_project_set', { id: 'ui', status: 'wait', waiting: 'design review' })).ok).toBe(true)
  })

  it('a project left with nothing is removed, and null clears a text field', async () => {
    const { call } = harness()
    expect((await call(LEAD, 'board_project_set', { id: 'ui', latest: 'x' })).ok).toBe(true)
    expect((await call(LEAD, 'board_project_set', { id: 'ui', latest: null })).ok).toBe(true)
    expect((await call(LEAD, 'board_get') as Ok).result.projects.ui.latest).toBeUndefined()
    expect((await call(LEAD, 'board_project_set', { id: 'ui', title: '', status: '' })).ok).toBe(true)
    expect((await call(LEAD, 'board_get') as Ok).result.projects.ui).toBeUndefined()
  })

  it('the writes and the overlay survive a daemon restart (the journal is on disk)', async () => {
    const first = harness()
    await first.call(WORKER, 'board_edit', { edits: [{ old: 'API: red', new: 'API: green' }] })
    const again = harness({ dir: first.dir })
    const read = await again.call(LEAD, 'board_get') as Ok
    expect(read.result.board).toMatchObject({ version: 4 })
    expect(read.result.board.html).toContain('API: green')
  })

  it('once the server took the writes (ack) and pushed a newer copy, the copy is the truth again', async () => {
    const h = harness()
    await h.call(WORKER, 'board_edit', { edits: [{ old: 'API: red', new: 'API: green' }] })
    const { records } = h.host.drain(HOME)
    h.host.ack(HOME, records[records.length - 1].seq)
    h.host.configure(slice({ hash: 'h2', boards: [{ ...BOARD, html: '<h1>Team</h1><p id="api">API: green (server)</p>', version: 4 }] }))
    const read = await h.call(LEAD, 'board_get') as Ok
    expect(read.result.board).toMatchObject({ version: 4, html: '<h1>Team</h1><p id="api">API: green (server)</p>' })
  })
})

describe('board kit: the same limits as the server', () => {
  const kit = createBoardOffline()
  const board: OfflineSliceBoard = { taskId: 't', html: '<p>x</p>', version: 1, projects: {} }

  it('html, message, statuses and item ids', () => {
    expect(kit.prepare(board, 'board_set', { html: 'a'.repeat(BOARD_HTML_MAX_BYTES) }, 'task:t').ok).toBe(true)
    expect(kit.prepare(board, 'board_set', { html: 'a'.repeat(BOARD_HTML_MAX_BYTES + 1) }, 'task:t')).toMatchObject({ ok: false, code: 'board_too_large' })
    // Bytes, not characters: CJK text is three bytes a character.
    expect(kit.prepare(board, 'board_post', { thread: 'a', text: '\u4e2d'.repeat(Math.floor(BOARD_MESSAGE_MAX_BYTES / 3) + 1) }, 'task:t')).toMatchObject({ ok: false, code: 'message_too_long' })
    for (const s of BOARD_PROJECT_STATUSES) expect(kit.prepare(board, 'board_project_set', { id: 'p', status: s }, 'task:t').ok).toBe(true)
    expect(kit.prepare(board, 'board_project_set', { id: 'p', status: 'blocked' }, 'task:t')).toMatchObject({ ok: false, code: 'bad_status' })
    for (const id of ['a', 'A.b:c-d_1', 'x'.repeat(128), '-a', 'a b', 'x'.repeat(129)]) {
      expect(kit.prepare(board, 'board_post', { thread: id, text: 'hi' }, 'task:t').ok, id).toBe(BOARD_ITEM_ID_RE.test(id))
    }
  })

  it('project text fields and title', () => {
    for (const [field, max] of Object.entries(BOARD_PROJECT_TEXT_FIELDS)) {
      expect(kit.prepare(board, 'board_project_set', { id: 'p', [field]: 'x'.repeat(max) }, 'task:t').ok, field).toBe(true)
      expect(kit.prepare(board, 'board_project_set', { id: 'p', [field]: 'x'.repeat(max + 1) }, 'task:t'), field).toMatchObject({ ok: false, code: 'bad_request' })
    }
    expect(kit.prepare(board, 'board_project_set', { id: 'p', title: 'x'.repeat(BOARD_PROJECT_TITLE_MAX) }, 'task:t').ok).toBe(true)
    expect(kit.prepare(board, 'board_project_set', { id: 'p', title: 'x'.repeat(BOARD_PROJECT_TITLE_MAX + 1) }, 'task:t')).toMatchObject({ ok: false, code: 'bad_request' })
  })

  it('behaves the same when rebuilt from its text (the source twin)', () => {
    const rebuilt = (new Function('"use strict"; return ' + createBoardOffline.toString())() as typeof createBoardOffline)()
    const r = rebuilt.applyEdits('<p>a</p><p>b</p>', [{ old: '<p>a</p>', new: '<p>c</p>' }])
    expect(r).toEqual({ ok: true, html: '<p>c</p><p>b</p>' })
    expect(rebuilt.prepare(board, 'board_post', { thread: 'a', text: 'x'.repeat(BOARD_MESSAGE_MAX_BYTES + 1) }, 'task:t')).toMatchObject({ ok: false, code: 'message_too_long' })
  })
})
