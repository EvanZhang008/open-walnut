/**
 * task_history never loses the newest rows when its answer is held to a cap (src/ops/task-history-shape.ts
 * fitWindow, src/ops/answer.ts cutToFit). 2026-11-24: `task_history {"limit":14}` on a busy task read
 * 63 rows (14 messages and the tool calls between them) from the host, correct to the last row, and
 * the agent got the OLDEST 13 of them: the answer cutter dropped list rows from the end, so the newest
 * reply (the one the reader came for) was gone, and `older.before` pointed further back still. The
 * same cut took the newest reply from a `since` read. Every read path is checked here as an agent
 * reads it: through agentAnswer, on both surfaces.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../src/ops/index.js'
import { agentAnswer, answerFit, cutToFit, printedSize, ANSWER_SURFACE_NAMES } from '../../src/ops/answer.js'

type Row = Record<string, unknown>
type Call = (method: string, path: string) => Promise<unknown>

const pad = (label: string, n: number) => `${label} ${'x'.repeat(Math.max(0, n - label.length - 1))}`
/** Two working days with a night between, as the real conversation: turn t of day d. */
const at = (day: number, t: number, s: number) => new Date(Date.UTC(2026, 10, 23 + day, 10, t, s)).toISOString()

/** A lead's busy conversation: per turn a notice, thinking, five tool calls with long results, one reply. */
function conversation(turnsPerDay = 12): Row[] {
  const rows: Row[] = []
  for (let day = 0; day < 2; day++) {
    for (let t = 0; t < turnsPerDay; t++) {
      rows.push({ role: 'user', sentBy: 'agent', text: `<walnut-message kind="notification" from="Walnut">\n${pad(`notice ${day}.${t}`, 900)}\n</walnut-message>`, timestamp: at(day, t, 0) })
      rows.push({ role: 'assistant', kind: 'thinking', text: pad(`thinking ${day}.${t}`, 700), timestamp: at(day, t, 5) })
      for (let n = 0; n < 5; n++) {
        rows.push({ role: 'assistant', kind: 'tool', text: 'Bash', detail: pad(`step ${day}.${t}.${n}`, 120), resultPreview: pad('{"result"', 1500), timestamp: at(day, t, 5) })
      }
      rows.push({ role: 'assistant', text: pad(`reply ${day}.${t}`, 900), timestamp: at(day, t, 30) })
    }
  }
  return rows
}

const ROWS = conversation()
const NEWEST = ROWS.at(-1)!

/** The route as the task's host answers it: its newest page, widened back to `since` or `visible` text rows. */
function route(paths: string[]): Call {
  return async (_method, path) => {
    paths.push(path)
    if (path.startsWith('/tasks/t-1/sessions')) return { sessions: [{ session_id: 's-1', engine: 'claude', active: true }] }
    if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: 's-1' } }
    const q = new URLSearchParams(path.split('?')[1] ?? '')
    const before = q.get('before')
    const rows = before ? ROWS.filter((r) => String(r.timestamp) < before) : ROWS
    return { version: 1, sessionId: 's-1', truncated: rows.length > 120, messages: rows.slice(-120) }
  }
}

const op = () => getOp('task_history')!
async function read(args: Record<string, unknown>, surface: (typeof ANSWER_SURFACE_NAMES)[number]): Promise<Row> {
  const paths: string[] = []
  const result = await (op().handler as (i: Record<string, unknown>, c: Call) => Promise<unknown>)({ ...args }, route(paths))
  return agentAnswer(op(), { ...args }, result, false, surface) as Row
}

/** Every row a reader reaches: this answer, then each `older.how` page in turn, until none is left or `stop`. */
async function readBack(args: Record<string, unknown>, surface: (typeof ANSWER_SURFACE_NAMES)[number], stop: (r: Row) => boolean): Promise<Row[]> {
  const seen: Row[] = []
  let next: Record<string, unknown> | undefined = args
  for (let page = 0; next && page < 40; page++) {
    const answer = await read(next, surface)
    const rows = answer.messages as Row[]
    seen.unshift(...rows)
    if (rows.some(stop)) break
    const older = answer.older as { how: string } | undefined
    next = older ? JSON.parse(older.how.match(/'(.*)'/)![1]) as Record<string, unknown> : undefined
  }
  return seen
}

const isText = (r: Row) => !r.kind && typeof r.text === 'string'
const justBefore = (iso: string) => new Date(Date.parse(iso) - 1).toISOString()

/** The time the window asked for starts after: since, the limit-th newest message, or the route's page; else the first row shown. */
function windowStart(args: Record<string, unknown>, shown: Row[]): string {
  if (args.since) return String(args.since)
  const pool = args.before ? ROWS.filter((r) => String(r.timestamp) < String(args.before)) : ROWS
  if (typeof args.limit === 'number') return justBefore(String(pool.filter(isText).at(-args.limit)!.timestamp))
  if (args.compact) return justBefore(String(pool.slice(-120)[0].timestamp))
  return String(shown[0].timestamp)
}

const textOf = (r: Row) => String(r.text).split(/[ \n]/).find((w) => /\d\.\d/.test(w))

describe('task_history keeps the newest rows when its answer is held to the cap', () => {
  for (const surface of ANSWER_SURFACE_NAMES) {
    const windows: Array<[string, Record<string, unknown>]> = [
      ['limit', { id: 't-1', limit: 14 }],
      ['limit, compact', { id: 't-1', limit: 14, compact: true }],
      ['since', { id: 't-1', since: at(1, 0, 1) }],
      ['since, compact', { id: 't-1', since: at(1, 0, 1), compact: true }],
      ['since, limit, compact', { id: 't-1', since: at(0, 3, 0), limit: 60, compact: true }],
      ['compact', { id: 't-1', compact: true }],
      ['limit, before', { id: 't-1', limit: 14, before: at(1, 6, 0) }],
      ['the default', { id: 't-1' }],
    ]
    for (const [label, args] of windows) {
      it(`${label}, on the ${surface} surface: the newest row is shown, the answer fits, and older.how reads what was left out`, async () => {
        const answer = await read(args, surface)
        expect(printedSize(answer, surface)).toBeLessThanOrEqual(answerFit(op(), surface).max)
        // The generic cutter never had to drop rows: the window itself was fitted (or fit already).
        expect(JSON.stringify((answer._cut as { fields?: unknown } | undefined)?.fields ?? {})).not.toMatch(/"messages":/)
        const rows = answer.messages as Row[]
        const newest = args.before ? ROWS.filter((r) => String(r.timestamp) < String(args.before)).at(-1)! : NEWEST
        expect(textOf(rows.at(-1)!)).toBe(textOf(newest))
        expect(rows.at(-1)!.timestamp).toBe(newest.timestamp)
        // Nothing between the first row the window asked for and the newest is lost: the pages before read it, in order.
        const from = windowStart(args, rows)
        const want = ROWS.filter((r) => String(r.timestamp) > from && String(r.timestamp) <= String(newest.timestamp) && !r.kind).map(textOf)
        const got = (await readBack(args, surface, (r) => String(r.timestamp) <= from)).filter((r) => !r.kind && String(r.timestamp) > from).map(textOf)
        expect(got).toEqual(want)
      })
    }
  }

  it('all:true over two sessions keeps the header of the session its newest rows belong to', async () => {
    const call: Call = async (_method, path) => {
      if (path.startsWith('/tasks/t-1/sessions')) return { sessions: [{ session_id: 's-0', engine: 'codex', active: false }, { session_id: 's-1', engine: 'claude', active: true }] }
      if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: 's-1' } }
      const sid = path.split('/')[2]
      return { truncated: false, messages: sid === 's-0' ? ROWS.slice(0, 96) : ROWS.slice(96) }
    }
    for (const surface of ANSWER_SURFACE_NAMES) {
      const args = { id: 't-1', all: true, limit: 14 }
      const result = await (op().handler as (i: Record<string, unknown>, c: Call) => Promise<unknown>)({ ...args }, call)
      const answer = agentAnswer(op(), { ...args }, result, false, surface) as Row
      const rows = answer.messages as Row[]
      expect(String(rows[0].text)).toMatch(/^Session on claude.*s-1$/)
      expect(rows.at(-1)!.timestamp).toBe(NEWEST.timestamp)
      expect(JSON.parse((answer.older as { how: string }).how.match(/'(.*)'/)![1])).toMatchObject({ id: 't-1', all: true, limit: 14 })
    }
  })

  it('a window that already fits is answered as the op gave it', async () => {
    const answer = await read({ id: 't-1', limit: 1, compact: true }, 'mcp')
    expect(answer._cut).toBeUndefined()
    expect(answer.shown).toBeUndefined()
  })
})

describe('the answer cutter keeps a conversation\'s newest rows', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `row ${i} ${'x'.repeat(80)}`, timestamp: new Date(Date.UTC(2026, 10, 24, 0, 0, i)).toISOString() }))

  it('a list of rows in time order loses its oldest rows and says so', () => {
    const cut = cutToFit({ messages: rows }, 4_000) as { messages: Row[]; _cut: { fields: Record<string, string> } }
    expect(cut.messages.at(-1)!.text).toBe(rows.at(-1)!.text)
    expect(cut.messages.length).toBeLessThan(rows.length)
    expect(cut._cut.fields.messages).toMatch(/older items/)
  })

  it('so does the one-walk cut of a very large answer', () => {
    const big = rows.map((r) => ({ ...r, text: `${r.text} ${'y'.repeat(1_900)}` }))
    const cut = cutToFit({ messages: big }, 8_000) as { messages: Row[] }
    expect(String(cut.messages.at(-1)!.text).startsWith('row 299 ')).toBe(true)
  })

  it('a list that is not a conversation in time order keeps its head, as before', () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}`, timestamp: new Date(Date.UTC(2026, 10, 24, 0, 0, i)).toISOString() }))
    expect((cutToFit({ items }, 2_000) as { items: Row[] }).items[0].id).toBe('r0')
    const newestFirst = [...rows].reverse()
    expect((cutToFit({ messages: newestFirst }, 4_000) as { messages: Row[] }).messages[0].text).toBe(rows.at(-1)!.text)
  })
})
