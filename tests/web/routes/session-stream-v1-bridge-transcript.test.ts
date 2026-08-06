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

function jsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

beforeEach(() => {
  bridgeRequestMock.mockReset()
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
