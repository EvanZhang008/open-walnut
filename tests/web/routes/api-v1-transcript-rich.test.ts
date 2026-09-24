/**
 * GET /api/v1/sessions/:id/transcript?rich=1 — the expanded-card opt-in.
 *
 * The defect: the two expanded-card fields (`inputPreview` on a tool row,
 * `thinkingText` on a reasoning row) are produced only by a `{ full: true }`
 * build, and this route built with no options at all — so on the phone an
 * ordinary coding session's timeline expanded a tool to a Result with no Input,
 * and its reasoning rows carried no chevron. The mobile CHAT read
 * (/conversations/:id/messages) already passes `full`, so the two surfaces
 * disagreed in the direction nobody expected: chat richer than sessions.
 *
 * Flipping the flag was never the fix, and `full` is why: it is not a field
 * switch. It ALSO drops the ~100-message tail slice and the 4 KB per-row text
 * clip, and this tail is the thing the sweep pushes to the cloud under a frame
 * cap and the phone refetches at every turn end. So the fields got their own
 * projection option (`rich`, which gates ONLY them) behind an explicit query
 * parameter, and NOTHING else about the response moves.
 *
 * What each case pins:
 *  - without `rich`, the answer is byte-for-byte the answer the bare
 *    buildSessionTranscript(sessionId) call produced — proven against a fixture
 *    that HAS both a reasoning block and a tool input to leak, so the case would
 *    catch the widening it exists to forbid;
 *  - with `rich=1`, both fields arrive, capped and masked as documented;
 *  - `rich=1` is NOT `full`: the tail still slices and text rows still clip. This
 *    is the misreading that produced the defect, so it gets its own case;
 *  - `full` still implies `rich`, so the lane read keeps the shape it shipped;
 *  - `rich` is parsed exactly like `fresh` (only the literal `1`), proven by
 *    running the same value set through BOTH parameters in one loop;
 *  - `rich=1` never FORCES a build: a cached read answers without the fields,
 *    which is what keeps the phone's two-phase open fast;
 *  - the route's other inline build (no exported file yet, session alive) passes
 *    the option too, so a tail is never rich on one path and slim on the other.
 *
 * Real: Express server (startServer), the api-v1 router, session records in
 * SQLite, and the whole read pipeline (buildSessionTranscript →
 * readSessionHistoryTail → DaemonFileReader → parseSessionMessages) against
 * JSONL written to disk. Mocked: constants (temp dirs) and the '__local__'
 * daemon file reader, which in
 * production expands `~/.claude` via its own process HOME and so cannot see
 * fixtures under the mocked CLAUDE_HOME.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-transcript-rich'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { buildSessionTranscript, SESSION_TRANSCRIPTS_DIR } from '../../../src/core/session-projection.js'

/** The session's cwd — records are seeded with one, and it is what locates the
 *  JSONL (`~/.claude/projects/<encoded cwd>/<sid>.jsonl`). */
const CWD = '/Users/test/transcript-rich'

let server: HttpServer
let port: number

const apiUrl = (p: string): string => `http://localhost:${port}${p}`

interface Row {
  role: string
  text: string
  timestamp: string
  kind?: string
  detail?: string
  resultPreview?: string
  inputPreview?: string
  thinkingText?: string
  detailRef?: string
}
interface Body {
  version: number
  sessionId: string
  exportedAt: string
  truncated: boolean
  messages: Row[]
  /** Present only on a `rich=1` request — whether these rows really carry the fields. */
  rich?: boolean
}

/** Raw body text AND the parsed shape — the byte-identity case needs the text. */
async function getTranscript(sid: string, qs = ''): Promise<{ status: number; text: string; body: Body }> {
  const res = await fetch(apiUrl(`/api/v1/sessions/${sid}/transcript${qs}`))
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) as Body : ({} as Body) }
}

/** `exportedAt` is `new Date()` per build, so it can never be compared. */
const stripExportedAt = (s: string): string => s.replace(/"exportedAt":"[^"]*"/g, '"exportedAt":"<t>"')

let seq = 0
const at = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString()

const userLine = (text: string): unknown => ({
  type: 'user', uuid: `u-${++seq}`, timestamp: at(),
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const assistantLine = (id: string, blocks: unknown[]): unknown => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp: at(),
  message: { id, role: 'assistant', content: blocks },
})
const toolResultLine = (toolUseId: string, content: string): unknown => ({
  type: 'user', uuid: `tr-${++seq}`, timestamp: at(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
})

async function writeJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** What the export sweep writes: the SLIM shape, so it can never carry the two
 *  fields. Deliberately different text from the JSONL, so a case can tell which
 *  source answered. */
async function writeExportedTail(sessionId: string): Promise<void> {
  await fs.mkdir(SESSION_TRANSCRIPTS_DIR, { recursive: true })
  await fs.writeFile(
    path.join(SESSION_TRANSCRIPTS_DIR, `${sessionId}.json`),
    JSON.stringify({
      version: 1, sessionId, exportedAt: '2026-01-01T00:00:00.000Z', truncated: false,
      messages: [{ role: 'user', text: 'FROM THE SWEEP FILE', timestamp: '2026-01-01T00:00:00.000Z' }],
    }),
  )
}

/** A reasoning block long enough that BOTH thinking caps bite, a tool whose
 *  input is worth an Input section, and a secret for the mask to catch. */
const REASONING = 'First, read the deploy script.\nThen, ' + 'weigh the options at length. '.repeat(200)

async function seedRichSession(sessionId: string): Promise<void> {
  await createSessionRecord(sessionId, '', '', CWD, { title: 'Coding session', initialProcessStatus: 'idle' })
  await writeJsonl(sessionId, [
    userLine('ship the release'),
    assistantLine('msg_a', [
      { type: 'thinking', thinking: REASONING },
      {
        type: 'tool_use', id: 'toolu_1', name: 'Bash',
        input: {
          command: 'curl -H "Authorization: Bearer abc123supersecrettoken" https://example.test/release',
          description: 'Kick the release',
        },
      },
    ]),
    toolResultLine('toolu_1', 'release queued'),
    assistantLine('msg_b', [{ type: 'text', text: 'Release is queued.' }]),
  ])
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('transcript ?rich=1', () => {
  it('without the parameter, answers byte-for-byte what the bare build answers', async () => {
    // The fixture HAS a reasoning block AND a tool input, so the two fields are
    // available to leak — that is the whole point of this case. A fixture without
    // them would pass no matter how wide the default shape got.
    const sid = 'sess-rich-identity'
    await seedRichSession(sid)

    const { status, text, body } = await getTranscript(sid, '?fresh=1')
    expect(status).toBe(200)

    // The pre-change route was exactly this call, with no options.
    const expected = await buildSessionTranscript(sid)
    expect(stripExportedAt(text)).toBe(stripExportedAt(JSON.stringify(expected)))

    // Stated as its own assertion so a future widening reads as a field leak
    // rather than as an opaque string diff.
    expect(text).not.toContain('inputPreview')
    expect(text).not.toContain('thinkingText')
    // The drawer's handle rides the same opt-in as the fields it points at: the
    // slim tail is what the sweep pushes over the bridge under a frame cap, and
    // a per-row token would widen every row of it for nothing.
    expect(text).not.toContain('detailRef')
    // …and the rows that WOULD carry them are present, unwidened.
    const thinking = body.messages.find((m) => m.kind === 'thinking')!
    const tool = body.messages.find((m) => m.kind === 'tool')!
    expect(thinking.text.length).toBeLessThanOrEqual(161)
    expect(thinking.thinkingText).toBeUndefined()
    expect(tool.text).toBe('Bash')
    expect(tool.detail).toBeDefined()
    expect(tool.inputPreview).toBeUndefined()
  })

  it('with rich=1, both fields arrive, capped and masked', async () => {
    const sid = 'sess-rich-fields'
    await seedRichSession(sid)

    const slim = await getTranscript(sid, '?fresh=1')
    const rich = await getTranscript(sid, '?fresh=1&rich=1')
    expect(rich.status).toBe(200)

    const thinking = rich.body.messages.find((m) => m.kind === 'thinking')!
    expect(thinking.thinkingText).toBeDefined()
    // Documented cap, +1 for the ellipsis. Newlines kept: reasoning is paragraphs.
    expect(thinking.thinkingText!.length).toBeLessThanOrEqual(2001)
    expect(thinking.thinkingText!.length).toBeGreaterThan(1000)
    expect(thinking.thinkingText).toContain('\n')
    expect(thinking.thinkingText!.startsWith('First, read the deploy script.')).toBe(true)
    // The collapsed line is untouched by the opt-in.
    expect(thinking.text).toBe(slim.body.messages.find((m) => m.kind === 'thinking')!.text)

    const tool = rich.body.messages.find((m) => m.kind === 'tool')!
    expect(tool.inputPreview).toBeDefined()
    expect(tool.inputPreview!.length).toBeLessThanOrEqual(2001)
    expect(tool.inputPreview).toContain('command: curl')
    expect(tool.inputPreview).toContain('description: Kick the release')
    // Masked by the same rule as every other preview field.
    expect(tool.inputPreview).toContain('[REDACTED]')
    expect(tool.inputPreview).not.toContain('abc123supersecrettoken')
    // `detail` stays the collapsed one-liner, not a second copy of the input.
    expect(tool.detail).toBe(slim.body.messages.find((m) => m.kind === 'tool')!.detail)

    // Everything OUTSIDE the two fields is the slim answer, unchanged: same rows,
    // same order, same text. The opt-in adds fields; it must not reshape the tail.
    const strip = (rows: Row[]): Row[] =>
      rows.map(({ inputPreview: _i, thinkingText: _t, detailRef: _d, ...rest }) => rest)
    expect(strip(rich.body.messages)).toEqual(strip(slim.body.messages))
    expect(rich.body.truncated).toBe(slim.body.truncated)
  })

  it('parses rich exactly like fresh: only the literal 1 counts', async () => {
    // Proven by symmetry rather than by asserting a convention twice: the same
    // value set runs through BOTH parameters, and each non-'1' value must leave
    // its own parameter's answer identical to omitting it. `fresh`'s effect is
    // observable because the sweep file says something the JSONL never does.
    const sid = 'sess-rich-parse'
    await seedRichSession(sid)
    await writeExportedTail(sid)

    const cached = await getTranscript(sid)
    expect(cached.body.messages[0].text).toBe('FROM THE SWEEP FILE')
    const fresh = await getTranscript(sid, '?fresh=1')
    expect(fresh.body.messages[0].text).toBe('ship the release')

    for (const value of ['true', '0', 'yes', '', '11', '1x']) {
      const asFresh = await getTranscript(sid, `?fresh=${value}`)
      expect(stripExportedAt(asFresh.text), `fresh=${value} must read as absent`)
        .toBe(stripExportedAt(cached.text))

      const asRich = await getTranscript(sid, `?fresh=1&rich=${value}`)
      expect(stripExportedAt(asRich.text), `rich=${value} must read as absent`)
        .toBe(stripExportedAt(fresh.text))
    }

    // And the literal 1 does engage, so the loop above is not passing vacuously.
    const on = await getTranscript(sid, '?fresh=1&rich=1')
    expect(on.body.messages.find((m) => m.kind === 'tool')!.inputPreview).toBeDefined()
  })

  it('a rich request is never answered with slim rows, on the second read as much as the first', async () => {
    // THE regression this case exists for, and it replaces the opposite pin.
    //
    // `rich=1` used to decorate only a tail the route BUILT, so a request that hit
    // the sweep-exported file answered without the fields — the sweep writes the
    // slim shape and cannot carry them. That was defended as protecting the phone's
    // two-phase open, but its real effect was that the SAME URL answered differently
    // depending on whether a cache file happened to exist: measured on a live box,
    // `?rich=1` gave 0 of 102 rows with `thinkingText` and `?fresh=1&rich=1` gave 39
    // of 106. A reviewer read the first number as "this box does not produce these
    // fields" and filed two defects about it. Nothing can be built against a shape
    // that depends on cache warmth, so a rich request now implies the live read on
    // the primary, and the answer says `rich: true` where the fields really are.
    //
    // The phone pays nothing for it: WalnutAPI.sessionTranscriptPath drops `rich`
    // unless `fresh` is already set, so its cached first phase is still a disk read.
    const sid = 'sess-rich-cached'
    await seedRichSession(sid)
    await writeExportedTail(sid)

    // Read 1 — the sweep file exists and is what a non-rich read still serves.
    const slim = await getTranscript(sid)
    expect(slim.body.messages[0].text).toBe('FROM THE SWEEP FILE')

    // Read 2 and read 3, same URL: the fields are there BOTH times. A cache-warmth
    // dependency would show up as one of these two being slim.
    for (const attempt of [1, 2]) {
      const { status, body } = await getTranscript(sid, '?rich=1')
      expect(status, `attempt ${attempt}`).toBe(200)
      expect(body.rich, `attempt ${attempt}: the answer must declare its rows rich`).toBe(true)
      expect(body.messages[0].text, `attempt ${attempt}: read live, not from the sweep file`)
        .toBe('ship the release')
      const thinking = body.messages.find((m) => m.kind === 'thinking')!
      const tool = body.messages.find((m) => m.kind === 'tool')!
      expect(thinking.thinkingText, `attempt ${attempt}`).toBeDefined()
      expect(tool.inputPreview, `attempt ${attempt}`).toContain('command: curl')
    }

    // …and the sweep file is untouched by any of it: a plain read still gets it, so
    // the fix did not quietly turn every transcript read into a live build.
    const after = await getTranscript(sid)
    expect(after.body.messages[0].text).toBe('FROM THE SWEEP FILE')
    expect(after.text).not.toContain('"rich"')
  })

  it('declares rich=false when it could not produce the fields, instead of answering silently slim', async () => {
    // The one path left that cannot carry them on the primary: a session with no
    // record and no readable history, whose sweep file is all there is. The rows are
    // slim — that part is unavoidable — but the response says so, which is the
    // difference between a client degrading on purpose and a client guessing.
    const sid = 'sess-rich-unreadable'
    await writeExportedTail(sid)

    const { status, body } = await getTranscript(sid, '?rich=1')
    expect(status).toBe(200)
    expect(body.rich).toBe(false)
    expect(body.messages[0].text).toBe('FROM THE SWEEP FILE')
  })

  it('rich=1 is NOT full: the tail is still sliced and text rows are still clipped', async () => {
    // THE most important case in this file. `rich` was carved out of `full`
    // precisely because reading `full` as a field switch is what produced the
    // original defect: `full` also drops the ~100-message tail slice and
    // clipTranscriptText, so wiring this route to it would have turned a tail the
    // phone refetches at every turn end into the whole unclipped conversation.
    // If `rich` ever starts implying either of those, this goes red.
    const sid = 'sess-rich-not-full'
    await createSessionRecord(sid, '', '', CWD, { title: 'Long session', initialProcessStatus: 'idle' })
    const lines: unknown[] = []
    // 130 source messages against a ~100 tail, so the slice is real and load-bearing.
    // The last assistant answer is far over the 4 KB row clip.
    for (let turn = 1; turn <= 65; turn++) {
      lines.push(userLine(`question ${turn}`))
      lines.push(assistantLine(`msg_${turn}`, [
        { type: 'thinking', thinking: `[t${turn}] weighing turn ${turn}.\nSecond paragraph of turn ${turn}.` },
        { type: 'tool_use', id: `toolu_${turn}`, name: 'Read', input: { file_path: `/Users/test/transcript-rich/mod-${turn}.ts` } },
        { type: 'text', text: `answer ${turn}. ` + 'prose that runs well past the four-kilobyte row clip. '.repeat(200) },
      ]))
    }
    await writeJsonl(sid, lines)

    const rich = await getTranscript(sid, '?fresh=1&rich=1')
    expect(rich.status).toBe(200)
    // 1. The tail STILL slices: fewer rows than the conversation has, and the
    //    flag that says so is still true.
    expect(rich.body.truncated).toBe(true)
    const firstUser = rich.body.messages.find((m) => m.role === 'user')!
    expect(firstUser.text).not.toBe('question 1') // turn 1 fell off the tail
    // 2. Text rows are STILL clipped. The source answer is ~10 KB; the clip is
    //    4 KB (12 KB only for a row carrying HTML, which this is not).
    const answers = rich.body.messages.filter((m) => !m.kind && m.role === 'assistant')
    expect(answers.length).toBeGreaterThan(0)
    for (const row of answers) {
      expect(row.text.length, 'a text row escaped clipTranscriptText').toBeLessThan(6000)
    }
    // 3. And the fields the caller actually asked for did arrive, so 1 and 2 are
    //    not passing because `rich` quietly did nothing.
    expect(rich.body.messages.find((m) => m.kind === 'tool')!.inputPreview).toContain('file_path: ')
    expect(rich.body.messages.find((m) => m.kind === 'thinking')!.thinkingText).toBeDefined()
    // 4. Row-for-row, `rich=1` is the slim answer plus the two fields: the tail
    //    it slices is the SAME tail, in the same order, with the same text.
    const slim = await getTranscript(sid, '?fresh=1')
    const strip = (rows: Row[]): Row[] =>
      rows.map(({ inputPreview: _i, thinkingText: _t, detailRef: _d, ...rest }) => rest)
    expect(strip(rich.body.messages)).toEqual(strip(slim.body.messages))
  })

  it('full still implies rich, so the lane read keeps the shape it shipped', async () => {
    // The chat read (GET /api/v1/conversations/:id/messages, api-v1.ts:889) passes
    // `{ full: true }` and has shipped these fields since 85e212ba. Carving `rich`
    // out of `full` must not have taken them away from it — and that claim should
    // not rest on reading the gate. Asserted here against the builder directly;
    // the end-to-end HTTP proof is api-v1-lane-messages.test.ts, which asserts the
    // same two fields on the lane route and must stay green alongside this.
    const sid = 'sess-rich-full-implies'
    await seedRichSession(sid)

    const full = await buildSessionTranscript(sid, { full: true })
    expect(full.messages.find((m) => m.kind === 'tool')!.inputPreview).toContain('command: curl')
    expect(full.messages.find((m) => m.kind === 'thinking')!.thinkingText).toBeDefined()
    // …and `full` still does its own three things, which `rich` must never do.
    const slim = await buildSessionTranscript(sid)
    const richOnly = await buildSessionTranscript(sid, { rich: true })
    expect(full.truncated).toBe(false)
    expect(richOnly.truncated).toBe(slim.truncated)
    // The two options agree on the FIELDS and disagree on nothing else here (this
    // fixture is shorter than the tail, so only the clip could differ).
    expect(richOnly.messages.map((m) => m.inputPreview ?? m.thinkingText ?? ''))
      .toEqual(full.messages.map((m) => m.inputPreview ?? m.thinkingText ?? ''))
  })

  it('passes the option to the route\'s OTHER inline build (no sweep file yet, session alive)', async () => {
    // Second call site: a non-fresh read whose sweep file does not exist yet
    // builds this one session inline. It must get `rich` too — a tail that is
    // rich on one path and slim on the other is the bug this batch is fixing,
    // one layer down. Runs last: this path kicks a background export sweep.
    const sid = 'sess-rich-coldstart'
    await seedRichSession(sid)
    await fs.rm(path.join(SESSION_TRANSCRIPTS_DIR, `${sid}.json`), { force: true })

    const { status, body } = await getTranscript(sid, '?rich=1')
    expect(status).toBe(200)
    expect(body.messages.find((m) => m.role === 'user')!.text).toBe('ship the release')
    expect(body.messages.find((m) => m.kind === 'tool')!.inputPreview).toContain('command: curl')
    expect(body.messages.find((m) => m.kind === 'thinking')!.thinkingText).toBeDefined()
  })
})
