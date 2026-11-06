/**
 * A Claude Code session answers Walnut's own CLI and MCP tools itself in every mode, as an
 * ACP session of the same task does (src/providers/acp-permission-posture.ts,
 * isWalnutOwnToolUse; hooked in ClaudeCodeSession's can_use_tool branch). A remote
 * host's session (a second Mac) sends its requests through the same handler.
 * 2026-11-05: a task's `walnut tools call ...` prompt landed on the user's list.
 *
 * What's real: ClaudeCodeSession's stream handling and the posture rules.
 * What's stubbed: the transport write.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { vi } from 'vitest'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { isWalnutOwnToolUse } from '../../src/providers/acp-permission-posture.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj))
const ask = (id: string, tool_name: string, input: Record<string, unknown>) => ({
  type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name, input },
})

describe('isWalnutOwnToolUse', () => {
  it.each([
    ['Bash', { command: `walnut tools call task_send '{"in_reply_to":"rq-1","text":"done"}'` }],
    ['Bash', { command: 'walnut tools list' }],
    ['Bash', { command: 'walnut guide' }],
    ['mcp__walnut__task_send', {}],
    ['mcp__walnut__task_report_set', {}],
  ])('%s %j is Walnut\'s own', (tool, input) => {
    expect(isWalnutOwnToolUse(tool, input)).toBe(true)
  })
  it.each([
    ['Bash', { command: 'walnut tools list | rg task' }],
    ['Bash', { command: 'walnut tools call task_send x; rm -rf ~' }],
    ['Bash', { command: `walnut tools call host_exec '{"host":"box","command":"id"}'` }],
    ['Bash', { command: 'rm -rf /' }],
    ['Bash', {}],
    ['mcp__walnut__host_exec', {}],
    ['mcp__walnut__task_create', {}],
    ['mcp__other__task_send', {}],
    ['Write', { file_path: '/x' }],
    [undefined, {}],
  ])('%s %j asks', (tool, input) => {
    expect(isWalnutOwnToolUse(tool as string | undefined, input)).toBe(false)
  })
})

describe('ClaudeCodeSession: Walnut\'s own tools never prompt the user', () => {
  let session: ClaudeCodeSession
  let responses: Array<{ requestId: string; allow: boolean }>
  let writeOk: boolean

  beforeEach(() => {
    bus.clear()
    session = new ClaudeCodeSession('task-x', 'proj', 'true')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = session as any
    s.claudeSessionId = 'sid-x'
    s._mode = 'default'
    responses = []
    writeOk = true
    s.respondToControlRequest = (requestId: string, _req: unknown, allow: boolean, _m?: unknown, _u?: unknown, _r?: unknown, onSettled?: (ok: boolean) => void) => {
      if (!writeOk) return false
      responses.push({ requestId, allow })
      onSettled?.(true)
      return true
    }
  })
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any)._clearAllPermissionReEmitTimers()
    bus.clear()
  })

  function prompts(): BusEvent[] {
    const events: BusEvent[] = []
    bus.subscribe('walnut-own-prompts', (e) => { if (e.name === EventNames.SESSION_PERMISSION_REQUEST) events.push(e) }, { global: true })
    return events
  }

  it.each(['default', 'accept', 'plan'])('in %s mode, a walnut CLI report and a walnut MCP report are allowed with no card', async (mode) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any)._mode = mode
    const shown = prompts()
    feed(session, ask('r-cli', 'Bash', { command: `walnut tools call task_send '{"in_reply_to":"rq-daf1329072fe","title":"t","text":"x"}'` }))
    feed(session, ask('r-mcp', 'mcp__walnut__task_send', { in_reply_to: 'rq-1', text: 'x' }))
    expect(responses).toEqual([{ requestId: 'r-cli', allow: true }, { requestId: 'r-mcp', allow: true }])
    expect(session.hasPendingPermission).toBe(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(shown).toHaveLength(0)
  })

  it('anything else still asks the user', async () => {
    const shown = prompts()
    feed(session, ask('r-pipe', 'Bash', { command: 'walnut tools list | rg host' }))
    feed(session, ask('r-exec', 'mcp__walnut__host_exec', { host: 'box', command: 'id' }))
    expect(responses).toEqual([])
    expect(session.hasPendingPermission).toBe(true)
    await vi.waitFor(() => expect(shown.map((e) => (e.data as { requestId: string }).requestId)).toEqual(['r-pipe', 'r-exec']))
  })

  it('a write the CLI never got (it resolved false) becomes a normal card, never a lost request', async () => {
    // Review round 1: the real write path, its transport answering false.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = session as any
    delete s.respondToControlRequest
    s._active = true
    s._transport = { writeRaw: async () => false }
    const shown = prompts()
    feed(session, ask('r-async', 'mcp__walnut__task_send', { text: 'x' }))
    await vi.waitFor(() => expect(shown.map((e) => (e.data as { requestId: string }).requestId)).toEqual(['r-async']))
    expect(session.hasPendingPermission).toBe(true)
  })

  it('a request the CLI withdrew while the answer was being written never comes back as a card (review round 1, Sol)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = session as any
    delete s.respondToControlRequest
    s._active = true
    let release!: (ok: boolean) => void
    s._transport = { writeRaw: () => new Promise<boolean>((r) => { release = r }) }
    const shown = prompts()
    feed(session, ask('r-cancel', 'mcp__walnut__task_send', { text: 'x' }))
    feed(session, { type: 'control_cancel_request', request_id: 'r-cancel' })
    release(false)
    await new Promise((r) => setTimeout(r, 30))
    expect(shown).toHaveLength(0)
    expect(session.hasPendingPermission).toBe(false)
  })

  it('a write whose transport was replaced before it ended becomes a card (review round 2)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = session as any
    delete s.respondToControlRequest
    s._active = true
    let release!: (ok: boolean) => void
    s._transport = { writeRaw: () => new Promise<boolean>((r) => { release = r }) }
    const shown = prompts()
    feed(session, ask('r-reconnect', 'Bash', { command: 'walnut guide' }))
    // Held while it is written: a replay of the same request is not answered twice.
    expect(session.hasPendingPermission).toBe(true)
    feed(session, ask('r-reconnect', 'Bash', { command: 'walnut guide' }))
    s._transport = { writeRaw: async () => true }
    release(true)
    await vi.waitFor(() => expect(shown.map((e) => (e.data as { requestId: string }).requestId)).toEqual(['r-reconnect']))
  })

  it('in bypass, Walnut answers its own tools itself, whatever auto_approve_bypass says (review round 1, Sol)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any)._mode = 'bypass'
    feed(session, ask('r-bypass', 'Bash', { command: 'walnut tools list' }))
    // Answered at once, never through the bypass branch's config read.
    expect(responses).toEqual([{ requestId: 'r-bypass', allow: true }])
  })

  it('a write that cannot be delivered becomes a normal card, never a lost request', async () => {
    writeOk = false
    const shown = prompts()
    feed(session, ask('r-lost', 'mcp__walnut__task_send', { text: 'x' }))
    expect(session.hasPendingPermission).toBe(true)
    await vi.waitFor(() => expect(shown).toHaveLength(1))
  })
})
