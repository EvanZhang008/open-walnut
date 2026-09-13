/**
 * An emoji on a cap must not poison the RESPONSE.
 *
 * The device report this pins: a session whose reasoning or tool output carried an
 * astral character (an emoji, a CJK extension character) exactly where an excerpt was
 * cut came back as an EMPTY conversation on the phone, with no error anywhere. The
 * cause is one layer below the drawer: every excerpt is `slice(0, N)` on a UTF-16
 * index, a cut between the halves of a surrogate pair leaves a lone surrogate,
 * `JSON.stringify` renders that as a `\udXXX` escape, and Swift's `JSONDecoder`
 * rejects the WHOLE body rather than that one field. A hundred good rows die with it.
 *
 * So these cases assert on the RAW response text, not on parsed fields: the poison is
 * an escape sequence in the bytes on the wire, and a JS client (`res.json()`) happily
 * accepts it, which is exactly why server-side tests missed this twice.
 *
 * The fixture puts an emoji on each cap the route can hit: 700 (`resultPreview`),
 * 2,000 (`thinkingText`, `inputPreview`), and 5,000 (the retained-row cap the detail
 * read lifts by re-reading the row). Offsets 0, 700 and 2,000 are then read back, plus
 * every `nextOffset` the answers offer, because a cursor is the other place a window
 * edge lands mid-character.
 *
 * Real: Express server (startServer), the api-v1 router, a session record, and the
 * whole read pipeline against a JSONL on disk. Mocked: constants (temp dirs) and the
 * '__local__' daemon reader (in production it resolves `~/.claude` through its own
 * process HOME and cannot see fixtures under the mocked CLAUDE_HOME).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-detail-surrogate'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath, HISTORY_TOOL_RESULT_MAX } from '../../../src/core/session-history.js'
import { FULL_TEXT_SECTION_MAX } from '../../../src/core/tool-summary.js'

const CWD = '/Users/test/detail-surrogate'
const EMOJI = '\u{1F600}'
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
/** What the phone's decoder rejects: an escaped, unpaired surrogate. The lookbehind
 *  matters — text that literally spells `\ud83d` serializes as `\\ud83d`, and a
 *  pattern without it reads that as the poison. */
const LONE_ESCAPE = /(?<!\\)\\u[dD][89abAB]/

const straddle = (cap: number, fill: string, tail: number): string =>
  fill.repeat(cap - 1) + EMOJI + fill.repeat(tail)

/** One string with an emoji straddling EVERY cap in `caps` (ascending), plus a tail. */
function straddleAll(caps: number[], tail: number): string {
  let s = ''
  for (const cap of caps) s += 'x'.repeat(cap - 1 - s.length) + EMOJI
  return s + 'z'.repeat(tail)
}

let server: HttpServer
let port: number
const apiUrl = (p: string): string => `http://localhost:${port}${p}`

interface Row { text: string; kind?: string; resultPreview?: string; inputPreview?: string; thinkingText?: string; detailRef?: string }
interface Detail {
  kind: string
  text?: string; textNextOffset?: number
  input?: string; inputNextOffset?: number
  result?: string; resultNextOffset?: number
  offset: number
}

/** Fetch, and judge the BYTES before anything parses them. */
async function clean(url: string, label: string): Promise<unknown> {
  const res = await fetch(apiUrl(url))
  expect(res.status, `${label}: status`).toBe(200)
  const raw = await res.text()
  expect(raw, `${label}: escaped lone surrogate on the wire`).not.toMatch(LONE_ESCAPE)
  const body = JSON.parse(raw) as unknown
  // Every string the body carries, not just the ones this test names.
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      expect(LONE_SURROGATE.test(v), `${label}: lone surrogate in a delivered string`).toBe(false)
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(body)
  return body
}

let seq = 0
const at = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString()

// Reasoning long enough to be cut, with the emoji ON the 2,000-character excerpt cap.
const REASONING = straddle(2_000, 'r', 1_500)
// A result with an emoji on EVERY edge that cuts it: 700 (the row preview), 5,000
// (what a whole-transcript parse retains and the detail read re-reads past), and
// 200,000 (the section window, i.e. the page seam a client walks with a cursor).
const RESULT = straddleAll([700, HISTORY_TOOL_RESULT_MAX, FULL_TEXT_SECTION_MAX], 5_000)
// An input whose fat value crosses the per-value clip (1,000) at an emoji.
const COMMAND = straddle(1_000, 'c', 2_500)

async function seedSession(sessionId: string): Promise<void> {
  await createSessionRecord(sessionId, '', '', CWD, { title: 'Coding session', initialProcessStatus: 'idle' })
  const lines: unknown[] = [
    { type: 'user', uuid: `u-${++seq}`, timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: `ship it ${EMOJI}` }] } },
    {
      type: 'assistant', uuid: `a-${++seq}`, timestamp: at(),
      message: { id: 'msg_reason', role: 'assistant', content: [{ type: 'thinking', thinking: REASONING }, { type: 'text', text: 'Checking.' }] },
    },
    {
      type: 'assistant', uuid: `a-${++seq}`, timestamp: at(),
      message: {
        id: 'msg_tools', role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: COMMAND, description: 'Deploy' } }],
      },
    },
    { type: 'user', uuid: `tr-${++seq}`, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: RESULT }] } },
  ]
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await seedSession('detail-surrogate')
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('activity detail: an emoji on a cap never poisons the body', () => {
  it('serves the rich row page decodable, with the excerpts cut one unit short', async () => {
    const body = await clean('/api/v1/sessions/detail-surrogate/transcript?fresh=1&rich=1', 'rich rows')
    const rows = (body as { messages: Row[] }).messages

    const thinking = rows.find((m) => m.kind === 'thinking')!
    // Cut on the boundary: 1,999 kept + the ellipsis, and the emoji went nowhere near
    // the wire in halves.
    expect(thinking.thinkingText!.length).toBe(2_000)
    expect(thinking.thinkingText!.endsWith('…')).toBe(true)
    // …and the row still advertises the fuller read, which the length-based verdict
    // would have dropped because the excerpt came back one character short.
    expect(thinking.detailRef).toBeDefined()

    const tool = rows.find((m) => m.text === 'Bash')!
    expect(tool.resultPreview!.length).toBe(700)
    expect(tool.detailRef).toBeDefined()
    expect(tool.inputPreview).toContain('description: Deploy')
  })

  it('reads every section back, at offset 0, 700 and 2000, chasing each cursor', async () => {
    const rows = (await clean('/api/v1/sessions/detail-surrogate/transcript?fresh=1&rich=1', 'rows') as { messages: Row[] }).messages
    const refs = {
      reasoning: rows.find((m) => m.kind === 'thinking')!.detailRef!,
      tool: rows.find((m) => m.text === 'Bash')!.detailRef!,
    }
    const q = (ref: string, extra = ''): string => `/api/v1/activity/detail?ref=${encodeURIComponent(ref)}${extra}`

    // Whole-row reads first (no part): both sections of the tool row at once. The
    // result is longer than one section window, so this is also the page-1 assertion:
    // 199,999 units, one short of the window, because the 200,000th is half an emoji.
    const whole = await clean(q(refs.tool), 'tool whole') as Detail
    expect(whole.input).toBeDefined()
    expect(whole.result!.length).toBe(FULL_TEXT_SECTION_MAX - 1)
    expect(whole.resultNextOffset).toBe(FULL_TEXT_SECTION_MAX - 1)

    for (const offset of [0, 700, 2_000]) {
      await clean(q(refs.reasoning, `&part=reasoning&offset=${offset}`), `reasoning @${offset}`)
      await clean(q(refs.tool, `&part=result&offset=${offset}`), `result @${offset}`)
      await clean(q(refs.tool, `&part=input&offset=${offset}`), `input @${offset}`)
    }

    // Chase whatever cursors the answers offer — a cursor is a window edge too, and it
    // is the one a client actually follows.
    let next = whole.resultNextOffset
    let hops = 0
    let joined = whole.result!
    while (next !== undefined && hops++ < 10) {
      const page = await clean(q(refs.tool, `&part=result&offset=${next}`), `result cursor @${next}`) as Detail
      expect(page.offset).toBe(next)
      // The seam: the next page opens with the WHOLE character the last one stopped
      // before, so the pages join back into the row's output.
      if (hops === 1) expect(page.result!.startsWith(EMOJI)).toBe(true)
      joined += page.result!
      next = page.resultNextOffset
    }
    expect(hops).toBeGreaterThan(0) // the fixture really does page
    expect(joined.length).toBe(RESULT.length)
  })

  it('serves the plain tail decodable too (the slim rows the bridge pushes)', async () => {
    // Same cuts, different budget: the 4 KB per-row clip on a plain read.
    await clean('/api/v1/sessions/detail-surrogate/transcript?fresh=1', 'slim rows')
  })
})
