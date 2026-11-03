/**
 * A background read of a remote transcript joins a read of the same file already in
 * flight; it never moves the same bytes again beside it.
 *
 * 2026-11-02 (CI, host-read-silent-link-e2e): once a sweep the throttle turned away
 * was owed instead of dropped, the minute transcript sweep read a 3 MB remote
 * transcript at the same moment as the open session's history, over a 64 KB/s link.
 * Each family had its own in-flight dedup (readSessionHistory keys on its options, the
 * history route on its request shape), so the two never met: two whole-file reads side
 * by side, each at half the link, and the history the person waited for took 261 s
 * instead of 131 s. DaemonFileReader, where every family's read meets, now shares one
 * read per file, stat and range.
 *
 * Real: session records in SQLite, the projection export, the transcript sweep, the
 * history route's read (readProviderSessionHistory with the cold tail bound), the
 * history parse, DaemonFileReader. Mocked: constants (temp dirs) and the host's link,
 * a daemon double serving a temp "box home" from disk whose fs.readRange answers wait
 * on a gate, so both reads are in flight before any byte arrives.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-transcript-read-shared'))

const HOST = 'box-shared-read'
const BOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-shared-read-box-'))

/** The daemon double: what each read moved and where each transfer began, and a gate on fs.readRange. */
const wire = vi.hoisted(() => ({
  bytes: new Map<string, number>(),
  /** Per path, the offset of every fs.readRange asked (a transfer's chunks follow its first). */
  starts: new Map<string, number[]>(),
  held: [] as Array<() => void>,
  holding: false,
  /** fs.readRange answers that fail before reading (a dropped link). */
  failNext: 0,
}))

vi.mock('../../src/core/hosts/link.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/hosts/link.js')>()
  const fsm = await import('node:fs')
  const toBox = (p: string): string => (p.startsWith('~/') ? path.join(BOX_HOME, p.slice(2)) : p)
  const moved = (p: string, n: number): void => { wire.bytes.set(p, (wire.bytes.get(p) ?? 0) + n) }
  const send = async (cmd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const p = toBox(String(args.path ?? ''))
    if (cmd === 'fs.stat') {
      if (!fsm.existsSync(p)) return { ok: true, exists: false }
      const st = fsm.statSync(p)
      return { ok: true, exists: true, mtimeMs: st.mtimeMs, size: st.size, dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs }
    }
    if (cmd === 'fs.readRange') {
      wire.starts.set(p, [...(wire.starts.get(p) ?? []), args.start as number])
      if (wire.holding) await new Promise<void>((resolve) => wire.held.push(resolve))
      if (wire.failNext > 0) { wire.failNext--; return { ok: false, error: 'link dropped' } }
      if (!fsm.existsSync(p)) return { ok: false, error: 'no such file (ENOENT)' }
      const buf = fsm.readFileSync(p)
      const start = args.start as number
      const slice = buf.subarray(start, Math.min(start + (args.length as number), buf.length))
      moved(p, slice.length)
      return { ok: true, data: slice.toString('base64'), bytesRead: slice.length, fileSize: buf.length, eof: start + slice.length >= buf.length }
    }
    if (cmd === 'fs.read') {
      if (!fsm.existsSync(p)) return { ok: false, error: 'no such file (ENOENT)' }
      const text = fsm.readFileSync(p, 'utf-8')
      moved(p, Buffer.byteLength(text))
      return { ok: true, data: text }
    }
    if (cmd === 'fs.find' || cmd === 'fs.ls') return { ok: true, files: [], entries: [] }
    return { ok: false, error: `unknown command ${cmd}` }
  }
  return { ...real, linkTarget: () => ({ hostname: HOST }), link: async () => ({ send, hasCapability: () => false }) }
})

import { createSessionRecord } from '../../src/core/session-tracker.js'
import { encodeProjectPath, HISTORY_COLD_TAIL_READ_BYTES, _resetHistoryCacheForTesting } from '../../src/core/session-history.js'
import { readProviderSessionHistory } from '../../src/core/sessions/session-lifecycle.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { exportSessionProjection, exportSessionTranscripts, _resetTranscriptSweepForTesting } from '../../src/core/session-projection.js'
import { _resetTailWindowsForTesting } from '../../src/core/history-tail-window.js'
import { log } from '../../src/logging/index.js'
import { DaemonFileReader } from '../../src/core/daemon-file-reader.js'

const CWD = '/home/dev/shared-read'
const boxPath = (sid: string): string => path.join(BOX_HOME, '.claude', 'projects', encodeProjectPath(CWD), `${sid}.jsonl`)

/** A chained transcript of about `bytes`; returns its last answer's words. */
async function writeTranscript(sid: string, bytes: number): Promise<string> {
  const lines: string[] = []
  let size = 0
  let parent: string | null = null
  let i = 0
  for (; size < bytes; i++) {
    const at = Date.parse('2026-09-01T00:00:00Z') + i * 2000
    const user = JSON.stringify({ type: 'user', uuid: `u-${i}`, parentUuid: parent, sessionId: sid, cwd: CWD, timestamp: new Date(at).toISOString(), message: { role: 'user', content: `question ${i}` } })
    const asst = JSON.stringify({ type: 'assistant', uuid: `a-${i}`, parentUuid: `u-${i}`, sessionId: sid, cwd: CWD, timestamp: new Date(at + 1000).toISOString(), message: { id: `msg_${i}`, role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: `answer ${i} ${'x'.repeat(4000)}` }] } })
    lines.push(user, asst)
    size += user.length + asst.length + 2
    parent = `a-${i}`
  }
  await fsp.mkdir(path.dirname(boxPath(sid)), { recursive: true })
  await fsp.writeFile(boxPath(sid), lines.join('\n') + '\n')
  lastIndexBySid.set(sid, i - 1)
  return `answer ${i - 1} `
}
const lastIndexBySid = new Map<string, number>()
const lastIndex = (sid: string): number => lastIndexBySid.get(sid)!

/** Joins of a read in flight, as DaemonFileReader reports them. */
let joins = 0

function release(): void {
  wire.holding = false
  for (const go of wire.held.splice(0)) go()
}

/** The open session's history read (GET /history?tail=400) and the sweep, both started before a byte moves. */
async function historyAndSweep(sid: string): Promise<{ history: string[]; swept: number }> {
  const record = await getSessionByClaudeId(sid)
  wire.holding = true
  joins = 0
  const history = readProviderSessionHistory(sid, record, HOST, true, { maxColdReadBytes: HISTORY_COLD_TAIL_READ_BYTES })
  await vi.waitFor(() => expect(wire.held.length).toBe(1), { timeout: 10_000 })
  const sweep = exportSessionTranscripts()
  // The sweep reaches the same file while the history read still waits for its first
  // byte: it either joins that read or (the regression) starts its own beside it.
  await vi.waitFor(() => expect(joins + wire.held.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 })
  release()
  const [h, swept] = await Promise.all([history, sweep])
  return { history: h.messages.map((m) => m.text ?? ''), swept }
}

const startsAt = (sid: string, offset: number): number => (wire.starts.get(boxPath(sid)) ?? []).filter((s) => s === offset).length

beforeEach(() => {
  wire.bytes.clear()
  wire.starts.clear()
  wire.failNext = 0
  vi.spyOn(log.session, 'info').mockImplementation((msg: string) => { if (msg.includes('joined a read in flight')) joins++ })
  _resetTranscriptSweepForTesting()
  _resetTailWindowsForTesting()
  _resetHistoryCacheForTesting()
})

afterEach(() => {
  vi.restoreAllMocks()
  release()
  _resetTranscriptSweepForTesting()
})

async function aliveRemoteSession(sid: string): Promise<void> {
  await createSessionRecord(sid, '', '', CWD, { title: 'Shared read', host: HOST, initialProcessStatus: 'idle' })
  await exportSessionProjection()
}

describe('a background transcript read beside a history read of the same file', () => {
  it('a transcript under the tail bound (one whole-file read): the sweep joins it, the bytes move once', async () => {
    const sid = 'sess-shared-whole-read'
    const last = await writeTranscript(sid, 3 * 1024 * 1024)
    await aliveRemoteSession(sid)
    const { history, swept } = await historyAndSweep(sid)
    const size = fs.statSync(boxPath(sid)).size
    expect(history.at(-1)).toContain(last)
    expect(swept).toBeGreaterThan(0)
    // One transfer from the first byte, the file's size moved once.
    expect(startsAt(sid, 0)).toBe(1)
    expect(wire.bytes.get(boxPath(sid))).toBe(size)
  })

  it('a transcript over the tail bound (one tail-window read): the sweep joins it, the window moves once', async () => {
    const sid = 'sess-shared-window-read'
    const last = await writeTranscript(sid, 5 * 1024 * 1024)
    await aliveRemoteSession(sid)
    const { history, swept } = await historyAndSweep(sid)
    expect(history.at(-1)).toContain(last)
    expect(swept).toBeGreaterThan(0)
    // One transfer of the last 4 MB. (The full read after it is the history route's own
    // warm-up of its incremental state, started once its window answered: never beside it.)
    expect(startsAt(sid, fs.statSync(boxPath(sid)).size - HISTORY_COLD_TAIL_READ_BYTES)).toBe(1)
  })

  it('a read after the file changed is its own: it never takes the bytes of the read before', async () => {
    const sid = 'sess-shared-read-fresh'
    await writeTranscript(sid, 3 * 1024 * 1024)
    await aliveRemoteSession(sid)
    await historyAndSweep(sid)
    const reply = JSON.stringify({ type: 'assistant', uuid: 'a-late', parentUuid: `a-${lastIndex(sid)}`, sessionId: sid, cwd: CWD, timestamp: '2026-12-01T00:00:00.000Z', message: { id: 'msg_late', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: 'the late reply' }] } })
    await fsp.appendFile(boxPath(sid), reply + '\n')
    const record = await getSessionByClaudeId(sid)
    const again = await readProviderSessionHistory(sid, record, HOST, true, { maxColdReadBytes: HISTORY_COLD_TAIL_READ_BYTES })
    expect(again.messages.map((m) => m.text ?? '')).toContain('the late reply')
  })

  it('a file that changed while a read of it is in flight gets a read of its own', async () => {
    const sid = 'sess-shared-read-moved'
    await writeTranscript(sid, 3 * 1024 * 1024)
    const remote = `~/.claude/projects/${encodeProjectPath(CWD)}/${sid}.jsonl`
    wire.holding = true
    const first = new DaemonFileReader(HOST).readFile(remote)
    await vi.waitFor(() => expect(wire.held.length).toBe(1), { timeout: 10_000 })
    await fsp.appendFile(boxPath(sid), '{"type":"user","uuid":"u-moved","message":{"role":"user","content":"moved"}}\n')
    const second = new DaemonFileReader(HOST).readFile(remote)
    // The second stat differs (size, mtime): it starts its own transfer instead of joining.
    await vi.waitFor(() => expect(wire.held.length).toBe(2), { timeout: 10_000 })
    release()
    const [, b] = await Promise.all([first, second])
    expect(startsAt(sid, 0)).toBe(2)
    expect(b).toContain('u-moved')
  })

  it('a read whose link dropped is shared to its end and then forgotten: the next read moves the bytes again', async () => {
    const sid = 'sess-shared-read-failed'
    await writeTranscript(sid, 3 * 1024 * 1024)
    const remote = `~/.claude/projects/${encodeProjectPath(CWD)}/${sid}.jsonl`
    wire.holding = true
    wire.failNext = 1
    const a = new DaemonFileReader(HOST).readFile(remote)
    await vi.waitFor(() => expect(wire.held.length).toBe(1), { timeout: 10_000 })
    const b = new DaemonFileReader(HOST).readFile(remote)
    await vi.waitFor(() => expect(joins).toBe(1), { timeout: 10_000 })
    release()
    const results = await Promise.allSettled([a, b])
    // The failed chunk is retried inside the one shared read; both callers get its answer.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(joins).toBe(1)
    const size = fs.statSync(boxPath(sid)).size
    const before = wire.bytes.get(boxPath(sid)) ?? 0
    // The same file at the same stat, after the shared read settled: a new transfer, not a stale answer.
    const again = await new DaemonFileReader(HOST).readFile(remote)
    expect(again).toContain('answer ')
    expect((wire.bytes.get(boxPath(sid)) ?? 0) - before).toBe(size)
  })
})
