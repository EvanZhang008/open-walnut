/**
 * buildTranscriptViaBridge — the CLOUD fresh-transcript path (read-history
 * over the daemon bridge → slim tail). Regression tests for the phone-images
 * bug: the old blanket `startsWith('[')` user-line filter swallowed every
 * "[Images attached — use the Read tool …]" send, so a session viewed from
 * the cloud replica showed the user's image messages MISSING (and the app
 * never even tried to fetch /api/v1/media for them). Only the CLI's
 * "[Request interrupted by user]" plumbing markers may be hidden; injected
 * lines (isMeta etc.) are skipped for parity with buildSessionTranscript.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-transcript', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError: class extends Error {},
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
}))

const SID = 'bridge-transcript-sid-1'
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      sessions: [{
        id: SID, host: 'devbox', process_status: 'running',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: 1, cwd: '/home/user/repo',
      }],
    }),
  }
})

import { buildTranscriptViaBridge } from '../../../src/web/routes/session-stream-v1.js'
import { _resetBridgeReadHistoryForTesting } from '../../../src/web/ws/bridge-read-history.js'

function jsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

beforeEach(() => {
  bridgeRequestMock.mockReset()
  // Each case answers the same session differently: drop the shared read cache.
  _resetBridgeReadHistoryForTesting()
})

describe('buildTranscriptViaBridge user-line filtering', () => {
  it('keeps "[Images attached …]" user sends (string and block content)', async () => {
    const imageText = '[Images attached — use the Read tool to view them]\n'
      + '- /tmp/open-walnut/images/1785990851406-9f13349681b7.png\n\n'
      + 'why does every panel have a scroll bar?'
    bridgeRequestMock.mockResolvedValue({
      ok: true,
      main: jsonl([
        { type: 'user', timestamp: '2026-08-06T00:00:01Z', message: { content: imageText } },
        { type: 'user', timestamp: '2026-08-06T00:00:02Z', message: { content: [{ type: 'text', text: imageText }] } },
        { type: 'assistant', timestamp: '2026-08-06T00:00:03Z', message: { content: [{ type: 'text', text: 'looking now' }] } },
      ]),
    })
    const t = await buildTranscriptViaBridge(SID)
    expect(t).not.toBeNull()
    const messages = t!.messages as Array<{ role: string; text: string }>
    const userRows = messages.filter((m) => m.role === 'user')
    expect(userRows.length).toBe(2)
    expect(userRows[0].text).toBe(imageText)
    expect(userRows[1].text).toBe(imageText)
  })

  it('still hides the CLI interrupt markers', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: true,
      main: jsonl([
        { type: 'user', timestamp: '2026-08-06T00:00:01Z', message: { content: '[Request interrupted by user]' } },
        { type: 'user', timestamp: '2026-08-06T00:00:02Z', message: { content: '[Request interrupted by user for tool use]' } },
        { type: 'user', timestamp: '2026-08-06T00:00:03Z', message: { content: 'real question' } },
      ]),
    })
    const t = await buildTranscriptViaBridge(SID)
    const messages = t!.messages as Array<{ role: string; text: string }>
    expect(messages.map((m) => m.text)).toEqual(['real question'])
  })

  it('skips CLI-injected lines (isMeta / isCompactSummary) but keeps walnut-injected markers', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: true,
      main: jsonl([
        { type: 'user', isMeta: true, timestamp: '2026-08-06T00:00:01Z', message: { content: 'Base directory for this skill: /x' } },
        { type: 'user', isCompactSummary: true, timestamp: '2026-08-06T00:00:02Z', message: { content: 'compaction summary blob' } },
        { type: 'user', subtype: 'walnut-injected', isSynthetic: true, timestamp: '2026-08-06T00:00:03Z', message: { content: 'user words via marker' } },
      ]),
    })
    const t = await buildTranscriptViaBridge(SID)
    const messages = t!.messages as Array<{ role: string; text: string }>
    expect(messages.map((m) => m.text)).toEqual(['user words via marker'])
  })
})

// M3: a line queued behind a turn whose CLI then crashed is resent to the next
// process, and that delivery is marked again. One message id is one row: the
// phone showed the message twice (the dead process's marker, then the resend's).
describe('buildTranscriptViaBridge: one row per message id', () => {
  it('keeps only the last marker of a resent message, at the delivery that ran', async () => {
    const marker = (id: string, text: string, pid: number, at: string) => ({
      type: 'user', subtype: 'walnut-injected', walnutMessageId: id, walnutDelivery: 'ordered', walnutPid: pid,
      timestamp: at, message: { role: 'user', content: text },
    })
    bridgeRequestMock.mockResolvedValue({
      ok: true,
      main: jsonl([
        marker('qm-1', 'a long turn', 100, '2026-10-05T11:52:44Z'),
        marker('qm-3', 'sent mid-turn', 100, '2026-10-05T11:52:45Z'),
        // The CLI crashes here; the next process gets qm-3 again, then qm-5.
        marker('qm-3', 'sent mid-turn', 200, '2026-10-05T11:52:47Z'),
        { type: 'assistant', timestamp: '2026-10-05T11:52:48Z', message: { content: [{ type: 'text', text: 'answer to the mid-turn send' }] } },
        marker('qm-5', 'probe', 200, '2026-10-05T11:52:49Z'),
        { type: 'assistant', timestamp: '2026-10-05T11:52:50Z', message: { content: [{ type: 'text', text: 'answer to the probe' }] } },
      ]),
    })
    const t = await buildTranscriptViaBridge(SID)
    const messages = t!.messages as Array<{ role: string; text: string; timestamp: string }>
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:a long turn', 'user:sent mid-turn', 'assistant:answer to the mid-turn send', 'user:probe', 'assistant:answer to the probe',
    ])
    expect(messages[1].timestamp).toBe('2026-10-05T11:52:47Z')
  })

  it('a user line with no message id is never folded', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: true,
      main: jsonl([
        { type: 'user', timestamp: '2026-10-05T00:00:01Z', message: { content: 'same words' } },
        { type: 'user', timestamp: '2026-10-05T00:00:02Z', message: { content: 'same words' } },
      ]),
    })
    const t = await buildTranscriptViaBridge(SID)
    expect((t!.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(['same words', 'same words'])
  })
})

// 2026-10-10: the phone showed a long reply whole while it streamed, then its
// first 4,000 characters plus "…" once the turn ended. This read only ever answers
// a phone reading right now (it is never pushed), so it clips at the live budget
// the primary's rich read uses, not the pushed tail's 4K.
describe('buildTranscriptViaBridge: a long reply arrives whole', () => {
  it('keeps a 5,000-character reply and still clips past the live budget', async () => {
    const reply = '\u957f\u56de\u7b54\u3002'.repeat(1250) + 'END' // CJK prose, 5,003 chars
    const huge = 'x'.repeat(20_000)
    bridgeRequestMock.mockResolvedValue({
      ok: true,
      main: jsonl([
        { type: 'user', timestamp: '2026-10-10T00:00:01Z', message: { content: 'explain it' } },
        { type: 'assistant', timestamp: '2026-10-10T00:00:02Z', message: { content: [{ type: 'text', text: reply }] } },
        { type: 'assistant', timestamp: '2026-10-10T00:00:03Z', message: { content: [{ type: 'text', text: huge }] } },
      ]),
    })
    const t = await buildTranscriptViaBridge(SID)
    const rows = (t!.messages as Array<{ role: string; text: string }>).filter((m) => m.role === 'assistant')
    expect(rows[0].text).toBe(reply)
    expect(rows[1].text.length).toBe(16_001)
    expect(rows[1].text.endsWith('\u2026')).toBe(true)
  })
})
