/**
 * CLI hook lifecycle lines never render as a raw subtype name.
 *
 * `claude -p --output-format stream-json --verbose` reports every SessionStart hook
 * as a `hook_started` + `hook_response` pair, on every spawn and resume. The
 * unknown-subtype catch-all rendered them as a "hook_response ›" row (found in a
 * recorded demo, 2026-09-23). The line shapes below are copied from a real daemon
 * stream file. A successful hook stays silent; a failed one becomes ONE readable
 * error row, and a reload (history parser) shows the same row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { hookFailureNotice } from '../../src/core/stream/hook-notice.js'
import { parseSessionMessages } from '../../src/core/session-history.js'

const SID = 'sess-hooks'

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

const HOOK = { hook_id: '684e00e2-d5df-4633-8426-6cddaa770e0f', hook_name: 'SessionStart:startup', hook_event: 'SessionStart' }

function started(uuid: string): Record<string, unknown> {
  return { type: 'system', subtype: 'hook_started', ...HOOK, uuid, session_id: SID }
}
function response(uuid: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'system', subtype: 'hook_response', ...HOOK,
    output: '', stdout: '', stderr: '', exit_code: 0, outcome: 'success',
    ...extra, uuid, session_id: SID,
  }
}

interface Notice { variant: string; message: string; detail?: string }

function captureNotices(): Notice[] {
  const seen: Notice[] = []
  bus.subscribe('main-ai', (event) => {
    if (event.name !== EventNames.SESSION_SYSTEM_EVENT) return
    const p = event.data as Notice
    seen.push({ variant: p.variant, message: p.message, detail: p.detail })
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

describe('hookFailureNotice', () => {
  it('is null for a start, a progress tick, a success and a cancelled hook', () => {
    expect(hookFailureNotice(started('a'))).toBeNull()
    expect(hookFailureNotice({ type: 'system', subtype: 'hook_progress', ...HOOK, stdout: 'x', stderr: '', output: 'x' })).toBeNull()
    expect(hookFailureNotice(response('b', {}))).toBeNull()
    expect(hookFailureNotice(response('c', { outcome: 'cancelled', exit_code: undefined }))).toBeNull()
  })

  it('names the hook and its exit code, and keeps what the hook printed as the detail', () => {
    expect(hookFailureNotice(response('d', { outcome: 'error', exit_code: 1, stderr: '  node: not found\n' })))
      .toEqual({ message: 'SessionStart:startup hook failed (exit 1)', detail: 'node: not found' })
  })

  it('falls back to stdout, then output, and caps the detail', () => {
    expect(hookFailureNotice(response('e', { outcome: 'error', exit_code: 2, stdout: 'bad config' }))?.detail).toBe('bad config')
    const long = hookFailureNotice(response('f', { outcome: 'error', output: 'y'.repeat(2000) }))
    expect(long?.detail).toHaveLength(500)
  })

  it('an HTTP hook failure without an exit code still reads cleanly', () => {
    expect(hookFailureNotice(response('g', { outcome: 'error', exit_code: undefined, hook_name: '' })))
      .toEqual({ message: 'SessionStart hook failed' })
  })
})

describe('ClaudeCodeSession: hook lifecycle lines', () => {
  it('a working SessionStart hook emits no row at all', () => {
    const session = new ClaudeCodeSession('task-hook-1', 'proj')
    init(session)
    const notices = captureNotices()
    feed(session, started('h-1'))
    feed(session, response('h-2', {}))
    expect(notices).toEqual([])
  })

  it('a failed hook emits ONE error row with a readable headline, never the subtype name', () => {
    const session = new ClaudeCodeSession('task-hook-2', 'proj')
    init(session)
    const notices = captureNotices()
    feed(session, started('h-3'))
    feed(session, response('h-4', { outcome: 'error', exit_code: 127, stderr: 'sh: my-hook: command not found' }))
    expect(notices).toEqual([
      { variant: 'error', message: 'SessionStart:startup hook failed (exit 127)', detail: 'sh: my-hook: command not found' },
    ])
  })

  it('an unknown subtype still reaches the catch-all (control case)', () => {
    const session = new ClaudeCodeSession('task-hook-3', 'proj')
    init(session)
    const notices = captureNotices()
    feed(session, { type: 'system', subtype: 'some_new_2027_subtype', session_id: SID, uuid: 'n-1', note: 'x' })
    expect(notices.map((n) => n.message)).toEqual(['some_new_2027_subtype'])
  })
})

describe('history parser: hook lifecycle lines', () => {
  it('hides a working hook and shows a failed one with the live row\'s wording', () => {
    const ts = '2025-01-01T00:00:0'
    const lines = [
      { ...started('h-5'), timestamp: `${ts}1Z` },
      { ...response('h-6', {}), timestamp: `${ts}2Z` },
      { ...started('h-7'), timestamp: `${ts}3Z` },
      { ...response('h-8', { outcome: 'error', exit_code: 1, stderr: 'boom' }), timestamp: `${ts}4Z` },
      { type: 'user', uuid: 'u-1', timestamp: `${ts}5Z`, message: { role: 'user', content: 'hello' } },
    ]
    const messages = parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n'))
    const sys = messages.filter((m) => m.role === 'system')
    expect(sys.map((m) => [m.systemVariant, m.text])).toEqual([
      ['error', 'SessionStart:startup hook failed (exit 1)'],
    ])
    expect(messages.some((m) => m.text?.includes('hook_'))).toBe(false)
  })
})
