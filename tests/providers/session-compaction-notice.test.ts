/**
 * The CLI's compaction lines, as they actually arrive, become ONE UI row.
 *
 * Reported 2026-09-18: five "Compacting context..." rows above one "Context
 * compacted 444K tokens". Those five were one compaction. Two independent causes,
 * both reproduced here with real line shapes taken from this machine's stream
 * files:
 *
 *   1. `{"type":"system","subtype":"status","status":"compacting"}` is a 30-SECOND
 *      TRANSPORT KEEP-ALIVE the CLI re-emits for the whole compaction
 *      (claude-code `services/compact/compact.ts` → `setInterval(… setSDKStatus
 *      ('compacting'), 30_000)`), and a real auto-compaction measurably runs
 *      147-539s.
 *   2. A daemon reattach replays the stream tail, and system lines have no dedup
 *      key of their own (only text/tool_use do), so every replayed line used to
 *      become another row.
 *
 * The boundary also has to be idempotent for a second reason: its handler fires a
 * `/context`-equivalent CLI query, which a replay would run again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { COMPACTED_MESSAGE, COMPACTING_MESSAGE } from '../../src/core/stream/compaction-notice.js'

const SID = 'sess-compaction'

function feed(session: ClaudeCodeSession, line: Record<string, unknown>): void {
  (session as unknown as { handleStreamLine(line: string): void })
    .handleStreamLine(JSON.stringify(line))
}

function init(session: ClaudeCodeSession): void {
  feed(session, {
    type: 'system', subtype: 'init', session_id: SID, cwd: '/tmp',
    model: 'mock-model', tools: [], mcp_servers: [], permissionMode: 'default',
  })
}

/** Real shape from ~/.open-walnut/tmp/streams/*.jsonl. */
function compactingLine(uuid: string): Record<string, unknown> {
  return { type: 'system', subtype: 'status', status: 'compacting', session_id: SID, uuid }
}
function boundaryLine(uuid: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'system', subtype: 'compact_boundary', session_id: SID, uuid,
    compact_metadata: {
      trigger: 'auto', pre_tokens: 443847, post_tokens: 49108,
      cumulative_dropped_tokens: 17494300, duration_ms: 181769,
      ...extra,
    },
  }
}

interface Notice { variant: string; message: string; detail?: string; progress?: boolean }

function captureNotices(): Notice[] {
  const seen: Notice[] = []
  bus.subscribe('main-ai', (event) => {
    if (event.name !== EventNames.SESSION_SYSTEM_EVENT) return
    const p = event.data as Notice
    seen.push({ variant: p.variant, message: p.message, detail: p.detail, progress: p.progress })
  })
  return seen
}

beforeEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('ClaudeCodeSession: compaction emits one notice per compaction', () => {
  it('a 5-minute compaction (11 keep-alives) emits ONE placeholder, then the outcome', () => {
    const session = new ClaudeCodeSession('task-compact-1', 'proj')
    init(session)
    const notices = captureNotices()

    // 11 keep-alives ≈ a 330s compaction, inside the measured 147-539s range.
    for (let i = 0; i < 11; i++) feed(session, compactingLine(`ka-${i}`))
    expect(notices).toEqual([
      { variant: 'compact', message: COMPACTING_MESSAGE, detail: undefined, progress: true },
    ])

    feed(session, boundaryLine('b-1'))
    expect(notices).toHaveLength(2)
    expect(notices[1]).toEqual({
      variant: 'compact', message: COMPACTED_MESSAGE,
      detail: '444K → 49K tokens · auto', progress: undefined,
    })
  })

  it('the numbers are labelled as tokens at both ends, never a bare figure', () => {
    const session = new ClaudeCodeSession('task-compact-2', 'proj')
    init(session)
    const notices = captureNotices()
    feed(session, boundaryLine('b-2', { pre_tokens: 867067, post_tokens: 43107 }))
    // The reported row said only "444K tokens", which reads like a percentage.
    expect(notices[0].detail).toBe('867K → 43K tokens · auto')
  })

  it('a replayed tail (reattach) re-emits nothing — same uuids, no new rows', () => {
    const session = new ClaudeCodeSession('task-compact-3', 'proj')
    init(session)
    const notices = captureNotices()

    const tail = [compactingLine('ka-a'), compactingLine('ka-b'), boundaryLine('b-3')]
    for (const line of tail) feed(session, line)
    expect(notices).toHaveLength(2)

    // addSubscriber replays [fromOffset, end) of the stream file: the exact same
    // lines, in order, a second time.
    for (const line of tail) feed(session, line)
    expect(notices).toHaveLength(2)
  })

  it('a second real compaction announces itself again', () => {
    const session = new ClaudeCodeSession('task-compact-4', 'proj')
    init(session)
    const notices = captureNotices()

    feed(session, compactingLine('ka-1'))
    feed(session, boundaryLine('b-4a'))
    feed(session, compactingLine('ka-2'))
    feed(session, boundaryLine('b-4b', { pre_tokens: 612799, post_tokens: 47027 }))

    expect(notices.map((n) => `${n.message}|${n.detail ?? ''}`)).toEqual([
      `${COMPACTING_MESSAGE}|`,
      `${COMPACTED_MESSAGE}|444K → 49K tokens · auto`,
      `${COMPACTING_MESSAGE}|`,
      `${COMPACTED_MESSAGE}|613K → 47K tokens · auto`,
    ])
  })

  it('a compaction that never finished does not mute the next process', () => {
    // The CLI died mid-compaction, so no boundary ever closed the placeholder.
    // Without a reset the gate would stay shut for the rest of the session's
    // life and no later compaction would ever announce itself.
    const session = new ClaudeCodeSession('task-compact-5', 'proj')
    init(session)
    const notices = captureNotices()
    feed(session, compactingLine('ka-dead'))
    expect(notices).toHaveLength(1)

    // Stand in for the spawn-time reset: start() clears this gate in the same
    // block as `_emittedStreamKeys.clear()`. Spawning a real CLI here would buy
    // nothing the mock-CLI e2e doesn't already cover.
    ;(session as unknown as { _compactionNoticeOpen: boolean })._compactionNoticeOpen = false

    feed(session, compactingLine('ka-alive'))
    expect(notices).toHaveLength(2)
    expect(notices[1].message).toBe(COMPACTING_MESSAGE)
  })

  it('a line with no uuid still collapses (older CLI / ACP dialect)', () => {
    const session = new ClaudeCodeSession('task-compact-6', 'proj')
    init(session)
    const notices = captureNotices()
    for (let i = 0; i < 4; i++) {
      feed(session, { type: 'system', subtype: 'status', status: 'compacting', session_id: SID })
    }
    expect(notices).toHaveLength(1)
  })
})
