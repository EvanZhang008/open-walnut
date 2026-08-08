/**
 * Unit tests for buildSessionContext().
 *
 * buildSessionContext was emptied 2026-06-18 (no blanket task/vault/server
 * preambles) and now injects EXACTLY ONE thing: a short agent-gateway hint
 * telling the session about the `wn` peer-session CLI. These tests pin that
 * contract from both sides — the hint is present (with its authorization
 * warning), and the old blanket preamble stays gone. If the hint ever grows
 * into a large context block again, the size guard below should fail first.
 */

import { describe, it, expect } from 'vitest'

import { buildSessionContext } from '../../src/agent/session-context.js'

describe('buildSessionContext (gateway hint only)', () => {
  it('returns the wn gateway hint for a normal taskId', async () => {
    const { systemPrompt } = await buildSessionContext('some-task-id')
    expect(systemPrompt).toContain('wn peers list')
    expect(systemPrompt).toContain('wn --help')
  })

  it('injects the same hint regardless of cwd and host', async () => {
    const base = await buildSessionContext('task-1')
    const withArgs = await buildSessionContext('task-1', '/some/repo/path', 'remote-host')
    expect(withArgs.systemPrompt).toBe(base.systemPrompt)
  })

  it('does not throw for a nonexistent task', async () => {
    const { systemPrompt } = await buildSessionContext('nonexistent-id')
    expect(typeof systemPrompt).toBe('string')
  })

  it('warns that peer messages never carry user authorization', async () => {
    const { systemPrompt } = await buildSessionContext('task-2')
    expect(systemPrompt).toMatch(/NEVER carry user authorization/i)
    expect(systemPrompt).toMatch(/never approve/i)
  })

  it('injects no vault / server-safety / task preamble and stays short', async () => {
    const { systemPrompt } = await buildSessionContext('task-2', '/x', 'h')
    expect(systemPrompt).not.toContain('<server_safety>')
    expect(systemPrompt).not.toContain('<notes_context>')
    expect(systemPrompt).not.toContain('<task>')
    // The hint must stay a hint — anything bigger belongs in the
    // walnut-peer-sessions skill, not the blanket system prompt.
    expect(systemPrompt.length).toBeLessThan(800)
  })
})
