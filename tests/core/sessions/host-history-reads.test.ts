/**
 * Transcript reads of a session its host runs and judges (src/core/sessions/host-history-reads.ts,
 * the host's side src/core/sessions/host-history-answer.ts): the leader's reader asks the host's
 * `history` call (src/core/session-channel/host-routes.ts), the host reads and parses its own
 * transcript, and the leader gets the parsed rows with their marks, parsing no line itself
 * (providers/line-parse-count.ts stays 0 for the session).
 *
 * Both ends are real in one process: the leader's readers (session-history.ts) and the host's
 * routes, joined by a caller that carries the body and the answer as JSON, as the wire does, and
 * counts the characters each answer moves. The host reads the fixture through the local daemon
 * reader double, so its answer is compared with the same reader run here on the same file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'
import { cutHere, transcript } from '../../helpers/transcript-fixtures.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-history-reads'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())
/** The host's own rows: the host answers from these, never from a path the leader names. */
const hostRows = new Map<string, Record<string, unknown>>()
vi.mock('../../../src/core/session-tracker.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSessionByClaudeId: async (sid: string) => hostRows.get(sid) ?? null,
}))

import { CLAUDE_HOME, WALNUT_HOME } from '../../../src/constants.js'
import {
  HistoryReadFailedError, encodeProjectPath, extractPlanContent, getCachedSessionHistory, getOrphanFinishedAgentIds, historyWindowStart,
  isSourceFoundHistory, isWindowedHistory, markHistoryRows, readSessionHistory, readSessionHistoryRange, readSessionHistoryTail,
  readSessionHistoryTailWindow, readSessionRowToolResult, readSingleSubagentHistory, _resetHistoryCacheForTesting,
} from '../../../src/core/session-history.js'
import { readSessionHistoryBefore } from '../../../src/core/session-history-pages.js'
import {
  _readHistoryHereForTesting, _resetHostHistoryReadsForTesting, _setHostHistoryDeadlineForTesting, noteHostReadsHistory,
  setHostHistoryCaller, viaJudgingHost,
} from '../../../src/core/sessions/host-history-reads.js'
import { HOST_HISTORY_ANSWERED, _parkedHistoryForTesting, _setHistoryPagingForTesting, answerHistoryRead } from '../../../src/core/sessions/host-history-answer.js'
import { HOST_CALL_ALLOWLIST, HOST_HISTORY_WIRE } from '../../../src/core/session-channel/host-calls.js'
import { createHostSessionRoutes } from '../../../src/core/session-channel/host-routes.js'
import { StartBundles } from '../../../src/core/session-channel/host-port.js'
import { _resetJudgeOfForTesting, noteHostJudged } from '../../../src/core/sessions/judge-of.js'
import { _resetLineParseCountForTesting, lineParsesOf, noteTranscriptLinesParsed } from '../../../src/providers/line-parse-count.js'
import { readSessionBody } from '../../../src/core/search/build.js'

const HOST = 'devbox'
const SID = '60000000-0000-4000-8000-0000000000a1'
const SID2 = '60000000-0000-4000-8000-0000000000a2'
const CWD = '/tmp/host-history-reads-project'
const prevCeiling = process.env.WALNUT_MAX_FILE_READ_BYTES

const owned = new Set<string>()
const routes = createHostSessionRoutes({
  enabled: async () => true, runner: async () => ({}) as never, bundles: new StartBundles(), channel: () => null,
  emit: () => {}, enqueue: async () => {}, spillDir: path.join(os.tmpdir(), 'host-history-reads-prompts'),
  owns: async (sid) => owned.has(sid),
})

/** Every call the leader made: its member, its tag, and the characters its answer moved. */
const sent: Array<{ host: string; member: string; args: unknown[]; read?: { id: string; known?: string }; chars: number; kind?: string }> = []
let hang = false
/** A read held before it reaches the host, until released (cancels pass). */
let gate: Promise<void> | null = null
async function wireCaller(host: string, body: { sid: string; target: 'history'; member: string; args: unknown[]; read?: { id: string; known?: string } }): Promise<unknown> {
  const entry: (typeof sent)[number] = { host, member: body.member, args: body.args, read: body.read, chars: 0 }
  sent.push(entry)
  if (hang && body.member !== 'cancelRead') return new Promise(() => {})
  if (gate && body.member !== 'cancelRead') await gate
  const r = await routes.call('POST', '/host-api/sessions/call', JSON.parse(JSON.stringify(body)))
  const text = JSON.stringify(r.body)
  entry.chars = text.length
  const a = JSON.parse(text) as { ok: boolean; value?: { k?: string }; error?: string }
  entry.kind = a.value?.k
  if (a.ok !== true) throw new Error(`${body.member} on ${host}: ${a.error ?? 'refused'}`)
  return a.value
}
const reads = () => sent.filter((s) => !(HOST_HISTORY_WIRE as readonly string[]).includes(s.member))

const line = (o: Record<string, unknown>) => JSON.stringify(o)
const transcriptPath = () => path.join(CLAUDE_HOME as string, 'projects', encodeProjectPath(CWD), `${SID}.jsonl`)
async function writeTranscript(extra: string[] = []): Promise<void> {
  await fsp.mkdir(path.dirname(transcriptPath()), { recursive: true })
  const lines = [
    line({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-11-24T10:00:00.000Z', message: { role: 'user', content: 'Plan the move' } }),
    line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-24T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'Reading it first.' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
    ] } }),
    line({ type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-11-24T10:00:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'alpha\nbeta\ngamma' },
    ] } }),
    line({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-11-24T10:00:03.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: { plan: '# The plan\n\n1. Move the files' } },
    ] } }),
    ...extra,
  ]
  await fsp.writeFile(transcriptPath(), lines.join('\n') + '\n')
}
/** A transcript of `turns` turns of about `pad` characters each. */
async function writeLong(turns: number, pad: number): Promise<void> {
  const lines: string[] = []
  let parent: string | null = null
  for (let i = 0; i < turns; i++) {
    const at = new Date(Date.UTC(2026, 10, 24, 10, 0, 0) + i * 2000)
    lines.push(line({ type: 'user', uuid: `lu${i}`, parentUuid: parent, timestamp: at.toISOString(), message: { role: 'user', content: `question ${i} ${'q'.repeat(pad)}` } }))
    lines.push(line({ type: 'assistant', uuid: `la${i}`, parentUuid: `lu${i}`, timestamp: new Date(at.getTime() + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i} ${'a'.repeat(pad)}` }] } }))
    parent = `la${i}`
  }
  await fsp.mkdir(path.dirname(transcriptPath()), { recursive: true })
  await fsp.writeFile(transcriptPath(), lines.join('\n') + '\n')
}
/** The same reader here, on the same file and row (the legacy read the host's answer must equal). */
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as unknown

beforeEach(async () => {
  await fsp.rm(CLAUDE_HOME as string, { recursive: true, force: true })
  await fsp.rm(path.join(WALNUT_HOME as string, 'host-history-readers.json'), { force: true })
  await writeTranscript()
  // One process plays both ends: a whole read's disk copy from an earlier test is not this test's.
  const disk = await import('../../../src/core/history-disk-cache.js')
  disk.flushHistoryCacheWrites()
  await disk.deleteHistoryCache(SID)
  await disk.deleteHistoryCache(SID2)
  _resetJudgeOfForTesting()
  _resetHistoryCacheForTesting()
  _resetLineParseCountForTesting()
  await _resetHostHistoryReadsForTesting()
  _setHistoryPagingForTesting(null)
  sent.length = 0
  hang = false
  gate = null
  owned.clear()
  hostRows.clear()
  // The host's row: its transcript is local to it (the double serves __local__ only).
  hostRows.set(SID, { claudeSessionId: SID, cwd: CWD, taskId: 't-1', project: 'Acme', status: 'idle', judge: 'host' })
  owned.add(SID)
  noteHostJudged(SID, HOST)
  noteHostReadsHistory(HOST, 'answers')
  setHostHistoryCaller(wireCaller)
})
afterEach(async () => {
  setHostHistoryCaller(null)
  await _resetHostHistoryReadsForTesting()
  _setHistoryPagingForTesting(null)
  if (prevCeiling === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES
  else process.env.WALNUT_MAX_FILE_READ_BYTES = prevCeiling
})

describe('a host-judged session is read on its host', () => {
  it('the whole history: one history call, the rows equal to the same read here, the marks kept, no line parsed here', async () => {
    const got = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    expect(reads().map((s) => s.member)).toEqual(['readSessionHistory'])
    expect(lineParsesOf(SID)).toBe(0)
    _resetHistoryCacheForTesting()
    const local = await readSessionHistory(SID, CWD, undefined, undefined, { skipSubagents: true })
    expect(got).toEqual(json(local))
    expect(got.length).toBeGreaterThan(1)
    expect(isSourceFoundHistory(got)).toBe(isSourceFoundHistory(local))
  })

  it('a tail window keeps its windowed mark and its start; a tool result comes back as its text only', async () => {
    const got = await readSessionHistoryTailWindow(SID, CWD, HOST, 64 * 1024)
    const local = await readSessionHistoryTailWindow(SID, CWD, undefined, 64 * 1024)
    expect(got).toEqual(json(local))
    expect(isWindowedHistory(got!)).toBe(isWindowedHistory(local!))
    expect(historyWindowStart(got!)).toEqual(historyWindowStart(local!))
    expect(await readSessionRowToolResult(SID, 'tool-1', 1000, CWD, HOST)).toEqual({ text: 'alpha\nbeta\ngamma', sourceChars: 'alpha\nbeta\ngamma'.length })
    expect(lineParsesOf(SID)).toBe(0)
  })

  it('plan content and the search body come back as text', async () => {
    expect(await extractPlanContent(SID, CWD, HOST)).toBe(await extractPlanContent(SID, CWD, undefined))
    const body = await readSessionBody({ claudeSessionId: SID, cwd: CWD, host: HOST } as never)
    expect(body.body).toContain('Plan the move')
    expect(lineParsesOf(SID)).toBe(0)
  })

  it('the host reads its own row: a path the leader names is not passed, and an agent id must be one', async () => {
    await readSessionHistory(SID, '/somewhere/else', HOST, '/etc/passwd')
    expect(reads()[0]!.args).toEqual([undefined])
    expect(await answerHistoryRead(SID, 'readSingleSubagentHistory', ['../../etc/passwd'])).toEqual({ ok: false, error: 'bad_request' })
  })
})

describe('an unchanged transcript moves no body (B1)', () => {
  it('two reads of an unchanged session move the rows once; a change moves them again', async () => {
    const first = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    const second = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    expect(second).toBe(first)
    const [a, b] = reads()
    expect(a!.kind).toBe('full')
    expect(b!.kind).toBe('same')
    expect(b!.read?.known).toBeTruthy()
    expect(b!.chars).toBeLessThan(100)
    expect(a!.chars).toBeGreaterThan(500)
    await writeTranscript([line({ type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: '2026-11-24T10:00:04.000Z', message: { role: 'user', content: 'One more thing' } })])
    const third = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    expect(reads()[2]!.kind).toBe('full')
    expect(third.some((m) => m.text.includes('One more thing'))).toBe(true)
    expect(lineParsesOf(SID)).toBe(0)
  })

  it('a poll of an idle session\'s tail costs no body', async () => {
    await readSessionHistoryTail(SID, CWD, HOST, undefined, 4 * 1024 * 1024, { poll: true })
    await readSessionHistoryTail(SID, CWD, HOST, undefined, 4 * 1024 * 1024, { poll: true })
    await readSessionHistoryTail(SID, CWD, HOST, undefined, 4 * 1024 * 1024, { poll: true })
    expect(reads().map((s) => s.kind)).toEqual(['full', 'same', 'same'])
  })

  it('reads of the same in one tick share one call', async () => {
    const [x, y, z] = await Promise.all([1, 2, 3].map(() => readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })))
    expect(reads()).toHaveLength(1)
    expect(y).toBe(x)
    expect(z).toBe(x)
  })
})

describe('a large answer comes in pages, never one frame past the cap (S1)', () => {
  it('pages join to the same rows, each frame under the page size', async () => {
    _setHistoryPagingForTesting({ pageChars: 300 })
    const got = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    _resetHistoryCacheForTesting()
    expect(got).toEqual(json(await readSessionHistory(SID, CWD, undefined, undefined, { skipSubagents: true })))
    const pages = sent.filter((s) => s.member === 'readNextPage')
    expect(pages.length).toBeGreaterThan(0)
    for (const s of sent) expect(s.chars).toBeLessThan(300 * 2 + 200)
    expect(_parkedHistoryForTesting().answers).toBe(0)
  })

  it('a reader with no window to fall back to answers too_large past the cap, and degrades as its failed read', async () => {
    _setHistoryPagingForTesting({ pageChars: 300, maxChars: 400 })
    expect(await readSessionHistoryTailWindow(SID, CWD, HOST)).toBeNull()
    expect(reads()[0]!.kind).toBe('too_large')
    expect(lineParsesOf(SID)).toBe(0)
  })

  it('past the cap, a whole read and a tail answer the legacy over-ceiling tail window, marked windowed (R2-S2)', async () => {
    await writeLong(50, 400)
    _setHistoryPagingForTesting({ maxChars: 20_000, tailBytes: 8 * 1024 })
    const whole = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    const tail = await readSessionHistoryTail(SID, CWD, HOST)
    _resetHistoryCacheForTesting()
    const local = await readSessionHistoryTailWindow(SID, CWD, undefined, 8 * 1024)
    expect(local && isWindowedHistory(local)).toBe(true)
    expect(whole).toEqual(json(local))
    expect(tail).toEqual(json(local))
    expect(isWindowedHistory(whole)).toBe(true)
    expect(historyWindowStart(whole)).toEqual(historyWindowStart(local!))
    expect(reads().map((r) => r.kind)).toEqual(['full', 'full'])
    expect(lineParsesOf(SID)).toBe(0)
  })

  it('a ~28 MB session (under the legacy 32 MiB read) comes whole, in pages, equal to the read here (R2-S2)', async () => {
    await writeLong(1000, 14_000)
    expect((await fsp.stat(transcriptPath())).size).toBeGreaterThan(27 * 1024 * 1024)
    const got = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    _resetHistoryCacheForTesting()
    const local = await readSessionHistory(SID, CWD, undefined, undefined, { skipSubagents: true })
    expect(isWindowedHistory(local)).toBe(false)
    expect(got.length).toBe(local.length)
    expect(got).toEqual(json(local))
    expect(reads()[0]!.kind).toBe('paged')
    expect(sent.filter((s) => s.member === 'readNextPage').length).toBeGreaterThan(3)
    for (const s of sent) expect(s.chars).toBeLessThan(5 * 1024 * 1024)
    expect(_parkedHistoryForTesting().answers).toBe(0)
  }, 120_000)
})

describe('parked answers being taken are never dropped (R2-S1)', () => {
  it('two large reads at once (two whale sessions) both come whole, their pages taken in turns', async () => {
    await writeLong(40, 400)
    await fsp.copyFile(transcriptPath(), transcriptPath().replace(SID, SID2))
    hostRows.set(SID2, { ...hostRows.get(SID)!, claudeSessionId: SID2, taskId: 't-2' })
    owned.add(SID2)
    noteHostJudged(SID2, HOST)
    _setHistoryPagingForTesting({ pageChars: 3000, maxAnswers: 2 })
    // Neither read takes a page before both are parked: the second park finds the first in flight.
    let most = 0
    let bothParked!: () => void
    const barrier = new Promise<void>((r) => { bothParked = r })
    let parkedReads = 0
    const caller = async (host: string, body: Parameters<typeof wireCaller>[1]) => {
      const got = await wireCaller(host, body) as { k?: string }
      most = Math.max(most, _parkedHistoryForTesting().answers)
      if (got.k === 'paged' && ++parkedReads === 2) bothParked()
      if (got.k === 'paged') await barrier
      return got
    }
    setHostHistoryCaller(caller as never)
    const [one, two] = await Promise.all([
      readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true }),
      readSessionHistory(SID2, CWD, HOST, undefined, { skipSubagents: true }),
    ])
    expect(most).toBe(2)
    _resetHistoryCacheForTesting()
    expect(one).toEqual(json(await readSessionHistory(SID, CWD, undefined, undefined, { skipSubagents: true })))
    expect(two).toEqual(json(await readSessionHistory(SID2, CWD, undefined, undefined, { skipSubagents: true })))
    expect(sent.filter((s) => s.member === 'readNextPage').every((s) => s.kind === 'page')).toBe(true)
    expect(_parkedHistoryForTesting().answers).toBe(0)
  })

  it('with the parking full a new large read is refused busy (its failed read), and its next try is served', async () => {
    await writeLong(40, 400)
    _setHistoryPagingForTesting({ pageChars: 3000, maxAnswers: 1 })
    const first = await answerHistoryRead(SID, 'readSessionHistoryTail', [], { id: 'held' })
    expect(first.ok && first.value.k).toBe('paged')
    await expect(readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })).rejects.toBeInstanceOf(HistoryReadFailedError)
    expect(reads().at(-1)!.kind).toBe('busy')
    // The held read is still whole: every one of its pages comes.
    const pages = first.ok && first.value.k === 'paged' ? first.value.pages : 0
    for (let n = 1; n < pages; n++) {
      const page = await answerHistoryRead(SID, 'readNextPage', ['held', n])
      expect(page.ok && page.value.k).toBe('page')
    }
    expect(_parkedHistoryForTesting().answers).toBe(0)
    const again = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    expect(again.length).toBeGreaterThan(0)
    expect(lineParsesOf(SID)).toBe(0)
  })

  it('a cancel drops the parked pages of that read', async () => {
    await writeLong(40, 400)
    _setHistoryPagingForTesting({ pageChars: 3000 })
    const first = await answerHistoryRead(SID, 'readSessionHistoryTail', [], { id: 'gave-up' })
    expect(first.ok && first.value.k).toBe('paged')
    expect(_parkedHistoryForTesting().answers).toBe(1)
    await answerHistoryRead(SID, 'cancelRead', ['gave-up'])
    expect(_parkedHistoryForTesting().answers).toBe(0)
    const page = await answerHistoryRead(SID, 'readNextPage', ['gave-up', 1])
    expect(page.ok && page.value.k).toBe('gone')
  })
})

describe('a read the leader gave up on (S2)', () => {
  it('waits the legacy remote budget by default, and a cancel stops the host\'s answer', async () => {
    let release!: () => void
    gate = new Promise<void>((r) => { release = r })
    _setHostHistoryDeadlineForTesting(50)
    const here = vi.fn(async () => [] as never)
    await expect(viaJudgingHost(SID, HOST, 'readSessionHistory', [{ skipSubagents: true }], here)).rejects.toBeInstanceOf(HistoryReadFailedError)
    await vi.waitFor(() => expect(sent.some((s) => s.member === 'cancelRead')).toBe(true))
    release()
    await vi.waitFor(() => expect(sent[0]!.kind).toBe('cancelled'))
    expect(sent[0]!.chars).toBeLessThan(80)
    expect(here).not.toHaveBeenCalled()
    _setHostHistoryDeadlineForTesting(null)
    const { HOST_HISTORY_DEADLINE_MS } = await import('../../../src/core/sessions/host-history-reads.js')
    expect(HOST_HISTORY_DEADLINE_MS).toBe(120_000)
  })

  it('each reader answers its own failed read, never reading here', async () => {
    hang = true
    _setHostHistoryDeadlineForTesting(50)
    const here = vi.fn(async () => 'here')
    await expect(viaJudgingHost(SID, HOST, 'readSessionHistory', [], here)).rejects.toBeInstanceOf(HistoryReadFailedError)
    await expect(viaJudgingHost(SID, HOST, 'readSessionHistoryTail', [], here)).rejects.toBeInstanceOf(HistoryReadFailedError)
    expect(await viaJudgingHost(SID, HOST, 'extractPlanContent', [], here)).toBeNull()
    expect(await viaJudgingHost(SID, HOST, 'readSessionHistoryTailWindow', [], here)).toBeNull()
    expect(await viaJudgingHost(SID, HOST, 'readSessionRowToolResult', [], here)).toBeUndefined()
    expect(await viaJudgingHost(SID, HOST, 'readSessionBody', [], here)).toEqual({ body: null })
    expect(here).not.toHaveBeenCalled()
    expect(lineParsesOf(SID)).toBe(0)
  })
})

describe('a host that answered reads is never parsed here while its service is down (S3)', () => {
  it('answers the kept copy (the whole history marked stale by its callers), recovers when the host is back', async () => {
    const plan = await extractPlanContent(SID, CWD, HOST)
    const whole = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    noteHostReadsHistory(HOST, 'down')
    sent.length = 0
    expect(await extractPlanContent(SID, CWD, HOST)).toBe(plan)
    await expect(readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })).rejects.toBeInstanceOf(HistoryReadFailedError)
    // What the history route and the phone's rich history serve, marked stale, on a failed read.
    expect(getCachedSessionHistory(SID, HOST)).toBe(whole)
    expect(await readSessionHistoryTailWindow(SID, CWD, HOST, 1024)).toBeNull()
    expect(sent).toHaveLength(0)
    expect(lineParsesOf(SID)).toBe(0)
    noteHostReadsHistory(HOST, 'answers')
    expect((await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })).length).toBe(whole.length)
    expect(sent).toHaveLength(1)
  })

  it('a leader restarted while the host is down remembers it answers reads (on disk): degraded, never parsed', async () => {
    await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    await vi.waitFor(async () => expect(JSON.parse(await fsp.readFile(path.join(WALNUT_HOME as string, 'host-history-readers.json'), 'utf8'))).toEqual({ hosts: [HOST] }))
    await _resetHostHistoryReadsForTesting()
    setHostHistoryCaller(wireCaller)
    noteHostReadsHistory(HOST, 'down')
    const here = vi.fn(async () => [] as never)
    await expect(viaJudgingHost(SID, HOST, 'readSessionHistory', [{ skipSubagents: true }], here)).rejects.toBeInstanceOf(HistoryReadFailedError)
    expect(here).not.toHaveBeenCalled()
    expect(lineParsesOf(SID)).toBe(0)
  })

  it('a host running an older service (no capability) is read here, as before', async () => {
    noteHostReadsHistory(HOST, 'old')
    expect(await viaJudgingHost(SID, HOST, 'readSessionHistory', [], countedHere)).toBe('here')
    expect(sent).toHaveLength(0)
    expect(lineParsesOf(SID)).toBe(3)
  })
})

describe('read here instead', () => {
  it('a legacy session, a host never seen answering reads, or no leader side: read here, its lines counted', async () => {
    _resetJudgeOfForTesting()
    expect(await viaJudgingHost(SID, HOST, 'readSessionHistory', [], countedHere)).toBe('here')
    noteHostJudged(SID, HOST)
    expect(await viaJudgingHost(SID, 'otherbox', 'readSessionHistory', [], countedHere)).toBe('here')
    expect(sent).toHaveLength(0)
    expect(lineParsesOf(SID)).toBe(6)
  })

  it('a local read is never routed and never counted', async () => {
    expect(await viaJudgingHost(SID, undefined, 'readSessionHistory', [], countedHere)).toBe('here')
    expect(await viaJudgingHost(SID, '__local__', 'readSessionHistory', [], countedHere)).toBe('here')
    expect(sent).toHaveLength(0)
    expect(lineParsesOf(SID)).toBe(0)
  })

  it('arguments JSON cannot carry (a Set) are read here', async () => {
    expect(await viaJudgingHost(SID, HOST, 'readSessionHistoryTailWindow', [1024, { chainFilter: { deadUuids: new Set(['x']) } }], countedHere)).toBe('here')
    expect(sent).toHaveLength(0)
  })

  it('the host says the session is not its own: read here', async () => {
    owned.clear()
    expect(await viaJudgingHost(SID, HOST, 'readSessionHistory', [], countedHere)).toBe('here')
    expect(sent).toHaveLength(1)
  })

  it('the legacy read the e2e compares against: the switch for tests reads here', async () => {
    _readHistoryHereForTesting(true)
    expect(await viaJudgingHost(SID, HOST, 'readSessionHistory', [], countedHere)).toBe('here')
    expect(sent).toHaveLength(0)
  })
})

describe('the host\'s answer equals the read here, mark by mark (S4)', () => {
  it('windowed: a cold read bounded to its tail keeps the mark and the window start', async () => {
    await writeLong(40, 400)
    const got = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true, maxColdReadBytes: 8 * 1024 })
    _resetHistoryCacheForTesting()
    const local = await readSessionHistory(SID, CWD, undefined, undefined, { skipSubagents: true, maxColdReadBytes: 8 * 1024 })
    expect(isWindowedHistory(local)).toBe(true)
    expect(got).toEqual(json(local))
    expect(isWindowedHistory(got)).toBe(true)
    expect(historyWindowStart(got)).toEqual(historyWindowStart(local))
  })

  it('over the reader\'s ceiling: the whole read falls back to the tail, the same on both ends', async () => {
    await writeLong(60, 400)
    process.env.WALNUT_MAX_FILE_READ_BYTES = String(16 * 1024)
    const got = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    _resetHistoryCacheForTesting()
    const local = await readSessionHistory(SID, CWD, undefined, undefined, { skipSubagents: true })
    expect(local.length).toBeGreaterThan(0)
    expect(got).toEqual(json(local))
    expect(isWindowedHistory(got)).toBe(isWindowedHistory(local))
    expect(historyWindowStart(got)).toEqual(historyWindowStart(local))
  })

  it('a session with an in-place rewind: the abandoned branch is gone on both ends', async () => {
    const t = transcript()
    t.user('r-u1', 'first').assistant('r-a1', 'reply one').user('r-u2', 'second')
    t.assistant('r-dead', 'ABANDONED reply')
    const cut = cutHere(t, 'r-u2')
    t.from('r-u2').user('r-new', 'the live branch')
    await fsp.writeFile(transcriptPath(), t.text())
    hostRows.set(SID, { ...hostRows.get(SID), inPlaceRewinds: [cut] })
    const got = await readSessionHistory(SID, CWD, HOST, undefined, { skipSubagents: true })
    _resetHistoryCacheForTesting()
    const local = await readSessionHistory(SID, CWD, undefined, undefined, { skipSubagents: true })
    expect(local.some((m) => m.text.includes('ABANDONED'))).toBe(false)
    expect(got).toEqual(json(local))
  })

  it('older pages: a byte range keeps its file size, epoch and first stamp; a page before a time is the same', async () => {
    await writeLong(30, 300)
    const size = (await fsp.stat(transcriptPath())).size
    const got = await readSessionHistoryRange(SID, CWD, HOST, 0, Math.floor(size / 2))
    const local = await readSessionHistoryRange(SID, CWD, undefined, 0, Math.floor(size / 2))
    expect(got).toEqual(json(local))
    expect(got!.epoch).toBe(local!.epoch)
    expect(got!.firstTimestamp).toBe(local!.firstTimestamp)
    const want = { minMessages: 4, minText: 0, isText: () => true }
    const before = '2026-11-24T10:00:40.000Z'
    const page = await readSessionHistoryBefore(SID, CWD, HOST, before, want)
    const localPage = await readSessionHistoryBefore(SID, CWD, undefined, before, want)
    expect(page!.messages).toEqual(json(localPage!.messages))
    expect(page!.reachedStart).toBe(localPage!.reachedStart)
    expect(lineParsesOf(SID)).toBe(0)
  })

  it('a subagent\'s rows come back as read here', async () => {
    expect(await readSingleSubagentHistory(SID, 'abc123', CWD, HOST)).toEqual(json(await readSingleSubagentHistory(SID, 'abc123', CWD, undefined)))
  })
})

describe('the host side', () => {
  it('answers every reader of the allowlist, and refuses one it does not have', async () => {
    const readers = HOST_CALL_ALLOWLIST.history.filter((m) => !(HOST_HISTORY_WIRE as readonly string[]).includes(m))
    expect([...HOST_HISTORY_ANSWERED].sort()).toEqual([...readers].sort())
    expect(await answerHistoryRead(SID, 'readEverything', [])).toEqual({ ok: false, error: 'no_such_member' })
    expect(await answerHistoryRead('60000000-0000-4000-8000-0000000000ff', 'readSessionHistory', [])).toEqual({ ok: false, error: 'no_row' })
    const r = await routes.call('POST', '/host-api/sessions/call', { sid: SID, target: 'history', member: 'readEverything', args: [] })
    expect(r.body).toEqual({ ok: false, error: 'not_allowed' })
  })

  it('the marks of a parse cross with its rows', async () => {
    const rows = [{ role: 'user', text: 'x' }]
    markHistoryRows(rows, { windowed: true, windowStart: { byte: 12, epoch: 'e1' }, sourceFound: true, orphans: ['tool-9'] })
    expect(isWindowedHistory(rows)).toBe(true)
    expect(historyWindowStart(rows)).toEqual({ byte: 12, epoch: 'e1' })
    expect(isSourceFoundHistory(rows)).toBe(true)
    expect([...getOrphanFinishedAgentIds(rows) ?? []]).toEqual(['tool-9'])
  })
})

/** A read here that parses three lines, as a reader's parse would count them. */
async function countedHere(): Promise<string> {
  noteTranscriptLinesParsed(3)
  return 'here'
}
