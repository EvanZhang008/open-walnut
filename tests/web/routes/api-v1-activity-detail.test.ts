/**
 * GET /api/v1/activity/detail — the full text behind ONE expanded activity row.
 *
 * The defect: the row fields a drawer opens on are EXCERPTS, and the drawer showed
 * nothing else. Measured on a live box, one reasoning block held 4,380 characters
 * while the API's longest `thinkingText` was exactly 2,001 (the 2,000-char cap plus
 * an ellipsis) — 46% of it — and a long tool result was cut at 700. A drawer whose
 * entire purpose is "open it to see everything" silently dropping the tail is a
 * defect, not a nuance.
 *
 * Raising the caps was the wrong fix and the numbers say why: a 200-row page is
 * already 202-278KB, one transcript carried 39 thinking rows, and average full
 * reasoning is several KB — so inlining it adds ~150KB to a payload the phone
 * refetches at every turn end, over cellular. The list read stays slim; the tail is
 * fetched per row, on the tap that asks for it.
 *
 * What each case pins:
 *  - the ROW advertises the fetch (`detailRef`) only when there IS more than the
 *    excerpt, so its presence is exactly the client's "show a full-text affordance"
 *    predicate and can never be a button that returns the same text;
 *  - the read returns the WHOLE thing, tail included, with an honest total;
 *  - a tool row answers input and result as separate sections;
 *  - REDACTION SURVIVES THE WIDENING: a secret sitting past the 700-char preview
 *    cap — i.e. one the old excerpt never reached — is still masked at full length.
 *    The drawer must not become a way to read credentials out of tool output;
 *  - a section too large for one response pages by offset, and the cursor is exact;
 *  - a LONG TOOL RESULT reads to its end. The retained-row cap the history parse
 *    applies (HISTORY_TOOL_RESULT_MAX) exists because a whole-transcript parse holds
 *    every row's result at once; a single-row read has no such problem, so it lifts
 *    the cap for that one tool_use_id. Before this, a 24,993-character result came
 *    back as 4,999 characters with `truncated: false` — a sentence ending mid-phrase
 *    and nothing anywhere saying so;
 *  - NOTHING EVER CLAIMS TO BE WHOLE WHEN IT IS NOT: a response that carries less
 *    than the row's text says `truncated: true` and reports the SOURCE length, even
 *    where no page cursor can be offered;
 *  - a ref that no longer resolves is a 410 (the client keeps its excerpt), and
 *    garbage is a 400 — never a neighbouring row's text;
 *  - the identity survives a RE-READ of the same JSONL after another turn lands,
 *    which is the whole reason it is a message id and a slot rather than a row
 *    position (the transcript serves a sliding tail).
 *
 * Real: Express server (startServer), the api-v1 router, session records in SQLite,
 * and the whole read pipeline (readSessionHistoryTail → DaemonFileReader →
 * parseSessionMessages) against JSONL written to disk. Mocked: constants (temp
 * dirs) and the '__local__' daemon file reader, which in production expands
 * `~/.claude` through its own process HOME and so cannot see fixtures under the
 * mocked CLAUDE_HOME.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-activity-detail'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath, HISTORY_TOOL_RESULT_MAX } from '../../../src/core/session-history.js'
import { FULL_TEXT_SECTION_MAX } from '../../../src/core/tool-summary.js'

const CWD = '/Users/test/activity-detail'

let server: HttpServer
let port: number
const apiUrl = (p: string): string => `http://localhost:${port}${p}`

interface Row {
  role: string
  text: string
  kind?: string
  detail?: string
  resultPreview?: string
  inputPreview?: string
  thinkingText?: string
  detailRef?: string
}
interface Detail {
  version: number
  kind: string
  toolName?: string
  text?: string
  textChars?: number
  textNextOffset?: number
  textTruncated?: boolean
  input?: string
  inputChars?: number
  inputNextOffset?: number
  inputTruncated?: boolean
  result?: string
  resultChars?: number
  resultNextOffset?: number
  resultTruncated?: boolean
  offset: number
  truncated: boolean
}

async function rows(sid: string, qs = '?fresh=1&rich=1'): Promise<Row[]> {
  const res = await fetch(apiUrl(`/api/v1/sessions/${sid}/transcript${qs}`))
  expect(res.status).toBe(200)
  return (await res.json() as { messages: Row[] }).messages
}

async function detail(qs: string): Promise<{ status: number; body: Detail; error?: { code: string } }> {
  const res = await fetch(apiUrl(`/api/v1/activity/detail${qs}`))
  const body = await res.json() as Detail & { error?: { code: string } }
  return { status: res.status, body, error: body.error }
}

const byRef = (ref: string, extra = ''): string => `?ref=${encodeURIComponent(ref)}${extra}`

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

// ── The fixture, built around the two numbers from the field report ──
//
// Reasoning of 4,380-ish characters (the measured block) with a unique marker at
// the very END: the old drawer showed the first 2,000 and the marker was exactly
// what a user could never reach.
const REASONING_HEAD = 'First, read the deploy script and see which release it pins.\n'
const REASONING = REASONING_HEAD
  + 'Then weigh the options at length before touching anything. '.repeat(70)
  + '\nLast paragraph: REASONING-TAIL-MARKER.'

// A tool result well past the 700-char preview, with a credential sitting ~3KB in
// — past everything the excerpt could ever have masked, so a mask hit there proves
// the full read runs the rule too.
const RESULT_SECRET = 'aws_secret_access_key=testfixturefakesecretvalue0123456789abcd'
const RESULT = 'line of ordinary build output\n'.repeat(70)
  + `\n${RESULT_SECRET}\n`
  + 'more output after the credential\n'.repeat(60)
  + 'RESULT-TAIL-MARKER\n'

// An input whose `command` alone blows past the 2,000-char inputPreview cap.
const LONG_COMMAND = 'deploy --stage prod --wait --verbose --annotate "release 1.9.0" && '.repeat(60)
  + 'echo INPUT-TAIL-MARKER'

async function seedSession(sessionId: string): Promise<void> {
  await createSessionRecord(sessionId, '', '', CWD, { title: 'Coding session', initialProcessStatus: 'idle' })
  await writeJsonl(sessionId, [
    userLine('ship the release'),
    // The reasoning rides a message that also has text: the parser drops an
    // assistant message with thinking and NOTHING else (an abandoned API call), so
    // a thinking-only fixture would test a row that production never produces.
    assistantLine('msg_reason', [{ type: 'thinking', thinking: REASONING }, { type: 'text', text: 'Checking.' }]),
    assistantLine('msg_tools', [
      { type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: LONG_COMMAND, description: 'Deploy' } },
      { type: 'tool_use', id: 'toolu_short', name: 'Read', input: { file_path: '/Users/test/activity-detail/mod.ts' } },
    ]),
    toolResultLine('toolu_long', RESULT),
    toolResultLine('toolu_short', 'export const x = 1'),
    assistantLine('msg_done', [{ type: 'text', text: 'Release is queued.' }]),
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

describe('activity detail: which rows advertise it', () => {
  it('offers the fetch only on rows the excerpt could not hold', async () => {
    const sid = 'act-refs'
    await seedSession(sid)
    const list = await rows(sid)

    const thinking = list.find((m) => m.kind === 'thinking')!
    const longTool = list.find((m) => m.text === 'Bash')!
    const shortTool = list.find((m) => m.text === 'Read')!

    // The excerpt really is cut — otherwise the ref below would be pinning nothing.
    expect(thinking.thinkingText!.endsWith('…')).toBe(true)
    expect(thinking.detailRef).toBeDefined()
    // The input's clip is INSIDE the render, not at its end: the fat `command` is
    // cut to its own per-value cap so the keys after it still appear. So the row is
    // "incomplete" without ending in an ellipsis, which is exactly why the ref is
    // minted from the renderer's own verdict rather than by sniffing the text.
    expect(longTool.inputPreview).toContain('…')
    expect(longTool.inputPreview).not.toContain('INPUT-TAIL-MARKER')
    expect(longTool.inputPreview).toContain('description: Deploy')
    expect(longTool.resultPreview!.endsWith('…')).toBe(true)
    expect(longTool.detailRef).toBeDefined()

    // …and a row whose input and result BOTH fit carries no ref. A ref here would
    // put a "see everything" affordance in front of the user and then answer with
    // the text already on screen.
    expect(shortTool.resultPreview).toBe('export const x = 1')
    expect(shortTool.detailRef).toBeUndefined()
  })

  it('rides the rich opt-in only: the slim tail the bridge pushes is unchanged', async () => {
    const sid = 'act-refs-slim'
    await seedSession(sid)
    const slim = await rows(sid, '?fresh=1')
    expect(slim.some((m) => m.detailRef !== undefined)).toBe(false)
  })
})

describe('activity detail: the whole text', () => {
  it('returns the reasoning block entire, tail included', async () => {
    const sid = 'act-reasoning'
    await seedSession(sid)
    const thinking = (await rows(sid)).find((m) => m.kind === 'thinking')!

    const { status, body } = await detail(byRef(thinking.detailRef!))
    expect(status).toBe(200)
    expect(body.kind).toBe('thinking')
    expect(body.truncated).toBe(false)
    // The exact defect: the tail. The excerpt stopped ~2,000 characters in.
    expect(body.text).toContain('REASONING-TAIL-MARKER')
    expect(body.text!.startsWith(REASONING_HEAD.trim().slice(0, 40))).toBe(true)
    // Whole, not merely longer: this fixture has no secrets in it, so the returned
    // text is the source verbatim.
    expect(body.text).toBe(REASONING.trim())
    expect(body.textChars).toBe(REASONING.trim().length)
    expect(body.textChars!).toBeGreaterThan(4_000)
    expect(body.textNextOffset).toBeUndefined()
    // A tool row's sections are absent on a reasoning row rather than empty.
    expect(body.input).toBeUndefined()
    expect(body.result).toBeUndefined()
  })

  it('returns a tool row input and result as separate sections', async () => {
    const sid = 'act-tool'
    await seedSession(sid)
    const tool = (await rows(sid)).find((m) => m.text === 'Bash')!

    const { status, body } = await detail(byRef(tool.detailRef!))
    expect(status).toBe(200)
    expect(body.kind).toBe('tool')
    expect(body.toolName).toBe('Bash')
    // Input: the whole command, and the key the collapsed row preferred is still
    // beside it (rendered in the input's own key order).
    expect(body.input).toContain('command: deploy --stage prod')
    expect(body.input).toContain('INPUT-TAIL-MARKER')
    expect(body.input).toContain('description: Deploy')
    expect(body.inputChars!).toBeGreaterThan(2_000)
    // Result: past the 700-char preview, to its last line.
    expect(body.result).toContain('RESULT-TAIL-MARKER')
    // The total is the DELIVERED length. This fixture carries a credential, so masking
    // shrank it below the source — see the case that pins that rule on its own.
    expect(body.resultChars).toBe(body.result!.length)
    expect(body.resultChars!).toBeLessThan(RESULT.trim().length)
    expect(body.truncated).toBe(false)
  })

  it('reads a long result to its END, past the cap a whole-transcript parse keeps', async () => {
    // The reported defect, at the reported size. A 24,993-character result came back
    // as 4,999 characters with `truncated: false`, so the drawer showed a sentence
    // ending mid-phrase and said nothing — the cap the history parse applies per
    // retained row (HISTORY_TOOL_RESULT_MAX) had leaked into the read whose entire
    // job is the opposite.
    //
    // That cap is right where it is: a whole-transcript parse holds EVERY row's
    // result at once, and the list read's display field is a 700-character preview
    // anyway. It is wrong here, because this reads exactly one row — so the row is
    // re-read with the cap lifted for its tool_use_id alone.
    const sid = 'act-long-result'
    await createSessionRecord(sid, '', '', CWD, { title: 'Big read', initialProcessStatus: 'idle' })
    const big = 'line of output from a long test run\n'.repeat(713) + 'BEYOND-THE-RETAINED-CAP'
    expect(big.length).toBeGreaterThan(HISTORY_TOOL_RESULT_MAX * 4)
    await writeJsonl(sid, [
      userLine('run the tests'),
      assistantLine('msg_big', [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'npm test' } }]),
      toolResultLine('toolu_b', big),
    ])
    const tool = (await rows(sid)).find((m) => m.text === 'Bash')!
    // The row itself still carries only the preview — the list read is untouched.
    expect(tool.resultPreview!.length).toBeLessThanOrEqual(701)

    const { body } = await detail(byRef(tool.detailRef!))
    expect(body.result).toContain('BEYOND-THE-RETAINED-CAP')
    expect(body.result).toBe(big.trim())
    expect(body.resultChars).toBe(big.trim().length)
    expect(body.truncated).toBe(false)
    expect(body.resultNextOffset).toBeUndefined()
  })

  it('masks a secret that only the lifted cap can reach', async () => {
    // The redaction rule has to hold on the NEW path too, and this is the offset that
    // proves it runs there: past HISTORY_TOOL_RESULT_MAX, so the credential is in
    // bytes no read of this session ever returned before today. A cap lift that
    // skipped the masker would be a credential leak introduced by a bug fix.
    const secret = 'aws_secret_access_key=zzPASTTHEROWCAPzz'
    const big = 'ordinary build output line\n'.repeat(400)
      + `\nwriting credentials: ${secret}\n`
      + 'trailing output\n'.repeat(50) + 'LIFTED-TAIL'
    expect(big.indexOf(secret)).toBeGreaterThan(HISTORY_TOOL_RESULT_MAX)

    const sid = 'act-secret-lifted'
    await createSessionRecord(sid, '', '', CWD, { title: 'Secretive', initialProcessStatus: 'idle' })
    await writeJsonl(sid, [
      userLine('build it'),
      assistantLine('msg_sl', [{ type: 'tool_use', id: 'toolu_sl', name: 'Bash', input: { command: 'make' } }]),
      toolResultLine('toolu_sl', big),
    ])
    const tool = (await rows(sid)).find((m) => m.text === 'Bash')!
    const { body } = await detail(byRef(tool.detailRef!))
    expect(body.result).toContain('LIFTED-TAIL')            // the lift did happen…
    expect(body.result).toContain('[REDACTED]')             // …and the masker ran
    expect(body.result).not.toContain('zzPASTTHEROWCAPzz')
    // Delivered whole, so the total is the delivered length — smaller than the source
    // here, because the mask replaced a longer credential with `[REDACTED]`.
    expect(body.resultChars).toBe(body.result!.length)
    expect(body.resultChars!).toBeLessThan(big.trim().length)
  })

  it('counts a fully delivered MASKED result after masking, so N equals M', async () => {
    // The device report: `result` 6,838 characters (masked, whole, end marker on
    // screen), `resultChars: 6999` (the PRE-masking source), no truncation flag, no
    // cursor — and the drawer's footer read "Showing the first 6,838 of 6,999
    // characters.", naming 161 characters that do not exist and that no request could
    // ever return. Masking legitimately SHRINKS text, so a source count is not a fact
    // about the text a client can display.
    //
    // This case needs a credential in it BY CONSTRUCTION: with no secret, masking is
    // the identity and pre/post lengths agree, which is exactly how the bug survived
    // 257 green tests.
    const sid = 'act-masked-total'
    await createSessionRecord(sid, '', '', CWD, { title: 'Masked', initialProcessStatus: 'idle' })
    const credential = 'aws_secret_access_key=testfixturefakesecretvalue0123456789abcd'
    const source = 'ordinary build output line\n'.repeat(220)
      + `${credential}\n`.repeat(6)
      + 'MASKED-TOTAL-TAIL'
    await writeJsonl(sid, [
      userLine('deploy'),
      assistantLine('msg_mt', [{ type: 'tool_use', id: 'toolu_mt', name: 'Bash', input: { command: 'deploy' } }]),
      toolResultLine('toolu_mt', source),
    ])
    const tool = (await rows(sid)).find((m) => m.text === 'Bash')!
    const { body } = await detail(byRef(tool.detailRef!))

    // Whole: the tail arrived, and the credentials did not.
    expect(body.result).toContain('MASKED-TOTAL-TAIL')
    expect(body.result).toContain('[REDACTED]')
    expect(body.result).not.toContain('testfixturefakesecretvalue0123456789abcd')
    // The claim under test: the number names the text that was delivered.
    expect(body.resultChars).toBe(body.result!.length)
    // …and masking really did shrink it, so the old rule would have failed here.
    expect(body.resultChars!).toBeLessThan(source.trim().length)
    // Nothing is withheld, so nothing says otherwise and there is nothing to press.
    expect(body.resultTruncated).toBeUndefined()
    expect(body.resultNextOffset).toBeUndefined()
    expect(body.truncated).toBe(false)
  })

  it('offers NO cursor when the row cannot be re-read, and still states the real total', async () => {
    // The asymmetry, built the way production reaches it rather than with a fake host:
    // the transcript read is given the session's `outputFile` and finds the rows there,
    // while the uncapped single-row re-read range-reads the CANONICAL JSONL, which this
    // session does not have. So the row resolves, its result is the retained prefix,
    // and the rest is genuinely unreachable.
    //
    // Measured before the fix: `resultNextOffset: 4999` was advertised and the
    // follow-up `part=result&offset=4999` answered 200 with `result: ""`. A cursor
    // must only exist when asking for it advances.
    const sid = 'act-unreachable'
    const snapshot = path.join(WALNUT_HOME, 'streams', `${sid}.jsonl`)
    await fs.mkdir(path.dirname(snapshot), { recursive: true })
    const big = 'output line from a long run\n'.repeat(900) + 'UNREACHABLE-TAIL'
    expect(big.length).toBeGreaterThan(HISTORY_TOOL_RESULT_MAX * 4)
    await fs.writeFile(snapshot, [
      userLine('run it'),
      assistantLine('msg_un', [{ type: 'tool_use', id: 'toolu_un', name: 'Bash', input: { command: 'run' } }]),
      toolResultLine('toolu_un', big),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    await createSessionRecord(sid, '', '', CWD, {
      title: 'Snapshot only', initialProcessStatus: 'idle', outputFile: snapshot,
    })

    const tool = (await rows(sid)).find((m) => m.text === 'Bash')!
    expect(tool.detailRef).toBeDefined()
    const { status, body } = await detail(byRef(tool.detailRef!))
    expect(status).toBe(200)
    // Honest on all three counts: the prefix, the true total, and no cursor.
    expect(body.result!.length).toBe(HISTORY_TOOL_RESULT_MAX)
    expect(body.resultChars).toBe(big.length)
    expect(body.resultTruncated).toBe(true)
    expect(body.truncated).toBe(true)
    expect(body.resultNextOffset).toBeUndefined()
    expect(body.result).not.toContain('UNREACHABLE-TAIL')
  })

  it('never reports a cut result as complete, and never a total smaller than the source', async () => {
    // The invariant, at the only cap that still exists for a result: one response's
    // per-section ceiling. A result over it must page, and page 1 must SAY it is
    // partial and state the real total — the failure mode this defect was made of is
    // a confident `truncated: false` on text that was cut.
    const sid = 'act-huge-result'
    await createSessionRecord(sid, '', '', CWD, { title: 'Huge read', initialProcessStatus: 'idle' })
    const huge = 'z'.repeat(FULL_TEXT_SECTION_MAX + 4_321) + 'HUGE-RESULT-TAIL'
    await writeJsonl(sid, [
      userLine('cat the log'),
      assistantLine('msg_h', [{ type: 'tool_use', id: 'toolu_h', name: 'Read', input: { file_path: '/tmp/log' } }]),
      toolResultLine('toolu_h', huge),
    ])
    const tool = (await rows(sid)).find((m) => m.text === 'Read')!

    const first = await detail(byRef(tool.detailRef!))
    expect(first.body.result!.length).toBe(FULL_TEXT_SECTION_MAX)
    expect(first.body.resultChars).toBe(huge.length)
    expect(first.body.truncated).toBe(true)
    expect(first.body.resultTruncated).toBe(true)
    expect(first.body.resultNextOffset).toBe(FULL_TEXT_SECTION_MAX)
    expect(first.body.result).not.toContain('HUGE-RESULT-TAIL')

    const second = await detail(byRef(tool.detailRef!, `&part=result&offset=${first.body.resultNextOffset}`))
    expect(second.status).toBe(200)
    expect(second.body.truncated).toBe(false)
    expect(second.body.resultTruncated).toBeUndefined()
    expect(second.body.result).toContain('HUGE-RESULT-TAIL')
    // The pages join exactly: both were rendered from the same source offsets.
    expect(first.body.result! + second.body.result!).toBe(huge)
    // Asking for the result alone leaves the input out rather than re-sending it.
    expect(second.body.input).toBeUndefined()
  })

  it('says WHICH section fell short, not just that something did', async () => {
    // A payload-wide flag cannot label a section: this row's input is clipped by the
    // renderer while its result is whole, so a client that ORed one flag into both
    // would print "showing the first N of M" under output it holds entirely. The
    // per-section flags are also the only signal that covers a clipped INPUT, whose
    // `inputChars` is a lower bound and can equal the text it came with — arithmetic
    // on the numbers cannot see that case at all.
    const sid = 'act-per-section'
    await seedSession(sid)
    const tool = (await rows(sid)).find((m) => m.text === 'Bash')!
    const whole = await detail(byRef(tool.detailRef!))
    expect(whole.body.inputTruncated).toBeUndefined()
    expect(whole.body.resultTruncated).toBeUndefined()
    expect(whole.body.truncated).toBe(false)

    // A huge input beside an ordinary result: one section short, one section whole.
    const sid2 = 'act-per-section-split'
    await createSessionRecord(sid2, '', '', CWD, { title: 'Split', initialProcessStatus: 'idle' })
    await writeJsonl(sid2, [
      userLine('write the file'),
      assistantLine('msg_ps', [{
        type: 'tool_use', id: 'toolu_ps', name: 'Write',
        input: { file_path: '/tmp/out.txt', content: 'q'.repeat(FULL_TEXT_SECTION_MAX + 2_000) },
      }]),
      toolResultLine('toolu_ps', 'wrote 202000 bytes'),
    ])
    const split = (await rows(sid2)).find((m) => m.text === 'Write')!
    const body = (await detail(byRef(split.detailRef!))).body
    expect(body.inputTruncated).toBe(true)
    expect(body.result).toBe('wrote 202000 bytes')
    expect(body.resultTruncated).toBeUndefined()
    // The top-level flag is the OR of the two, which is exactly why it cannot label
    // either one on its own.
    expect(body.truncated).toBe(true)
  })

  it('a result sitting EXACTLY on a cap is complete, not complete-looking', async () => {
    // The neighbouring trap: an off-by-one in either bound turns "exactly full" into
    // a phantom extra page (a client fetches an empty tail) or turns "one character
    // over" into a silent cut. Both bounds are pinned from the same fixture pair.
    const sid = 'act-exact-cap'
    await createSessionRecord(sid, '', '', CWD, { title: 'Exact', initialProcessStatus: 'idle' })
    const exact = 'e'.repeat(HISTORY_TOOL_RESULT_MAX)
    const overByOne = 'o'.repeat(HISTORY_TOOL_RESULT_MAX) + 'X'
    await writeJsonl(sid, [
      userLine('two reads'),
      assistantLine('msg_x', [
        { type: 'tool_use', id: 'toolu_exact', name: 'Read', input: { file_path: '/tmp/exact' } },
        { type: 'tool_use', id: 'toolu_over', name: 'Grep', input: { pattern: 'x' } },
      ]),
      toolResultLine('toolu_exact', exact),
      toolResultLine('toolu_over', overByOne),
    ])
    const list = await rows(sid)

    const atCap = await detail(byRef(list.find((m) => m.text === 'Read')!.detailRef!))
    expect(atCap.body.resultChars).toBe(HISTORY_TOOL_RESULT_MAX)
    expect(atCap.body.result).toBe(exact)
    expect(atCap.body.truncated).toBe(false)
    expect(atCap.body.resultNextOffset).toBeUndefined()

    const overCap = await detail(byRef(list.find((m) => m.text === 'Grep')!.detailRef!))
    expect(overCap.body.resultChars).toBe(HISTORY_TOOL_RESULT_MAX + 1)
    expect(overCap.body.result!.endsWith('X')).toBe(true)
    expect(overCap.body.truncated).toBe(false)
  })

  it('keeps a secret masked at FULL length, past where the preview ever reached', async () => {
    // The redaction proof, and its whole value is WHERE the credential sits: past
    // 700 (`resultPreview`) and past 2000 (the widest excerpt any row field has), so
    // the preview masker demonstrably never saw these bytes. If the full read shipped
    // raw text, this is the offset at which a drawer starts leaking credentials that
    // no surface leaked before.
    expect(RESULT.indexOf(RESULT_SECRET)).toBeGreaterThan(2_000)
    const sid = 'act-secret'
    await seedSession(sid)
    const tool = (await rows(sid)).find((m) => m.text === 'Bash')!
    // The excerpt stops long before the credential, so it is no evidence either way.
    expect(tool.resultPreview!.length).toBeLessThanOrEqual(701)
    expect(tool.resultPreview).not.toContain('aws_secret_access_key')

    const { body } = await detail(byRef(tool.detailRef!))
    expect(body.result).toContain('[REDACTED]')
    expect(body.result).not.toContain('testfixturefakesecretvalue0123456789abcd')
    // The masker rewrote the value, not the surrounding output: the section is still
    // the whole result.
    expect(body.result).toContain('aws_secret_access_key=')
    expect(body.result).toContain('RESULT-TAIL-MARKER')
  })

  it('keeps a secret masked inside a long REASONING block too', async () => {
    // Same proof, the other section. A model quotes what it just read ("the config
    // says token=…, so I will…"), and this credential sits past 2000 characters, so
    // only the full read ever reaches it. Reasoning is not a safer source than a
    // tool's output, and it is the section with no upstream length cap at all.
    const secret = 'aws_secret_access_key=zzREASONINGSECRETzz'
    const reasoning = 'Weighing the deploy options carefully. '.repeat(80)
      + `\nThe credentials file says ${secret}, so the deploy can proceed.\n`
      + 'REASONING-SECRET-TAIL'
    expect(reasoning.indexOf(secret)).toBeGreaterThan(2_000)

    const sid = 'act-secret-reasoning'
    await createSessionRecord(sid, '', '', CWD, { title: 'Reasoned', initialProcessStatus: 'idle' })
    await writeJsonl(sid, [
      userLine('deploy it'),
      assistantLine('msg_rsec', [{ type: 'thinking', thinking: reasoning }, { type: 'text', text: 'Deploying.' }]),
    ])
    const thinking = (await rows(sid)).find((m) => m.kind === 'thinking')!
    expect(thinking.thinkingText).not.toContain('zzREASONINGSECRETzz')

    const { body } = await detail(byRef(thinking.detailRef!))
    expect(body.text).toContain('REASONING-SECRET-TAIL') // the tail did arrive…
    expect(body.text).toContain('[REDACTED]')            // …masked on the way
    expect(body.text).not.toContain('zzREASONINGSECRETzz')
    // The same post-masking count rule holds on this section: N equals M, and M is
    // below the source because the mask shortened the credential.
    expect(body.textChars).toBe(body.text!.length)
    expect(body.textChars!).toBeLessThan(reasoning.trim().length)
    expect(body.textTruncated).toBeUndefined()
  })
})

describe('activity detail: paging a section too big for one response', () => {
  it('pages by offset with an exact cursor, and refuses an ambiguous one', async () => {
    // Over the per-section ceiling, so `nextOffset` is real rather than theoretical.
    // Reasoning is the section that can get there: the parse keeps a thinking block
    // whole (no equivalent of the 5,000-char result cap), which is also why the
    // originally reported defect was a reasoning block.
    const sid = 'act-huge'
    const HUGE = 'x'.repeat(FULL_TEXT_SECTION_MAX + 5_000) + 'HUGE-TAIL'
    await createSessionRecord(sid, '', '', CWD, { title: 'Huge', initialProcessStatus: 'idle' })
    await writeJsonl(sid, [
      userLine('think it through'),
      assistantLine('msg_huge', [{ type: 'thinking', thinking: HUGE }, { type: 'text', text: 'Done.' }]),
    ])
    const thinking = (await rows(sid)).find((m) => m.kind === 'thinking')!
    expect(thinking.detailRef).toBeDefined()

    const first = await detail(byRef(thinking.detailRef!))
    expect(first.body.truncated).toBe(true)
    expect(first.body.textTruncated).toBe(true)
    expect(first.body.text!.length).toBe(FULL_TEXT_SECTION_MAX)
    expect(first.body.textNextOffset).toBe(FULL_TEXT_SECTION_MAX)
    expect(first.body.textChars).toBe(HUGE.length)
    expect(first.body.text).not.toContain('HUGE-TAIL')

    const second = await detail(byRef(thinking.detailRef!, `&part=reasoning&offset=${first.body.textNextOffset}`))
    expect(second.status).toBe(200)
    expect(second.body.offset).toBe(FULL_TEXT_SECTION_MAX)
    expect(second.body.truncated).toBe(false)
    expect(second.body.textNextOffset).toBeUndefined()
    // Exact, not approximate: the two pages joined ARE the source. A cursor derived
    // from masked lengths would drift and drop characters here.
    expect(first.body.text! + second.body.text!).toBe(HUGE)

    // An offset with no part cannot be answered: on a tool row the same number
    // means a different place in the input than in the result.
    const ambiguous = await detail(byRef(thinking.detailRef!, '&offset=10'))
    expect(ambiguous.status).toBe(400)
    expect(ambiguous.error!.code).toBe('bad_request')
    // …and a part that does not exist on this row is "gone", not another row's text.
    const wrongPart = await detail(byRef(thinking.detailRef!, '&part=result'))
    expect(wrongPart.status).toBe(410)
  })
})

describe('activity detail: failing closed', () => {
  it('answers 410 (never 404) for a row that is gone, and 400s a ref it never minted', async () => {
    // Why 410 and not 404, which is the obvious choice: an OLDER server answers 404
    // for this URL because it has no such ROUTE, and the client's two reactions have
    // to differ (hide the affordance entirely vs. tell the user the text is gone).
    // 410 can only come from a server that has the route, so the two are decidable
    // without sniffing the error body's shape.
    const sid = 'act-missing'
    await seedSession(sid)
    const thinking = (await rows(sid)).find((m) => m.kind === 'thinking')!

    // Same session, a message id that is not in the transcript — what a rewind, a
    // compaction, or a whale's bounded read window leaves behind. The answer must be
    // "gone", never the nearest row's text.
    const stale = thinking.detailRef!.replace('msg_reason', 'msg_never_written')
    const gone = await detail(byRef(stale))
    expect(gone.status).toBe(410)
    expect(gone.error!.code).toBe('detail_gone')

    // A real message, a slot it does not have (only one tool on msg_tools' sibling).
    const noSuchSlot = await detail(byRef(thinking.detailRef!.replace(/~k$/, '~t7')))
    expect(noSuchSlot.status).toBe(410)

    for (const bad of ['', 'nonsense', '1~sid', '9~sid~msg~k', '1~../etc~msg~k', '1~sid~msg~zz']) {
      const res = await detail(byRef(bad))
      expect(res.status, `ref ${JSON.stringify(bad)} must not be accepted`).toBe(400)
      expect(res.error!.code).toBe('bad_request')
    }
    const noRef = await detail('')
    expect(noRef.status).toBe(400)
  })

  it('answers 503 (never 500) when the transcript cannot be read at all', async () => {
    // A session on a host this box cannot reach: the read THROWS rather than coming
    // back empty. A 500 tells the client "this server is broken" about a session that
    // is merely unreachable, and this repo has a rule against answering a path question
    // with an errno — the honest answer is the retryable 503 a timeout already gets, so
    // the drawer retries once and then keeps its excerpt.
    const sid = 'act-unreachable-host'
    await seedSession(sid)
    const ref = (await rows(sid)).find((m) => m.kind === 'thinking')!.detailRef!
    // Repoint the same session at a host with no daemon, so only the READ changes.
    const gone = 'act-unreachable-host-remote'
    await createSessionRecord(gone, '', '', CWD, {
      title: 'Away', initialProcessStatus: 'idle', host: 'nosuchhost',
    })
    const res = await detail(byRef(ref.replace(sid, gone)))
    expect(res.status).toBe(503)
    expect(res.error!.code).toBe('unavailable')
  })

  it('resolves the same row after another turn lands, which a row position could not', async () => {
    // The identity claim, tested the only way that means anything: take a ref from
    // one read, append a turn to the JSONL, and resolve it after the row has moved.
    const sid = 'act-stable'
    await seedSession(sid)
    const before = (await rows(sid)).find((m) => m.kind === 'thinking')!
    const ref = before.detailRef!
    const firstRead = await detail(byRef(ref))
    expect(firstRead.status).toBe(200)

    await writeJsonl(sid, [
      userLine('ship the release'),
      assistantLine('msg_reason', [{ type: 'thinking', thinking: REASONING }, { type: 'text', text: 'Checking.' }]),
      assistantLine('msg_tools', [
        { type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: LONG_COMMAND, description: 'Deploy' } },
      ]),
      toolResultLine('toolu_long', RESULT),
      // The new turn: every row above it keeps its message id and shifts position.
      userLine('and now the changelog'),
      assistantLine('msg_after', [{ type: 'thinking', thinking: 'A second block of reasoning.' }]),
      assistantLine('msg_after_text', [{ type: 'text', text: 'Done.' }]),
    ])

    const after = await detail(byRef(ref))
    expect(after.status).toBe(200)
    expect(after.body.text).toBe(firstRead.body.text)
    expect(after.body.text).toContain('REASONING-TAIL-MARKER')
  })
})
