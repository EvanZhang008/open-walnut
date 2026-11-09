/**
 * Task Board store (src/core/boards/board-store.ts): storage, versioning, the
 * exact-string edit contract, caps, threads, marks, the html readers, and the
 * cleanup that follows a task's deletion. Real files in an isolated home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
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
  DELETED_BOARD_COPIES,
  _deletedBoardsDir,
  deleteBoard,
  deleteBoardMessage,
  listBoardTaskIds,
  removeBoard,
  editBoardHtml,
  extractTaskRefs,
  getBoard,
  htmlSourcesOf,
  initBoardStore,
  postBoardMessage,
  setBoardHtml,
  setBoardMark,
  sharedEnds,
  stopBoardStore,
  threadMeta,
} from '../../../src/core/boards/board-store.js'
import {
  htmlSourceAt, mergeHtmlSources, spliceHtmlSources, validHtmlSources, wholeHtmlSource, type BoardHtmlSource,
} from '../../../src/core/boards/board-html-source.js'
import { boardSummaryRange, boardSummaryTexts } from '../../../src/lib/board-summary-text.js'

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

  it('retains the HTML writer session across side writes and clears it on a human edit', async () => {
    await setBoardHtml(T, '<p>one</p>', { by: 'task:leader-1', sessionId: 'writing-session-full' })
    expect((await getBoard(T))!.updated_session_id).toBe('writing-session-full')
    await postBoardMessage(T, 't', { author: 'task:worker-1', sessionId: 'post-session-full', text: 'Side post' })
    await setBoardMark(T, 'mark', { state: 'read' })
    expect((await getBoard(T))!.updated_session_id).toBe('writing-session-full')
    await editBoardHtml(T, [{ old: 'one', new: 'two' }], { by: 'task:leader-1', sessionId: 'editing-session-full' })
    expect((await getBoard(T))!.updated_session_id).toBe('editing-session-full')
    await editBoardHtml(T, [{ old: 'two', new: 'three' }], { by: 'human' })
    expect((await getBoard(T))!).not.toHaveProperty('updated_session_id')
    expect((await getBoard(T))!.threads.t[0].sessionId).toBe('post-session-full')
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

describe('html sources (who wrote each part of the page)', () => {
  const LEAD = { by: 'task:lead-1' as const, sessionId: 'sid-lead' }
  const WORKER = { by: 'task:worker-1' as const, sessionId: 'sid-worker' }

  /** The writer of the text at the nth occurrence of `needle`, as the stored spans say. */
  function writerAt(html: string, sources: BoardHtmlSource[], needle: string, nth = 0): { by: string; sessionId?: string } | null {
    let at = -1
    for (let i = 0; i <= nth; i += 1) at = html.indexOf(needle, at + 1)
    expect(at).toBeGreaterThanOrEqual(0)
    const span = htmlSourceAt(sources, html.length, at)
    return span ? { by: span.by, ...(span.sessionId ? { sessionId: span.sessionId } : {}) } : null
  }

  async function writeRaw(record: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.dirname(_boardFilePath(T)), { recursive: true })
    await fs.writeFile(_boardFilePath(T), JSON.stringify({
      task_id: T, version: 4, updated_at: '2026-11-01T00:00:00.000Z',
      threads: {}, marks: {}, projects: {}, checks: {}, choices: {}, reminders: {}, section_seen: {},
      lanes: null, cards: {}, kanban_seen: null, ...record,
    }))
  }

  it('a full write makes the whole page its writer\'s; empty html has no spans', async () => {
    const html = '<p>See src/lead.ts</p>'
    const board = await setBoardHtml(T, html, LEAD)
    expect(board.html_sources).toEqual([{ start: 0, end: html.length, by: 'task:lead-1', sessionId: 'sid-lead' }])
    expect((await getBoard(T))!.html_sources).toEqual(board.html_sources)
    expect((await setBoardHtml(T, '', LEAD)).html_sources).toEqual([])
  })

  it('a same-byte whole write preserves every writer, including an old unknown writer', async () => {
    await setBoardHtml(T, '<p>See src/lead.ts</p><p>Open</p>', LEAD)
    const mixed = await editBoardHtml(T, [{ old: 'Open', new: 'src/worker.ts' }], WORKER)
    const echoed = await setBoardHtml(T, mixed.html, { by: 'human' })
    expect(echoed.html_sources).toEqual(mixed.html_sources)
    expect(writerAt(echoed.html, echoed.html_sources!, 'src/lead.ts')).toEqual(LEAD)
    expect(writerAt(echoed.html, echoed.html_sources!, 'src/worker.ts')).toEqual(WORKER)
    await writeRaw({ html: '<p>Older /srv/unknown.txt</p>', updated_by: 'agent' })
    const old = (await getBoard(T))!
    const again = await setBoardHtml(T, old.html, LEAD)
    expect(again.html_sources).toEqual(htmlSourcesOf(old))
    expect(writerAt(again.html, again.html_sources!, '/srv/unknown.txt')).toEqual({ by: 'agent' })
  })

  it('a worker editing text with no path leaves the lead\'s path the lead\'s', async () => {
    await setBoardHtml(T, '<p>See src/lead.ts</p><p>Status: open</p>', LEAD)
    const board = await editBoardHtml(T, [{ old: 'Status: open', new: 'Status: done' }], WORKER)
    expect(board.updated_session_id).toBe('sid-worker')
    expect(writerAt(board.html, board.html_sources!, 'src/lead.ts')).toEqual(LEAD)
    // `Status: ` is repeated from the old text, so only `done` is the worker's.
    expect(writerAt(board.html, board.html_sources!, 'Status: ')).toEqual(LEAD)
    expect(writerAt(board.html, board.html_sources!, 'done')).toEqual(WORKER)
    expect(writerAt(board.html, board.html_sources!, '</p>', 1)).toEqual(LEAD)
    expect(board.html_sources).toEqual(htmlSourcesOf((await getBoard(T))!))
  })

  it('a path a worker adds is the worker\'s, and two same-name paths keep their own writers', async () => {
    await setBoardHtml(T, '<p>Lead: src/a.ts</p><p>Next</p>', LEAD)
    const board = await editBoardHtml(T, [{ old: '<p>Next</p>', new: '<p>Worker: src/a.ts</p><p>Next</p>' }], WORKER)
    expect(writerAt(board.html, board.html_sources!, 'src/a.ts', 0)).toEqual(LEAD)
    expect(writerAt(board.html, board.html_sources!, 'src/a.ts', 1)).toEqual(WORKER)
    // The lead rewording its own line later changes nothing of the worker's.
    const again = await editBoardHtml(T, [{ old: 'Lead: ', new: 'Lead wrote: ' }], LEAD)
    expect(writerAt(again.html, again.html_sources!, 'src/a.ts', 0)).toEqual(LEAD)
    expect(writerAt(again.html, again.html_sources!, 'src/a.ts', 1)).toEqual(WORKER)
  })

  it('a deletion adds no span and the text after keeps its writer at its new offset', async () => {
    const html = '<p>drop me</p><p>src/keep.ts</p>'
    await setBoardHtml(T, html, LEAD)
    const board = await editBoardHtml(T, [{ old: '<p>drop me</p>', new: '' }], WORKER)
    expect(board.html).toBe('<p>src/keep.ts</p>')
    expect(board.html_sources).toEqual([{ start: 0, end: board.html.length, by: 'task:lead-1', sessionId: 'sid-lead' }])
  })

  /** Every writer of the text at the nth occurrence of `needle`. */
  function writersOf(html: string, sources: BoardHtmlSource[], needle: string, nth = 0): string[] {
    let at = -1
    for (let i = 0; i <= nth; i += 1) at = html.indexOf(needle, at + 1)
    expect(at).toBeGreaterThanOrEqual(0)
    return [...new Set(sources.filter((s) => s.start < at + needle.length && s.end > at).map((s) => `${s.by}|${s.sessionId ?? ''}`))]
  }

  it('a deletion that joins or cuts a path names the editor in it; the other paths keep their writer', async () => {
    await setBoardHtml(T, '<p>See /srv/a/old/x.ts, <code>/tmp/b/run.log</code></p><p>Keep /srv/keep.ts</p>', LEAD)
    const board = await editBoardHtml(T, [
      { old: '/srv/a/old/x.ts', new: '/srv/a/x.ts' },
      { old: '/tmp/b/run.log', new: '/b/run.log' },
    ], WORKER)
    expect(board.html).toBe('<p>See /srv/a/x.ts, <code>/b/run.log</code></p><p>Keep /srv/keep.ts</p>')
    expect(writersOf(board.html, board.html_sources!, '/srv/a/x.ts')).toEqual(['task:lead-1|sid-lead', 'task:worker-1|sid-worker'])
    expect(writersOf(board.html, board.html_sources!, '/b/run.log')).toEqual(['task:worker-1|sid-worker', 'task:lead-1|sid-lead'])
    expect(writersOf(board.html, board.html_sources!, '/srv/keep.ts')).toEqual(['task:lead-1|sid-lead'])
    expect(board.html_sources).toEqual(htmlSourcesOf((await getBoard(T))!))
  })

  it.each(['&#10;', '&#xA;', '&#9;', '&Tab;', '&NewLine;', '&quot;', '&lt;'])('an encoded token break %s names the editor in the shortened path', async (separator) => {
    for (const html of ['<p>See /tmp/a.txt.bak</p>', '<walnut-choice summary="See /tmp/a.txt.bak"></walnut-choice>']) {
      await setBoardHtml(T, html, LEAD)
      const board = await editBoardHtml(T, [{ old: '/tmp/a.txt.bak', new: `/tmp/a.txt${separator}.bak` }], WORKER)
      expect(writersOf(board.html, board.html_sources!, '/tmp/a.txt')).toContain('task:worker-1|sid-worker')
      const summary = boardSummaryTexts(board.html)[0]
      if (summary) {
        const offset = summary.text.indexOf('/tmp/a.txt')
        const range = boardSummaryRange(summary, offset, offset + '/tmp/a.txt'.length)!
        expect(board.html_sources!.filter((s) => s.start < range.end && s.end > range.start).map((s) => s.by)).toContain(WORKER.by)
      }
    }
  })

  it('changing inside an entity to cut a path names the editor in the new path', async () => {
    await setBoardHtml(T, '<walnut-choice summary="See /tmp/a.txt&#46;bak"></walnut-choice>', LEAD)
    const board = await editBoardHtml(T, [{ old: '&#46;', new: '&#10;' }], WORKER)
    expect(writersOf(board.html, board.html_sources!, '/tmp/a.txt')).toContain('task:worker-1|sid-worker')
  })

  it.each(['&lt', '&quot', '&gt', '&nbsp'])('a legacy text entity %s names the editor at the cut', async (separator) => {
    await setBoardHtml(T, '<p>/tmp/abc.txt</p>', LEAD)
    const board = await editBoardHtml(T, [{ old: '/tmp/abc.txt', new: `/tmp/a${separator}bc.txt` }], WORKER)
    expect(writersOf(board.html, board.html_sources!, '/tmp/a')).toContain('task:worker-1|sid-worker')
  })

  it('an entity longer than the seam budget keeps the edit but trusts no old writer', async () => {
    const entity = `&#${'0'.repeat(600)}46;`
    await setBoardHtml(T, `<walnut-choice summary="See /tmp/a.txt${entity}bak"></walnut-choice>`, LEAD)
    const board = await editBoardHtml(T, [{ old: '46;', new: '10;' }], WORKER)
    expect(board.html).toContain(`&#${'0'.repeat(600)}10;`)
    expect(board.html_sources).toEqual(wholeHtmlSource(board.html.length, 'agent'))
  })

  it.each([
    ['&#100.', '&#10x.'],
    ['&#100.', '&#10.'],
    ['&ltimes;', '&lt1mes;'],
  ])('terminating %s early names the editor in the shortened path', async (old, next) => {
    await setBoardHtml(T, `<p>/tmp/a${old}txt</p><p>/keep/file.txt</p>`, LEAD)
    const board = await editBoardHtml(T, [{ old, new: next }], WORKER)
    expect(writersOf(board.html, board.html_sources!, '/tmp/a')).toContain('task:worker-1|sid-worker')
    expect(writersOf(board.html, board.html_sources!, '/keep/file.txt')).toEqual(['task:lead-1|sid-lead'])
  })

  it.each(['46bak', '46;bak'])('an unbounded numeric entity ending in %s trusts no old writer', async (tail) => {
    const entity = `&#${'0'.repeat(600)}${tail}`
    await setBoardHtml(T, `<p>/tmp/a.txt${entity}</p>`, LEAD)
    const board = await editBoardHtml(T, [{ old: tail, new: tail.replace('46', '10') }], WORKER)
    expect(board.html).toContain(`&#${'0'.repeat(600)}${tail.replace('46', '10')}`)
    expect(board.html_sources).toEqual(wholeHtmlSource(board.html.length, 'agent'))
  })

  it.each(['&#10;', '&lt;', '&nbsp;'])('editing after an unchanged %s preserves the earlier path', async (entity) => {
    await setBoardHtml(T, `<p>/tmp/a.txt${entity}old</p>`, LEAD)
    const board = await editBoardHtml(T, [{ old: 'old', new: 'new' }], WORKER)
    expect(writersOf(board.html, board.html_sources!, '/tmp/a.txt')).toEqual(['task:lead-1|sid-lead'])
  })

  it.each(['0', 'ab'])('a long plain %s run retains unrelated path sources', async (chars) => {
    await setBoardHtml(T, `<p>/keep/file.txt</p><code>${chars.repeat(2000)}x</code>`, LEAD)
    const board = await editBoardHtml(T, [{ old: `${chars}x`, new: `${chars}y` }], WORKER)
    expect(writersOf(board.html, board.html_sources!, '/keep/file.txt')).toEqual(['task:lead-1|sid-lead'])
  })

  it('removing an encoded break joins the path with the editor at its seam', async () => {
    await setBoardHtml(T, '<p>/tmp/a.txt&#10;.bak</p>', LEAD)
    const board = await editBoardHtml(T, [{ old: '&#10;', new: '' }], WORKER)
    expect(writersOf(board.html, board.html_sources!, '/tmp/a.txt.bak')).toContain('task:worker-1|sid-worker')
  })

  it('editing repeated encoded spaces leaves distant paths with their writers', async () => {
    await setBoardHtml(T, `<p>/keep/file.txt</p><p>${'&nbsp;'.repeat(2000)}</p><p>/tail/file.txt</p>`, LEAD)
    const board = await editBoardHtml(T, [{ old: `<p>${'&nbsp;'.repeat(2000)}</p>`, new: `<p>${'&nbsp;'.repeat(1999)}</p>` }], WORKER)
    expect(writersOf(board.html, board.html_sources!, '/keep/file.txt')).toEqual(['task:lead-1|sid-lead'])
    expect(writersOf(board.html, board.html_sources!, '/tail/file.txt')).toEqual(['task:lead-1|sid-lead'])
  })

  it('deleting a whole paragraph takes nothing of the next one, even when the two end alike', async () => {
    // The lead's two paragraphs around the worker's one.
    const html = '<p>lead /a/x.ts</p><p>old /b/x.ts</p><p>lead /c/x.ts</p>'
    await writeRaw({ html, updated_by: 'task:lead-1', html_sources: [
      { start: 0, end: 19, ...LEAD }, { start: 19, end: 37, ...WORKER }, { start: 37, end: html.length, ...LEAD },
    ] })
    // The shared ends leave the cut as "old /b/x.ts</p><p>", which slides to the worker's whole paragraph.
    const board = await editBoardHtml(T, [{ old: '</p><p>old /b/x.ts</p><p>lead', new: '</p><p>lead' }], WORKER)
    expect(board.html).toBe('<p>lead /a/x.ts</p><p>lead /c/x.ts</p>')
    expect(board.html_sources).toEqual([{ start: 0, end: board.html.length, ...LEAD }])
  })

  it('a deletion seam next to a surrogate pair marks the whole pair', async () => {
    await setBoardHtml(T, '<p>/a/\ud83d\ude00old/x.ts</p>', LEAD)
    const board = await editBoardHtml(T, [{ old: '\ud83d\ude00old/x', new: '\ud83d\ude00x' }], WORKER)
    expect(board.html).toBe('<p>/a/\ud83d\ude00x.ts</p>')
    expect(board.html_sources).toEqual([{ start: 0, end: 6, ...LEAD }, { start: 6, end: 9, ...WORKER }, { start: 9, end: board.html.length, ...LEAD }])
  })

  it('a deletion that makes a path with spaces names the editor, in text and in an href', async () => {
    const lead = 'task:lead-1|sid-lead'
    const worker = 'task:worker-1|sid-worker'
    await setBoardHtml(T, '<p>/n/Plan Old\nFinal.md</p><p><a href="/n/x old b.txt">x</a></p><a href="/n/a removed /b.txt">b</a>', LEAD)
    const board = await editBoardHtml(T, [{ old: 'Old\n', new: '' }, { old: 'old ', new: '' }, { old: 'removed ', new: '' }], WORKER)
    expect(board.html).toBe('<p>/n/Plan Final.md</p><p><a href="/n/x b.txt">x</a></p><a href="/n/a /b.txt">b</a>')
    expect(writersOf(board.html, board.html_sources!, '/n/Plan Final.md')).toEqual([lead, worker])
    expect(writersOf(board.html, board.html_sources!, '/n/x b.txt')).toEqual([lead, worker])
    expect(writersOf(board.html, board.html_sources!, '/n/a /b.txt')).toEqual([lead, worker])
  })

  it('a word deleted between two paths leaves both with their writer', async () => {
    await setBoardHtml(T, '<p>see /a/x.ts old /b/y.ts</p>', LEAD)
    const board = await editBoardHtml(T, [{ old: 'old ', new: '' }], WORKER)
    expect(board.html).toBe('<p>see /a/x.ts /b/y.ts</p>')
    expect(board.html_sources).toEqual([{ start: 0, end: board.html.length, ...LEAD }])
  })

  it('edits in ~1 MB of repeated text stay at their own seam and leave far paths alone, edit after edit', async () => {
    const html = `<p>/keep/k.ts</p><p>${'ab'.repeat(450_000)}</p><p>/tail/t.ts</p>`
    await setBoardHtml(T, html, LEAD)
    let board = (await getBoard(T))!
    for (let round = 1; round <= 3; round += 1) {
      // A deletion at the end of the run and an insertion at its start: the run could absorb either
      // anywhere, so each stays where its edit put it and names the worker on both sides of its seam.
      board = await editBoardHtml(T, [{ old: 'ab</p><p>/tail', new: '</p><p>/tail' }, { old: '<p>ab', new: '<p>abab' }], WORKER)
      expect(board.html).toBe(html)
      const start = html.indexOf('ab')
      const end = html.indexOf('</p><p>/tail')
      expect(board.html_sources).toEqual([
        { start: 0, end: start + 1, ...LEAD },
        { start: start + 1, end: start + 3 + 2 * round, ...WORKER },
        { start: start + 3 + 2 * round, end: end - 1, ...LEAD },
        { start: end - 1, end: end + 1, ...WORKER },
        { start: end + 1, end: html.length, ...LEAD },
      ])
    }
    expect(writersOf(board.html, board.html_sources!, '/keep/k.ts')).toEqual(['task:lead-1|sid-lead'])
    expect(writersOf(board.html, board.html_sources!, '/tail/t.ts')).toEqual(['task:lead-1|sid-lead'])
  })

  it('edits whose source work runs past the budget keep every edit, with the page\'s writers unknown', async () => {
    await setBoardHtml(T, '<p>one /a/x.ts</p><p>two</p>', LEAD)
    let tick = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (tick += 26))
    const board = await (async () => {
      try {
        return await editBoardHtml(T, [{ old: 'one', new: 'ONE' }, { old: 'two', new: 'TWO' }], WORKER)
      } finally {
        now.mockRestore()
      }
    })()
    expect(board.html).toBe('<p>ONE /a/x.ts</p><p>TWO</p>')
    expect(board.updated_by).toBe('task:worker-1')
    expect(board.html_sources).toEqual([{ start: 0, end: board.html.length, by: 'agent' }])
    expect((await getBoard(T))!.html_sources).toEqual(board.html_sources)
  })

  it('identical edits retain the old writer even when the source clock has no budget', async () => {
    const html = '<p>Read /a/remote.ts</p>'
    await setBoardHtml(T, html, LEAD)
    let tick = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (tick += 26))
    try {
      const board = await editBoardHtml(T, [{ old: html, new: html }, { old: '/a/remote.ts', new: '/a/remote.ts' }], WORKER)
      expect(board.html).toBe(html)
      expect(board.html_sources).toEqual([{ start: 0, end: html.length, ...LEAD }])
    } finally {
      clock.mockRestore()
    }
  })

  it('a longer and a shorter replacement shift what follows by the length change', async () => {
    await setBoardHtml(T, 'A-B-src/x.ts', LEAD)
    const longer = await editBoardHtml(T, [{ old: 'A', new: 'BBBBB' }], WORKER)
    expect(longer.html_sources).toEqual([
      { start: 0, end: 5, ...WORKER },
      { start: 5, end: 16, ...LEAD },
    ])
    const shorter = await editBoardHtml(T, [{ old: 'BBBBB', new: 'Z' }], WORKER)
    expect(shorter.html).toBe('Z-B-src/x.ts')
    expect(shorter.html_sources).toEqual([
      { start: 0, end: 1, ...WORKER },
      { start: 1, end: 12, ...LEAD },
    ])
  })

  it('several edits in one call each cut the spans at their own place, and same-writer neighbours merge', async () => {
    await setBoardHtml(T, '<a>one</a><b>two</b><c>three</c>', LEAD)
    const board = await editBoardHtml(T, [
      { old: 'one', new: 'ONE [X]' },
      // Only exists because of the first edit.
      { old: '[X]', new: 'src/w.ts' },
      { old: 'three', new: '3' },
    ], WORKER)
    expect(board.html).toBe('<a>ONE src/w.ts</a><b>two</b><c>3</c>')
    expect(board.html_sources).toEqual([
      { start: 0, end: 3, ...LEAD },
      { start: 3, end: 15, ...WORKER },
      { start: 15, end: 32, ...LEAD },
      { start: 32, end: 33, ...WORKER },
      { start: 33, end: 37, ...LEAD },
    ])
    expect(writerAt(board.html, board.html_sources!, 'src/w.ts')).toEqual(WORKER)
    expect(writerAt(board.html, board.html_sources!, 'two')).toEqual(LEAD)
  })

  it('offsets count UTF-16 units: CJK text and a surrogate pair before a path', async () => {
    // Two CJK characters and an emoji of two UTF-16 units (a surrogate pair) before the path.
    const html = '<p>\u4e2d\u6587 \ud83d\ude00 src/lead.ts</p><p>\u72b6\u6001</p>'
    await setBoardHtml(T, html, LEAD)
    const added = '\u5b8c\u6210 src/w.ts'
    const board = await editBoardHtml(T, [{ old: '\u72b6\u6001', new: added }], WORKER)
    expect(writerAt(board.html, board.html_sources!, 'src/lead.ts')).toEqual(LEAD)
    expect(writerAt(board.html, board.html_sources!, 'src/w.ts')).toEqual(WORKER)
    const at = board.html.indexOf(added)
    expect(at).toBe(html.indexOf('\u72b6'))
    expect(board.html_sources![1]).toEqual({ start: at, end: at + added.length, ...WORKER })
    expect(board.html_sources![board.html_sources!.length - 1].end).toBe(board.html.length)
  })

  it('text replaced by itself rewrites no one\'s span', async () => {
    await setBoardHtml(T, '<p>src/lead.ts</p>', LEAD)
    const board = await editBoardHtml(T, [{ old: 'src/lead.ts', new: 'src/lead.ts' }], WORKER)
    expect(board.updated_by).toBe('task:worker-1')
    expect(board.html_sources).toEqual([{ start: 0, end: board.html.length, ...LEAD }])
  })

  it('a block re-sent with a change at its end keeps the lead\'s path in the shared start', async () => {
    await setBoardHtml(T, '<section><p>See src/lead.ts</p><p>Status: open</p></section>', LEAD)
    const board = await editBoardHtml(T, [{
      old: '<section><p>See src/lead.ts</p><p>Status: open</p>',
      new: '<section><p>See src/lead.ts</p><p>Status: done</p>',
    }], WORKER)
    const at = board.html.indexOf('done')
    expect(board.html_sources).toEqual([
      { start: 0, end: at, ...LEAD },
      { start: at, end: at + 4, ...WORKER },
      { start: at + 4, end: board.html.length, ...LEAD },
    ])
    expect(writerAt(board.html, board.html_sources!, 'src/lead.ts')).toEqual(LEAD)
  })

  it('a block re-sent with a change at its start keeps the lead\'s path in the shared end', async () => {
    await setBoardHtml(T, '<p>Status: open</p><p>See src/lead.ts</p>', LEAD)
    const board = await editBoardHtml(T, [{
      old: 'open</p><p>See src/lead.ts</p>',
      new: 'closed</p><p>See src/lead.ts</p>',
    }], WORKER)
    expect(board.html).toBe('<p>Status: closed</p><p>See src/lead.ts</p>')
    const at = board.html.indexOf('closed')
    expect(board.html_sources).toEqual([
      { start: 0, end: at, ...LEAD },
      { start: at, end: at + 6, ...WORKER },
      { start: at + 6, end: board.html.length, ...LEAD },
    ])
    expect(writerAt(board.html, board.html_sources!, 'src/lead.ts')).toEqual(LEAD)
  })

  it('shared ends never overlap: repeated characters count once, and a repeated path is new only where added', async () => {
    expect(sharedEnds('abc', 'xyz')).toEqual({ prefix: 0, suffix: 0 })
    expect(sharedEnds('ab', 'ab')).toEqual({ prefix: 2, suffix: 0 })
    expect(sharedEnds('aa', 'aaa')).toEqual({ prefix: 2, suffix: 0 })
    expect(sharedEnds('aaa', 'aa')).toEqual({ prefix: 2, suffix: 0 })
    expect(sharedEnds('aba', 'aa')).toEqual({ prefix: 1, suffix: 1 })

    await setBoardHtml(T, 'x[aa]y', LEAD)
    const grown = await editBoardHtml(T, [{ old: '[aa]', new: '[aaaa]' }], WORKER)
    expect(grown.html).toBe('x[aaaa]y')
    expect(grown.html_sources).toEqual([
      { start: 0, end: 4, ...LEAD },
      { start: 4, end: 6, ...WORKER },
      { start: 6, end: 8, ...LEAD },
    ])
    // Shrinking removes the worker's two characters and one of the lead's; the lead's text is left,
    // and the seam the deletion made inside `[a]` is the worker's (a token it changed).
    const shrunk = await editBoardHtml(T, [{ old: '[aaaa]', new: '[a]' }], WORKER)
    expect(shrunk.html).toBe('x[a]y')
    expect(shrunk.html_sources).toEqual([{ start: 0, end: 2, ...LEAD }, { start: 2, end: 4, ...WORKER }, { start: 4, end: 5, ...LEAD }])

    await setBoardHtml(T, '<p>src/a.ts</p>', LEAD)
    const twice = await editBoardHtml(T, [{ old: 'src/a.ts', new: 'src/a.ts src/a.ts' }], WORKER)
    expect(writerAt(twice.html, twice.html_sources!, 'src/a.ts', 0)).toEqual(LEAD)
    expect(writerAt(twice.html, twice.html_sources!, 'src/a.ts', 1)).toEqual(WORKER)
    expect(twice.html_sources).toEqual([
      { start: 0, end: 11, ...LEAD },
      { start: 11, end: 20, ...WORKER },
      { start: 20, end: 24, ...LEAD },
    ])
  })

  it('shared ends never split a surrogate pair: a changed emoji is the writer\'s whole', async () => {
    // U+1F600 and U+1F601 share their high surrogate; U+1F600 and U+1FA00 share their low one.
    expect(sharedEnds('\ud83d\ude00 x', '\ud83d\ude01 x')).toEqual({ prefix: 0, suffix: 2 })
    expect(sharedEnds('x \ud83d\ude00', 'x \ud83e\ude00')).toEqual({ prefix: 2, suffix: 0 })
    expect(sharedEnds('\ud83d\ude00a', '\ud83d\ude00b')).toEqual({ prefix: 2, suffix: 0 })

    await setBoardHtml(T, '<p>\ud83d\ude00 src/lead.ts</p>', LEAD)
    const high = await editBoardHtml(T, [{ old: '\ud83d\ude00 src/lead.ts', new: '\ud83d\ude01 src/lead.ts' }], WORKER)
    expect(high.html_sources).toEqual([
      { start: 0, end: 3, ...LEAD },
      { start: 3, end: 5, ...WORKER },
      { start: 5, end: 21, ...LEAD },
    ])

    await setBoardHtml(T, '<p>src/lead.ts \ud83d\ude00</p>', LEAD)
    const low = await editBoardHtml(T, [{ old: 'src/lead.ts \ud83d\ude00', new: 'src/lead.ts \ud83e\ude00' }], WORKER)
    expect(low.html_sources).toEqual([
      { start: 0, end: 15, ...LEAD },
      { start: 15, end: 17, ...WORKER },
      { start: 17, end: 21, ...LEAD },
    ])
    for (const board of [high, low]) {
      for (const span of board.html_sources!) {
        expect(board.html.charCodeAt(span.start) >= 0xdc00 && board.html.charCodeAt(span.start) <= 0xdfff).toBe(false)
      }
    }
  })

  it('a full write of the same text keeps the original writer', async () => {
    const html = '<p>src/lead.ts</p>'
    await setBoardHtml(T, html, LEAD)
    const board = await setBoardHtml(T, html, WORKER)
    expect(board.html_sources).toEqual([{ start: 0, end: html.length, ...LEAD }])
  })

  it('a person changing the whole page replaces every earlier writer', async () => {
    await setBoardHtml(T, '<p>src/lead.ts</p><p>x</p>', LEAD)
    await editBoardHtml(T, [{ old: 'x', new: 'src/w.ts' }], WORKER)
    const board = await setBoardHtml(T, '<p>src/lead.ts</p><p>src/me.ts</p>', { by: 'human' })
    expect(board).not.toHaveProperty('updated_session_id')
    expect(board.html_sources).toEqual([{ start: 0, end: board.html.length, by: 'human' }])
  })

  it('a person\'s edit is the person\'s text only, with no session', async () => {
    await setBoardHtml(T, '<p>src/lead.ts</p><p>x</p>', LEAD)
    const board = await editBoardHtml(T, [{ old: 'x', new: 'src/me.ts' }], { by: 'human' })
    expect(writerAt(board.html, board.html_sources!, 'src/me.ts')).toEqual({ by: 'human' })
    expect(writerAt(board.html, board.html_sources!, 'src/lead.ts')).toEqual(LEAD)
  })

  it('a record from before spans reads as its last writer\'s, and an edit keeps that for the untouched text', async () => {
    await writeRaw({ html: '<p>src/old.ts</p><p>x</p>', updated_by: 'task:old-1', updated_session_id: 'sid-old' })
    const old = (await getBoard(T))!
    expect(old).not.toHaveProperty('html_sources')
    expect(htmlSourcesOf(old)).toEqual([{ start: 0, end: old.html.length, by: 'task:old-1', sessionId: 'sid-old' }])
    const board = await editBoardHtml(T, [{ old: 'x', new: 'src/w.ts' }], WORKER)
    expect(writerAt(board.html, board.html_sources!, 'src/old.ts')).toEqual({ by: 'task:old-1', sessionId: 'sid-old' })
    expect(writerAt(board.html, board.html_sources!, 'src/w.ts')).toEqual(WORKER)
    // A record with no session stored keeps its writer's task alone.
    await writeRaw({ html: '<p>a</p>', updated_by: 'task:old-2' })
    expect(htmlSourcesOf((await getBoard(T))!)).toEqual([{ start: 0, end: 8, by: 'task:old-2' }])
  })

  it('a stored record keeps every field an older Walnut reads, the spans beside them', async () => {
    await setBoardHtml(T, '<p>src/lead.ts</p>', LEAD)
    const raw = JSON.parse((await rawFile())!)
    expect(raw).toMatchObject({ task_id: T, html: '<p>src/lead.ts</p>', version: 1, updated_by: 'task:lead-1', updated_session_id: 'sid-lead' })
    expect(raw.html_sources).toEqual([{ start: 0, end: 18, ...LEAD }])
  })

  it('spans of the wrong shape are not trusted in any part: the page reads as its last writer\'s', async () => {
    const html = '<p>src/a.ts</p>'
    const n = html.length
    const bad: unknown[] = [
      'not a list',
      { start: 0, end: n, by: 'task:w' },
      [{ start: 0, end: n - 1, by: 'task:w' }],
      [{ start: 1, end: n, by: 'task:w' }],
      [{ start: 0, end: 5, by: 'task:w' }, { start: 6, end: n, by: 'task:w' }],
      [{ start: 0, end: 5, by: 'task:w' }, { start: 4, end: n, by: 'task:w' }],
      [{ start: 0, end: n + 3, by: 'task:w' }],
      [{ start: 0, end: 0, by: 'task:w' }, { start: 0, end: n, by: 'task:w' }],
      [{ start: '0', end: n, by: 'task:w' }],
      [{ start: 0, end: n + 0.5, by: 'task:w' }],
      [{ start: 0, end: n, by: 'task:../x' }],
      [{ start: 0, end: n, by: 'someone' }],
      [{ start: 0, end: n, by: 'task:w', sessionId: '../s' }],
      [{ start: 0, end: n, by: 'task:w', sessionId: 7 }],
      [null],
      [[0, n, 'task:w']],
    ]
    for (const html_sources of bad) {
      await writeRaw({ html, updated_by: 'task:old-1', updated_session_id: 'sid-old', html_sources })
      const board = (await getBoard(T))!
      expect(board, JSON.stringify(html_sources)).not.toHaveProperty('html_sources')
      expect(htmlSourcesOf(board)).toEqual([{ start: 0, end: n, by: 'task:old-1', sessionId: 'sid-old' }])
    }
    // An exact cover is kept as stored.
    const good = [{ start: 0, end: 3, by: 'human' }, { start: 3, end: n, by: 'task:w', sessionId: 'sid-w' }]
    await writeRaw({ html, updated_by: 'task:old-1', html_sources: good })
    expect((await getBoard(T))!.html_sources).toEqual(good)
  })

  it('a stale version, a missing anchor or a page grown too large writes nothing, spans included', async () => {
    await setBoardHtml(T, '<p>src/lead.ts</p><p>x</p>', LEAD)
    await editBoardHtml(T, [{ old: 'x', new: 'y' }], WORKER)
    const before = await rawFile()
    events = []
    expect((await boardError(() => editBoardHtml(T, [{ old: 'y', new: 'z' }], { ...WORKER, expectVersion: 1 }))).code)
      .toBe('board_version_conflict')
    expect((await boardError(() => editBoardHtml(T, [{ old: 'y', new: 'z' }, { old: 'nope', new: 'q' }], WORKER))).code)
      .toBe('board_edit_not_found')
    expect((await boardError(() => editBoardHtml(T, [{ old: '<p>', new: '<div>' }], WORKER))).code)
      .toBe('board_edit_not_unique')
    expect((await boardError(() => editBoardHtml(T, [{ old: 'y', new: 'z'.repeat(BOARD_HTML_MAX_BYTES) }], WORKER))).code)
      .toBe('board_too_large')
    expect(await rawFile()).toBe(before)
    expect(events).toEqual([])
  })

  it('concurrent edits keep every original and inserted writer under the board lock', async () => {
    // Neither old text shares a first or last character with its replacement.
    await setBoardHtml(T, '<p>first</p><p>other</p>', LEAD);
    await Promise.all([
      editBoardHtml(T, [{ old: 'first', new: 'src/a.ts' }], { by: 'task:a', sessionId: 'sid-a' }),
      editBoardHtml(T, [{ old: 'other', new: 'src/b.ts' }], { by: 'task:b', sessionId: 'sid-b' }),
    ]);
    const board = (await getBoard(T))!;
    expect(board.html).toBe('<p>src/a.ts</p><p>src/b.ts</p>');
    expect(board.version).toBe(3);
    expect(writerAt(board.html, board.html_sources!, 'src/a.ts')).toEqual({ by: 'task:a', sessionId: 'sid-a' });
    expect(writerAt(board.html, board.html_sources!, 'src/b.ts')).toEqual({ by: 'task:b', sessionId: 'sid-b' });
    expect(writerAt(board.html, board.html_sources!, '<p>')).toEqual(LEAD);
    expect(validHtmlSources(board.html_sources, board.html.length)).not.toBeNull();
  });

  it('side writes (a post, a mark) keep the spans', async () => {
    await setBoardHtml(T, '<p>src/lead.ts</p><p>x</p>', LEAD)
    const edited = await editBoardHtml(T, [{ old: 'x', new: 'y' }], WORKER)
    await postBoardMessage(T, 't', { author: 'task:worker-1', sessionId: 'sid-worker', text: 'hi' })
    await setBoardMark(T, 'm', { state: 'read' })
    expect((await getBoard(T))!.html_sources).toEqual(edited.html_sources)
  })

  describe('pure span helpers', () => {
    const s = (start: number, end: number, by: BoardHtmlSource['by'], sessionId?: string): BoardHtmlSource =>
      (sessionId ? { start, end, by, sessionId } : { start, end, by })

    it('a replacement across several spans keeps their outer parts', () => {
      const spans = [s(0, 4, 'task:a'), s(4, 8, 'task:b'), s(8, 12, 'task:c')]
      expect(spliceHtmlSources(spans, 2, 8, 3, { by: 'task:w' })).toEqual([
        s(0, 2, 'task:a'), s(2, 5, 'task:w'), s(5, 7, 'task:c'),
      ])
    })

    it('a replacement on a span edge cuts nothing it does not cover', () => {
      const spans = [s(0, 4, 'task:a'), s(4, 8, 'task:b')]
      expect(spliceHtmlSources(spans, 4, 4, 2, { by: 'task:w' })).toEqual([s(0, 4, 'task:a'), s(4, 6, 'task:w')])
      expect(spliceHtmlSources(spans, 0, 4, 0, { by: 'task:w' })).toEqual([s(0, 4, 'task:b')])
    })

    it('neighbours merge only with the same writer and the same session', () => {
      expect(mergeHtmlSources([s(0, 2, 'task:a', 'x'), s(2, 4, 'task:a', 'x'), s(4, 6, 'task:a', 'y'), s(6, 8, 'task:a')]))
        .toEqual([s(0, 4, 'task:a', 'x'), s(4, 6, 'task:a', 'y'), s(6, 8, 'task:a')])
      expect(spliceHtmlSources([s(0, 6, 'task:a', 'x')], 2, 2, 2, { by: 'task:a', sessionId: 'x' })).toEqual([s(0, 6, 'task:a', 'x')])
    })

    it('a lookup needs an integer offset inside the page and an exact cover', () => {
      const spans = [s(0, 3, 'human'), s(3, 6, 'task:w', 'sid')]
      expect(htmlSourceAt(spans, 6, 3)).toEqual(s(3, 6, 'task:w', 'sid'))
      expect(htmlSourceAt(spans, 6, 2)).toEqual(s(0, 3, 'human'))
      for (const off of [-1, 6, 1.5, '3', NaN, null, undefined]) expect(htmlSourceAt(spans, 6, off)).toBeNull()
      expect(htmlSourceAt(spans, 7, 3)).toBeNull()
      expect(validHtmlSources([], 0)).toEqual([])
      expect(validHtmlSources([], 1)).toBeNull()
    })
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

  it('keeps the writing session on a post without changing older posts', async () => {
    await setBoardHtml(T, '<p/>', { by: 'human' })
    const old = await postBoardMessage(T, 't', { author: 'task:leader-1', text: 'Old post' })
    const posted = await postBoardMessage(T, 't', { author: 'task:leader-1', sessionId: 'writing-session-full', text: 'New post' })
    expect(old).not.toHaveProperty('sessionId')
    expect(posted.sessionId).toBe('writing-session-full')
    expect((await getBoard(T))!.threads.t).toEqual([old, posted])
    await editBoardHtml(T, [{ old: '<p/>', new: '<p>Updated</p>' }], { by: 'human' })
    expect((await getBoard(T))!.threads.t).toEqual([old, posted])
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

  it('a session deletes someone else\'s post too (its leader\'s), as the user may; an unnamed agent as well', async () => {
    const m = await seed()
    events = []
    expect(await deleteBoardMessage(T, 'rc-1', m.leader.id, { by: 'agent' })).toEqual(m.leader)
    expect(await deleteBoardMessage(T, 'rc-1', m.worker.id, { by: 'task:leader-1' })).toEqual(m.worker)
    expect((await getBoard(T))!.threads['rc-1']).toEqual([m.user])
    expect(events).toHaveLength(2)
  })

  it('a post the user wrote needs override_user from a session (409 user_wrote, the post stays); with it, it goes', async () => {
    const m = await seed()
    events = []
    for (const by of ['task:worker-1', 'agent'] as const) {
      const err = await boardError(() => deleteBoardMessage(T, 'rc-1', m.user.id, { by }))
      expect([err.statusCode, err.code, err.details]).toEqual([409, 'user_wrote', { thread: 'rc-1', id: m.user.id, author: 'user' }])
      expect(err.message).toContain('override_user: true')
    }
    expect((await getBoard(T))!.threads['rc-1'].map((x) => x.id)).toContain(m.user.id)
    expect(events).toHaveLength(0)
    expect(await fs.readdir(_deletedBoardsDir()).catch(() => [])).toEqual([])
    expect(await deleteBoardMessage(T, 'rc-1', m.user.id, { by: 'task:worker-1', overrideUser: true })).toEqual(m.user)
    expect((await getBoard(T))!.threads['rc-1'].map((x) => x.id)).not.toContain(m.user.id)
    // The board as it was, the user's post included, is kept in boards/.deleted/ to restore from.
    const copies = await fs.readdir(_deletedBoardsDir())
    expect(copies).toHaveLength(1)
    const copy = JSON.parse(await fs.readFile(path.join(_deletedBoardsDir(), copies[0]), 'utf-8'))
    expect(copy.threads['rc-1'].map((x: { id: string }) => x.id)).toContain(m.user.id)
    // Deleting a session's post, or the user deleting their own, keeps no copy.
    await deleteBoardMessage(T, 'rc-1', m.worker.id, { by: 'task:leader-1', overrideUser: true })
    expect(await fs.readdir(_deletedBoardsDir())).toHaveLength(1)
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

  it('an agent\'s mark carries its writer; the user\'s mark stays theirs (409 user_wrote unless override_user)', async () => {
    await setBoardHtml(T, '<p/>', { by: 'human' })
    const ceo = { by: 'task:main-1' as const, by_name: 'the CEO' }
    expect(await setBoardMark(T, 'sec-a', { note: 'Agent note' }, { writer: ceo })).toMatchObject({ note: 'Agent note', by: 'task:main-1', by_name: 'the CEO' })
    // The user writing over an agent's note makes it theirs.
    expect(await setBoardMark(T, 'sec-a', { note: 'My note now' })).not.toHaveProperty('by')
    const mine = (await getBoard(T))!.marks['sec-a']
    events = []
    for (const input of [{ note: 'Changed by an agent' }, { note: '' }, {}]) {
      const err = await boardError(() => setBoardMark(T, 'sec-a', input, { writer: ceo }))
      expect([err.statusCode, err.code, err.details]).toEqual([409, 'user_wrote', { mark: 'sec-a', author: 'user' }])
    }
    // The same text again is no change and no event; old marks with no by are the user's.
    expect(await setBoardMark(T, 'sec-a', { note: 'My note now' }, { writer: ceo })).toEqual(mine)
    expect((await getBoard(T))!.marks['sec-a']).toEqual(mine)
    expect(events).toEqual([])
    expect(await setBoardMark(T, 'sec-a', { note: 'Rewritten as asked' }, { writer: ceo, overrideUser: true }))
      .toMatchObject({ note: 'Rewritten as asked', by: 'task:main-1' })
    // An agent's note another agent may change or clear.
    expect(await setBoardMark(T, 'sec-a', {}, { writer: { by: 'agent', by_name: 'an agent' } })).toBeNull()
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
    expect(await fs.readdir(_deletedBoardsDir()).catch(() => [])).toEqual([])
  })

  it('removeBoard with keepCopy moves the file to boards/.deleted/, keeps the newest 5 per task, and no reader lists them', async () => {
    const other = 'mt0abc12-cccc'
    await setBoardHtml(other, '<p>other</p>', { by: 'human' })
    expect((await removeBoard(other, { keepCopy: true })).existed).toBe(true)
    const copies: string[] = []
    for (let i = 0; i < DELETED_BOARD_COPIES + 2; i += 1) {
      await setBoardHtml(T, `<p>v${i}</p>`, { by: 'human' })
      const out = await removeBoard(T, { keepCopy: true })
      expect(out.existed).toBe(true)
      expect(path.dirname(out.copy!)).toBe(_deletedBoardsDir())
      copies.push(path.basename(out.copy!))
      expect(await rawFile()).toBeNull()
      await new Promise((r) => setTimeout(r, 3))
    }
    const kept = (await fs.readdir(_deletedBoardsDir())).filter((n) => n.startsWith(`${T}-`)).sort()
    expect(kept).toEqual(copies.slice(-DELETED_BOARD_COPIES))
    const newest = JSON.parse(await fs.readFile(path.join(_deletedBoardsDir(), kept[kept.length - 1]), 'utf-8'))
    expect(newest).toMatchObject({ task_id: T, html: `<p>v${DELETED_BOARD_COPIES + 1}</p>` })
    // Another task's copy is not pruned with these.
    expect((await fs.readdir(_deletedBoardsDir())).filter((n) => n.startsWith(`${other}-`))).toHaveLength(1)
    expect(await listBoardTaskIds()).toEqual([])
    expect(await removeBoard(T, { keepCopy: true })).toEqual({ existed: false })
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
