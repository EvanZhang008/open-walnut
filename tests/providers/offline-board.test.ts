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
const journals: Array<{ close: () => void }> = []
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs = []
})

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
  journals.push(host.journal)
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

  it('any session reads and writes any board this host keeps, as online; the writer is recorded', async () => {
    const { call } = harness()
    expect((await call(OUTSIDER, 'board_get', { task: LEAD_TASK }) as Ok).result.task_id).toBe(LEAD_TASK)
    const r = await call(OUTSIDER, 'board_edit', { task: LEAD_TASK, edits: [{ old: 'API: red', new: 'API: amber' }] }) as Ok
    expect(r.result).toMatchObject({ queued: true, task_id: LEAD_TASK, version: 4 })
    const read = await call(LEAD, 'board_get') as Ok
    expect(read.result.board).toMatchObject({ version: 4, updated_by: `task:${OUT_TASK}` })
    expect(read.result.board.html).toContain('API: amber')
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

describe('board kit: who wrote each part of the page', () => {
  const kit = createBoardOffline()
  const NOW = '2026-11-07T00:00:00.000Z'
  const applyOp = (board: OfflineSliceBoard | undefined, op: string, args: Record<string, unknown>, by: string) =>
    kit.apply(board, op, args, by, NOW, 'task-1', () => 'bm-1') as OfflineSliceBoard
  const OLD = { by: 'task:old', sessionId: 'sid-old' }
  const HI = '😀' // one character, two UTF-16 units

  it('a post and a project write keep the page provenance exactly as the server sent it', () => {
    const sources = [{ start: 0, end: 4, by: 'human' }, { start: 4, end: 8, ...OLD }]
    const board: OfflineSliceBoard = { taskId: 't', html: '<p>a</p>', version: 3, updated_by: 'task:old', updated_session_id: 'sid-old', html_sources: sources, projects: {} }
    const posted = applyOp(board, 'board_post', { thread: 'th', text: 'hi' }, 'device:phone')
    const project = applyOp(posted, 'board_project_set', { id: 'p', status: 'wip' }, 'device:phone')
    for (const next of [posted, project]) {
      expect(next.html).toBe(board.html)
      expect(next.version).toBe(3)
      expect(next.updated_by).toBe('task:old')
      expect(next.updated_session_id).toBe('sid-old')
      expect(next.html_sources).toEqual(sources)
    }
  })

  it('a person\'s full set makes the whole page theirs and drops the old session', () => {
    const board: OfflineSliceBoard = { taskId: 't', html: '<p>old</p>', version: 1, updated_by: 'task:old', updated_session_id: 'sid-old', html_sources: [{ start: 0, end: 10, ...OLD }] }
    const next = applyOp(board, 'board_set', { html: '<h1>New page</h1>' }, 'device:phone')
    expect(next.html_sources).toEqual([{ start: 0, end: 17, by: 'human' }])
    expect('updated_session_id' in next).toBe(false)
    expect(next.version).toBe(2)
    // An agent's full set is its own, with no session named (none is known here).
    const agent = applyOp(board, 'board_set', { html: '<h1>New page</h1>' }, 'task:w1')
    expect(agent.html_sources).toEqual([{ start: 0, end: 17, by: 'task:w1' }])
    expect('updated_session_id' in agent).toBe(false)
  })

  it('a partial edit marks only the changed middle, and the head and tail keep their writer', () => {
    const html = '<p>API: red now</p>'
    const board: OfflineSliceBoard = { taskId: 't', html, version: 1, updated_by: 'task:old', updated_session_id: 'sid-old', html_sources: [{ start: 0, end: html.length, ...OLD }] }
    const next = applyOp(board, 'board_edit', { edits: [{ old: 'API: red now', new: 'API: green now' }] }, 'task:w')
    expect(next.html).toBe('<p>API: green now</p>')
    expect(next.html_sources).toEqual([
      { start: 0, end: 8, ...OLD },
      { start: 8, end: 13, by: 'task:w' },
      { start: 13, end: 21, ...OLD },
    ])
    expect('updated_session_id' in next).toBe(false)
    // Text replaced by itself changes no one's words.
    expect(applyOp(board, 'board_edit', { edits: [{ old: 'red', new: 'red' }] }, 'task:w').html_sources).toEqual(board.html_sources)
  })

  it('a change inside a surrogate pair marks the whole character, never half of it', () => {
    const lowOnlyShared = ['😀', '🈀'] // same low unit: the shared tail starts on a low surrogate
    const highOnlyShared = ['😀', '😁'] // same high unit: the shared head ends on a high surrogate
    for (const [from, to] of [lowOnlyShared, highOnlyShared]) {
      const html = `X${from}Y`
      const board: OfflineSliceBoard = { taskId: 't', html, version: 1, updated_by: 'task:old', html_sources: [{ start: 0, end: 4, by: 'task:old' }] }
      const next = applyOp(board, 'board_edit', { edits: [{ old: from, new: to }] }, 'task:w')
      expect(next.html).toBe(`X${to}Y`)
      expect(next.html_sources).toEqual([
        { start: 0, end: 1, by: 'task:old' },
        { start: 1, end: 3, by: 'task:w' },
        { start: 3, end: 4, by: 'task:old' },
      ])
    }
    expect(HI.length).toBe(2)
  })

  it('a record with no usable provenance reads as its last writer\'s whole page', () => {
    const base = { taskId: 't', html: 'aaXbb', version: 1, updated_by: 'task:lead', updated_session_id: 'sid-l' }
    const expected = [
      { start: 0, end: 2, by: 'task:lead', sessionId: 'sid-l' },
      { start: 2, end: 3, by: 'task:w' },
      { start: 3, end: 5, by: 'task:lead', sessionId: 'sid-l' },
    ]
    const edit = { edits: [{ old: 'X', new: 'Y' }] }
    expect(applyOp(base, 'board_edit', edit, 'task:w').html_sources).toEqual(expected)
    // Spans that leave a gap, or do not reach the end, are not trusted in any part.
    const gap = [{ start: 0, end: 2, by: 'human' }]
    expect(applyOp({ ...base, html_sources: gap }, 'board_edit', edit, 'task:w').html_sources).toEqual(expected)
    const unknownWriter = [{ start: 0, end: 5, by: 'someone' }]
    expect(applyOp({ ...base, html_sources: unknownWriter }, 'board_edit', edit, 'task:w').html_sources).toEqual(expected)
  })

  it('a source named in the arguments is never trusted', () => {
    const board: OfflineSliceBoard = { taskId: 't', html: 'aaXbb', version: 1, updated_by: 'task:lead' }
    const forged = { html_sources: [{ start: 0, end: 5, by: 'human' }], updated_session_id: 'forged', by: 'human', sessionId: 'forged' }
    const set = kit.prepare(board, 'board_set', { html: 'new', ...forged }, 'task:w')
    expect(set).toEqual({ ok: true, args: { html: 'new' } })
    const edit = kit.prepare(board, 'board_edit', { edits: [{ old: 'X', new: 'Y' }], ...forged }, 'task:w')
    expect(edit).toEqual({ ok: true, args: { edits: [{ old: 'X', new: 'Y' }] } })
    // Even an argument that reaches apply directly changes nothing.
    expect(applyOp(board, 'board_set', { html: 'new', ...forged }, 'task:w').html_sources).toEqual([{ start: 0, end: 3, by: 'task:w' }])
    const edited = applyOp(board, 'board_edit', { edits: [{ old: 'X', new: 'Y' }], ...forged }, 'task:w')
    expect(edited.html_sources!.every((s) => s.by !== 'human' && s.sessionId === undefined)).toBe(true)
    expect('updated_session_id' in edited).toBe(false)
  })

  it('the source twin rebuilt from its text needs no module and gives the same answers', () => {
    const text = createBoardOffline.toString()
    expect(text).not.toMatch(/\b(import|require)\b/)
    const rebuilt = (new Function('"use strict"; return ' + text)() as typeof createBoardOffline)()
    const board: OfflineSliceBoard = { taskId: 't', html: `X${HI}Y`, version: 1, updated_by: 'task:old', updated_session_id: 'sid-old' }
    const args = { edits: [{ old: HI, new: '😁' }] }
    const a = rebuilt.apply(board, 'board_edit', args, 'task:w', NOW, 't', () => 'bm')
    expect(a).toEqual(kit.apply(board, 'board_edit', args, 'task:w', NOW, 't', () => 'bm'))
    expect(a!.html_sources).toEqual([
      { start: 0, end: 1, by: 'task:old', sessionId: 'sid-old' },
      { start: 1, end: 3, by: 'task:w' },
      { start: 3, end: 4, by: 'task:old', sessionId: 'sid-old' },
    ])
    expect(rebuilt.apply(board, 'board_set', { html: 'z' }, 'device:p', NOW, 't', () => 'bm')!.html_sources).toEqual([{ start: 0, end: 1, by: 'human' }])
  })
})
