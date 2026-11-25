/**
 * Guard: with threads_reply_tag on, no check of the Stop hook sends a turn back for something a
 * card line can say (GET /api/v1/me/open?hook=stop, src/web/routes/api-v1.ts).
 *
 * 2026-11-25, a live session: his message on a new subject made the summaries check send the turn
 * back ("the user wrote to you after these answers ... thread_update merge_into / close: acked /
 * known: all"), and the session then wrote him a closing chat message, "I've left those three
 * threads as they are ... so I haven't marked any of them as read". Thread bookkeeping in his chat
 * is what the card line is there to remove: whatever a session writes after a hook is a message to
 * him, so a hook may only ask for card lines, which Walnut hides.
 *
 * The checks are read from the route's own source, so one added there fails here until it is
 * classified:
 *   answers  it asks for an answer someone waits for (a request, an Ask here question, his own
 *            message): its texts name no thread write at all;
 *   off      about threads, and never run for a session that writes card lines;
 *   lines    about threads: every text is in one table, names the line to write and no
 *            thread_update, and the reason ends by asking for the lines and no other words.
 * The flow on a server is tests/e2e/reply-card-stop-quiet.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { CARD_STOP_LINES, cardStopEnd, cardStopReason } from '../../../src/core/org/reply-card-stop.js'
import { answeredBeforeHimReason, staleSummaryReason } from '../../../src/core/org/thread-summary-stop.js'
import type { OrgThread } from '../../../src/core/org/threads-model.js'

const ROUTE = 'src/web/routes/api-v1.ts'

type Kind = 'answers' | 'off' | 'lines'
/** Every check the Stop hook runs, in the route's order, with the file that holds its texts. */
const CHECKS: Record<string, { file: string; kind: Kind }> = {
  unansweredAtStop: { file: 'src/core/sessions/unanswered-at-stop.ts', kind: 'answers' },
  askUnansweredAtStop: { file: 'src/core/sessions/ask-unanswered.ts', kind: 'answers' },
  owedAtStop: { file: 'src/core/sessions/user-asks.ts', kind: 'answers' },
  staleSummariesAtStop: { file: 'src/core/org/thread-summary-stop.ts', kind: 'off' },
  cardLinesAtStop: { file: 'src/core/org/reply-card-stop.ts', kind: 'lines' },
}

/** A write on a thread, as an op or one of its arguments. */
const THREAD_WRITE = /thread_(?:update|create|split|move|file)|merge_into|close: acked|known: "all"/

/** The code of a file without its comments (a text in a comment is sent to no one). */
function codeOf(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/(?<=[\s;,{}()])\/\/ .*$/gm, '')
}

/** The body of the route's hook=stop branch. */
function stopBranch(): string {
  const src = fs.readFileSync(ROUTE, 'utf8')
  const start = src.indexOf("if (req.query.hook === 'stop') {")
  expect(start, 'the hook=stop branch').toBeGreaterThan(0)
  return src.slice(start, src.indexOf('const { collectOpenItems }', start))
}

/** The checks the route runs: the calls of its Promise.all, in order. */
function routeChecks(): string[] {
  const branch = stopBranch()
  const open = branch.indexOf('await Promise.all([')
  expect(open, 'the checks run together').toBeGreaterThan(0)
  const body = branch.slice(open + 'await Promise.all(['.length, branch.indexOf('\n      ])', open)).replace(/^\s*\/\/.*$/gm, '')
  // Split on the commas between the calls, never inside one.
  const calls: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of body) {
    if ('([{'.includes(ch)) depth += 1
    if (')]}'.includes(ch)) depth -= 1
    if (ch === ',' && depth === 0) { calls.push(cur); cur = '' } else cur += ch
  }
  calls.push(cur)
  return calls.map((c) => c.trim()).filter(Boolean).map((c) => /^([A-Za-z_$][\w$]*)\(/.exec(c)?.[1] ?? `not a call: ${c}`)
}

const thread = (id: string, title: string): OrgThread => ({ id, title, titled: true, state: 'answered', reply: 'Two metres.', messages: [{ id: 'm1', text: 'How tall?', via: 'chat', at: '2026-11-25T10:00:00.000Z' }], createdAt: '2026-11-25T10:00:00.000Z', updatedAt: '2026-11-25T10:01:00.000Z' } as OrgThread)

describe('every check of the Stop hook is classified', () => {
  it('the route runs exactly the checks listed here, in this order', () => {
    expect(routeChecks()).toEqual(Object.keys(CHECKS))
  })

  it('every reason the route sends back comes from one of them', () => {
    const joined = /const reason = \[([^\]]+)\]/.exec(stopBranch())?.[1] ?? ''
    expect(joined.split(',').map((x) => x.trim())).toEqual(['requests?.reason', 'asks?.reason', 'owed?.reason', 'summaries?.reason', 'cards?.reason'])
  })
})

describe('a check that asks for an answer names no thread write', () => {
  for (const [name, c] of Object.entries(CHECKS).filter(([, x]) => x.kind === 'answers')) {
    it(`${name} (${c.file})`, () => {
      expect(codeOf(c.file)).not.toMatch(THREAD_WRITE)
    })
  }
})

describe('the summaries check is never run for a session that writes card lines', () => {
  const src = fs.readFileSync(CHECKS.staleSummariesAtStop.file, 'utf8')
  const fn = src.slice(src.indexOf('export async function staleSummariesAtStop('))

  it('its texts ask for thread_update, which is why it is off there (the words stay for a session with the tag off)', () => {
    const t = thread('th-0000000000a1', 'Orchard fence')
    expect(staleSummaryReason([t])).toMatch(THREAD_WRITE)
    expect(answeredBeforeHimReason([t], { at: '2026-11-25T11:00:00.000Z', thread: thread('th-0000000000a2', 'Seed order') })).toMatch(THREAD_WRITE)
  })

  it('it answers nothing for such a session before it reads a thread or builds a text', () => {
    const gate = fn.indexOf('.tagsReplies(task)) return null')
    expect(gate, 'the gate').toBeGreaterThan(0)
    for (const later of ['readThreads(taskId)', 'staleSummaryReason(', 'answeredBeforeHimReason(', 'markChecked(']) {
      expect(fn.indexOf(later), later).toBeGreaterThan(gate)
    }
  })
})

describe('the card line check sends back only lines to write', () => {
  const src = codeOf(CHECKS.cardLinesAtStop.file)

  it('every text it sends is built from the one table, and every entry of the table is used', () => {
    const lines = [...src.matchAll(/\bline: (?!string\b)([^,}]+)/g)].map((m) => m[1].trim())
    expect(lines.length).toBeGreaterThan(0)
    const kinds = lines.map((l) => /^CARD_STOP_LINES\.(\w+)\(/.exec(l)?.[1] ?? `not from the table: ${l}`)
    expect([...new Set(kinds)].sort()).toEqual(Object.keys(CARD_STOP_LINES).sort())
  })

  it('the reason is built in one place, which ends it with the words that ask for lines alone', () => {
    expect([...src.matchAll(/\breason: (?!string\b)/g)]).toHaveLength(1)
    expect(src).toContain('reason: due.length ? cardStopReason(due.map((x) => x.line)) : null')
    for (const n of [1, 2, 5]) {
      const lines = Array.from({ length: n }, (_, i) => `line ${i + 1}.`)
      expect(cardStopReason(lines).endsWith(cardStopEnd(n)), `${n} lines`).toBe(true)
      expect(cardStopEnd(n)).toMatch(/^Write only (?:this line|these lines) now, .*no other words about (?:it|them): anything else you add is shown to him as chat\.$/)
    }
  })

  it('no text of the table names a thread write: each names the line', () => {
    const t = { id: 'th-0000000000a1', title: 'Orchard fence' }
    const texts: Record<keyof typeof CARD_STOP_LINES, string> = {
      unread: CARD_STOP_LINES.unread(`${t.id}: state is working, waiting, answered, done, needs, not "finished"`),
      gone: CARD_STOP_LINES.gone(`${t.id} is closed: a new ask about it is a new thread, which Walnut files and names to you`),
      merge: CARD_STOP_LINES.merge(t.id, 'A thread cannot be merged into itself'),
      needs: CARD_STOP_LINES.needs(t.id, 'A question reaches the user only when it is theirs: name its user_kind'),
      missing: CARD_STOP_LINES.missing(t),
      returned: CARD_STOP_LINES.returned(t.id, ['since', 'decision']),
    }
    for (const [kind, text] of Object.entries(texts)) expect(text, kind).not.toMatch(THREAD_WRITE)
    // The store's fields in a decision's refusal are given as the line's own attributes.
    expect(texts.needs).toContain('In a card line user_kind is kind="..." and user_kind_why is why="...".')
    expect(texts.missing).toContain(`<walnut-card thread="${t.id}" state="answered"/>`)
  })

  it('a line that names no open thread holds no turn by itself: there is nothing to write in its place', () => {
    expect(src).toContain("open.some((x) => x.kind !== 'gone') ? open : []")
  })
})
