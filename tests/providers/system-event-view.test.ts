/**
 * A stream-json `system` line with no handler never renders as its subtype name plus
 * a JSON payload. `vcs_state_changed {"kind":"push","cwd":...}` rows sat between two
 * step rows in a live turn and split them (2026-10-26, the user: "the vcs changes
 * should be combined also"). CLI 2.1.284 reports some thirty subtypes Walnut has no
 * handler for; the shapes below copy the CLI's own field names.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { systemEventView } from '../../src/core/stream/system-event-view.js'

const SID = 'sess-system-view'

function feed(session: ClaudeCodeSession, line: Record<string, unknown>): void {
  (session as unknown as { handleStreamLine(line: string): void }).handleStreamLine(JSON.stringify(line))
}

interface Notice { variant: string; message: string; detail?: string }

function captureNotices(): Notice[] {
  const seen: Notice[] = []
  bus.subscribe('main-ai', (event) => {
    if (event.name !== EventNames.SESSION_SYSTEM_EVENT) return
    const p = event.data as Notice
    seen.push({ variant: p.variant, message: p.message, ...(p.detail ? { detail: p.detail } : {}) })
  })
  return seen
}

const sys = (subtype: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype, uuid: `u-${subtype}`, session_id: SID, ...extra })

describe('systemEventView', () => {
  it('a vcs change is bookkeeping, for every kind', () => {
    for (const kind of ['commit', 'push', 'merge', 'rebase', 'some_future_kind']) {
      expect(systemEventView(sys('vcs_state_changed', { kind, cwd: '/home/sample/repo' }))).toEqual({ show: false, why: 'bookkeeping' })
    }
  })

  it('a line with no words for a reader never shows', () => {
    for (const line of [
      sys('plugin_install', { status: 'installed', name: 'sample-plugin' }),
      sys('mirror_error', { error: 'x', key: 'k' }),
      sys('turn_duration', { durationMs: 1200, messageCount: 4 }),
      sys('session_metadata', { title: '' }),
      sys('some_new_2027_subtype', { note: 'x', nested: { a: 1 } }),
      sys('informational', { content: '   ' }),
    ]) {
      expect(systemEventView(line)).toEqual({ show: false, why: 'no-words' })
    }
  })

  it('a refusal with no fallback says so, with the reason behind the row', () => {
    expect(systemEventView(sys('model_refusal_no_fallback', { content: '', level: 'warning', api_refusal_explanation: 'Sample reason.' })))
      .toEqual({ show: true, variant: 'error', message: 'The model declined this request.', detail: 'Sample reason.' })
    expect(systemEventView(sys('model_refusal_no_fallback', { content: '', apiRefusalExplanation: null })))
      .toEqual({ show: true, variant: 'error', message: 'The model declined this request.' })
  })

  it('a plugin install shows only when it failed', () => {
    expect(systemEventView(sys('plugin_install', { status: 'failed', name: 'sample-plugin', error: 'network down' })))
      .toEqual({ show: true, variant: 'error', message: 'Plugin sample-plugin failed to install', detail: 'network down' })
    expect(systemEventView(sys('plugin_install', { status: 'failed' })))
      .toEqual({ show: true, variant: 'error', message: 'A plugin failed to install' })
  })

  it('a line whose words repeat what is on screen never shows', () => {
    expect(systemEventView(sys('permission_denied', { tool_name: 'Bash', message: 'Permission denied' }))).toEqual({ show: false, why: 'shown-elsewhere' })
    expect(systemEventView(sys('post_turn_summary', { title: 'Done' }))).toEqual({ show: false, why: 'shown-elsewhere' })
    expect(systemEventView(sys('code_change_published', { url: 'https://example.com/pr/1' }))).toEqual({ show: false, why: 'shown-elsewhere' })
  })

  it('words written for a person show as they are', () => {
    expect(systemEventView(sys('model_fallback', { content: 'Switched to a backup model.', level: 'warning' })))
      .toEqual({ show: true, variant: 'info', message: 'Switched to a backup model.' })
    expect(systemEventView(sys('notification', { key: 'k', text: 'Usage limit reached.', color: 'error' })))
      .toEqual({ show: true, variant: 'error', message: 'Usage limit reached.' })
    expect(systemEventView(sys('some_new_2027_subtype', { message: 'A readable sentence.' })))
      .toEqual({ show: true, variant: 'info', message: 'A readable sentence.' })
  })

  it('long or multi-line words keep a one-line headline and the full text behind it', () => {
    const v = systemEventView(sys('local_command', { content: 'First line\nsecond line\nthird line', level: 'info' }))
    expect(v).toEqual({ show: true, variant: 'info', message: 'First line', detail: 'First line\nsecond line\nthird line' })
    const long = 'w'.repeat(500)
    const l = systemEventView(sys('informational', { content: long }))
    expect(l.show && l.message.length).toBe(200)
    expect(l.show && l.message.endsWith('…')).toBe(true)
    expect(l.show && l.detail).toBe(long)
  })
})

describe('live parser: system lines with no handler', () => {
  beforeEach(() => bus.clear())
  afterEach(() => bus.clear())

  it('emits no row for the reported vcs lines, nor for any line without words', () => {
    const session = new ClaudeCodeSession('task-sys-1', 'proj')
    const notices = captureNotices()
    feed(session, sys('vcs_state_changed', { kind: 'push', cwd: '/home/sample/.claude' }))
    feed(session, sys('vcs_state_changed', { kind: 'commit', cwd: '/home/sample/repo' }))
    feed(session, sys('plugin_install', { status: 'installed', name: 'sample-plugin' }))
    feed(session, sys('permission_denied', { tool_name: 'Bash', tool_use_id: 't-1', message: 'Denied' }))
    feed(session, sys('some_new_2027_subtype', { note: 'x' }))
    expect(notices).toEqual([])
  })

  it('shows a readable line as its words, never with the subtype name or JSON', () => {
    const session = new ClaudeCodeSession('task-sys-2', 'proj')
    const notices = captureNotices()
    feed(session, sys('model_fallback', { content: 'Switched to a backup model.', level: 'warning', originalModel: 'a', fallbackModel: 'b' }))
    expect(notices).toEqual([{ variant: 'info', message: 'Switched to a backup model.' }])
    for (const n of notices) {
      expect(n.message).not.toMatch(/model_fallback|[{}]/)
      expect(n.detail ?? '').not.toMatch(/[{}]/)
    }
  })

  it('a capped replay still reads as its sentence (handled before the rule)', () => {
    const session = new ClaudeCodeSession('task-sys-3', 'proj')
    const notices = captureNotices()
    feed(session, sys('replay_truncated', { content: 'Earlier output was skipped.', skipped_bytes: 10 }))
    expect(notices).toEqual([{ variant: 'info', message: 'Earlier output was skipped.' }])
  })
})
