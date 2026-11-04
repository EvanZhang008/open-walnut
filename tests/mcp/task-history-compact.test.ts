/**
 * task_history's short reads (src/ops/task-history-shape.ts, src/ops/work.ts). 2026-11-02: Main's
 * daily reflection read one task's history as about 90,000 characters, over its tool output
 * ceiling, and had to grep the saved file. `compact` folds tool calls and thinking to one line,
 * `limit` keeps the newest N messages, `since` only what came after a time; the default answer
 * stays the route's own.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../src/ops/index.js'
import { shapeHistory, COMPACT_LINE_MAX } from '../../src/ops/task-history-shape.js'

type Row = Record<string, unknown>
type Call = (method: string, path: string) => Promise<unknown>

const pad = (label: string, n: number) => `${label} ${'x'.repeat(Math.max(0, n - label.length - 1))}`
const at = (i: number) => new Date(Date.UTC(2026, 10, 3, 8, 0, i)).toISOString()

/**
 * A busy task's page as the route answers it (TRANSCRIPT_TAIL, 100 rows), shaped like a real lead's
 * conversation but heavier: per turn one person message, two Walnut notices, four tool calls with
 * long results, two thinking blocks, one reply.
 */
function bigPage(turns = 10, from = 0): Row[] {
  const rows: Row[] = []
  for (let t = 0; t < turns; t++) {
    rows.push({ role: 'user', sentBy: 'person', text: pad(`person ask ${t}`, 300), timestamp: at(from + t * 10) })
    for (let n = 0; n < 2; n++) {
      rows.push({
        role: 'user', sentBy: 'agent', timestamp: at(from + t * 10 + 1 + n),
        text: `<walnut-message kind="notification" from="Walnut" about="Some subtask title" about-session="9414f38e-e53a-4d2f-bdf1-0acc15019eea" about-task="8d26aaf4-4541-5992-afe5-15113b67e4d6" outcome="waiting" note="automated Walnut status notice">\n${pad('Your subtask set itself to WAITING', 2500)}\n</walnut-message>`,
      })
    }
    for (let n = 0; n < 2; n++) rows.push({ role: 'assistant', kind: 'thinking', text: pad(`thinking ${t}.${n}`, 1500), timestamp: at(from + t * 10 + 3) })
    for (let n = 0; n < 4; n++) {
      rows.push({ role: 'assistant', kind: 'tool', text: 'Bash', detail: pad(`step ${t}.${n}`, 80), resultPreview: pad('{"result"', 2000), timestamp: at(from + t * 10 + 3) })
    }
    rows.push({ role: 'assistant', text: pad(`reply ${t}`, 1200), timestamp: at(from + t * 10 + 4), about: ['e19223d8-72c5-57dc-ac72-d5f17351c0db'], aboutTagged: true })
  }
  return rows
}

function fakeCall(paths: string[], pages: Record<string, Record<string, unknown>>, sessions = [{ session_id: 's-1', engine: 'claude', active: true }]): Call {
  return async (_method, path) => {
    paths.push(path)
    if (path.startsWith('/tasks/t-1/sessions')) return { sessions }
    if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: sessions.at(-1)!.session_id } }
    const sid = path.split('/')[2]
    return (path.includes('before=') && pages[`${sid}:before`]) || pages[sid]
  }
}

const op = () => getOp('task_history')!
const run = (input: Record<string, unknown>, call: Call) =>
  (op().handler as (i: Record<string, unknown>, c: Call) => Promise<Record<string, unknown>>)(input, call)
const size = (v: unknown) => JSON.stringify(v, null, 2).length

describe('task_history short reads', () => {
  it('a big task in the compact form stays under 50,000 characters, a third of the full read', async () => {
    const page = { version: 1, sessionId: 's-1', truncated: true, messages: bigPage() }
    const full = await run({ id: 't-1' }, fakeCall([], { 's-1': page }))
    const compact = await run({ id: 't-1', compact: true }, fakeCall([], { 's-1': page }))
    expect(size(full)).toBeGreaterThan(150_000)
    expect(size(compact)).toBeLessThan(50_000)
    expect(size(compact) * 3).toBeLessThan(size(full))
    const short = await run({ id: 't-1', compact: true, limit: 3 }, fakeCall([], { 's-1': page }))
    expect(size(short)).toBeLessThan(12_000)
  })

  it('compact keeps every message, folds each tool call and thinking block to one line, and totals what it left out', async () => {
    const page = { truncated: false, messages: bigPage(2) }
    const out = await run({ id: 't-1', compact: true }, fakeCall([], { 's-1': page }))
    const rows = out.messages as Row[]
    expect(rows).toHaveLength(page.messages.length)
    for (const r of rows.filter((r) => r.kind)) {
      expect(String(r.text).length).toBeLessThanOrEqual(COMPACT_LINE_MAX)
      expect(String(r.text)).not.toContain('\n')
      expect(r.resultPreview).toBeUndefined()
    }
    expect(rows.find((r) => r.kind === 'tool')!.text).toMatch(/^Bash: step 0\.0/)
    // The person's own words are whole; a Walnut notice loses its routing tag.
    expect(rows[0].text).toBe(page.messages[0].text)
    expect(String(rows[1].text)).toMatch(/^\[notification /)
    expect(String(rows[1].text)).not.toContain('about-session')
    const left = out.left_out as { folded: { tool: number; thinking: number }; chars: number; note: string }
    expect(left.folded).toEqual({ tool: 8, thinking: 4 })
    expect(left.chars).toBeGreaterThan(20_000)
    expect(left.note).toMatch(/8 tool calls and 4 thinking blocks folded to one line each: [0-9,]+ characters left out\./)
  })

  it('a row that also carries notices keeps the person part whole in personText', () => {
    const personText = pad('No I mean can u read the slack star', 900)
    const notice = '<walnut-message kind="notification" from="Walnut" outcome="status" note="status changes">\nA task you follow changed its status.\n</walnut-message>'
    const r = shapeHistory([{ role: 'user', sentBy: 'person', personText, text: `${notice}\n\n${personText}`, timestamp: at(0) }], { compact: true })
    expect(r.messages[0].personText).toBe(personText)
    expect(String(r.messages[0].text)).not.toContain(personText)
    expect(String(r.messages[0].text)).toMatch(/^\[notification/)
    // The person's words on both sides of an envelope: the rest is the envelope alone, not clipped.
    const both = shapeHistory([{ role: 'user', sentBy: 'person', personText: `hello\n\n${personText}`, text: `hello\n\n${notice}\n\n${personText}`, timestamp: at(0) }], { compact: true })
    expect(both.messages[0].text).toMatch(/^\[notification[^\n]*$/)
    expect(both.clipped).toBe(0)
  })

  it('limit keeps the newest N messages with the rows between them, and older.before reads the rest', async () => {
    const paths: string[] = []
    const page = { truncated: false, messages: bigPage(3) }
    const out = await run({ id: 't-1', limit: 2, compact: true }, fakeCall(paths, { 's-1': page }))
    expect(paths).toContain('/sessions/s-1/transcript?fresh=1&visible=2')
    const rows = out.messages as Row[]
    // A Walnut notice is a message too: the newest two are the last turn's second notice and reply.
    expect(rows.filter((r) => !r.kind).map((r) => String(r.text).split(' ')[0])).toEqual(['[notification', 'reply'])
    const older = out.older as { before: string; how: string }
    expect(older.before).toBe(rows[0].timestamp)
    expect(JSON.parse(older.how.match(/'(.*)'/)![1])).toEqual({ id: 't-1', limit: 2, compact: true, before: rows[0].timestamp })
    const cutOlder = (out.left_out as { cutOlder: number }).cutOlder
    expect(cutOlder + rows.length).toBe(page.messages.length)
    expect(page.messages[cutOlder - 1].timestamp).not.toBe(rows[0].timestamp)
  })

  it('limit never splits rows that share a timestamp', () => {
    const rows: Row[] = [
      { role: 'user', text: 'ask', timestamp: at(0) },
      { role: 'assistant', kind: 'thinking', text: 'think', timestamp: at(1) },
      { role: 'assistant', kind: 'tool', text: 'Bash', timestamp: at(1) },
      { role: 'assistant', text: 'one', timestamp: at(1) },
      { role: 'assistant', text: 'two', timestamp: at(1) },
    ]
    const r = shapeHistory(rows, { limit: 1 })
    expect(r.messages.map((m) => m.text)).toEqual(['think', 'Bash', 'one', 'two'])
    expect(r.cutOlder).toBe(1)
    expect(shapeHistory(rows, { limit: 50 }).messages).toHaveLength(5)
  })

  it('since keeps only rows after the time, asks the route to build a page reaching back to it, and offers no older page once reached', async () => {
    const paths: string[] = []
    const since = at(14)
    // The route reaches back to the first row at or after `since`; one at exactly that time shows it got there.
    const page = { truncated: true, messages: bigPage(3).filter((r) => Date.parse(String(r.timestamp)) >= Date.parse(since)) }
    const out = await run({ id: 't-1', since }, fakeCall(paths, { 's-1': page }))
    expect(paths).toContain(`/sessions/s-1/transcript?fresh=1&since=${encodeURIComponent(since)}`)
    const rows = out.messages as Row[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => Date.parse(String(r.timestamp)) > Date.parse(since))).toBe(true)
    // Not compact: the rows are the route's own, whole.
    expect(rows.find((r) => r.kind === 'tool')!.resultPreview).toBeDefined()
    expect(out.older).toBeUndefined()
    expect(out.truncated).toBe(false)
    expect((out.left_out as { cutSince: number }).cutSince).toBe(page.messages.length - rows.length)
    expect(paths.some((p) => p.includes('before='))).toBe(false)
  })

  it('a cut page that starts after since asks the page before it whether since was reached', async () => {
    const all = bigPage(6)
    const since = at(25) // between rows: nothing in the history is at exactly this time
    const page = { truncated: true, messages: all.filter((r) => Date.parse(String(r.timestamp)) > Date.parse(since)) }
    const first = String(page.messages[0].timestamp)
    // Reached: the page before holds nothing after since.
    const paths: string[] = []
    const reached = await run({ id: 't-1', since }, fakeCall(paths, { 's-1': page, 's-1:before': { truncated: true, messages: all.filter((r) => String(r.timestamp) < first) } }))
    expect(paths).toContain(`/sessions/s-1/transcript?before=${encodeURIComponent(first)}`)
    expect(reached.older).toBeUndefined()
    expect(reached.truncated).toBe(false)
    // Not reached: the route stopped at its own ceiling, rows after since are still unread.
    const capped = { truncated: true, messages: page.messages.slice(20) }
    const capFirst = String(capped.messages[0].timestamp)
    const out = await run({ id: 't-1', since, compact: true }, fakeCall([], { 's-1': capped, 's-1:before': { truncated: true, messages: all.filter((r) => String(r.timestamp) < capFirst) } }))
    const older = out.older as { before: string; how: string }
    expect(older.before).toBe(capFirst)
    expect(JSON.parse(older.how.match(/'(.*)'/)![1])).toEqual({ id: 't-1', since, compact: true, before: capFirst })
    expect(out.truncated).toBe(true)
  })

  it('the default read is the route answer unchanged', async () => {
    const page = { version: 1, sessionId: 's-1', truncated: false, messages: bigPage(1) }
    const paths: string[] = []
    const out = await run({ id: 't-1' }, fakeCall(paths, { 's-1': page }))
    expect(paths).toContain('/sessions/s-1/transcript')
    expect(out).toEqual({ ...page, taskId: 't-1' })
    expect(out.left_out).toBeUndefined()
  })

  it('all:true shapes every session, skips one with nothing after since, and limits across them', async () => {
    const sessions = [
      { session_id: 's-0', engine: 'codex', active: false },
      { session_id: 's-1', engine: 'claude', active: true },
    ]
    const pages = {
      's-0': { truncated: false, messages: [{ role: 'user', text: 'old engine', timestamp: at(0) }] },
      's-1': { truncated: false, messages: bigPage(2, 100) },
    }
    const out = await run({ id: 't-1', all: true, since: at(50), compact: true }, fakeCall([], pages, sessions))
    const rows = out.messages as Row[]
    expect(rows.some((r) => String(r.text).includes('s-0'))).toBe(false)
    expect(rows[0].text).toMatch(/^Session on claude, the active one: s-1/)
    expect(rows.filter((r) => r.kind === 'tool').every((r) => !('resultPreview' in r))).toBe(true)
    const limited = await run({ id: 't-1', all: true, limit: 1 }, fakeCall([], pages, sessions))
    const kept = limited.messages as Row[]
    expect(kept.filter((r) => !r.kind).length).toBe(1)
    // The cut landed inside the active session: its header still leads.
    expect(kept[0].text).toMatch(/^Session on claude, the active one: s-1/)
    const left = limited.left_out as { cutOlder: number; note: string }
    expect(left.cutOlder).toBeGreaterThan(0)
    expect(left.note).not.toContain('older.before')
  })

  it('the inputs are checked and the help says when to use which', () => {
    const input = op().input
    expect(input.limit.safeParse(0).success).toBe(false)
    expect(input.limit.safeParse(201).success).toBe(false)
    expect(input.limit.safeParse(20).success).toBe(true)
    expect(input.since.safeParse('yesterday').success).toBe(false)
    expect(input.since.safeParse('2026-11-03T08:00:00Z').success).toBe(true)
    expect(op().description).toMatch(/compact:true.*limit:N.*since/s)
  })
})
