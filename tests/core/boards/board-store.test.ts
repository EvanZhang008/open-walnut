/**
 * Task Board store (src/core/boards/board-store.ts): storage, versioning, the
 * exact-string edit contract, caps, threads, marks, the html readers, and the
 * cleanup that follows a task's deletion. Real files in an isolated home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-board-store'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import {
  BOARD_HTML_MAX_BYTES,
  BOARD_MESSAGE_MAX_BYTES,
  BOARD_NOTE_MAX_BYTES,
  BoardError,
  _boardFilePath,
  applyBoardEdits,
  deleteBoard,
  deleteBoardMessage,
  editBoardHtml,
  extractTaskRefs,
  getBoard,
  initBoardStore,
  postBoardMessage,
  setBoardHtml,
  setBoardMark,
  stopBoardStore,
  threadMeta,
} from '../../../src/core/boards/board-store.js'

const T = 'mt0abc12-aaaa'

/** Run `fn`, expect a BoardError, return it. */
async function boardError(fn: () => Promise<unknown> | unknown): Promise<BoardError> {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(BoardError)
    return err as BoardError
  }
  throw new Error('expected a BoardError')
}

async function rawFile(taskId = T): Promise<string | null> {
  return fs.readFile(_boardFilePath(taskId), 'utf-8').catch(() => null)
}

let events: BusEvent[] = []

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  events = []
  bus.subscribe('test-board-spy', (e) => { events.push(e) }, { global: true, interest: ['board:'] })
})

afterEach(async () => {
  bus.unsubscribe('test-board-spy')
  stopBoardStore()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('set and get', () => {
  it('a task with no board reads null; the first set creates version 1 under WALNUT_HOME/boards', async () => {
    expect(await getBoard(T)).toBeNull()
    const board = await setBoardHtml(T, '<h1>Plan</h1>', { by: 'task:leader-1' })
    expect(board).toMatchObject({ task_id: T, html: '<h1>Plan</h1>', version: 1, updated_by: 'task:leader-1', threads: {}, marks: {} })
    expect(Date.parse(board.updated_at)).not.toBeNaN()
    expect(_boardFilePath(T)).toBe(`${WALNUT_HOME}/boards/${T}.json`)
    expect(await getBoard(T)).toEqual(board)
  })

  it('a task id that is not a plain file name is refused', async () => {
    const err = await boardError(() => getBoard('../escape'))
    expect(err.code).toBe('bad_id')
    expect(err.statusCode).toBe(400)
  })

  it('version counts html changes only: thread posts and marks leave it alone', async () => {
    expect((await setBoardHtml(T, '<p>a</p>', { by: 'human' })).version).toBe(1)
    await postBoardMessage(T, 'root-cause', { author: 'user', text: 'why?' })
    await setBoardMark(T, 'sec-1', { state: 'reviewed' })
    expect((await getBoard(T))!.version).toBe(1)
    expect((await editBoardHtml(T, [{ old: 'a', new: 'b' }], { by: 'task:w' })).version).toBe(2)
    const third = await setBoardHtml(T, '<p>c</p>', { by: 'human' })
    expect(third.version).toBe(3)
    // Threads and marks survive a whole-document set.
    expect(Object.keys(third.threads)).toEqual(['root-cause'])
    expect(Object.keys(third.marks)).toEqual(['sec-1'])
    // updated_by tracks the html writer, never the chat author.
    expect(third.updated_by).toBe('human')
  })

  it('a stale expectVersion is a 409 that carries the current version and writes nothing', async () => {
    await setBoardHtml(T, 'one', { by: 'human' })
    await setBoardHtml(T, 'two', { by: 'human', expectVersion: 1 })
    const before = await rawFile()
    const err = await boardError(() => setBoardHtml(T, 'three', { by: 'human', expectVersion: 1 }))
    expect(err).toMatchObject({ code: 'board_version_conflict', statusCode: 409, details: { version: 2 } })
    const editErr = await boardError(() => editBoardHtml(T, [{ old: 'two', new: 'x' }], { by: 'human', expectVersion: 5 }))
    expect(editErr.details).toEqual({ version: 2 })
    expect(await rawFile()).toBe(before)
  })

  it('a missing board is version 0 to expectVersion', async () => {
    const err = await boardError(() => setBoardHtml(T, 'x', { by: 'human', expectVersion: 3 }))
    expect(err.details).toEqual({ version: 0 })
    expect(await rawFile()).toBeNull()
    expect((await setBoardHtml(T, 'x', { by: 'human', expectVersion: 0 })).version).toBe(1)
  })
})

describe('edits', () => {
  const HTML = '<section id="a">Status: open</section><section id="b">Owner: none</section>'

  it('an old text found once is replaced', async () => {
    await setBoardHtml(T, HTML, { by: 'human' })
    const board = await editBoardHtml(T, [{ old: 'Status: open', new: 'Status: done' }], { by: 'task:w1' })
    expect(board.html).toContain('Status: done')
    expect(board.updated_by).toBe('task:w1')
  })

  it('missing → board_edit_not_found with its index; twice → board_edit_not_unique with the count', async () => {
    await setBoardHtml(T, HTML, { by: 'human' })
    const missing = await boardError(() => editBoardHtml(T, [{ old: 'Status: open', new: 'S' }, { old: 'nope', new: 'x' }], { by: 'human' }))
    expect(missing).toMatchObject({ code: 'board_edit_not_found', statusCode: 409, details: { index: 1 } })
    const twice = await boardError(() => editBoardHtml(T, [{ old: '<section', new: '<div' }], { by: 'human' }))
    expect(twice).toMatchObject({ code: 'board_edit_not_unique', statusCode: 409, details: { index: 0, count: 2 } })
  })

  it('overlapping occurrences make an anchor ambiguous too', () => {
    const err = (() => { try { applyBoardEdits('aaa', [{ old: 'aa', new: 'b' }]) } catch (e) { return e as BoardError } })()
    expect(err).toMatchObject({ code: 'board_edit_not_unique', details: { index: 0, count: 2 } })
  })

  it('several edits apply in order, each against the previous result', async () => {
    await setBoardHtml(T, HTML, { by: 'human' })
    const board = await editBoardHtml(T, [
      { old: 'Status: open', new: 'Status: blocked on [X]' },
      // Only exists because of the first edit.
      { old: '[X]', new: 'review' },
      { old: 'Owner: none', new: 'Owner: $& and $1' },
    ], { by: 'human' })
    expect(board.html).toBe('<section id="a">Status: blocked on review</section><section id="b">Owner: $& and $1</section>')
    expect(board.version).toBe(2)
  })

  it('a failing third edit leaves the file byte for byte unchanged and emits nothing', async () => {
    await setBoardHtml(T, HTML, { by: 'human' })
    const before = await rawFile()
    events = []
    const err = await boardError(() => editBoardHtml(T, [
      { old: 'Status: open', new: 'Status: done' },
      { old: 'Owner: none', new: 'Owner: me' },
      { old: 'Status: open', new: 'again' },
    ], { by: 'human' }))
    expect(err.details).toEqual({ index: 2 })
    expect(await rawFile()).toBe(before)
    expect(events).toEqual([])
  })

  it('editing a task with no board is 404 no_board and creates no file', async () => {
    const err = await boardError(() => editBoardHtml(T, [{ old: 'a', new: 'b' }], { by: 'human' }))
    expect(err).toMatchObject({ code: 'no_board', statusCode: 404 })
    expect(await rawFile()).toBeNull()
  })

  it('bad edit shapes are 400', () => {
    for (const edits of [[], [{ old: '', new: 'x' }], [{ old: 'a' }], ['a']] as unknown[]) {
      let err: BoardError | undefined
      try { applyBoardEdits('a', edits as never) } catch (e) { err = e as BoardError }
      expect(err?.code).toBe('bad_request')
    }
  })
})

describe('caps', () => {
  it('html over 1 MiB is 413 board_too_large, on a set and on an edit that grows past it', async () => {
    const big = 'x'.repeat(BOARD_HTML_MAX_BYTES + 1)
    expect(await boardError(() => setBoardHtml(T, big, { by: 'human' }))).toMatchObject({ code: 'board_too_large', statusCode: 413 })
    // Exactly at the cap is fine; multi-byte characters count as bytes.
    await setBoardHtml(T, 'x'.repeat(BOARD_HTML_MAX_BYTES - 2) + 'AB', { by: 'human' })
    const before = await rawFile()
    const grow = await boardError(() => editBoardHtml(T, [{ old: 'AB', new: 'éé' }], { by: 'human' }))
    expect(grow.code).toBe('board_too_large')
    expect(await rawFile()).toBe(before)
  })

  it('message text over 8 KiB, a note over 4 KiB, a state over 64 chars, bad ids', async () => {
    await setBoardHtml(T, '<p/>', { by: 'human' })
    expect(await boardError(() => postBoardMessage(T, 't1', { author: 'user', text: 'm'.repeat(BOARD_MESSAGE_MAX_BYTES + 1) })))
      .toMatchObject({ code: 'message_too_long', statusCode: 413 })
    expect(await boardError(() => setBoardMark(T, 'm1', { note: 'n'.repeat(BOARD_NOTE_MAX_BYTES + 1) })))
      .toMatchObject({ code: 'note_too_long', statusCode: 413 })
    expect(await boardError(() => setBoardMark(T, 'm1', { state: 's'.repeat(65) })))
      .toMatchObject({ code: 'bad_request', statusCode: 400 })
    for (const id of ['', '-lead', 'has space', 'a/b', 'x'.repeat(129)]) {
      expect(await boardError(() => postBoardMessage(T, id, { author: 'user', text: 'hi' }))).toMatchObject({ code: 'bad_id', statusCode: 400 })
      expect(await boardError(() => setBoardMark(T, id, { state: 'x' }))).toMatchObject({ code: 'bad_id', statusCode: 400 })
    }
    // The widest legal id.
    await postBoardMessage(T, `A${'z._:-'.repeat(25)}zz`, { author: 'user', text: 'ok' })
  })
})

describe('threads', () => {
  it('messages append in order with bm- ids, authors and non-decreasing timestamps', async () => {
    await setBoardHtml(T, '<p/>', { by: 'human' })
    const a = await postBoardMessage(T, 'rc-1', { author: 'user', text: '  first  ' })
    const b = await postBoardMessage(T, 'rc-1', { author: 'task:leader-1', text: 'second' })
    const c = await postBoardMessage(T, 'rc-1', { author: 'user', text: 'third' })
    await postBoardMessage(T, 'other', { author: 'user', text: 'elsewhere' })
    const list = (await getBoard(T))!.threads['rc-1']
    expect(list.map((m) => m.text)).toEqual(['first', 'second', 'third'])
    expect(list.map((m) => m.id)).toEqual([a.id, b.id, c.id])
    for (const m of list) expect(m.id).toMatch(/^bm-[0-9a-f]{12}$/)
    expect(new Set(list.map((m) => m.id)).size).toBe(3)
    expect(list.map((m) => m.author)).toEqual(['user', 'task:leader-1', 'user'])
    const ts = list.map((m) => m.ts)
    expect([...ts].sort()).toEqual(ts)
  })

  it('a post on a task with no board is 404 no_board; empty text is 400', async () => {
    expect(await boardError(() => postBoardMessage(T, 't', { author: 'user', text: 'hi' }))).toMatchObject({ code: 'no_board', statusCode: 404 })
    expect(await rawFile()).toBeNull()
    await setBoardHtml(T, '<p/>', { by: 'human' })
    expect(await boardError(() => postBoardMessage(T, 't', { author: 'user', text: '   ' }))).toMatchObject({ code: 'bad_request' })
  })
})

describe('deleting a post', () => {
  async function seed() {
    await setBoardHtml(T, '<p/>', { by: 'human' })
    return {
      user: await postBoardMessage(T, 'rc-1', { author: 'user', text: 'Why?' }),
      leader: await postBoardMessage(T, 'rc-1', { author: 'task:leader-1', text: 'Because.' }),
      worker: await postBoardMessage(T, 'rc-1', { author: 'task:worker-1', text: 'Fixed.' }),
    }
  }

  it('a human deletes any message, the user\'s own or a session\'s, and gets it back', async () => {
    const m = await seed()
    expect(await deleteBoardMessage(T, 'rc-1', m.leader.id, { by: 'human' })).toEqual(m.leader)
    expect(await deleteBoardMessage(T, 'rc-1', m.user.id, { by: 'human' })).toEqual(m.user)
    expect((await getBoard(T))!.threads['rc-1']).toEqual([m.worker])
  })

  it('a session deletes its own post', async () => {
    const m = await seed()
    expect(await deleteBoardMessage(T, 'rc-1', m.worker.id, { by: 'task:worker-1' })).toEqual(m.worker)
    expect((await getBoard(T))!.threads['rc-1'].map((x) => x.id)).toEqual([m.user.id, m.leader.id])
  })

  it('a session deleting someone else\'s post (the user\'s, its leader\'s) is 403 not_author and writes nothing', async () => {
    const m = await seed()
    const before = await rawFile()
    events = []
    for (const id of [m.user.id, m.leader.id]) {
      const err = await boardError(() => deleteBoardMessage(T, 'rc-1', id, { by: 'task:worker-1' }))
      expect(err).toMatchObject({ code: 'not_author', statusCode: 403, details: { thread: 'rc-1', id } })
      expect(err.message).toBe('A session may delete only its own posts')
    }
    expect(await rawFile()).toBe(before)
    expect(events).toEqual([])
  })

  it('unknown board, thread or message is 404; a malformed id is 400', async () => {
    expect(await boardError(() => deleteBoardMessage(T, 'rc-1', 'bm-000000000000', { by: 'human' })))
      .toMatchObject({ code: 'no_board', statusCode: 404 })
    const m = await seed()
    expect(await boardError(() => deleteBoardMessage(T, 'other', m.user.id, { by: 'human' })))
      .toMatchObject({ code: 'message_not_found', statusCode: 404 })
    expect(await boardError(() => deleteBoardMessage(T, 'rc-1', 'bm-000000000000', { by: 'human' })))
      .toMatchObject({ code: 'message_not_found', statusCode: 404 })
    for (const id of ['', 'bm-', 'bm-XYZ', 'x-0b7d4261eca6', '../bm-0b7d4261eca6', `bm-${'a'.repeat(33)}`]) {
      expect(await boardError(() => deleteBoardMessage(T, 'rc-1', id, { by: 'human' })), id)
        .toMatchObject({ code: 'bad_id', statusCode: 400 })
    }
    expect(await boardError(() => deleteBoardMessage(T, '-bad', m.user.id, { by: 'human' })))
      .toMatchObject({ code: 'bad_id', statusCode: 400 })
    expect((await getBoard(T))!.threads['rc-1']).toHaveLength(3)
  })

  it('the last message takes its thread key with it; other threads, the html version and marks stay', async () => {
    await setBoardHtml(T, '<p/>', { by: 'human' })
    const only = await postBoardMessage(T, 'solo', { author: 'task:leader-1', text: 'placeholder' })
    await postBoardMessage(T, 'kept', { author: 'user', text: 'stays' })
    await setBoardMark(T, 'sec-1', { state: 'revisit' })
    await deleteBoardMessage(T, 'solo', only.id, { by: 'task:leader-1' })
    const board = (await getBoard(T))!
    expect(Object.keys(board.threads)).toEqual(['kept'])
    expect(board.version).toBe(1)
    expect(board.marks).toHaveProperty('sec-1')
  })

  it('each delete emits board:changed kind thread', async () => {
    const m = await seed()
    events = []
    await deleteBoardMessage(T, 'rc-1', m.user.id, { by: 'human' })
    expect(events.map((e) => [e.name, e.destinations, e.data])).toEqual([
      [EventNames.BOARD_CHANGED, ['web-ui'], { taskId: T, kind: 'thread', thread: 'rc-1', version: 1 }],
    ])
  })
})

describe('marks', () => {
  it('upsert replaces the whole mark; neither state nor note removes it', async () => {
    await setBoardHtml(T, '<p/>', { by: 'human' })
    expect(await setBoardMark(T, 'sec-1', { state: 'revisit' })).toMatchObject({ state: 'revisit' })
    const both = await setBoardMark(T, 'sec-1', { state: 'reviewed', note: 'checked the logs' })
    expect(both).toMatchObject({ state: 'reviewed', note: 'checked the logs' })
    expect(Date.parse(both!.updated_at)).not.toBeNaN()
    expect((await getBoard(T))!.marks['sec-1']).toEqual(both)
    // PUT semantics: a note alone drops the state.
    expect(await setBoardMark(T, 'sec-1', { note: 'only a note' })).not.toHaveProperty('state')
    await setBoardMark(T, 'sec-2', { state: 'waiting' })
    expect(await setBoardMark(T, 'sec-1', {})).toBeNull()
    expect(await setBoardMark(T, 'sec-2', { state: '', note: '  ' })).toBeNull()
    expect((await getBoard(T))!.marks).toEqual({})
  })

  it('a mark on a task with no board is 404 no_board', async () => {
    expect(await boardError(() => setBoardMark(T, 'sec-1', { state: 'x' }))).toMatchObject({ code: 'no_board' })
  })
})

describe('events', () => {
  it('every change emits board:changed to the web UI with a top-level taskId', async () => {
    await setBoardHtml(T, '<p>a</p>', { by: 'human' })
    await editBoardHtml(T, [{ old: 'a', new: 'b' }], { by: 'human' })
    await postBoardMessage(T, 'th', { author: 'user', text: 'hi' })
    await setBoardMark(T, 'mk', { state: 'x' })
    await deleteBoard(T)
    expect(events.map((e) => e.name)).toEqual(Array(5).fill(EventNames.BOARD_CHANGED))
    for (const e of events) expect(e.destinations).toEqual(['web-ui'])
    expect(events.map((e) => e.data)).toEqual([
      { taskId: T, kind: 'html', version: 1 },
      { taskId: T, kind: 'html', version: 2 },
      { taskId: T, kind: 'thread', thread: 'th', version: 2 },
      { taskId: T, kind: 'mark', mark: 'mk', version: 2 },
      { taskId: T, kind: 'deleted', version: 0 },
    ])
  })
})

describe('delete', () => {
  it('deleteBoard removes the file and is idempotent', async () => {
    await setBoardHtml(T, '<p/>', { by: 'human' })
    expect(await deleteBoard(T)).toBe(true)
    expect(await rawFile()).toBeNull()
    expect(await deleteBoard(T)).toBe(false)
    expect(await getBoard(T)).toBeNull()
  })

  it('deleting the task removes its board (also when the event names no destination)', async () => {
    initBoardStore()
    await setBoardHtml(T, '<p/>', { by: 'human' })
    await setBoardHtml('mt0abc12-bbbb', '<p/>', { by: 'human' })
    bus.emit(EventNames.TASK_DELETED, { task: { id: T } } as never, [], { source: 'sync' })
    await vi.waitFor(async () => { expect(await rawFile()).toBeNull() })
    // Another task's board is untouched.
    expect(await getBoard('mt0abc12-bbbb')).not.toBeNull()
    bus.emit(EventNames.TASK_DELETED, { id: 'mt0abc12-bbbb', task: { id: 'mt0abc12-bbbb' } } as never, ['web-ui'])
    await vi.waitFor(async () => { expect(await rawFile('mt0abc12-bbbb')).toBeNull() })
  })
})

describe('extractTaskRefs', () => {
  it('reads id in any attribute position and quote style, in document order, each once', () => {
    const html = [
      '<walnut-task id="mt1aaaa-0001"></walnut-task>',
      '<walnut-task class="chip" id=\'mt1aaaa-0002\' data-x="1"></walnut-task>',
      '<WALNUT-TASK data-id="not-this" title="see id=\'nope\' > here" id=mt1aaaa-0003 />',
      '<walnut-task id="mt1aaaa-0001"></walnut-task>',
      '<walnut-tasks id="other-element"></walnut-tasks>',
      '<walnut-task title="no id"></walnut-task>',
      '<walnut-task\n  id = "  mt1aaaa-0004 "\n>',
    ].join('\n')
    expect(extractTaskRefs(html)).toEqual(['mt1aaaa-0001', 'mt1aaaa-0002', 'mt1aaaa-0003', 'mt1aaaa-0004'])
  })

  it('no refs → []', () => {
    expect(extractTaskRefs('')).toEqual([])
    expect(extractTaskRefs('<div id="mt1aaaa-0001">plain html</div>')).toEqual([])
  })
})

describe('threadMeta', () => {
  const html = '<walnut-thread id="t-other" title="Other"></walnut-thread>'
    + '<walnut-thread task="mt1aaaa-0009" title="Root cause &amp; fix" id="rc-1"></walnut-thread>'
    + '<walnut-thread id="bare"></walnut-thread>'

  it('returns the matching tag\'s title and task, entities decoded', () => {
    expect(threadMeta(html, 'rc-1')).toEqual({ title: 'Root cause & fix', task: 'mt1aaaa-0009' })
    expect(threadMeta(html, 't-other')).toEqual({ title: 'Other' })
    expect(threadMeta(html, 'bare')).toEqual({})
  })

  it('null when the html has no such thread', () => {
    expect(threadMeta(html, 'missing')).toBeNull()
    expect(threadMeta('', 'rc-1')).toBeNull()
  })
})
