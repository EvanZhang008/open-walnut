import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-warm-start'))
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { findSessionByClaudeId: () => undefined },
}))

import ts from 'typescript'
import { initialFoldState, foldLine, assembleSnapshot, snapshotDiffers, type SessionSnapshot } from '../../src/providers/daemon-fold.js'
import { applySnapshot, setSnapshotModeForTests, _resetSnapshotApplyForTests, _resetSnapshotGateForTests } from '../../src/core/session-snapshot-apply.js'
import { createSessionRecord, getSessionByClaudeId, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { buildDeps, createDaemonCore } from '../helpers/daemon-core-fixtures.js'

// The daemon's own snapshot push (assembleSessionSnapshot, emitSnapshot, pushSnapshot) and its
// marker command, cut from daemon-standalone.ts and run against the real daemon core.
const source = fs.readFileSync(path.join(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
function region(from: string, to: string): string {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  if (start < 0 || end <= start) throw new Error(`daemon region not found: ${from}`)
  return source.slice(start, end)
}
const daemonCode = ts.transpileModule(
  region('function streamEpochOf(', '// ── daemon-core wiring ──') + '\n'
    + region('function cmdAppendUserMarker(', '// ── Set session mode ──'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText
const sid = 'warm-start'
const line = (value: unknown) => JSON.stringify(value) + '\n'
const endedTurn = line({ type: 'system', subtype: 'init' })
  + line({ type: 'result', is_error: false, num_turns: 1 })
  + line({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

let cleanupCore: (() => Promise<void>) | null = null

async function harness() {
  const jsonlPath = path.join(WALNUT_HOME, 'stream.jsonl')
  fs.writeFileSync(jsonlPath, endedTurn)
  const ctx = await buildDeps()
  cleanupCore = ctx.cleanup
  const session = {
    jsonlPath, foldState: initialFoldState(), state: 'running', pid: 4242,
    exitCode: null, pendingCtrl: null, subscribers: new Set([{ readyState: 1 }]),
    streamEpoch: 'warm-stream', lastPushedSnapshot: null as SessionSnapshot | null, snapshotTimer: null,
  }
  ctx.sessions.set(sid, session as unknown as Parameters<typeof ctx.sessions.set>[1])
  const core = createDaemonCore(ctx.deps)
  const frames: SessionSnapshot[] = []
  let offset = 0
  const foldAvailable = () => {
    const bytes = fs.readFileSync(jsonlPath)
    for (;;) {
      const end = bytes.indexOf(10, offset)
      if (end < 0) break
      session.foldState = foldLine(session.foldState, bytes.subarray(offset, end).toString('utf8'), end + 1)
      offset = end + 1
    }
  }
  foldAvailable()
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const api = new Function('fs', 'sessions', 'core', 'sendEvent', 'assembleSnapshot', 'snapshotDiffers', 'SNAPSHOT_COALESCE_MS', 'sendOk', 'sendError',
    `${daemonCode}\nreturn { cmdAppendUserMarker, pushSnapshot };`)(
    fs, ctx.sessions, core, (_ws: unknown, _ev: string, data: { snapshot: SessionSnapshot }) => frames.push(data.snapshot),
    assembleSnapshot, snapshotDiffers, 50,
    (_ws: unknown, _id: string, result: { ok: boolean }) => expect(result.ok).toBe(true),
    (_ws: unknown, _id: string, error: string) => { throw new Error(error) },
  ) as { cmdAppendUserMarker: (ws: null, id: string, cmd: { sid: string; message: string; messageId: string }) => void; pushSnapshot: (sid: string, immediate: boolean) => void }
  api.pushSnapshot(sid, true)
  return { api, session, frames, foldAvailable, jsonlPath }
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  bus.clear()
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  setSnapshotModeForTests('enforce')
  await createSessionRecord(sid, '', 'test-project', WALNUT_HOME, { pid: 4242 })
})

afterEach(async () => {
  vi.useRealTimers()
  await cleanupCore?.()
  cleanupCore = null
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('warm turn-start snapshot acceptance', () => {
  it.each([10, 90, 250])('publishes an accepted start when the tailer arrives at %i ms', async (tailerMs) => {
    const h = await harness()
    const idle = h.frames[0]
    expect((await applySnapshot(sid, idle, 'daemon-push')).outcome).toBe('applied')
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(idle.v)

    vi.useFakeTimers()
    const text = `Repeat ${String.fromCodePoint(0x4f60, 0x597d, 0x1f680)}\n` + 'long input '.repeat(6000)
    h.api.cmdAppendUserMarker(null, 'rpc-warm', { sid, message: text, messageId: 'qm-warm' })
    setTimeout(() => { h.foldAvailable(); h.api.pushSnapshot(sid, false) }, tailerMs)
    await vi.advanceTimersByTimeAsync(tailerMs + 51)
    vi.useRealTimers()

    const starts = h.frames.slice(1)
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ cliState: 'running', turnActive: true, pid: 4242 })
    expect(starts[0].v).toBe(fs.statSync(h.jsonlPath).size)
    expect(starts[0].v).toBeGreaterThan(idle.v)
    expect((await applySnapshot(sid, starts[0], 'daemon-push')).outcome).toBe('applied')
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(idle.v)

    h.foldAvailable()
    h.api.pushSnapshot(sid, true)
    fs.appendFileSync(h.jsonlPath, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }))
    h.foldAvailable()
    h.api.pushSnapshot(sid, true)
    expect(h.frames).toHaveLength(2)
  })

  it('settles raced output without losing lines or leaving a phantom running turn', async () => {
    const h = await harness()
    await applySnapshot(sid, h.frames[0], 'daemon-push')
    vi.useFakeTimers()
    h.api.cmdAppendUserMarker(null, 'rpc-fast', { sid, message: 'quick reply', messageId: 'qm-fast' })
    fs.appendFileSync(h.jsonlPath, endedTurn)
    await vi.advanceTimersByTimeAsync(70)
    h.foldAvailable()
    h.api.pushSnapshot(sid, false)
    await vi.advanceTimersByTimeAsync(51)
    vi.useRealTimers()
    const final = h.frames.at(-1)!
    expect(final).toMatchObject({ cliState: 'idle', turnActive: false, pid: 4242 })
    expect(final.v).toBe(fs.statSync(h.jsonlPath).size)
    await applySnapshot(sid, final, 'daemon-push')
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('idle')
  })
})
