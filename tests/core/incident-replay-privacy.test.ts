/**
 * Privacy guard for shape-only incident replays (scripts/incident-replay/). A raw CLI stream holds
 * the user's real words; a fixture may hold only its shape. These tests feed the converter
 * adversarial SYNTHETIC streams (secrets in unknown fields, object keys, enum slots, tool inputs,
 * home paths, URLs, Unicode, malformed and torn lines, duplicate JSON keys) and check that none
 * survive, that the shape the session paths read does (ids, tool names, AskUserQuestion, control
 * enums, the fold verdict, the usage-limit class), and that the validator rejects anything that is
 * not canonical without echoing it. The recorder is tested against temp homes only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import {
  ERROR_TEXT,
  PLACEHOLDER,
  USAGE_LIMIT_TEXT,
  assertShapeOnly,
  convertStream,
  createStreamConverter,
  findDuplicateFixtures,
  toCanonicalShape,
  usageLimitVariant,
  validateStream,
} from '../../scripts/incident-replay/shape.mjs'
import { DETECTORS, convertRawStream, detectorReading, productionClassifyText, replayParity, toShapeOnly } from '../../scripts/incident-replay/production.js'
import { enclosingGitWorktree, prepareDestination, privateReplayDir, recordFromFile, recordFromStream } from '../../scripts/incident-replay/record.js'
import { FIXTURE_DIR, validateFixtures } from '../../scripts/incident-replay/validate.js'
import { matchesUsageLimitText } from '../../src/providers/usage-limit-text.js'
import { claudeWindowFromText } from '../../src/core/sessions/usage-limit-model.js'
import { classifyTurnError } from '../../src/providers/daemon-core.js'
import { CLI_ERROR_PREFIX, cliErrorRowText, isCliErrorReply, isCliErrorText } from '../../src/core/sessions/cli-error-reply.js'
import { foldLines } from '../../src/providers/daemon-fold.js'

// ── Synthetic adversarial input ──

const UUID_A = '6f1c2a9e-1b2c-4d3e-8f90-0a1b2c3d4e5f'
const UUID_REQ = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d'
/** Unicode secret, spelled with escapes (test data only). */
const UNICODE_SECRET = '\u79d8\u5bc6\u30c7\u30fc\u30bf'
const SECRETS = ['secret', 'alice', 'bob', 'example.com', 'acme', 'id_rsa', 'america/los_angeles', '4242', 'zz_private_',
  UNICODE_SECRET.toLowerCase(), '\u79d8']

const j = (o: unknown): string => JSON.stringify(o)

function adversarialRaw(): string {
  const lines = [
    j({ type: 'system', subtype: 'init', cwd: '/Users/alice/private', session_id: 'sess-SECRET-1', uuid: UUID_A,
      model: 'claude-secret-model[1m]', tools: ['Bash', 'AskUserQuestion', 'mcp__acme_internal__SECRET_TOOL'],
      mcp_servers: [{ name: 'acme-SECRET-server', status: 'connected' }, { name: 'zz_private_srv', status: 'SECRET_STATUS' }],
      plugins: [{ name: 'SECRET_PLUGIN', path: '/home/bob/plugins' }], permissionMode: 'bypassPermissions',
      SECRET_KEY_FIELD: 'SECRET_VALUE', nested: { SECRET_OBJECT_KEY: 1, 'zz_private_key /Users/alice': { deeper: 'SECRET' } } }),
    j({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: `SECRET user words ${UNICODE_SECRET}` },
      walnutMessageId: 'line-SECRET-1', walnutDelivery: 'ordered', walnutPid: 4242, timestamp: '2026-11-14T01:02:03.456Z' }),
    j({ type: 'command_lifecycle', command_uuid: 'line-SECRET-1', state: 'queued', session_id: 'sess-SECRET-1' }),
    j({ type: 'command_lifecycle', command_uuid: 'line-SECRET-1', state: 'started', session_id: 'sess-SECRET-1' }),
    j({ type: 'assistant', session_id: 'sess-SECRET-1', parent_tool_use_id: null,
      message: { id: 'msg_SECRET', role: 'assistant', model: 'claude-secret-model', stop_reason: 'SECRET_REASON',
        usage: { input_tokens: 5, output_tokens: '123SECRET', SECRET_USAGE: 1 },
        content: [
          { type: 'text', text: 'SECRET answer https://internal.example.com/x' },
          { type: 'thinking', thinking: 'SECRET thought', signature: 'SECRETSIG' },
          { type: 'tool_use', id: 'toolu_SECRET1', name: 'Bash', input: { command: 'cat /home/bob/.ssh/id_rsa', description: 'SECRET desc', run_in_background: true, SECRET_INPUT_KEY: 'x' } },
          { type: 'tool_use', id: 'toolu_SECRET2', name: 'WebFetch', input: { url: 'https://internal.example.com/SECRET', prompt: 'SECRET' } },
          { type: 'tool_use', id: 'toolu_SECRET3', name: 'mcp__acme_internal__SECRET_TOOL', input: { q: 'SECRET' } },
          { type: 'SECRET_BLOCK_TYPE', x: 'SECRET' },
        ] } }),
    j({ type: 'system', subtype: 'task_started', session_id: 'sess-SECRET-1', task_id: 'bgSECRET1', tool_use_id: 'toolu_SECRET1',
      is_backgrounded: true, description: 'SECRET', task_type: 'local_bash', output_file: '/Users/alice/out.txt' }),
    j({ type: 'system', subtype: 'session_state_changed', state: 'requires_action', session_id: 'sess-SECRET-1' }),
    j({ type: 'assistant', session_id: 'sess-SECRET-1', parent_tool_use_id: null,
      message: { id: 'msg_SECRET_2', role: 'assistant', model: 'claude-secret-model', content: [
        { type: 'tool_use', id: 'toolu_SECRET4', name: 'AskUserQuestion', input: { questions: [
          { question: 'SECRET q one?', header: 'SECRET h', multiSelect: false, options: [{ label: 'SECRET A', description: 'SECRET d' }, { label: 'SECRET B', description: '' }] },
          { question: 'SECRET q two?', header: '', multiSelect: true, options: [{ label: 'SECRET C', description: 'SECRET e', SECRET_OPT_KEY: 1 }] },
        ], SECRET_EXTRA: 'x' } },
      ] } }),
    j({ type: 'control_request', request_id: UUID_REQ, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion',
      input: { questions: [{ question: 'SECRET q one?', header: 'SECRET h', multiSelect: false, options: [{ label: 'SECRET A', description: 'SECRET d' }, { label: 'SECRET B', description: '' }] }] },
      tool_use_id: 'toolu_SECRET4', requires_user_interaction: true, blocked_path: '/Users/alice/x',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'SECRET rule' }], behavior: 'allow', destination: 'SECRET_DEST' }] } }),
    j({ type: 'control_cancel_request', request_id: UUID_REQ }),
    j({ type: 'user', session_id: 'sess-SECRET-1', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_SECRET1', content: 'SECRET out /Users/alice', is_error: false }] },
      tool_use_result: { stdout: 'SECRET', stderr: '', scheduledFor: 1893456000000, SECRET_TUR_KEY: 'x' } }),
    j({ type: 'user', session_id: 'sess-SECRET-1', message: { role: 'user', content: '<local-command-stdout>SECRET</local-command-stdout>' } }),
    j({ type: 'system', subtype: 'walnut_process', walnutPid: 4242, walnutTurn: true }),
    j({ type: 'system', subtype: 'SECRET_SUBTYPE', content: 'SECRET' }),
    j({ type: 'SECRET_TYPE', payload: 'SECRET' }),
    '{"type":"user", "message": SECRET not json',
    '{"type":"system","subtype":"session_state_changed","state":"idle","state":"SECRET_DUP"}',
    j({ type: 'rate_limit_event', session_id: 'sess-SECRET-1', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1893456000,
      unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1893456000 }, SECRET_WINDOW: { utilization: 1, resetsAt: 1 } },
      overageDisabledReason: 'SECRET reason' } }),
    j({ type: 'result', subtype: 'success', is_error: true, num_turns: 3, duration_ms: 1200, session_id: 'sess-SECRET-1',
      result: 'You\'ve hit your session limit \u00b7 resets 3pm (America/Los_Angeles)', errors: ['SECRET error /Users/alice'],
      modelUsage: { 'claude-secret-model': { inputTokens: 1, SECRET: 2 } }, origin: { kind: 'peer', name: 'SECRET_ORIGIN' },
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_SECRET1', tool_input: { command: 'SECRET' } }] }),
    j({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'sess-SECRET-1' }),
    '{"__proto__":{"type":"SECRET"},"type":"user","message":{"role":"user","content":"SECRET hi"}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"SECRET torn',
  ]
  return lines.join('\n')
}

function assertNoSecrets(text: string): void {
  const lower = text.toLowerCase()
  // Report WHICH canary leaked, not the surrounding text.
  expect(SECRETS.filter((s) => lower.includes(s))).toEqual([])
}

const parse = (content: string): Record<string, any>[] => content.trim().split('\n').map((l) => JSON.parse(l))

describe('convert: nothing private survives', () => {
  it('drops or replaces every secret, wherever it hides', () => {
    const { content, report } = convertRawStream(adversarialRaw())
    assertNoSecrets(content)
    assertNoSecrets(JSON.stringify(report))
    expect(report).toMatchObject({ malformed: 1, unknownType: 2, tornTail: true })
    expect(validateStream(content)).toEqual({ ok: true, errors: [] })
  })

  it('is deterministic and a fixpoint: converting the output again changes no byte', () => {
    const once = toShapeOnly(adversarialRaw())
    expect(toShapeOnly(adversarialRaw())).toBe(once)
    expect(toShapeOnly(once)).toBe(once)
    expect(toCanonicalShape(once)).toBe(once)
  })

  it('the incremental converter and the whole-text one agree on raw input', () => {
    const raw = adversarialRaw() + '\n' // terminated: the last line is malformed, not torn
    const c = createStreamConverter()
    const incremental = raw.split('\n').slice(0, -1).map((l) => c.line(l)).filter((l) => l !== null)
    expect(incremental.join('\n') + '\n').toBe(convertStream(raw).content)
  })

  it('garbage becomes stand-in lines that say nothing; an empty input stays empty and never validates', () => {
    expect(convertStream('').content).toBe('')
    expect(convertStream('not json\n{"type":"nope"}\n{"type":"system","subtype":"nope"}\n\n').content)
      .toBe('{"type":"unknown_event"}\n{"type":"unknown_event"}\n{"type":"system","subtype":"unknown_subtype"}\n')
    expect(validateStream('').ok).toBe(false)
  })
})

describe('convert: the shape the session paths read survives', () => {
  const out = parse(toShapeOnly(adversarialRaw()))
  const byType = (t: string, sub?: string) => out.filter((o) => o.type === t && (sub === undefined || o.subtype === sub))

  it('keeps event order, types and control enums', () => {
    expect(out.map((o) => o.subtype ? `${o.type}/${o.subtype}` : o.type)).toEqual([
      'system/init', 'user/walnut-injected', 'command_lifecycle', 'command_lifecycle', 'assistant', 'system/task_started',
      'system/session_state_changed', 'assistant', 'control_request', 'control_cancel_request', 'user', 'user',
      'system/walnut_process', 'system/unknown_subtype', 'unknown_event', 'unknown_event', 'system/session_state_changed',
      'rate_limit_event', 'result/success', 'system/session_state_changed', 'user',
    ])
    expect(byType('command_lifecycle').map((o) => o.state)).toEqual(['queued', 'started'])
    expect(byType('system', 'session_state_changed').map((o) => o.state)).toEqual(['requires_action', undefined, 'idle'])
    expect(byType('system', 'task_started')[0]).toMatchObject({ task_type: 'local_bash', is_backgrounded: true })
    expect(byType('system', 'walnut_process')[0]).toMatchObject({ walnutPid: 10001, walnutTurn: true })
    expect(byType('user', 'walnut-injected')[0]).toMatchObject({ walnutPid: 10001, walnutDelivery: 'ordered', timestamp: '2026-01-01T00:00:00.000Z' })
    expect(out[0]).toMatchObject({ permissionMode: 'bypassPermissions', cwd: PLACEHOLDER.cwd, model: 'synthetic-model-1[1m]' })
    expect(out[0].tools).toEqual(['Bash', 'AskUserQuestion', 'mcp__synthetic__tool_1'])
    expect(out[0].mcp_servers).toEqual([{ name: 'synthetic-server-1', status: 'connected' }, { name: 'synthetic-server-2' }])
  })

  it('maps every id through one map, so correlations across fields and lines hold', () => {
    const [init, marker, queued, started, a1, task, , a2, ctrl, cancel, toolResult] = out
    expect(marker.walnutMessageId).toBe(queued.command_uuid)
    expect(started.command_uuid).toBe(queued.command_uuid)
    expect(a1.session_id).toBe(init.session_id)
    const bash = a1.message.content.find((b: any) => b.name === 'Bash')
    expect(task.tool_use_id).toBe(bash.id)
    expect(toolResult.message.content[0].tool_use_id).toBe(bash.id)
    expect(ctrl.request.tool_use_id).toBe(a2.message.content[0].id)
    expect(cancel.request_id).toBe(ctrl.request_id)
    expect(init.uuid).toMatch(/^00000000-0000-4000-8000-\d{12}$/)
    expect(bash.id).toMatch(/^toolu_synth\d{6}$/)
    expect(a1.message.id).toMatch(/^msg_synth\d{6}$/)
    expect(task.task_id).toMatch(/^synth_\d{6}$/)
  })

  it('keeps distinct raw ids distinct, even ones that look synthetic or differ only by case or space', () => {
    const raws = ['a', 'A', ' a', 'synth_000002', 'synth_000001', 'a']
    const content = raws.map((id) => j({ type: 'system', subtype: 'task_started', task_id: id, task_type: 'local_bash' })).join('\n') + '\n'
    const ids = parse(toShapeOnly(content)).map((o) => o.task_id)
    expect(new Set(ids.slice(0, 5)).size).toBe(5)
    expect(ids[5]).toBe(ids[0])
    expect(ids).toEqual(['synth_000001', 'synth_000002', 'synth_000003', 'synth_000004', 'synth_000005', 'synth_000001'])
  })

  it('keeps built-in tool names and the AskUserQuestion structure, with placeholder words', () => {
    const a1 = out[4]
    expect(a1.message.content.map((b: any) => b.type === 'tool_use' ? b.name : b.type))
      .toEqual(['text', 'thinking', 'Bash', 'WebFetch', 'mcp__synthetic__tool_1', 'text'])
    expect(a1.message.content[5]).toEqual({ type: 'text', text: PLACEHOLDER.text }) // the unknown block: still an answer
    expect(a1.message.content[2].input).toEqual({ command: PLACEHOLDER.command, description: PLACEHOLDER.description, run_in_background: true })
    expect(a1.message.content[3].input).toEqual({}) // WebFetch: URL and prompt gone
    expect(a1.message.content[4].input).toEqual({})
    expect(a1.message.stop_reason).toBeUndefined()
    expect(a1.message.usage).toEqual({ input_tokens: 5 })
    const ask = out[7].message.content[0]
    expect(ask.name).toBe('AskUserQuestion')
    expect(ask.input).toEqual({ questions: [
      { question: '(question 1)', header: PLACEHOLDER.header, options: [{ label: 'Option 1', description: PLACEHOLDER.optionDescription }, { label: 'Option 2', description: '' }], multiSelect: false },
      { question: '(question 2)', header: '', options: [{ label: 'Option 1', description: PLACEHOLDER.optionDescription }], multiSelect: true },
    ] })
    expect(out[8].request).toMatchObject({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', requires_user_interaction: true, blocked_path: PLACEHOLDER.path })
    expect(out[8].request.input.questions[0].options.map((o: any) => o.label)).toEqual(['Option 1', 'Option 2'])
    expect(out[8].request.permission_suggestions).toEqual([{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: PLACEHOLDER.rule }] }])
  })

  it('keeps the user-line prefixes the fold and the projections branch on, and what the fold reads off tool results', () => {
    expect(out[11].message.content).toBe(`<local-command-stdout>${PLACEHOLDER.user}</local-command-stdout>`)
    expect(out[1].message.content).toBe(PLACEHOLDER.user)
    expect(out[10].tool_use_result).toEqual({ scheduledFor: 1893456000000, stdout: PLACEHOLDER.toolOutput, stderr: '' })
    const lastUser = out[out.length - 1]
    expect(lastUser.message.content).toBe(PLACEHOLDER.user)
  })

  it('keeps the counters and rate-limit enums, drops unlisted windows and reasons', () => {
    const result = byType('result')[0]
    expect(result).toMatchObject({ is_error: true, num_turns: 3, duration_ms: 1200, origin: { kind: 'peer' } })
    expect(result.modelUsage).toEqual({ 'synthetic-model-1': { inputTokens: 1 } })
    expect(result.permission_denials).toEqual([{ tool_name: 'Bash', tool_use_id: out[4].message.content[2].id, tool_input: { command: PLACEHOLDER.command } }])
    expect(byType('rate_limit_event')[0].rate_limit_info).toEqual({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1893456000,
      unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1893456000 } } })
  })

  it('the daemon fold reaches the same verdict after every line of the raw and the converted stream', () => {
    const raw = adversarialRaw()
    expect(replayParity(raw)).toEqual({ ok: true, diffs: [], line: null })
    const bg = [
      j({ type: 'user', session_id: 's', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
      j({ type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash' }),
      j({ type: 'system', subtype: 'task_started', task_id: 'b2', task_type: 'local_bash', is_backgrounded: true }),
      j({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed' } }),
      j({ type: 'result', subtype: 'success', is_error: false, num_turns: 16, result: 'done', session_id: 's' }),
      j({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 's' }),
    ].join('\n') + '\n'
    const shaped = toShapeOnly(bg)
    expect(replayParity(bg)).toEqual({ ok: true, diffs: [], line: null })
    const fold = foldLines(shaped)
    expect(fold.lastResult?.numTurns).toBe(16)
    expect(fold.turnActive).toBe(false)
    expect(Object.values(fold.bgTasks).filter((t) => t.isBackgrounded && !t.terminal)).toHaveLength(1)
  })
})

describe('convert: readings that hinge on presence or prefixes do not flip', () => {
  it('an unlisted error value on Claude Code\'s own reply becomes "unknown", keeping the reply and the fixpoint', () => {
    const raw = j({ type: 'assistant', error: 'brand_new_error', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 400 x' }] } }) + '\n'
    const shaped = toShapeOnly(raw)
    expect(parse(shaped)[0]).toMatchObject({ error: 'unknown', message: { content: [{ text: ERROR_TEXT.terminalCli }] } })
    expect(validateStream(shaped)).toEqual({ ok: true, errors: [] })
    expect(replayParity(raw).ok).toBe(true)
  })

  it('an unlisted task status stays non-terminal instead of vanishing into "completed"', () => {
    const raw = [
      j({ type: 'user', session_id: 's', message: { role: 'user', content: 'go' } }),
      j({ type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_bash' }),
      j({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'paused' }),
      j({ type: 'system', subtype: 'task_started', task_id: 't2', task_type: 'local_bash' }),
      j({ type: 'system', subtype: 'task_updated', task_id: 't2', patch: { status: 'completed' } }),
      j({ type: 'system', subtype: 'task_updated', task_id: 't2', patch: { status: 'resumed' } }),
      j({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'x', session_id: 's' }),
      j({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 's' }),
    ].join('\n') + '\n'
    const out = parse(toShapeOnly(raw))
    expect(out[2].status).toBe('running')
    expect(out[5].patch.status).toBe('running')
    expect(replayParity(raw)).toEqual({ ok: true, diffs: [], line: null })
    expect(foldLines(toShapeOnly(raw)).turnActive).toBe(true)
  })

  it('keeps a tag only for the exact prefix the code tests', () => {
    const shape = (content: string) => parse(toShapeOnly(j({ type: 'user', message: { role: 'user', content } }) + '\n'))[0].message.content
    expect(shape('<local-command-stdout-x> real words')).toBe(PLACEHOLDER.user)
    expect(shape('  <local-command-stdout>out</local-command-stdout>')).toBe(`<local-command-stdout>${PLACEHOLDER.user}</local-command-stdout>`)
    expect(shape('<task-notification id="x">done')).toBe(PLACEHOLDER.user)
    expect(shape('<teammate-message teammate_id="SECRET">hi')).toBe(`<teammate-message>${PLACEHOLDER.user}</teammate-message>`)
    const raw = [
      j({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'x', session_id: 's' }),
      j({ type: 'user', message: { role: 'user', content: '<local-command-stdout-x> real words' } }),
    ].join('\n') + '\n'
    expect(replayParity(raw).ok).toBe(true)
  })

  it('isApiErrorMessage marks Claude Code\'s own reply too, as the production rule does', () => {
    const raw = j({ type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Prompt is too long' }] } }) + '\n'
    expect(parse(toShapeOnly(raw))[0].message.content[0].text).toBe(ERROR_TEXT.contextFull)
  })

  it('line-fate reads a delivered, started and answered line the same way, unknown output included', () => {
    const raw = [
      j({ type: 'system', subtype: 'walnut_process', walnutPid: 777, walnutTurn: true }),
      j({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'SECRET ask' }, walnutMessageId: 'line-1', walnutPid: 777, timestamp: '2026-11-14T01:00:00.000Z' }),
      j({ type: 'command_lifecycle', command_uuid: 'line-1', state: 'queued' }),
      j({ type: 'keep_alive' }),
      j({ type: 'command_lifecycle', command_uuid: 'line-1', state: 'started' }),
      j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'server_tool_use', id: 'x' }] } }),
      j({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'SECRET two' }, walnutMessageId: 'line-2', walnutPid: 777, timestamp: '2026-11-14T01:00:05.000Z' }),
      j({ type: 'command_lifecycle', command_uuid: 'line-2', state: 'cancelled' }),
    ].join('\n') + '\n'
    expect(replayParity(raw)).toEqual({ ok: true, diffs: [], line: null })
    const out = parse(toShapeOnly(raw))
    // Spacing kept, absolute time not.
    expect(Date.parse(out[6].timestamp) - Date.parse(out[1].timestamp)).toBe(5000)
    expect(out[1].timestamp).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('usage-limit and error classes survive as canonical texts', () => {
  it('every canonical usage-limit text is a usage limit to the production detector, naming its window', () => {
    for (const [window, text] of Object.entries(USAGE_LIMIT_TEXT)) {
      expect(matchesUsageLimitText(text)).toBe(true)
      expect(classifyTurnError(text)).toBe('terminal')
      expect(claudeWindowFromText(text) ?? 'unknown').toBe(window)
      expect(productionClassifyText(text, true)).toBe(text)
    }
  })

  it('every canonical error text keeps its retryable/terminal and CLI-phrasing class, and is its own class', () => {
    expect(classifyTurnError(ERROR_TEXT.retryableCli)).toBe('retryable')
    expect(isCliErrorText(ERROR_TEXT.retryableCli)).toBe(true)
    expect(classifyTurnError(ERROR_TEXT.retryable)).toBe('retryable')
    expect(isCliErrorText(ERROR_TEXT.retryable)).toBe(false)
    expect(classifyTurnError(ERROR_TEXT.terminalCli)).toBe('terminal')
    expect(isCliErrorText(ERROR_TEXT.terminalCli)).toBe(true)
    expect(classifyTurnError(ERROR_TEXT.terminal)).toBe('terminal')
    expect(isCliErrorText(ERROR_TEXT.terminal)).toBe(false)
    for (const text of Object.values(ERROR_TEXT)) {
      expect(matchesUsageLimitText(text)).toBe(false)
      expect(productionClassifyText(text, true)).toBe(text)
    }
    expect(matchesUsageLimitText(PLACEHOLDER.result)).toBe(false)
  })

  it('each specific canonical error text reads as its own class to every production detector', () => {
    const specific = [ERROR_TEXT.contextFull, ERROR_TEXT.noConversation, ERROR_TEXT.signIn, ERROR_TEXT.credentials,
      ERROR_TEXT.permissions, ERROR_TEXT.spending, ERROR_TEXT.retryableCli, ERROR_TEXT.retryable, ERROR_TEXT.terminalCli, ERROR_TEXT.terminal]
    expect(new Set(specific.map(detectorReading)).size).toBe(specific.length)
    expect(DETECTORS.length).toBeGreaterThanOrEqual(5)
    const raws: Array<[string, string]> = [
      ['prompt is too long: 250000 tokens > 200000 maximum', ERROR_TEXT.contextFull],
      ['No conversation found with session ID: 1234-SECRET', ERROR_TEXT.noConversation],
      ['Not logged in \u00b7 Please run /login', ERROR_TEXT.signIn],
      ['API Error: 401 {"error":"invalid x-api-key SECRET"}', ERROR_TEXT.credentials],
      ['API Error: 403 forbidden for SECRET', ERROR_TEXT.permissions],
      ['Credit balance is too low', ERROR_TEXT.spending],
    ]
    for (const [raw, want] of raws) {
      expect(productionClassifyText(raw, true)).toBe(want)
      expect(detectorReading(want)).toBe(detectorReading(raw))
    }
  })

  it('maps raw texts to their class, never keeping the words', () => {
    const cases: Array<[string, boolean, string]> = [
      ['You\u2019ve hit your weekly limit \u00b7 resets Nov 6, 3pm (Europe/Berlin)', true, USAGE_LIMIT_TEXT.seven_day],
      ['You\'re out of extra usage \u00b7 resets 4pm', true, USAGE_LIMIT_TEXT.overage],
      ['Claude AI usage limit reached|1762282800', true, USAGE_LIMIT_TEXT.unknown],
      ['API Error: 529 {"type":"overloaded_error","request_id":"req_SECRET"}', true, ERROR_TEXT.retryableCli],
      ['socket hang up while talking to SECRET host', true, ERROR_TEXT.retryable],
      ['Prompt is too long', true, ERROR_TEXT.contextFull],
      ['the SECRET plan failed', true, ERROR_TEXT.terminal],
      ['SECRET final answer', false, PLACEHOLDER.result],
      ['   ', true, ''],
    ]
    for (const [raw, isError, want] of cases) expect(productionClassifyText(raw, isError)).toBe(want)
  })

  it('a raw usage-limit result converts to the canonical one; without the production classifier it does not', () => {
    const raw = j({ type: 'result', subtype: 'success', is_error: true, num_turns: 2, result: 'You\'ve hit your Opus limit \u00b7 resets 9am (Asia/Tokyo)', session_id: 's' }) + '\n'
    expect(parse(toShapeOnly(raw))[0].result).toBe(USAGE_LIMIT_TEXT.seven_day_opus)
    expect(parse(toCanonicalShape(raw))[0].result).toBe(ERROR_TEXT.terminal)
  })

  it('Claude Code\'s own error reply (<synthetic> model) keeps its class; a model answer never does', () => {
    const raw = [
      j({ type: 'assistant', error: 'invalid_request', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Prompt is too long' }] } }),
      j({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Prompt is too long' }] } }),
    ].join('\n') + '\n'
    const [reply, answer] = parse(toShapeOnly(raw))
    expect(reply).toMatchObject({ error: 'invalid_request', message: { model: '<synthetic>', content: [{ type: 'text', text: ERROR_TEXT.contextFull }] } })
    expect(answer.message.content[0].text).toBe(PLACEHOLDER.text)
  })

  it('usageLimitVariant writes a blocked turn as the CLI does: limit event, its own error reply, the usage-limit stop', () => {
    const base = toShapeOnly([
      j({ type: 'user', session_id: 's', message: { role: 'user', content: 'go' } }),
      j({ type: 'assistant', session_id: 's', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'partial answer' }] } }),
      j({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok', session_id: 's', terminal_reason: 'completed' }),
      j({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 's' }),
    ].join('\n') + '\n')
    for (const window of Object.keys(USAGE_LIMIT_TEXT) as Array<keyof typeof USAGE_LIMIT_TEXT>) {
      const variant = usageLimitVariant(base, { window })
      expect(validateStream(variant).ok).toBe(true)
      const lines = parse(variant)
      expect(lines.map((o) => o.type)).toEqual(['user', 'assistant', 'rate_limit_event', 'assistant', 'result', 'system'])
      const [, answer, event, reply, result] = lines
      expect(answer.message).toMatchObject({ model: 'synthetic-model-1', content: [{ type: 'text', text: PLACEHOLDER.text }] }) // earlier output kept
      expect(event.rate_limit_info.status).toBe('rejected')
      expect(event.session_id).toBe(result.session_id)
      // The reply as every reader of Claude Code's own error line reads it (cli-error-reply.ts), and as
      // claude-code-session.ts takes a blocked reply's limit (error 'rate_limit' + api_error_params).
      expect(reply).toMatchObject({ error: 'rate_limit', isApiErrorMessage: true, message: { model: '<synthetic>' }, session_id: result.session_id })
      expect(reply.api_error_params.rate_limit_info).toEqual(event.rate_limit_info)
      expect(isCliErrorReply(reply)).toBe(true)
      expect(cliErrorRowText(reply)).toBe(`${CLI_ERROR_PREFIX}${USAGE_LIMIT_TEXT[window]}`)
      expect(matchesUsageLimitText(reply.message.content[0].text)).toBe(true)
      expect(result).toMatchObject({ is_error: true, result: USAGE_LIMIT_TEXT[window] })
      expect(result.terminal_reason).toBeUndefined()
      expect(matchesUsageLimitText(result.result)).toBe(true)
      expect(replayParity(variant).ok).toBe(true)
    }
    expect(() => usageLimitVariant(base, { window: 'SECRET' as never })).toThrow()
  })
})

describe('validate: strict, and never echoes what it rejects', () => {
  const good = toShapeOnly(adversarialRaw())

  /** Validation must fail and its errors must not carry the canary. */
  function rejects(content: string, reason?: RegExp): void {
    const res = validateStream(content)
    expect(res.ok).toBe(false)
    assertNoSecrets(JSON.stringify(res.errors))
    if (reason) expect(res.errors.some((e) => reason.test(e.reason))).toBe(true)
    let message = ''
    try { assertShapeOnly(content, 'fixture') } catch (err) { message = (err as Error).message }
    expect(message).toMatch(/not a shape-only replay/)
    assertNoSecrets(message)
  }
  const mutateLine = (idx: number, f: (o: any) => void): string => {
    const lines = good.trim().split('\n')
    const o = JSON.parse(lines[idx]); f(o); lines[idx] = JSON.stringify(o)
    return lines.join('\n') + '\n'
  }
  const replaceText = (from: string, to: string): string => {
    expect(good.includes(from)).toBe(true)
    return good.replace(from, to)
  }

  it('accepts the converted file', () => {
    expect(validateStream(good)).toEqual({ ok: true, errors: [] })
    expect(() => assertShapeOnly(good)).not.toThrow()
  })

  it('rejects an unknown key, at the top or nested, and masks the key in the error path', () => {
    rejects(mutateLine(0, (o) => { o.SECRET_FIELD = 'x' }), /key/)
    rejects(mutateLine(4, (o) => { o.message.usage['zz_private_tokens'] = 1 }), /key/)
    rejects(mutateLine(7, (o) => { o.message.content[0].input.questions[0].SECRET_Q = true }), /key/)
    const res = validateStream(mutateLine(0, (o) => { o.nested = { SECRET_OBJECT_KEY: 1 } }))
    expect(res.errors.map((e) => e.path)).toContain('.<key>')
  })

  it('rejects a raw string in a text, enum, id, name or timestamp slot', () => {
    rejects(mutateLine(4, (o) => { o.message.content[0].text = 'SECRET words' }))
    rejects(mutateLine(6, (o) => { o.state = 'SECRET_STATE' }))
    rejects(mutateLine(5, (o) => { o.task_id = 'bgSECRET1' }))
    rejects(mutateLine(5, (o) => { o.task_id = 'toolu_01SECRETRAWID' }))
    rejects(mutateLine(0, (o) => { o.tools.push('mcp__acme__SECRET') }))
    rejects(mutateLine(0, (o) => { o.model = 'claude-secret' }))
    rejects(mutateLine(1, (o) => { o.timestamp = '2026-11-14 SECRET' }))
    rejects(mutateLine(7, (o) => { o.message.content[0].input.questions[0].options[0].label = 'SECRET A' }))
  })

  it('rejects home paths, URLs and emails anywhere in a line', () => {
    rejects(mutateLine(0, (o) => { o.cwd = '/Users/alice/private' }), /home path/)
    rejects(mutateLine(0, (o) => { o.cwd = '/home/bob/x' }), /home path/)
    rejects(mutateLine(4, (o) => { o.message.content[0].text = 'see https://internal.example.com' }), /url/)
    rejects(mutateLine(4, (o) => { o.message.content[0].text = 'bob@example.com' }), /email/)
  })

  it('rejects numbers in the wrong form or out of range, and numeric strings', () => {
    rejects(mutateLine(18, (o) => { o.num_turns = '3' }))
    rejects(mutateLine(18, (o) => { o.num_turns = -1 }))
    rejects(good.replace('"num_turns":3', '"num_turns":1e400'))
    rejects(good.replace('"num_turns":3', '"num_turns":3.0'), /not canonical/)
    rejects(good.replace('"num_turns":3', '"num_turns":3e0'), /not canonical/)
    rejects(mutateLine(18, (o) => { o.duration_ms = 1e14 }))
  })

  it('rejects byte tricks the parsed value hides: duplicate keys, escapes, spacing, key order', () => {
    rejects(replaceText('"state":"idle"', '"state":"SECRET_DUP","state":"idle"'), /not canonical/)
    rejects(replaceText('"(text)"', '"\\u0028text)"'), /not canonical/)
    rejects(replaceText('{"type":"control_cancel_request"', '{ "type": "control_cancel_request"'), /not canonical/)
    rejects(mutateLine(9, (o) => { const id = o.request_id; delete o.request_id; o.request_id = id; const t = o.type; delete o.type; o.type = t }), /not canonical/)
  })

  it('rejects ids that are synthetic in form but not in canonical first-seen order', () => {
    const lines = good.trim().split('\n')
    const swapped = lines.map((l) => l.replaceAll('00000000-0000-4000-8000-000000000001', 'X').replaceAll('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001').replaceAll('X', '00000000-0000-4000-8000-000000000002'))
    rejects(swapped.join('\n') + '\n', /not canonical/)
  })

  it('rejects unknown events, malformed lines, blank lines, a missing final newline and an empty file', () => {
    rejects(good + j({ type: 'SECRET_TYPE' }) + '\n', /event type/)
    rejects(good + j({ type: 'system', subtype: 'SECRET_SUBTYPE' }) + '\n', /event type/)
    rejects(good + '{"type":"user", SECRET\n', /not JSON/)
    rejects(good + '[1,2]\n', /JSON object/)
    rejects(good + '\n', /not JSON|canonical/)
    rejects(good.slice(0, -1), /final newline/)
    rejects('', /empty/)
  })

  it('rejects an allowed word in the wrong slot, CRLF endings and a BOM', () => {
    rejects(mutateLine(1, (o) => { o.message.content = 'Bash' }))
    rejects(good.replaceAll('\n', '\r\n'), /not canonical|JSON/)
    rejects('\ufeff' + good, /not JSON|canonical/)
  })

  it('rejects deep nesting as a problem, without throwing', () => {
    const deep = '{"type":"result","x":' + '['.repeat(30000) + ']'.repeat(30000) + '}\n'
    let res: ReturnType<typeof validateStream> | undefined
    expect(() => { res = validateStream(deep) }).not.toThrow()
    expect(res!.ok).toBe(false)
  })

  it('rejects an oversized line or file', () => {
    expect(validateStream(good, { maxLineBytes: 100 }).errors.some((e) => /line over/.test(e.reason))).toBe(true)
    expect(validateStream(good, { maxBytes: 100 }).errors.some((e) => /file over/.test(e.reason))).toBe(true)
    const huge = j({ type: 'system', subtype: 'init', tools: Array(20000).fill('Bash') }) + '\n'
    expect(validateStream(huge).errors.some((e) => /line over/.test(e.reason))).toBe(true)
  })

  it('finds two recordings of the same shape as duplicates (the canonical id map makes them equal)', () => {
    const mk = (sid: string, tid: string) => [
      j({ type: 'system', subtype: 'task_started', session_id: sid, task_id: tid, task_type: 'local_bash' }),
      j({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: tid, status: 'completed' }),
    ].join('\n') + '\n'
    const a = toShapeOnly(mk('sess-one', 'task-one'))
    const b = toShapeOnly(mk('sess-two', 'task-two'))
    const c = toShapeOnly(mk('sess-three', 'task-three').replace('completed', 'failed'))
    expect(a).toBe(b)
    expect(findDuplicateFixtures([{ name: 'a', content: a }, { name: 'b', content: b }, { name: 'c', content: c }])).toEqual([['a', 'b']])
  })
})

describe('checked-in fixtures', () => {
  it('every *.jsonl under tests/fixtures/incident-replays is shape-only, and none is a duplicate', () => {
    const { files, problems } = validateFixtures([FIXTURE_DIR])
    expect(files.length).toBeGreaterThan(0)
    // file:line path reason only (the validator never carries text).
    expect(problems.map((p) => `${path.basename(p.file)}:${p.line} ${p.path} ${p.reason}`)).toEqual([])
  })

  it('the guard reaches nested directories, any *.jsonl name, symlinks and stray files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-replay-guard-'))
    try {
      const good = toShapeOnly(j({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 's' }) + '\n')
      fs.writeFileSync(path.join(dir, 'ok.shape.jsonl'), good)
      fs.writeFileSync(path.join(dir, 'README.md'), 'docs')
      fs.mkdirSync(path.join(dir, 'nested', 'deeper'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'nested', 'deeper', 'ordinary-name.jsonl'), j({ type: 'user', message: { content: 'SECRET' } }) + '\n')
      fs.writeFileSync(path.join(dir, 'nested', 'copy.jsonl'), good)
      fs.writeFileSync(path.join(dir, 'nested', 'private.log'), 'SECRET')
      fs.symlinkSync(path.join(dir, 'ok.shape.jsonl'), path.join(dir, 'link.jsonl'))
      const { files, problems } = validateFixtures([dir])
      expect(files.map((f) => path.relative(dir, f))).toEqual(['nested/copy.jsonl', 'nested/deeper/ordinary-name.jsonl', 'ok.shape.jsonl'])
      const by = (name: string) => problems.filter((p) => p.file.endsWith(name)).map((p) => p.reason)
      expect(by('ordinary-name.jsonl').length).toBeGreaterThan(0)
      expect(by('private.log')).toEqual(['unexpected file in a replay fixture directory'])
      expect(by('link.jsonl')).toEqual(['symlink (never followed)'])
      expect(by('ok.shape.jsonl')).toEqual(['same recording as copy.jsonl'])
      assertNoSecrets(JSON.stringify(problems.map((p) => [p.path, p.reason])))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The developer's own recordings, when this machine has them: converted in memory only.
// WALNUT_LOCAL_REPLAYS_DIR: a copy of them outside the repo, for a test container that cannot see
// the private directory.
const LOCAL_DIR = process.env.WALNUT_LOCAL_REPLAYS_DIR || privateReplayDir()
const localFiles = fs.existsSync(LOCAL_DIR) ? fs.readdirSync(LOCAL_DIR).filter((f) => f.endsWith('.jsonl')) : []
describe.skipIf(localFiles.length === 0)('local raw recordings (skipped when absent)', () => {
  it.each(localFiles)('%s converts to a valid shape with the same fold verdict', (name) => {
    const raw = fs.readFileSync(path.join(LOCAL_DIR, name), 'utf8')
    const shaped = toShapeOnly(raw)
    expect(validateStream(shaped).errors).toEqual([])
    expect(replayParity(raw).diffs).toEqual([])
  })
})

/** A temp root outside every git worktree (some hosts carry a stray /tmp/.git). */
function tempRoot(): string {
  for (const dir of [os.tmpdir(), '/var/tmp', path.join(os.homedir(), '.cache')]) {
    if (fs.existsSync(dir) && !enclosingGitWorktree(fs.realpathSync(dir))) return dir
  }
  throw new Error('no temp directory outside a git worktree')
}

describe('record: private copies only', () => {
  let tmp: string
  let home: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(tempRoot(), 'walnut-replay-record-'))
    home = path.join(tmp, 'home')
    fs.mkdirSync(home)
  })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const sample = j({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 's' }) + '\n'
  const mode = (p: string) => fs.statSync(p).mode & 0o777

  it('copies a recorded stream into <home>/.local/state/open-walnut/incident-replays as 0600 in a 0700 directory, leaving the source alone', async () => {
    const src = path.join(tmp, 'stream.jsonl')
    fs.writeFileSync(src, sample + sample)
    const res = await recordFromFile(src, { name: 'idle-twice', home })
    expect(res).toEqual({ file: path.join(home, '.local', 'state', 'open-walnut', 'incident-replays', 'idle-twice.jsonl'), bytes: sample.length * 2, lines: 2 })
    expect(fs.readFileSync(res.file, 'utf8')).toBe(sample + sample)
    expect(mode(res.file)).toBe(0o600)
    expect(mode(path.dirname(res.file))).toBe(0o700)
    expect(fs.readFileSync(src, 'utf8')).toBe(sample + sample)
  })

  it('never overwrites, and never writes through a planted symlink', async () => {
    const src = path.join(tmp, 'stream.jsonl')
    fs.writeFileSync(src, sample)
    const first = await recordFromFile(src, { name: 'once', home })
    await expect(recordFromFile(src, { name: 'once', home })).rejects.toThrow(/overwrite/)
    expect(fs.readFileSync(first.file, 'utf8')).toBe(sample)
    const victim = path.join(tmp, 'victim.txt')
    fs.writeFileSync(victim, 'untouched')
    fs.symlinkSync(victim, path.join(path.dirname(first.file), 'planted.jsonl'))
    await expect(recordFromFile(src, { name: 'planted', home })).rejects.toThrow()
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched')
  })

  it('refuses a symlinked private directory or parent', async () => {
    const elsewhere = path.join(tmp, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(home, '.local'))
    expect(() => prepareDestination('x', home)).toThrow(/symlink/)
    fs.rmSync(path.join(home, '.local'))
    fs.mkdirSync(path.join(home, '.local', 'state', 'open-walnut'), { recursive: true })
    fs.symlinkSync(elsewhere, path.join(home, '.local', 'state', 'open-walnut', 'incident-replays'))
    expect(() => prepareDestination('x', home)).toThrow(/symlink/)
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it('refuses a destination inside a git worktree (a .git dir or a worktree .git file above it)', () => {
    fs.mkdirSync(path.join(home, '.git'))
    expect(() => prepareDestination('x', home)).toThrow(/git worktree/)
    // Refused before anything is created: the worktree is left exactly as it was.
    expect(fs.readdirSync(home)).toEqual(['.git'])
    fs.rmSync(path.join(home, '.git'), { recursive: true })
    fs.writeFileSync(path.join(home, '.git'), 'gitdir: /nowhere\n')
    expect(() => prepareDestination('x', home)).toThrow(/git worktree/)
    expect(enclosingGitWorktree(path.join(home, 'a', 'b'))).toBe(home)
    // A repo part way down (a synced state directory): refused before its child is created.
    fs.rmSync(path.join(home, '.git'))
    fs.mkdirSync(path.join(home, '.local', 'state', '.git'), { recursive: true })
    expect(() => prepareDestination('x', home)).toThrow(/git worktree/)
    expect(fs.readdirSync(path.join(home, '.local', 'state'))).toEqual(['.git'])
  })

  it('refuses names that could leave the directory, and a relative home', () => {
    for (const name of ['../x', 'a/b', '', '.hidden', 'UPPER', 'x'.repeat(81)]) expect(() => prepareDestination(name, home)).toThrow(/name/)
    expect(() => prepareDestination('x', 'relative/home')).toThrow(/absolute/)
  })

  it('records a piped stream and tees it, and removes a partial copy past the size cap', async () => {
    async function* chunks(): AsyncGenerator<string> { yield sample.slice(0, 10); yield sample.slice(10); yield '{"torn":' }
    const teed: Buffer[] = []
    const res = await recordFromStream(chunks(), { name: 'piped', home, tee: (b) => teed.push(b) })
    expect(Buffer.concat(teed).toString()).toBe(sample + '{"torn":')
    expect(res.lines).toBe(2)
    expect(mode(res.file)).toBe(0o600)
    await expect(recordFromStream(chunks(), { name: 'capped', home, maxBytes: 5 })).rejects.toThrow(/over 5 bytes/)
    expect(fs.existsSync(path.join(path.dirname(res.file), 'capped.jsonl'))).toBe(false)
  })

  it('refuses a source that is not a regular file', async () => {
    await expect(recordFromFile(tmp, { name: 'dir', home })).rejects.toThrow(/regular file/)
  })
})
