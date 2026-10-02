/**
 * The board's round-two side state (src/core/boards/board-items.ts) and the
 * html readers it relies on (board-html.ts): the point hash, choice options,
 * the project / check / choice / reminder / section-seen writers with their caps,
 * and an old board file read by this build. Real files in an isolated home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-board-items'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, type BusEvent } from '../../../src/core/event-bus.js'
import {
  BoardError,
  _boardFilePath,
  getBoard,
  postBoardMessage,
  setBoardHtml,
  type BoardFile,
} from '../../../src/core/boards/board-store.js'
import { checkContentHash, checkHashes, choiceSpecs, parsePairs } from '../../../src/core/boards/board-html.js'
import {
  BOARD_MAX_CHECKS,
  BOARD_MAX_PROJECTS,
  BOARD_MAX_SECTION_SEEN,
  BOARD_PROJECT_MAX_TASKS,
  boardCheckStates,
  patchBoardReminder,
  setBoardCheck,
  setBoardChoice,
  setBoardProject,
  setBoardReminder,
  setBoardSectionSeen,
  writeBoardProject,
} from '../../../src/core/boards/board-items.js'

const T = 'mt0abc12-aaaa'
const HOUR = 3_600_000

async function boardError(fn: () => Promise<unknown> | unknown): Promise<BoardError> {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(BoardError)
    return err as BoardError
  }
  throw new Error('expected a BoardError')
}

async function rawFile(): Promise<string | null> {
  return fs.readFile(_boardFilePath(T), 'utf-8').catch(() => null)
}

async function writeRaw(board: Partial<BoardFile>): Promise<void> {
  await fs.mkdir(path.dirname(_boardFilePath(T)), { recursive: true })
  await fs.writeFile(_boardFilePath(T), JSON.stringify(board))
}

const PAGE = [
  '<section data-project="cause-a">',
  '<walnut-check id="fact-1">Cache TTL is <b>5 min</b></walnut-check>',
  '<walnut-check id="fix-1">Raise the TTL</walnut-check>',
  '<walnut-choice id="when" title="Deploy timing" options="wait:Wait for the deploy,now:Run it now" recommended="wait"></walnut-choice>',
  '<walnut-thread id="cause-a" title="Cause A"></walnut-thread>',
  '</section>',
].join('\n')

let events: BusEvent[] = []

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  events = []
  bus.subscribe('test-board-items-spy', (e) => { events.push(e) }, { global: true, interest: ['board:'] })
})

afterEach(async () => {
  bus.unsubscribe('test-board-items-spy')
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('checkHashes', () => {
  it('hashes the inner html: whitespace runs do not count, any other change does', () => {
    const a = checkHashes('<walnut-check id="p1">Cache  TTL\n  is <b>5</b> </walnut-check>').p1
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(checkHashes('<walnut-check id="p1">  Cache TTL is <b>5</b></walnut-check>').p1).toBe(a)
    expect(checkHashes('<walnut-check id="p1">Cache TTL is <b>6</b></walnut-check>').p1).not.toBe(a)
    expect(checkHashes('<walnut-check id="p1">Cache TTL is <i>5</i></walnut-check>').p1).not.toBe(a)
    expect(a).toBe(checkContentHash('Cache TTL is <b>5</b>'))
  })

  it('reads id in any attribute position and quote style; the first occurrence of an id wins; bad ids are skipped', () => {
    const html = [
      '<walnut-check class="x" id=\'p1\' data-id="nope">First</walnut-check>',
      '<WALNUT-CHECK title="id=\'p9\'" id=p2>Second</WALNUT-CHECK>',
      '<walnut-check id="p1">Duplicate</walnut-check>',
      '<walnut-check id="-bad">Never tickable</walnut-check>',
      '<walnut-check>No id</walnut-check>',
    ].join('')
    const out = checkHashes(html)
    expect(Object.keys(out)).toEqual(['p1', 'p2'])
    expect(out.p1).toBe(checkContentHash('First'))
    expect(out.p2).toBe(checkContentHash('Second'))
  })

  it('nests the way a browser does, and an unclosed tag neither counts nor goes quadratic', () => {
    const nested = checkHashes('<walnut-check id="outer">A <walnut-check id="inner">B</walnut-check> C</walnut-check>')
    expect(nested.inner).toBe(checkContentHash('B'))
    expect(nested.outer).toBe(checkContentHash('A <walnut-check id="inner">B</walnut-check> C'))
    expect(checkHashes('<walnut-check id="open">never closed')).toEqual({})
    const many = '<walnut-check id="x">'.repeat(20_000) + 'tail'
    const started = performance.now()
    expect(checkHashes(many)).toEqual({})
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe('choiceSpecs and parsePairs', () => {
  it('parses options like walnut-mark states: spaces, non-ASCII and entities in labels; recommended only when it is an option', () => {
    const html = '<walnut-choice task="mt1aaaa-0009" id="when" options="a:Wait for the \u00e9t\u00e9 deploy, b : Run it now &amp; watch,c" '
      + 'recommended="b" title="Deploy &#8220;timing&#8221;"></walnut-choice>'
      + '<walnut-choice id="other" options="x:\u4e0a\u7ebf" recommended="zz"></walnut-choice>'
      + '<walnut-choice id="when" options="z:Second copy"></walnut-choice>'
      + '<walnut-choice id="empty"></walnut-choice>'
    const specs = choiceSpecs(html)
    expect(specs.when).toEqual({
      options: [
        { value: 'a', label: 'Wait for the \u00e9t\u00e9 deploy' },
        { value: 'b', label: 'Run it now & watch' },
        { value: 'c', label: 'c' },
      ],
      recommended: 'b',
      title: 'Deploy \u201ctiming\u201d',
      task: 'mt1aaaa-0009',
    })
    expect(specs.other).toEqual({ options: [{ value: 'x', label: '\u4e0a\u7ebf' }] })
    expect(specs.empty).toEqual({ options: [] })
  })

  it('parsePairs is the frame core\'s twin: empty keys dropped, a bare part is its own label, duplicates kept', () => {
    expect(parsePairs('a:A,,b, :Nameless,a:Again')).toEqual([
      { key: 'a', label: 'A' }, { key: 'b', label: 'b' }, { key: 'a', label: 'Again' },
    ])
    expect(parsePairs(undefined)).toEqual([])
  })
})

describe('an old board file', () => {
  it('reads with empty new maps, and the next write keeps what it had', async () => {
    await writeRaw({ task_id: T, html: '<p>old</p>', version: 4, updated_at: '2026-09-30T00:00:00.000Z', updated_by: 'human',
      threads: { t: [{ id: 'bm-0b7d4261eca6', author: 'user', text: 'hi', ts: '2026-09-30T00:00:00.000Z' }] }, marks: {} })
    const board = await getBoard(T)
    expect(board).toMatchObject({ version: 4, projects: {}, checks: {}, choices: {}, reminders: {}, section_seen: {} })
    const next = await setBoardHtml(T, PAGE, { by: 'human' })
    expect(next.threads.t).toHaveLength(1)
    expect(next.version).toBe(5)
  })

  it('a whole-document set keeps every side map', async () => {
    await setBoardHtml(T, PAGE, { by: 'human' })
    await setBoardProject(T, 'cause-a', { status: 'wip' }, { by: 'human' })
    await setBoardCheck(T, 'fix-1', { read: true, hash: checkHashes(PAGE)['fix-1'] })
    await setBoardChoice(T, 'when', { option: 'now' })
    await setBoardReminder(T, 'cause-a', { at: new Date(Date.now() + HOUR).toISOString() }, { by: 'human' })
    await setBoardSectionSeen(T, 'cause-a', { hash: 'h1' })
    const after = await setBoardHtml(T, `${PAGE}<p>more</p>`, { by: 'task:lead' })
    expect(Object.keys(after.projects)).toEqual(['cause-a'])
    expect(Object.keys(after.checks)).toEqual(['fix-1'])
    expect(Object.keys(after.choices)).toEqual(['when'])
    expect(Object.keys(after.reminders)).toEqual(['cause-a'])
    expect(Object.keys(after.section_seen)).toEqual(['cause-a'])
  })
})

describe('projects', () => {
  beforeEach(async () => { await setBoardHtml(T, PAGE, { by: 'human' }) })

  it('partial updates keep the rest; tasks are a full replacement (deduped); "" clears; empty or delete removes', async () => {
    expect(await setBoardProject(T, 'cause-a', { title: '  Cache TTL ', status: 'decide' }, { by: 'human' }))
      .toMatchObject({ title: 'Cache TTL', status: 'decide', updated_by: 'human' })
    expect(await setBoardProject(T, 'cause-a', { tasks: ['t1', 't2', 't1'] }, { by: 'task:lead' }))
      .toMatchObject({ title: 'Cache TTL', status: 'decide', tasks: ['t1', 't2'], updated_by: 'task:lead' })
    expect(await setBoardProject(T, 'cause-a', { tasks: ['t3'], status: 'wip' }, { by: 'human' }))
      .toMatchObject({ status: 'wip', tasks: ['t3'] })
    const noStatus = await setBoardProject(T, 'cause-a', { status: '', tasks: [] }, { by: 'human' })
    expect(noStatus).toEqual({ title: 'Cache TTL', updated_at: expect.any(String), updated_by: 'human' })
    expect(await setBoardProject(T, 'cause-a', { title: null }, { by: 'human' })).toBeNull()
    expect((await getBoard(T))!.projects).toEqual({})
    await setBoardProject(T, 'p2', { status: 'done' }, { by: 'human' })
    expect(await setBoardProject(T, 'p2', { delete: true }, { by: 'human' })).toBeNull()
    expect((await getBoard(T))!.projects).toEqual({})
    expect(events.filter((e) => (e.data as { kind: string }).kind === 'project')).toHaveLength(7)
    // The html version never moves.
    expect((await getBoard(T))!.version).toBe(1)
  })

  it('bad status, long title, too many tasks, bad id, a 201st project; nothing written', async () => {
    expect(await boardError(() => setBoardProject(T, 'p', { status: 'blocked' }, { by: 'human' }))).toMatchObject({ code: 'bad_status', statusCode: 400 })
    expect(await boardError(() => setBoardProject(T, 'p', { title: 'x'.repeat(201) }, { by: 'human' }))).toMatchObject({ code: 'bad_request' })
    const tasks = Array.from({ length: BOARD_PROJECT_MAX_TASKS + 1 }, (_, i) => `t${i}`)
    expect(await boardError(() => setBoardProject(T, 'p', { tasks }, { by: 'human' }))).toMatchObject({ code: 'too_many', statusCode: 400 })
    expect(await setBoardProject(T, 'p', { tasks: tasks.slice(1) }, { by: 'human' })).toMatchObject({ tasks: tasks.slice(1) })
    expect(await boardError(() => setBoardProject(T, 'a/b', { title: 'x' }, { by: 'human' }))).toMatchObject({ code: 'bad_id' })
    expect(await boardError(() => setBoardProject('mt0abc12-none', 'p', { title: 'x' }, { by: 'human' }))).toMatchObject({ code: 'no_board' })

    const projects = Object.fromEntries(Array.from({ length: BOARD_MAX_PROJECTS }, (_, i) => [`p${i}`, { status: 'wip', updated_at: 'x', updated_by: 'human' }]))
    await writeRaw({ ...(await getBoard(T))!, projects })
    const before = await rawFile()
    expect(await boardError(() => setBoardProject(T, 'one-more', { status: 'wip' }, { by: 'human' }))).toMatchObject({ code: 'too_many' })
    expect(await rawFile()).toBe(before)
    // An existing one still updates at the cap.
    expect(await setBoardProject(T, 'p0', { status: 'done' }, { by: 'human' })).toMatchObject({ status: 'done' })
  })

  it('an id like `constructor` is just an id', async () => {
    expect(await setBoardProject(T, 'constructor', { status: 'wip' }, { by: 'human' })).toMatchObject({ status: 'wip' })
    expect(await setBoardProject(T, 'toString', { title: 'x' }, { by: 'human' })).toMatchObject({ title: 'x' })
  })

  it('records who set the status; a status the user picked stays theirs until a session overrides it', async () => {
    const lead = { by: 'task:lead' } as const
    const first = await writeBoardProject(T, 'cause-a', { title: 'Cache TTL', status: 'wip' }, lead)
    expect(first).toMatchObject({ previous: null, statusChanged: true, project: { status: 'wip', status_by: 'task:lead' } })
    const picked = await writeBoardProject(T, 'cause-a', { status: 'wait' }, { by: 'human' })
    expect(picked.statusChanged).toBe(true)
    expect(picked.previous).toMatchObject({ status: 'wip', status_by: 'task:lead' })
    expect(picked.project).toMatchObject({ status: 'wait', status_by: 'human', status_at: expect.any(String) })
    const pickedAt = picked.project!.status_at

    // A session that would change or remove it is refused, and nothing is written.
    const before = await rawFile()
    for (const input of [{ status: 'wip' }, { status: '' }, { delete: true }, { title: null, status: null, tasks: null }]) {
      expect(await boardError(() => setBoardProject(T, 'cause-a', input, lead)))
        .toMatchObject({ code: 'status_set_by_user', statusCode: 409, details: { project: 'cause-a', status: 'wait', status_at: pickedAt } })
    }
    expect(await rawFile()).toBe(before)
    expect((await boardError(() => setBoardProject(T, 'cause-a', { status: 'done' }, lead))).message)
      .toMatch(/^The user set project "cause-a" to wait \(Waiting on others\) at .+override_user: true/)

    // Title, tasks and the same status go through, and the pick stays the user's.
    const kept = await writeBoardProject(T, 'cause-a', { title: 'Cache TTL (prod)', tasks: ['t1'], status: 'wait' }, lead)
    expect(kept.statusChanged).toBe(false)
    expect(kept.project).toMatchObject({ title: 'Cache TTL (prod)', tasks: ['t1'], status: 'wait', status_by: 'human', status_at: pickedAt, updated_by: 'task:lead' })

    // Saying so replaces it; from then on the status is the session's again.
    expect(await setBoardProject(T, 'cause-a', { status: 'wip' }, { ...lead, overrideUser: true }))
      .toMatchObject({ status: 'wip', status_by: 'task:lead' })
    expect(await setBoardProject(T, 'cause-a', { status: 'done' }, lead)).toMatchObject({ status: 'done', status_by: 'task:lead' })
    // The user changes theirs at will; a cleared status forgets who set it.
    expect(await setBoardProject(T, 'cause-a', { status: 'decide' }, { by: 'human' })).toMatchObject({ status_by: 'human' })
    const cleared = await setBoardProject(T, 'cause-a', { status: '' }, { by: 'human' })
    expect(cleared).not.toHaveProperty('status_by')
    expect(cleared).not.toHaveProperty('status_at')
    expect(await setBoardProject(T, 'cause-a', { status: 'wip' }, lead)).toMatchObject({ status_by: 'task:lead' })
  })
})

describe('checks', () => {
  beforeEach(async () => { await setBoardHtml(T, PAGE, { by: 'human' }) })

  it('read with the current hash, idempotent; the states follow an edit; read false removes', async () => {
    const hash = checkHashes(PAGE)['fact-1']
    const first = await setBoardCheck(T, 'fact-1', { read: true, hash })
    expect(first).toEqual({ check: { hash, read_at: expect.any(String) }, hash })
    expect((await setBoardCheck(T, 'fact-1', { read: true, hash })).check).toEqual(first.check)
    let board = (await getBoard(T))!
    expect(boardCheckStates(board)).toEqual({
      'fact-1': { hash, read: true, read_at: first.check!.read_at },
      'fix-1': { hash: checkHashes(PAGE)['fix-1'], read: false },
    })
    board = await setBoardHtml(T, PAGE.replace('<b>5 min</b>', '<b>1 min</b>'), { by: 'task:lead' })
    const changed = boardCheckStates(board)['fact-1']
    expect(changed).toEqual({ hash: expect.any(String), read: false, read_at: first.check!.read_at, changed: true })
    const stale = await boardError(() => setBoardCheck(T, 'fact-1', { read: true, hash }))
    expect(stale).toMatchObject({ code: 'check_changed', statusCode: 409, details: { check: 'fact-1', hash: changed.hash } })
    expect(await setBoardCheck(T, 'fact-1', { read: false })).toEqual({ check: null, hash: changed.hash })
    expect((await getBoard(T))!.checks).toEqual({})
  })

  it('unknown id 404; missing hash 400; at the cap, ticks on points no longer on the page go first', async () => {
    expect(await boardError(() => setBoardCheck(T, 'nope', { read: true, hash: 'x' }))).toMatchObject({ code: 'check_not_found', statusCode: 404 })
    expect(await boardError(() => setBoardCheck(T, 'fact-1', { read: true }))).toMatchObject({ code: 'bad_request' })
    const stale = Object.fromEntries(Array.from({ length: BOARD_MAX_CHECKS }, (_, i) => [`gone-${i}`, { hash: 'h', read_at: 'x' }]))
    await writeRaw({ ...(await getBoard(T))!, checks: stale })
    await setBoardCheck(T, 'fix-1', { read: true, hash: checkHashes(PAGE)['fix-1'] })
    expect(Object.keys((await getBoard(T))!.checks)).toEqual(['fix-1'])

    const pageOf = (n: number) => Array.from({ length: n }, (_, i) => `<walnut-check id="c${i}">${i}</walnut-check>`).join('')
    const big = pageOf(BOARD_MAX_CHECKS + 1)
    const hashes = checkHashes(big)
    const full = Object.fromEntries(Array.from({ length: BOARD_MAX_CHECKS }, (_, i) => [`c${i}`, { hash: hashes[`c${i}`], read_at: 'x' }]))
    await writeRaw({ ...(await getBoard(T))!, html: big, checks: full })
    const last = `c${BOARD_MAX_CHECKS}`
    expect(await boardError(() => setBoardCheck(T, last, { read: true, hash: hashes[last] }))).toMatchObject({ code: 'too_many' })
  })
})

describe('choices', () => {
  beforeEach(async () => { await setBoardHtml(T, PAGE, { by: 'human' }) })

  it('stores the label; the same option again changes nothing and emits nothing; another changes; "" clears', async () => {
    const first = await setBoardChoice(T, 'when', { option: 'now' })
    expect(first).toMatchObject({ changed: true, choice: { option: 'now', label: 'Run it now' } })
    events = []
    const again = await setBoardChoice(T, 'when', { option: 'now' })
    expect(again).toMatchObject({ changed: false, choice: first.choice })
    expect(events).toEqual([])
    expect((await setBoardChoice(T, 'when', { option: 'wait' })).choice).toMatchObject({ option: 'wait', label: 'Wait for the deploy' })
    expect(await setBoardChoice(T, 'when', { option: '' })).toMatchObject({ changed: true, choice: null })
    expect((await getBoard(T))!.choices).toEqual({})
  })

  it('an option not on the element is 400 bad_option; a choice not on the page is 404', async () => {
    expect(await boardError(() => setBoardChoice(T, 'when', { option: 'later' })))
      .toMatchObject({ code: 'bad_option', statusCode: 400, details: { options: ['wait', 'now'] } })
    expect(await boardError(() => setBoardChoice(T, 'nope', { option: 'now' }))).toMatchObject({ code: 'choice_not_found', statusCode: 404 })
  })

  it('answering clears a DUE reminder on that choice in the same write; a pending one stays', async () => {
    const now = Date.now()
    await setBoardReminder(T, 'when', { at: new Date(now - 1_000).toISOString() }, { by: 'human', nowMs: now - 2_000 })
    await setBoardChoice(T, 'when', { option: 'now' })
    expect((await getBoard(T))!.reminders).toEqual({})
    await setBoardReminder(T, 'when', { at: new Date(now + HOUR).toISOString() }, { by: 'human' })
    await setBoardChoice(T, 'when', { option: 'wait' })
    expect((await getBoard(T))!.reminders).toHaveProperty('when')
  })
})

describe('reminders', () => {
  beforeEach(async () => { await setBoardHtml(T, PAGE, { by: 'human' }) })

  it('on a choice or a thread, in the future, at most 90 days out; replaced by a new one; cleared by null', async () => {
    const at = new Date(Date.now() + HOUR).toISOString()
    expect(await setBoardReminder(T, 'when', { at, note: ' after lunch ' }, { by: 'human' }))
      .toEqual({ at, set_at: expect.any(String), set_by: 'human', note: 'after lunch' })
    expect(await setBoardReminder(T, 'cause-a', { at }, { by: 'task:lead' })).toMatchObject({ set_by: 'task:lead' })
    expect(await setBoardReminder(T, 'when', { at: new Date(Date.now() + 2 * HOUR).toISOString() }, { by: 'human' })).not.toHaveProperty('note')
    expect(await setBoardReminder(T, 'when', { at: null }, { by: 'human' })).toBeNull()
    expect(Object.keys((await getBoard(T))!.reminders)).toEqual(['cause-a'])
    for (const bad of [new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 91 * 24 * HOUR).toISOString(), 'soon']) {
      expect(await boardError(() => setBoardReminder(T, 'when', { at: bad }, { by: 'human' })), bad).toMatchObject({ code: 'bad_time', statusCode: 400 })
    }
    expect(await boardError(() => setBoardReminder(T, 'fact-1', { at }, { by: 'human' }))).toMatchObject({ code: 'target_not_found', statusCode: 404 })
  })

  it('a reminder whose element left the page can still be cleared', async () => {
    await setBoardReminder(T, 'when', { at: new Date(Date.now() + HOUR).toISOString() }, { by: 'human' })
    await setBoardHtml(T, '<p>rebuilt</p>', { by: 'task:lead' })
    expect(await setBoardReminder(T, 'when', { at: null }, { by: 'human' })).toBeNull()
    expect(await boardError(() => setBoardReminder(T, 'when', { at: null }, { by: 'human' }))).toMatchObject({ code: 'target_not_found' })
  })

  it('the user posting in the thread clears a due one; a session posting does not; a pending one stays', async () => {
    const now = Date.now()
    await setBoardReminder(T, 'cause-a', { at: new Date(now - 1_000).toISOString() }, { by: 'human', nowMs: now - 2_000 })
    await postBoardMessage(T, 'cause-a', { author: 'task:lead', text: 'Noted' })
    expect((await getBoard(T))!.reminders).toHaveProperty('cause-a')
    await postBoardMessage(T, 'cause-a', { author: 'user', text: 'Done with it' })
    expect((await getBoard(T))!.reminders).toEqual({})
    await setBoardReminder(T, 'cause-a', { at: new Date(now + HOUR).toISOString() }, { by: 'human' })
    await postBoardMessage(T, 'cause-a', { author: 'user', text: 'Not yet' })
    expect((await getBoard(T))!.reminders).toHaveProperty('cause-a')
  })

  it('patchBoardReminder applies only to the reminder the clock read', async () => {
    const r = await setBoardReminder(T, 'when', { at: new Date(Date.now() + HOUR).toISOString() }, { by: 'human' })
    expect(await patchBoardReminder(T, 'when', 'some-other-set', { fired_at: 'x' })).toBeNull()
    expect(await patchBoardReminder(T, 'when', r!.set_at, { attempts: 1 })).toMatchObject({ attempts: 1 })
    expect(await patchBoardReminder('mt0abc12-none', 'when', r!.set_at, { attempts: 1 })).toBeNull()
  })
})

describe('sections seen', () => {
  beforeEach(async () => { await setBoardHtml(T, PAGE, { by: 'human' }) })

  it('stores the frame\'s hash, forgets on "", and drops the oldest past the cap', async () => {
    expect(await setBoardSectionSeen(T, 'cause-a', { hash: 'abc' })).toEqual({ hash: 'abc', at: expect.any(String) })
    expect(await setBoardSectionSeen(T, 'cause-a', { hash: '' })).toBeNull()
    expect((await getBoard(T))!.section_seen).toEqual({})
    expect(await boardError(() => setBoardSectionSeen(T, 'cause-a', { hash: 'h'.repeat(129) }))).toMatchObject({ code: 'bad_request' })
    expect(await boardError(() => setBoardSectionSeen(T, '-bad', { hash: 'h' }))).toMatchObject({ code: 'bad_id' })
    const seen = Object.fromEntries(Array.from({ length: BOARD_MAX_SECTION_SEEN }, (_, i) => [
      `s${i}`, { hash: 'h', at: new Date(Date.UTC(2026, 0, 1, 0, 0, i === 7 ? 0 : 10 + i)).toISOString() },
    ]))
    await writeRaw({ ...(await getBoard(T))!, section_seen: seen })
    await setBoardSectionSeen(T, 'fresh', { hash: 'h2' })
    const after = (await getBoard(T))!.section_seen
    expect(Object.keys(after)).toHaveLength(BOARD_MAX_SECTION_SEEN)
    expect(after).not.toHaveProperty('s7')
    expect(after).toHaveProperty('fresh')
  })
})
