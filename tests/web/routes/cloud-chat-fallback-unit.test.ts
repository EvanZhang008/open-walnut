/**
 * Pure pieces of the cloud companion fallback: where banked rows land in a
 * page, how a relayed page is renumbered, which rows a banked turn contributes,
 * and the companion lane's tool posture. The end-to-end behavior is pinned in
 * api-v1-chat-cloud-fallback.test.ts; these are the rules it is built from.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-fallback-unit', { CLOUD_MODE: true }))

import {
  cloudTurnRows, mergeRowsByTime, mergeCloudRowsIntoRelayedPage,
} from '../../../src/web/routes/cloud-chat-fallback.js'
import {
  toCloudChatProfile, CLOUD_CHAT_ALLOWED_TOOLS, CLOUD_CHAT_TOOLS, CLOUD_CHAT_NOTE,
} from '../../../src/core/sessions/cloud-chat-lane.js'
import { CONVERSATION_SEED_HEADER } from '../../../src/core/chat-history.js'
import type { CloudChatOutboxEntry } from '../../../src/core/cloud-chat-outbox.js'

const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 9, minute)).toISOString()

function entry(over: Partial<CloudChatOutboxEntry>): CloudChatOutboxEntry {
  return {
    v: 1, turnId: 'turn-unit-00001', agentId: 'general', conversationId: 'conv-unit-1',
    userText: 'q', userAt: at(1), state: 'answered', answerText: 'a', answeredAt: at(2),
    bootId: 'boot', updatedAt: at(2), ...over,
  }
}

describe('cloudTurnRows', () => {
  it('an answered turn is two rows; a running or failed one is the user row alone', () => {
    expect(cloudTurnRows([entry({})])).toEqual([
      { role: 'user', text: 'q', createdAt: at(1) },
      { role: 'assistant', text: 'a', createdAt: at(2) },
    ])
    expect(cloudTurnRows([entry({ state: 'running', answerText: undefined })])).toHaveLength(1)
    expect(cloudTurnRows([entry({ state: 'failed', answerText: undefined, error: 'x' })])).toHaveLength(1)
  })

  it('resolves entity refs like every other read path', () => {
    const [user] = cloudTurnRows([entry({ userText: 'see <task-ref id="t1" label="Taxes"/> please' })])
    expect(user.text).not.toContain('<task-ref')
  })
})

describe('mergeRowsByTime', () => {
  const row = (text: string, minute?: number) => ({ text, ...(minute !== undefined ? { createdAt: at(minute) } : {}) })

  it('slots extra rows before the first strictly newer base row, keeping base order', () => {
    const merged = mergeRowsByTime([row('b1', 1), row('b2', 5), row('b3', 9)], [row('x', 4), row('y', 6)])
    expect(merged.map((r) => r.text)).toEqual(['b1', 'x', 'b2', 'y', 'b3'])
  })

  it('an equal time goes AFTER the base row; newer-than-all rows go last', () => {
    expect(mergeRowsByTime([row('b1', 5)], [row('x', 5)]).map((r) => r.text)).toEqual(['b1', 'x'])
    expect(mergeRowsByTime([row('b1', 1)], [row('x', 7)]).map((r) => r.text)).toEqual(['b1', 'x'])
  })

  it('a base row without a time never pulls an extra row ahead of itself', () => {
    const merged = mergeRowsByTime([row('b1', 1), row('untimed'), row('b3', 9)], [row('x', 4)])
    expect(merged.map((r) => r.text)).toEqual(['b1', 'untimed', 'x', 'b3'])
  })
})

describe('mergeCloudRowsIntoRelayedPage', () => {
  const page = [
    { id: 'm10', role: 'user', text: 'p1', createdAt: at(1) },
    { id: 'm11', role: 'assistant', text: 'p2', createdAt: at(8) },
  ]

  it('renumbers from the page\'s first index, as the primary will after adoption', () => {
    const merged = mergeCloudRowsIntoRelayedPage(page, [{ role: 'user', text: 'c', createdAt: at(4) }])
    expect(merged.map((r) => [r.id, r.text])).toEqual([['m10', 'p1'], ['m11', 'c'], ['m12', 'p2']])
  })

  it('an empty page starts at m0; a page with foreign ids is left alone', () => {
    type Row = { id: string; role: string; text: string; createdAt: string }
    expect(mergeCloudRowsIntoRelayedPage<Row>([], [{ role: 'user', text: 'c', createdAt: at(4) }]).map((r) => r.id))
      .toEqual(['m0'])
    const foreign = [{ id: 'x-1', role: 'user', text: 'p', createdAt: at(1) }]
    expect(mergeCloudRowsIntoRelayedPage(foreign, [{ role: 'user', text: 'c', createdAt: at(4) }])).toBe(foreign)
  })
})

describe('toCloudChatProfile', () => {
  it('drops the Walnut MCP, keeps other mounts, pre-approves only the web tools, and puts the note before the seed', () => {
    const profile = toCloudChatProfile({
      systemPrompt: `PERSONA\n\n${CONVERSATION_SEED_HEADER}\n\nSEED`,
      systemPromptMode: 'append',
      mcpServers: { walnut: { command: 'node', args: ['cli.js', 'mcp'] }, other: { command: 'x' } },
    }, CONVERSATION_SEED_HEADER)
    expect(profile.mcpServers).toEqual({ other: { command: 'x' } })
    expect(profile.allowedTools).toEqual(CLOUD_CHAT_ALLOWED_TOOLS)
    // No shell, no writes, and no WHOLE-TOOL read rule: the CLI allows reads in
    // the working directory by itself, and a bare `Read` rule would allow every
    // path on the box, the data folder included.
    for (const tool of ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep']) {
      expect(profile.allowedTools).not.toContain(tool)
    }
    // And no shell EXISTS: the available built-in set is read and web tools only.
    expect(profile.tools).toEqual(CLOUD_CHAT_TOOLS)
    for (const tool of ['Bash', 'PowerShell', 'Agent', 'Task', 'Write', 'Edit']) {
      expect(profile.tools).not.toContain(tool)
    }
    const p = profile.systemPrompt!
    expect(p.indexOf('PERSONA')).toBeLessThan(p.indexOf(CLOUD_CHAT_NOTE))
    expect(p.indexOf(CLOUD_CHAT_NOTE)).toBeLessThan(p.indexOf(CONVERSATION_SEED_HEADER))
  })

  it('a profile with only the Walnut MCP ends up with no mounts at all', () => {
    const profile = toCloudChatProfile({
      systemPrompt: 'PERSONA', mcpServers: { walnut: { command: 'node' } },
    }, CONVERSATION_SEED_HEADER)
    expect(profile).not.toHaveProperty('mcpServers')
    expect(profile.systemPrompt!.endsWith(CLOUD_CHAT_NOTE)).toBe(true)
  })
})
