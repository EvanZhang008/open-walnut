/**
 * The Org ops answer an agent small (src/ops/org-answer-shapes.ts over answer.ts): a write answers
 * a receipt, a list a page of short rows, and one thread is read compactly with thread_get.
 *
 * 2026-11-21: in seven days thread_update answered the whole thread it had just changed (159
 * answers over 10,000 characters, max 27,446, which the harness showed as a FAILED call), and
 * thread_list answered every open thread with every message (max 50K), so a VP saved it to a file
 * and read it with jq. Also: a split that took a thread's last open message closed the thread it
 * left without saying so, and a split then a merge took two calls each answering the whole thread.
 */
import { describe, expect, it } from 'vitest'
import { getOp } from '../../src/ops/index.js'
import { agentAnswer as answerOn, CONTENT_MAX_CHARS, RECEIPT_MAX_CHARS } from '../../src/ops/answer.js'
import { withOutcome } from '../../src/ops/outcome.js'
import * as model from '../../src/core/org/threads-model.js'
import { BRIEF_SECTION_LINES, briefReadAnswer, briefWriteAnswer, openItemsAnswer } from '../../src/ops/org-answer-shapes.js'
import { briefSectionsBlock } from '../../src/core/sessions/brief-structure.js'
import { holdsPageMark } from '../../src/ops/doc-page.js'
import { cutMark } from '../../src/ops/answer.js'

/** Each op's own shape under its own cap, as an MCP tool answers it (answer-policy.test.ts holds every op to the CLI's smaller cap too). */
const agentAnswer = (op: Parameters<typeof answerOn>[0], args: Record<string, unknown>, result: unknown, full = false): unknown => answerOn(op, args, result, full, 'mcp')

const size = (v: unknown): number => JSON.stringify(v).length
const at = (n: number) => new Date(Date.UTC(2026, 10, 14, 6, 0) + n * 60_000).toISOString()
const hex = (n: number, w = 6) => n.toString(16).padStart(w, '0')
const LONG = 'A line of what he asked, with the detail that goes on and on. '

/** A thread like the VP's: 40 messages, each with long words and a long answer, some answers repeated. */
function longThread(id = 'th-a0a0a0', n = 40): model.OrgThread {
  return {
    id, title: 'Release the bakery app', titled: true, state: 'answered', ask: 'Ship 2.1 this week',
    reply: 'Build 140 is uploaded; the review is waiting on the store.', replyAt: at(n + 1),
    tasks: ['t-build', 't-review'], createdAt: at(0), updatedAt: at(n + 1), by: 'task:vp-1',
    messages: Array.from({ length: n }, (_, i) => ({
      id: `tm-${hex(0x100000 + i)}`, at: at(i), via: 'chat' as const, text: `${i}: ${LONG.repeat(25)}`,
      // Every second answer is the same reply under two of his messages.
      answer: { text: `Answer ${Math.floor(i / 2)}: ${LONG.repeat(30)}`, at: at(i + 1) },
    })),
  }
}

async function run(name: string, args: Record<string, unknown>, routes: Record<string, unknown>) {
  const op = getOp(name)!
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const call = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body })
    if (path === '/me') return { task: { id: 'vp-1' } }
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k.split(' ')[1]) && method === k.split(' ')[0])
    if (!hit) throw new Error(`no route ${method} ${path}`)
    return typeof hit[1] === 'function' ? (hit[1] as (p: string, b: unknown) => unknown)(path, body) : hit[1]
  }
  const result = await op.handler!(args, call as never)
  return { op, result, calls, answer: agentAnswer(op, args, result) as Record<string, unknown> }
}

describe('a thread write answers a receipt, not the thread', () => {
  const thread = longThread()

  it('thread_update on a 40-message thread: under 2,000 characters, naming the id, state and count', async () => {
    const { result, answer } = await run('thread_update', { id: thread.id, state: 'answered', reply: 'Shipped.' }, { 'PATCH /tasks/vp-1/threads/': { task_id: 'vp-1', thread } })
    expect(size(result)).toBeGreaterThan(100_000)
    expect(size(answer)).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
    expect(answer.thread).toMatchObject({ id: thread.id, state: 'answered', messages: 40 })
    expect(answer.changed).toEqual(['state', 'reply'])
    expect(String(answer.outcome)).toContain(thread.id)
    expect(answer._cut).toBeUndefined()
  })

  it('merge_into answers about one line: the thread it went under and the one that is gone', async () => {
    const { answer } = await run('thread_update', { id: 'th-b0b0b0', merge_into: thread.id }, { 'PATCH /tasks/vp-1/threads/': { task_id: 'vp-1', thread, merged: 'th-b0b0b0' } })
    expect(size(answer)).toBeLessThan(600)
    expect(answer).toMatchObject({ merged: 'th-b0b0b0', thread: { id: thread.id, messages: 40 } })
    expect(String(answer.outcome)).toBe(`Thread th-b0b0b0 is now under ${thread.id} "${thread.title}" (40 messages).`)
  })

  it('thread_create, thread_file and thread_move answer receipts too', async () => {
    const created = await run('thread_create', { title: 'Pick a supplier', text: 'Two quotes.', from: 'node', state: 'answered' }, { 'POST /tasks/vp-1/threads/open': { task_id: 'vp-1', thread } })
    expect(size(created.answer)).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
    expect(created.answer.thread).toMatchObject({ id: thread.id })
    const filed = await run('thread_file', { text: 'his words', thread: thread.id }, { 'POST /tasks/vp-1/threads': { task_id: 'vp-1', thread, message: thread.messages[39], created: false } })
    expect(size(filed.answer)).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
    expect(filed.answer).toMatchObject({ message_id: thread.messages[39].id, created: false })
    const moved = await run('thread_move', { id: thread.id, to: 'Main' }, { 'POST /tasks/vp-1/threads/': { task_id: 'vp-1', thread, moved_to: { task: 'main-1', title: 'Main' } } })
    expect(size(moved.answer)).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
    expect(moved.answer.moved_to).toEqual({ task: 'main-1', title: 'Main' })
  })

  it('"_full": true still gives the whole thread (executor: full skips the shape)', () => {
    const op = getOp('thread_update')!
    const result = withOutcome({ task_id: 'vp-1', thread }, 'x', 'y')
    expect(agentAnswer(op, {}, result, true)).toBe(result)
  })
})

describe('thread_list pages short rows; thread_get reads one thread', () => {
  const threads = Array.from({ length: 60 }, (_, i) => longThread(`th-${hex(0xc00000 + i)}`, 8))
  const list = (path: string) => ({ task_id: 'vp-1', title: 'Bakery VP', threads: path.includes('open=1') ? threads : [...threads, { ...longThread('th-dead00', 3), closed: { how: 'acked', at: at(9), by: 'human' } }], closed_count: 1, shown_count: 12 })

  it('the default answer for 60 threads fits its cap, says the page and names the next one', async () => {
    const { result, answer, calls } = await run('thread_list', {}, { 'GET /tasks/vp-1/threads': list })
    expect(calls.at(-1)!.path).toBe('/tasks/vp-1/threads?open=1')
    expect(size(result)).toBeGreaterThan(200_000)
    expect(size(answer)).toBeLessThanOrEqual(CONTENT_MAX_CHARS)
    // As many of the first 20 as fit, and the next page starts right after them (none skipped).
    const shown = (answer.threads as unknown[]).length
    expect(shown).toBeGreaterThanOrEqual(10)
    expect(shown).toBeLessThanOrEqual(20)
    expect(answer.page).toEqual({ offset: 0, shown, total: 60, next_offset: shown })
    expect(String(answer.next)).toContain(`thread_list {"offset":${shown}}`)
    const row = (answer.threads as Array<Record<string, unknown>>)[0]
    expect(row).toMatchObject({ id: 'th-c00000', state: 'answered', messages: 8, unanswered: 0 })
    expect(row.messages_shown).toBeUndefined()
    expect(answer._cut).toBeUndefined()
  })

  it('offset and limit page in the handler; the next page follows', async () => {
    const { answer } = await run('thread_list', { offset: 40, limit: 20 }, { 'GET /tasks/vp-1/threads': list })
    const page = answer.page as { offset: number; shown: number; total: number; next_offset?: number }
    expect(page).toMatchObject({ offset: 40, total: 60 })
    expect(page.next_offset).toBe(page.shown === 20 ? undefined : 40 + page.shown)
    expect((answer.threads as Array<{ id: string }>)[0].id).toBe('th-c00028')
    expect(size(answer)).toBeLessThanOrEqual(CONTENT_MAX_CHARS)
  })

  it('ids reads a closed thread too (so a reopen can be checked), and names an id that is not there', async () => {
    const { answer, calls } = await run('thread_list', { ids: ['th-dead00', 'th-ffffff'] }, { 'GET /tasks/vp-1/threads': list })
    expect(calls.at(-1)!.path).toBe('/tasks/vp-1/threads')
    expect(answer.threads).toEqual([expect.objectContaining({ id: 'th-dead00', state: 'closed', closed: 'acked' })])
    expect(answer.missing).toEqual(['th-ffffff'])
    const closed = await run('thread_list', { state: 'closed' }, { 'GET /tasks/vp-1/threads': list })
    expect((closed.answer.threads as unknown[]).length).toBe(1)
  })

  it('a call with none of the new arguments keeps its old answer for server code', async () => {
    const { result } = await run('thread_list', {}, { 'GET /tasks/vp-1/threads': list })
    expect((result as { threads: unknown[] }).threads).toHaveLength(60)
    expect((result as { page?: unknown }).page).toBeUndefined()
  })

  it('thread_get: the head, the newest 10 messages cut, a repeated answer named once, one message whole', async () => {
    const thread = longThread()
    const routes = { 'GET /tasks/vp-1/threads/': { task_id: 'vp-1', thread } }
    const { answer } = await run('thread_get', { id: thread.id }, routes)
    expect(size(answer)).toBeLessThanOrEqual(CONTENT_MAX_CHARS)
    const t = answer.thread as Record<string, unknown>
    expect(t).toMatchObject({ id: thread.id, state: 'answered', messages: 40, earlier_messages: 30, reply: thread.reply })
    const shown = t.messages_shown as Array<{ id: string; text: string; chars?: number; answer?: { same_as?: string; text?: string } }>
    expect(shown.map((m) => m.id)).toEqual(thread.messages.slice(30).map((m) => m.id))
    expect(shown[0].text.length).toBeLessThanOrEqual(601)
    expect(shown[0].chars).toBe(thread.messages[30].text.length)
    expect(shown[1].answer).toEqual({ same_as: thread.messages[30].id, at: thread.messages[31].answer!.at })
    expect(String(answer.next)).toContain(`thread_get {"id":"${thread.id}","limit":40}`)
    const one = await run('thread_get', { id: thread.id, message: thread.messages[5].id }, routes)
    const whole = (one.answer.thread as { messages_shown: Array<{ text: string }> }).messages_shown
    expect(whole).toHaveLength(1)
    expect(whole[0].text).toBe(thread.messages[5].text)
    await expect(run('thread_get', { id: thread.id, message: 'tm-999999' }, routes)).rejects.toThrow(/No message tm-999999/)
  })
})

describe('thread_split says when it closed the thread it left, and can move straight into another', () => {
  const by = 'task:lead' as const
  /** He reacted to the answer, then asked about another subject in the same thread. */
  const reacted = () => {
    const base: model.ThreadsFile = { version: 1, taskId: 'lead', threads: [{
      id: 'th-aaaaaa', title: 'Thread explanation', state: 'answered', reply: 'The explanation.', replyAt: at(2), createdAt: at(0), updatedAt: at(2), by,
      messages: [{ id: 'tm-aaaaaa', at: at(0), text: 'Explain threads?', via: 'chat', answer: { text: 'The explanation.', at: at(2) } }],
    }, {
      id: 'th-cccccc', title: 'The other subject', state: 'working', createdAt: at(1), updatedAt: at(1), by,
      messages: [{ id: 'tm-cccccc', at: at(1), text: 'The other subject', via: 'chat' }],
    }] }
    return model.fileMessage(base, { threadId: 'th-aaaaaa', text: 'Another subject?', via: 'follow-up', at: at(3), messageId: 'tm-bbbbbb' })
  }

  it('a split that leaves nothing open closes the source, says so, and keep_open keeps it open', () => {
    const r = reacted()
    const closing = model.splitThreadMessage(r.file, 'th-aaaaaa', 'tm-bbbbbb', by, at(4))
    expect(closing.closedFrom).toBe(true)
    expect(closing.from.closed).toMatchObject({ how: 'acked' })
    const kept = model.splitThreadMessage(r.file, 'th-aaaaaa', 'tm-bbbbbb', by, at(4), undefined, 'en', { keepOpen: true })
    expect(kept.closedFrom).toBe(false)
    expect(kept.from.closed).toBeUndefined()
    expect(kept.thread.messages.map((m) => m.id)).toEqual(['tm-bbbbbb'])
  })

  it('merge_into moves the message into the open thread in one write, and refuses without changing anything', () => {
    const r = reacted()
    const out = model.splitMessageInto(r.file, 'th-aaaaaa', 'tm-bbbbbb', 'th-cccccc', by, at(4))
    expect(out.thread.id).toBe('th-cccccc')
    expect(out.thread.messages.map((m) => m.id)).toEqual(['tm-cccccc', 'tm-bbbbbb'])
    expect(out.file.threads.map((t) => t.id).sort()).toEqual(['th-aaaaaa', 'th-cccccc'])
    expect(out.closedFrom).toBe(true)
    expect(() => model.splitMessageInto(r.file, 'th-aaaaaa', 'tm-bbbbbb', 'th-aaaaaa', by, at(4))).toThrow(/already in th-aaaaaa/)
    const closedTarget = { ...r.file, threads: r.file.threads.map((t) => (t.id === 'th-cccccc' ? { ...t, closed: { how: 'dropped' as const, at: at(4), by: 'human' as const } } : t)) }
    expect(() => model.splitMessageInto(closedTarget, 'th-aaaaaa', 'tm-bbbbbb', 'th-cccccc', by, at(5))).toThrow(model.ThreadError)
  })

  it('the op\'s receipt says the source CLOSED and how to keep or reopen it; merge_into rides in one call', async () => {
    const thread = longThread('th-e0e0e0', 1)
    const from = { ...longThread('th-a0a0a0', 39), closed: { how: 'acked', at: at(50), by: 'task:vp-1' } }
    const split = await run('thread_split', { id: 'th-a0a0a0', message: 'tm-100027' }, { 'POST /tasks/vp-1/threads/': { task_id: 'vp-1', thread, from, from_closed: true } })
    expect(size(split.answer)).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
    expect(split.answer).toMatchObject({ from_closed: true, thread: { id: 'th-e0e0e0' }, from: { id: 'th-a0a0a0', state: 'closed', closed: 'acked', messages: 39 } })
    expect(String(split.answer.outcome)).toMatch(/th-a0a0a0 "Release the bakery app" CLOSED with it/)
    expect(String(split.answer.outcome)).toContain('thread_update {"id":"th-a0a0a0","reopen":true}')
    expect(String(split.answer.outcome)).toContain('keep_open: true')
    const target = longThread('th-c0c0c0', 41)
    const merged = await run('thread_split', { id: 'th-a0a0a0', message: 'tm-100027', merge_into: 'th-c0c0c0', keep_open: true }, { 'POST /tasks/vp-1/threads/': { task_id: 'vp-1', thread: target, from: longThread('th-a0a0a0', 39), merged_into: 'th-c0c0c0' } })
    expect(merged.calls.at(-1)!.body).toEqual({ message: 'tm-100027', merge_into: 'th-c0c0c0', keep_open: true })
    expect(String(merged.answer.outcome)).toContain('Moved tm-100027 into th-c0c0c0')
    expect(size(merged.answer)).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
  })
})

describe('a thread refusal says the call that goes through', () => {
  it('merge_into with other keys: refused before any write, naming the two calls', async () => {
    const r = run('thread_update', { id: 'th-a0a0a0', merge_into: 'th-c0c0c0', state: 'working' }, {})
    await expect(r).rejects.toThrow('Two calls: thread_update {"id":"th-a0a0a0","merge_into":"th-c0c0c0"}, then thread_update {"id":"th-c0c0c0","state":"working"}.')
  })

  it('needs without user_kind: the caller\'s call with the keys it lacks', async () => {
    const refusal = Object.assign(new Error('Not handed to the user: a question reaches the user only when it is theirs. Name which kind it is with user_kind (one of: spending (x)) and user_kind_why.'), { status: 409, code: 'user_kind' })
    const r = run('thread_update', { id: 'th-a0a0a0', state: 'needs', reply: 'Pick one.' }, { 'PATCH /tasks/vp-1/threads/': () => { throw refusal } })
    await expect(r).rejects.toThrow(/The call that goes through: thread_update \{"id":"th-a0a0a0","state":"needs","reply":"Pick one.","user_kind":"<one of [^>]+>","user_kind_why":"<one line/)
  })

  it('a needs write that lists choices with no options: the call with options', async () => {
    const refusal = Object.assign(new Error('This thread asks him to pick among choices with no options.'), { status: 409, code: 'needs_options' })
    const r = run('thread_create', { title: 'Pick', text: 'A: one, B: two', from: 'node' }, { 'POST /tasks/vp-1/threads/open': () => { throw refusal } })
    await expect(r).rejects.toThrow(/thread_create \{"title":"Pick","text":"A: one, B: two","from":"node","options":\[\{"label":"<your pick>","recommended":true\}/)
  })

  it('a split of a thread\'s only message into another: the merge call instead', async () => {
    const refusal = Object.assign(new Error('A thread keeps at least one message; this one is already its own thread.'), { status: 409, code: 'last_message' })
    const r = run('thread_split', { id: 'th-a0a0a0', message: 'tm-100000', merge_into: 'th-c0c0c0' }, { 'POST /tasks/vp-1/threads/': () => { throw refusal } })
    await expect(r).rejects.toThrow('thread_update {"id":"th-a0a0a0","merge_into":"th-c0c0c0"}')
  })

  it('any other bad input lists the keys the op takes', async () => {
    const refusal = Object.assign(new Error('snooze: not a time.'), { status: 400, code: 'bad_input' })
    const r = run('thread_update', { id: 'th-a0a0a0', snooze: 'later' }, { 'PATCH /tasks/vp-1/threads/': () => { throw refusal } })
    await expect(r).rejects.toThrow(/thread_update takes: id, title, ask, state, .*merge_into, task\./)
  })
})

describe('the other Org reads page and the writes answer receipts', () => {
  it('human_inbox_list: 60 letters with long options answer a page of short rows', async () => {
    const letters = Array.from({ length: 60 }, (_, i) => ({
      id: `lt-${i}`, subject: `Decide ${i} ${LONG.repeat(4)}`, type: 'action_required', textPreview: LONG.repeat(10), createdAt: Date.UTC(2026, 10, 1) + i,
      sender: { taskId: `t-${i}`, taskTitle: 'A task with a long title '.repeat(3) }, read: false, thread: [{}, {}],
      actions: [{ id: 'a', label: 'Yes', detail: LONG.repeat(5) }, { id: 'b', label: 'No', detail: LONG.repeat(5) }],
    }))
    const { result, answer } = await run('human_inbox_list', {}, { 'GET /human-inbox': { letters, unreadCount: 60 } })
    expect(size(result)).toBeGreaterThan(CONTENT_MAX_CHARS)
    expect(size(answer)).toBeLessThanOrEqual(CONTENT_MAX_CHARS)
    const shown = (answer.letters as unknown[]).length
    expect(shown).toBeGreaterThanOrEqual(8)
    expect(answer.page).toMatchObject({ offset: 0, shown, total: 60, next_offset: shown })
    expect((answer.letters as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'lt-0', actions: 2, turns: 2 })
    const second = await run('human_inbox_list', { offset: 20, limit: 20 }, { 'GET /human-inbox': { letters, unreadCount: 60 } })
    expect((second.answer.letters as Array<{ id: string }>)[0].id).toBe('lt-20')
  })

  it('board_get parts html: exact windows of the page, marked as a part, without the version, the next one named', async () => {
    const html = `<h1>Plan</h1>${'<p class="x">A paragraph of the board.</p>\n'.repeat(600)}`
    const board = { board_task_id: 'lead01', board_version: 4, board: { html, version: 4 }, threads: {} }
    const call = async (_m: string, path: string) => (path.endsWith('/board') ? board : { task_id: 'lead01', self: true })
    const op = getOp('board_get')!
    const args = { task: 'lead01', parts: ['html'] }
    const first = agentAnswer(op, args, await op.handler!(args, call as never)) as Record<string, unknown>
    expect(size(first)).toBeLessThanOrEqual(CONTENT_MAX_CHARS)
    const w = first.html_window as { from: number; chars: number; total: number; next_from: number }
    expect(w).toMatchObject({ from: 0, total: html.length })
    const got = (first.board as { html: string }).html
    // The part is exact text a board_edit can quote; the mark comes after it, never inside it.
    expect(got.slice(0, w.chars)).toBe(html.slice(0, w.chars))
    expect(got.slice(w.chars)).toMatch(/^\n\n\[Walnut: this is part of a longer document: characters 0 to \d+ of \d+/)
    expect(holdsPageMark(got)).toBe(true)
    // A partial read hands no version to a write.
    expect(first.board_version).toBeUndefined()
    expect((first.board as { version?: number }).version).toBeUndefined()
    expect(String(first.next)).toContain(`"html_from":${w.next_from}`)
    const args2 = { ...args, html_from: w.next_from }
    const second = agentAnswer(op, args2, await op.handler!(args2, call as never)) as Record<string, unknown>
    const w2 = second.html_window as { chars: number }
    expect((second.board as { html: string }).html.slice(0, w2.chars)).toBe(html.slice(w.next_from, w.next_from + w2.chars))
    // A board too big for the default read answers a summary with no version either.
    const summary = agentAnswer(op, { task: 'lead01' }, await op.handler!({ task: 'lead01' }, call as never)) as Record<string, any>
    expect(summary.board_version).toBeUndefined()
    expect(summary.summary.page.version).toBeUndefined()
    // board_set refuses a window written back whole, for every caller.
    const set = getOp('board_set')!
    await expect(set.handler!({ task: 'lead01', html: got }, call as never)).rejects.toThrow(/board_set refused: this html is one part of the page/)
  })

  it('board_edit answers the version and size, not the html', () => {
    const op = getOp('board_edit')!
    const answer = agentAnswer(op, {}, withOutcome({ task_id: 'lead01', board: { html: 'x'.repeat(40_000), version: 7, updated_by: 'task:lead01' } }, 'Updated.', 'Next.')) as Record<string, unknown>
    expect(answer.board).toEqual({ version: 7, updated_by: 'task:lead01', html_chars: 40_000 })
    expect(size(answer)).toBeLessThan(400)
  })

  it('org_get pages its rows, each with only the counts that are not zero', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ id: `t-${i}`, title: `Team ${i}`, kind: 'team', project: 'Bakery', open: i % 3, running: 0, needs_you: 0, to_read: 0, waiting: 1 }))
    const { answer } = await run('org_get', {}, { 'GET /org/reports': { of: 'vp-1', rows } })
    expect(size(answer)).toBeLessThanOrEqual(CONTENT_MAX_CHARS)
    expect(answer.page).toMatchObject({ total: 150, shown: 30, next_offset: 30 })
    expect((answer.rows as unknown[])[0]).toEqual({ id: 't-0', title: 'Team 0', kind: 'team', waiting: 1 })
  })

  it('topic_read shows the newest messages cut; topic_post answers its message id', async () => {
    const messages = Array.from({ length: 80 }, (_, i) => ({ id: `tpm-${hex(i, 12)}`, at: at(i), author: 'mb-00000001', text: LONG.repeat(40), mentions: [], via: 'agent' }))
    const topic = { id: 'tp-000000000001', title: 'Launch', members: [{ id: 'mb-00000001', name: 'Lead', ref: { kind: 'task' }, role: 'host', status: 'active' }], messages }
    const { answer } = await run('topic_read', { id: topic.id }, { 'GET /api/topics/': { topic } })
    expect(size(answer)).toBeLessThanOrEqual(CONTENT_MAX_CHARS)
    const t = answer.topic as { messages: Array<{ id: string }>; earlier_messages: number }
    expect(t.messages.at(-1)!.id).toBe(messages[79].id)
    expect(t.earlier_messages).toBeGreaterThan(0)
    const post = agentAnswer(getOp('topic_post')!, {}, withOutcome({ message: { ...messages[0] }, delivery: { wake: [], fold: [], mail: [], refused: [] } }, 'Posted.', 'Next.')) as Record<string, unknown>
    expect(post.message).toEqual({ id: messages[0].id, at: messages[0].at })
  })
})

describe('the Brief reads compact and writes a receipt (shapes for ops/tasks.ts)', () => {
  const line = (i: number) => `- <task-ref id="t-${i}" label="A task with a long title number ${i}"/>: ${LONG.repeat(2)}`
  const sections = { needs: Array.from({ length: 30 }, (_, i) => line(i)), working: Array.from({ length: 4 }, (_, i) => line(100 + i)), waiting: [] as string[] }
  const text = `### Needs you\n${sections.needs.slice(0, 8).join('\n')}\n### Working\n- none\n### Waiting\n- none`
  const full = withOutcome({
    task_id: 'vp-1', title: 'Bakery VP', brief: { text, at: at(1), text_sources: Array.from({ length: 12 }, () => ({ by: 'task:vp-1', from: 0, to: 10 })) },
    chars: text.length, limit: 4000, fresh: { stale: true, words: '3 moved', moved: Array.from({ length: 40 }, (_, i) => ({ id: `t-${i}` })), finished: [] },
    sections, rules: `How to write it.\n${briefSectionsBlock(sections)}\nThe end of the rules.`,
  }, 'Brief of "Bakery VP".', 'Update it.')

  it('the letter whole, each list cut with its count, the rules without their copy of the lists', () => {
    const a = briefReadAnswer(full, {}) as Record<string, any>
    expect(size(full)).toBeGreaterThan(size(a) * 2)
    expect(a.brief.text).toBe(text)
    expect(a.brief.text_sources).toBe(12)
    expect(a.sections.needs).toHaveLength(BRIEF_SECTION_LINES)
    expect(a.sections_more).toEqual({ needs: 30 - BRIEF_SECTION_LINES })
    expect(a.rules).not.toContain(sections.needs[0])
    expect(a.rules).toContain('The end of the rules.')
    expect(a.fresh.moved).toHaveLength(15)
    expect(a.next).toContain('brief_read {"section":"needs"}')
    expect((briefReadAnswer(full, { section: 'needs' }) as Record<string, any>).sections.needs).toHaveLength(30)
    // A compact read is short already: as it is.
    const compact = { compact: true, brief: { at: at(1), chars: 10 } }
    expect(briefReadAnswer(compact, {})).toBe(compact)
  })

  it('brief_write answers its size and the lines to fix, never the letter', () => {
    const a = briefWriteAnswer(withOutcome({ task_id: 'vp-1', brief: { text, at: at(2) }, issues: ['- names no task: x'], chars: text.length, own_chars: 900, limit: 4000 }, 'Written.', 'Fix 1 line.')) as Record<string, unknown>
    expect(a).toMatchObject({ task_id: 'vp-1', chars: text.length, own_chars: 900, limit: 4000, brief: { at: at(2) }, issues: ['- names no task: x'] })
    expect(JSON.stringify(a)).not.toContain('Needs you')
  })

  it('open_items keeps the first rows of each list; a hook\'s answer passes as it is', () => {
    const open = { subtasks: Array.from({ length: 40 }, (_, i) => ({ id: `t-${i}` })), owedUser: [] }
    const a = openItemsAnswer(open, {}) as Record<string, unknown[]>
    expect(a.subtasks).toHaveLength(15)
    expect(a.subtasks_more).toBe(25)
    const hook = { hookSpecificOutput: { additionalContext: 'x'.repeat(30_000) } }
    expect(openItemsAnswer(hook, { hook: 'compact' })).toBe(hook)
  })
})

describe('a whole read stays whole, and a cut text says so', () => {
  const brief = (letter: string, lines = 60) => {
    const row = (i: number) => `- <task-ref id="t-${i}" label="Task ${i}"/>: ${LONG.repeat(3)}`
    const sections = { needs: Array.from({ length: lines }, (_, i) => row(i)), working: Array.from({ length: lines }, (_, i) => row(500 + i)), waiting: [] as string[] }
    return withOutcome({ task_id: 'vp-1', title: 'Bakery VP', brief: { text: letter, at: at(1) }, sections, rules: `${LONG.repeat(80)}\n${briefSectionsBlock(sections)}` }, 'Brief.', 'Update it.')
  }

  it('brief_read answers a 7,809 and a 16,000 character letter whole, cutting the rules and the lists instead', () => {
    const op = getOp('brief_read')!
    for (const n of [7_809, 16_000]) {
      const letter = `### Needs you\n${'x'.repeat(n - 14)}`
      const a = agentAnswer(op, {}, brief(letter)) as Record<string, any>
      expect(a.brief.text, `${n}`).toBe(letter)
      expect(a._cut, `${n}`).toBeUndefined()
      expect(size(a)).toBeLessThanOrEqual(24_000)
    }
    // A letter that cannot fit even alone: cut, marked, and the call that reads it whole named.
    const huge = agentAnswer(op, {}, brief('y'.repeat(30_000))) as Record<string, any>
    expect(huge.brief.text).toMatch(/… \[Walnut cut: \d+ more characters\]$/)
    expect(huge.next).toContain('brief_read {"_full":true}')
  })

  it('thread_get message: a 16,000 character answer whole, never same_as; his long words and a long answer in two reads', async () => {
    const t = longThread('th-a0a0a0', 4)
    t.messages[1].answer = { text: t.messages[0].answer!.text, at: at(9) }
    t.messages[3].answer = { text: 'z'.repeat(16_000), at: at(9) }
    const routes = { 'GET /tasks/vp-1/threads/': { task_id: 'vp-1', thread: t } }
    const same = await run('thread_get', { id: t.id, message: t.messages[1].id }, routes)
    expect((same.answer.thread as any).messages_shown[0].answer.text).toBe(t.messages[0].answer!.text)
    const big = await run('thread_get', { id: t.id, message: t.messages[3].id }, routes)
    expect((big.answer.thread as any).messages_shown[0].answer.text).toBe('z'.repeat(16_000))
    expect(big.answer._cut).toBeUndefined()
    t.messages[2] = { ...t.messages[2], text: 'w'.repeat(8_000), answer: { text: 'v'.repeat(16_000), at: at(9) } }
    const both = await run('thread_get', { id: t.id, message: t.messages[2].id }, routes)
    const shown = (both.answer.thread as any).messages_shown[0]
    expect(shown.text).toBe('w'.repeat(8_000))
    expect(shown.answer).toBeUndefined()
    expect(shown.answer_chars).toBe(16_000)
    expect(String(both.answer.next)).toContain(`"part":"answer"`)
    const answerOnly = await run('thread_get', { id: t.id, message: t.messages[2].id, part: 'answer' }, routes)
    expect((answerOnly.answer.thread as any).messages_shown[0].answer.text).toBe('v'.repeat(16_000))
  })

  it('a text a shape shortens ends with the cut mark', async () => {
    const { answer } = await run('thread_get', { id: 'th-a0a0a0' }, { 'GET /tasks/vp-1/threads/': { task_id: 'vp-1', thread: longThread() } })
    const m = (answer.thread as any).messages_shown[0] as { text: string; chars: number }
    const hit = /^([\s\S]*)… \[Walnut cut: (\d+) more characters\]$/.exec(m.text)!
    expect(hit).not.toBeNull()
    // What is shown and what the mark counts add up to the whole (the cut trims a trailing space).
    expect(Number(hit[2])).toBeGreaterThan(0)
    expect(hit[1].length + Number(hit[2])).toBeLessThanOrEqual(m.chars)
    expect(m.text.endsWith(cutMark(Number(hit[2])))).toBe(true)
  })
})

describe('thread_split states only what the server answered', () => {
  it('a server older than merge_into made a new thread: the receipt says so and gives the call that finishes it', async () => {
    const fresh = longThread('th-e0e0e0', 1)
    const { answer } = await run('thread_split', { id: 'th-a0a0a0', message: 'tm-100000', merge_into: 'th-c0c0c0', keep_open: true }, {
      'POST /tasks/vp-1/threads/': { task_id: 'vp-1', thread: fresh, from: { ...longThread('th-a0a0a0', 3), closed: { how: 'acked', at: at(5), by: 'task:vp-1' } } },
    })
    expect(answer.not_applied).toEqual(['merge_into', 'keep_open'])
    expect(answer.from_closed).toBeUndefined()
    expect(answer.merged_into).toBeUndefined()
    expect(String(answer.outcome)).toContain('did not apply merge_into')
    expect(String(answer.outcome)).toContain('NEW thread th-e0e0e0')
    expect(String(answer.outcome)).toContain('keep_open was not applied')
    expect(String(answer.next)).toBe('thread_update {"id":"th-e0e0e0","merge_into":"th-c0c0c0"}')
  })

  it('a corrected refusal is a new error of the same kind; the original keeps its words', async () => {
    class CallError extends Error { constructor(message: string, readonly status: number, readonly code: string, readonly lost: boolean) { super(message) } }
    const refusal = new CallError('A thread keeps at least one message.', 409, 'last_message', false)
    const r = run('thread_split', { id: 'th-a0a0a0', message: 'tm-100000', merge_into: 'th-c0c0c0' }, { 'POST /tasks/vp-1/threads/': () => { throw refusal } })
    const err = await r.catch((e: unknown) => e) as CallError
    expect(err).not.toBe(refusal)
    expect(err).toBeInstanceOf(CallError)
    expect(err).toMatchObject({ status: 409, code: 'last_message', lost: false })
    expect(err.message).toContain('thread_update {"id":"th-a0a0a0","merge_into":"th-c0c0c0"}')
    expect(refusal.message).toBe('A thread keeps at least one message.')
  })

  it('human_inbox_reply keeps the server\'s next when it gives one', () => {
    const op = getOp('human_inbox_reply')!
    const a = agentAnswer(op, { letter: 'lt-1' }, { letter: { id: 'lt-1', subject: 'S', thread: [{}, {}], body: 'x'.repeat(9_000) }, next: 'The server says this.' }) as Record<string, unknown>
    expect(a.next).toBe('The server says this.')
    expect(a.letter).toEqual({ id: 'lt-1', subject: 'S', turns: 2 })
  })
})
