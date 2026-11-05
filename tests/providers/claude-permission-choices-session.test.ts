/**
 * A Claude prompt's choices through the real session object: the request event
 * and the session record carry them, and an answer by optionId writes the CLI's
 * suggested rules back as `updatedPermissions` (claude-permission-options.ts).
 * No process: the transport is a stub that records the line it is asked to write.
 */
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('claude-permission-choices-session'))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { createSessionRecord, _resetSessionTrackerForTesting, getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { WALNUT_HOME } from '../../src/constants.js'

const SID = '30000000-0000-4000-8000-0000000000c7'
const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }
const request = {
  subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' },
  decision_reason: 'This command requires approval', permission_suggestions: [rule],
}
let session: ClaudeCodeSession
let requests: Array<Record<string, unknown>>
let writeRaw: ReturnType<typeof vi.fn>

type Internals = { _clearAllPermissionReEmitTimers(): void; handleStreamLine(line: string): void }
const state = () => session as unknown as Internals
const written = () => writeRaw.mock.calls.map(([line]) => JSON.parse(String(line)) as { response: { response: Record<string, unknown> } })

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await createSessionRecord(SID, 'choices-task', 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
  session = new ClaudeCodeSession('choices-task', 'test', '/bin/true')
  writeRaw = vi.fn(async () => true)
  Object.assign(session, { claudeSessionId: SID, _active: true, _mode: 'default', _transport: { writeRaw, detach: vi.fn(), stopTail: vi.fn() } })
  requests = []
  bus.subscribe('choices-session-test', (event) => {
    if (event.name === EventNames.SESSION_PERMISSION_REQUEST) requests.push(event.data as Record<string, unknown>)
  }, { global: true })
  // The CLI's own line, as the stream delivers it.
  state().handleStreamLine(JSON.stringify({ type: 'control_request', request_id: 'req-1', request }))
  await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.pendingPermission?.requestId).toBe('req-1'))
})
afterEach(() => {
  state()._clearAllPermissionReEmitTimers()
  bus.clear()
  closeDb()
  _resetSessionTrackerForTesting()
  vi.restoreAllMocks()
})

describe('a Claude prompt with suggested rules', () => {
  it('the request event, the pending list and the record all carry the choices', async () => {
    const ids = ['allow_once', 'allow_session', 'allow_always', 'reject_once']
    expect((requests[0].acpOptions as Array<{ optionId: string }>).map((o) => o.optionId)).toEqual(ids)
    expect(session.getPendingPermissionRequests()[0].acpOptions?.map((o) => o.optionId)).toEqual(ids)
    const record = (await getSessionByClaudeId(SID))?.pendingPermission
    expect(record?.acpOptions?.map((o) => o.optionId)).toEqual(ids)
    expect(record?.permissionSuggestions).toEqual([rule])
  })

  it('"Allow for this session" sends the rule with destination session', async () => {
    await expect(session.resolvePermissionRequest('req-1', true, undefined, undefined, 'allow_session')).resolves.toBe(true)
    expect(written()[0].response.response).toEqual({
      behavior: 'allow', updatedInput: request.input,
      updatedPermissions: [{ ...rule, destination: 'session' }], decisionClassification: 'user_permanent',
    })
    expect(session.hasPendingPermission).toBe(false)
  })

  it('"Always allow in this project" keeps the CLI\'s destination', async () => {
    await session.resolvePermissionRequest('req-1', true, undefined, undefined, 'allow_always')
    expect(written()[0].response.response.updatedPermissions).toEqual([rule])
  })

  it('plain Allow sends no rule, as before', async () => {
    await session.resolvePermissionRequest('req-1', true)
    expect(written()[0].response.response).toEqual({ behavior: 'allow', updatedInput: request.input })
  })

  it('a deny with a note sends the note as the message, whatever `allow` said', async () => {
    await session.resolvePermissionRequest('req-1', true, 'The user denied this tool call and said: use pnpm', undefined, 'reject_once')
    // In the CLI's own rejection words, which the agent follows.
    expect(written()[0].response.response).toEqual({ behavior: 'deny', message: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nuse pnpm" })
  })

  it('the answer is kept on the record by the call it gated (promptAnswerLines)', async () => {
    state().handleStreamLine(JSON.stringify({ type: 'control_request', request_id: 'req-2', request: { ...request, tool_use_id: 'toolu_2' } }))
    await vi.waitFor(() => expect(session.getPendingPermissionRequests().map((p) => p.requestId)).toContain('req-2'))
    await session.resolvePermissionRequest('req-2', false, 'The user denied this tool call and said: use pnpm', undefined, 'reject_once')
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.promptAnswerLines).toEqual([
      { toolUseId: 'toolu_2', line: 'Denied with note \u201Cuse pnpm\u201D: npm test' },
    ]))
  })

  it('a later call a granted session rule covers says so on its row, and never over an answer', async () => {
    state().handleStreamLine(JSON.stringify({ type: 'control_request', request_id: 'req-3', request: { ...request, tool_use_id: 'toolu_3' } }))
    await vi.waitFor(() => expect(session.getPendingPermissionRequests().map((p) => p.requestId)).toContain('req-3'))
    await session.resolvePermissionRequest('req-3', true, undefined, undefined, 'allow_session')
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.promptAnswerLines?.map((d) => d.toolUseId)).toContain('toolu_3'))
    // The agent runs it again: the CLI does not ask, and the row names the rule.
    const call = (id: string, command: string) => JSON.stringify({ type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
    state().handleStreamLine(call('toolu_4', 'npm test -- --watch'))
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.promptAnswerLines).toContainEqual(
      { toolUseId: 'toolu_4', line: 'Allowed by session rule: Bash commands starting with npm test' },
    ))
    // A call the rule does not cover gets no line; one already answered keeps its answer.
    state().handleStreamLine(call('toolu_5', 'npm run build'))
    state().handleStreamLine(call('toolu_3', 'npm test'))
    await new Promise((r) => setTimeout(r, 200))
    const lines = (await getSessionByClaudeId(SID))?.promptAnswerLines ?? []
    expect(lines.find((d) => d.toolUseId === 'toolu_5')).toBeUndefined()
    expect(lines.find((d) => d.toolUseId === 'toolu_3')?.line).toBe('Allowed for this session: Bash commands starting with npm test')
  })

  it('a call sent beside the prompted one runs on the rule its answer grants, and its row says so', async () => {
    // One message, two calls: the CLI asks for the first; the second waits behind it.
    const tool = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } })
    state().handleStreamLine(JSON.stringify({ type: 'assistant', message: { id: 'msg_pair', role: 'assistant', content: [tool('toolu_6', 'npm test'), tool('toolu_7', 'npm test -- --ci')] } }))
    // A call that already returned before the answer ran on something else: it gets no line.
    state().handleStreamLine(JSON.stringify({ type: 'assistant', message: { id: 'msg_done', role: 'assistant', content: [tool('toolu_8', 'npm test -- --list')] } }))
    state().handleStreamLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_8', content: 'ok' }] } }))
    state().handleStreamLine(JSON.stringify({ type: 'control_request', request_id: 'req-6', request: { ...request, tool_use_id: 'toolu_6' } }))
    await vi.waitFor(() => expect(session.getPendingPermissionRequests().map((p) => p.requestId)).toContain('req-6'))
    await session.resolvePermissionRequest('req-6', true, undefined, undefined, 'allow_session')
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.promptAnswerLines).toContainEqual(
      { toolUseId: 'toolu_7', line: 'Allowed by session rule: Bash commands starting with npm test' },
    ))
    const lines = (await getSessionByClaudeId(SID))?.promptAnswerLines ?? []
    expect(lines.find((d) => d.toolUseId === 'toolu_6')?.line).toBe('Allowed for this session: Bash commands starting with npm test')
    expect(lines.find((d) => d.toolUseId === 'toolu_8')).toBeUndefined()
  })

  it('a compound command whose part a session rule covers says which rule let it run', async () => {
    state().handleStreamLine(JSON.stringify({ type: 'control_request', request_id: 'req-9', request: { ...request, tool_use_id: 'toolu_9' } }))
    await vi.waitFor(() => expect(session.getPendingPermissionRequests().map((p) => p.requestId)).toContain('req-9'))
    await session.resolvePermissionRequest('req-9', true, undefined, undefined, 'allow_session')
    const tool = (id: string, command: string) => JSON.stringify({ type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
    state().handleStreamLine(tool('toolu_10', 'npm test -- --ci && echo done'))
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.promptAnswerLines).toContainEqual(
      { toolUseId: 'toolu_10', line: 'Allowed by session rule: Bash commands starting with npm test' },
    ))
  })

  it('an option the request never offered writes nothing and keeps the prompt', async () => {
    await expect(session.resolvePermissionRequest('req-1', true, undefined, undefined, 'approved-for-session')).rejects.toThrow(/Unknown permission option/)
    expect(writeRaw).not.toHaveBeenCalled()
    expect(session.hasPendingPermission).toBe(true)
  })
})

describe('every Claude permission request event carries the choices', () => {
  // A new emit site that builds its own payload would show plain Allow / Deny for a
  // prompt that offers more (and lose the choices after a restart).
  it('each SESSION_PERMISSION_REQUEST emit in the Claude session uses permissionEventFields', () => {
    const src = fs.readFileSync('src/providers/claude-code-session.ts', 'utf8')
    const sites = [...src.matchAll(/bus\.emit\(EventNames\.SESSION_PERMISSION_REQUEST, \{([\s\S]*?)\}, \[/g)]
    expect(sites.length).toBeGreaterThanOrEqual(4)
    for (const site of sites) expect(site[1]).toContain('...permissionEventFields(')
    const persists = [...src.matchAll(/pendingPermission: \{([^}]*)/g)].filter((m) => /requestId|Fields/.test(m[1]))
    expect(persists.length).toBeGreaterThanOrEqual(3)
    for (const p of persists) expect(p[1]).toContain('pendingPermissionRecordFields(')
    // Restart recovery (Layer 2) rebuilds the request with its suggestions.
    expect(src).toMatch(/record\.pendingPermission\)[\s\S]{0,400}request: requestFromPendingRecord\(pp\)/)
  })
})
