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

  it('all:true with a limit that fits under the cap still names the page before what the limit left out', async () => {
    const call: Call = async (_method, path) => {
      if (path.startsWith('/tasks/t-1/sessions')) return { sessions: [{ session_id: 's-0', engine: 'codex', active: false }, { session_id: 's-1', engine: 'claude', active: true }] }
      if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: 's-1' } }
      const sid = path.split('/')[2]
      return { truncated: false, messages: sid === 's-0' ? ROWS.slice(0, 96) : ROWS.slice(96) }
    }
    const args = { id: 't-1', all: true, limit: 2 }
    const result = await (op().handler as (i: Record<string, unknown>, c: Call) => Promise<unknown>)({ ...args }, call) as Row
    const rows = (result.messages as Row[]).filter((r) => !String(r.text ?? '').startsWith('Session on '))
    const older = result.older as { before: string; how: string }
    expect(older.before).toBe(rows[0].timestamp)
    expect(JSON.parse(older.how.match(/'(.*)'/)![1])).toMatchObject({ id: 't-1', all: true, limit: 2, before: older.before })
  })

  /**
   * all:true joins the sessions by when each started. A task that switched back to its first engine
   * resumes the FIRST session, so its newest rows sit ahead of the later session's (2026-11-24 review
   * probe): the cut is by time, so they are the ones kept, and the pages before read the rest once each.
   */
  describe('all:true where the first session was resumed after a switch back', () => {
    const hm = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 10, 24, h, m, s)).toISOString()
    const turns = (label: string, h0: number, n: number): Row[] => Array.from({ length: n }, (_, i) => [
      { role: 'user', sentBy: 'agent', text: `${label}-ask-${i} ${'x'.repeat(900)}`, timestamp: hm(h0, i) },
      { role: 'assistant', kind: 'tool', text: 'Bash', detail: pad(`${label}-step-${i}`, 120), resultPreview: pad('{"result"', 1500), timestamp: hm(h0, i, 10) },
      { role: 'assistant', text: `${label}-reply-${i} ${'y'.repeat(900)}`, timestamp: hm(h0, i, 30) },
    ]).flat()
    const A = [...turns('A-old', 9, 10), ...turns('A-resumed', 11, 10)]
    const B = turns('B', 10, 10)
    const call: Call = async (_method, path) => {
      if (path.startsWith('/tasks/t-1/sessions')) return { sessions: [{ session_id: 's-A', engine: 'claude', active: true, started_at: hm(9, 0) }, { session_id: 's-B', engine: 'codex', active: false, started_at: hm(10, 0) }] }
      if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: 's-A' } }
      const before = new URLSearchParams(path.split('?')[1] ?? '').get('before')
      const src = path.split('/')[2] === 's-A' ? A : B
      return { truncated: false, messages: before ? src.filter((r) => String(r.timestamp) < before) : src }
    }
    const label = (r: Row) => `${String(r.text)} ${String(r.detail ?? '')}`.match(/[AB][-a-z]*-(ask|step|reply)-\d+/)?.[0]
    const ask = async (args: Record<string, unknown>, surface: (typeof ANSWER_SURFACE_NAMES)[number]) =>
      agentAnswer(op(), { ...args }, await (op().handler as (i: Record<string, unknown>, c: Call) => Promise<unknown>)({ ...args }, call), false, surface) as Row
    const byTime = [...A, ...B].sort((x, y) => String(x.timestamp).localeCompare(String(y.timestamp)))

    for (const surface of ANSWER_SURFACE_NAMES) {
      for (const args of [{ id: 't-1', all: true, compact: true }, { id: 't-1', all: true, limit: 6 }, { id: 't-1', all: true }]) {
        it(`${JSON.stringify(args)} on the ${surface} surface: the resumed session's newest rows are shown, each with its header, and the pages before read every row once`, async () => {
          const answer = await ask(args, surface)
          expect(printedSize(answer, surface)).toBeLessThanOrEqual(answerFit(op(), surface).max)
          const rows = answer.messages as Row[]
          const shown = rows.filter((r) => r.timestamp)
          expect(label(shown.at(-1)!)).toBe('A-resumed-reply-9')
          // Every row older than the oldest shown was left out; none newer.
          const oldest = Math.min(...shown.map((r) => Date.parse(String(r.timestamp))))
          expect(shown.length).toBe(byTime.filter((r) => Date.parse(String(r.timestamp)) >= oldest).length)
          // A shown row's session header is right above its session's rows.
          for (const [i, r] of rows.entries()) if (!r.timestamp) expect(String(r.text)).toMatch(/^Session on /)
          expect(String(rows[0].text)).toMatch(/^Session on claude/)
          // Page back to the start: every row once, in each session's own order.
          const seen: Row[] = [...shown]
          let older = answer.older as { how: string } | undefined
          for (let page = 0; older && page < 60; page++) {
            const next = await ask(JSON.parse(older.how.match(/'(.*)'/)![1]) as Record<string, unknown>, surface)
            seen.push(...(next.messages as Row[]).filter((r) => r.timestamp))
            older = next.older as { how: string } | undefined
          }
          const labels = seen.map(label)
          expect(new Set(labels).size).toBe(labels.length)
          expect([...labels].sort()).toEqual(byTime.map(label).sort())
        })
      }
    }
  })

  describe('the newest time alone over the cap', () => {
    const t = '2026-11-24T08:22:09.000Z'
    const page = (tools: number): Row[] => [
      { role: 'user', sentBy: 'person', text: 'check every host', timestamp: '2026-11-24T08:21:00.000Z' },
      ...Array.from({ length: tools }, (_, i) => ({ role: 'assistant', kind: 'tool', text: 'Bash', detail: pad(`host ${i}`, 120), resultPreview: pad('{"result"', 1500), timestamp: t })),
      { role: 'assistant', text: pad('all hosts are fine', 800), timestamp: t },
    ]
    const read = async (rows: Row[], surface: (typeof ANSWER_SURFACE_NAMES)[number]) => {
      const call: Call = async (_method, path) => {
        if (path.startsWith('/tasks/t-1/sessions')) return { sessions: [{ session_id: 's-1', engine: 'claude', active: true }] }
        if (path.startsWith('/tasks/')) return { task: { id: 't-1', session_id: 's-1' } }
        return { truncated: false, messages: rows }
      }
      const args = { id: 't-1', limit: 1 }
      return agentAnswer(op(), { ...args }, await (op().handler as (i: Record<string, unknown>, c: Call) => Promise<unknown>)({ ...args }, call), false, surface) as Row
    }

    it('its rows are folded to the compact form, never left out (the page before could not read them back)', async () => {
      for (const surface of ANSWER_SURFACE_NAMES) {
        const answer = await read(page(16), surface)
        const rows = answer.messages as Row[]
        expect(printedSize(answer, surface)).toBeLessThanOrEqual(answerFit(op(), surface).max)
        expect(rows.filter((r) => r.timestamp === t)).toHaveLength(17)
        expect(rows.filter((r) => r.kind === 'tool').every((r) => r.resultPreview === undefined)).toBe(true)
        expect(String(rows.at(-1)!.text)).toMatch(/^all hosts are fine/)
        expect(answer._cut).toBeUndefined()
        // The older person message is left out, and the page before reads it.
        expect((answer.older as { before: string }).before).toBe(t)
        expect(String(answer.shown)).toMatch(/folded to the compact form/)
      }
    })

    it('when even folded they do not fit, the answer says that "_full": true reads them whole', async () => {
      for (const surface of ANSWER_SURFACE_NAMES) {
        const answer = await read(page(80), surface)
        expect(printedSize(answer, surface)).toBeLessThanOrEqual(answerFit(op(), surface).max)
        expect(String((answer.messages as Row[]).at(-1)!.text)).toMatch(/^all hosts are fine/)
        expect(String(answer.shown)).toMatch(/"_full": true reads them whole/)
      }
    })
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
