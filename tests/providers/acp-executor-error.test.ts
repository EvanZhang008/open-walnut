/**
 * The executor-error line some ACP adapters end a failed turn with (acp-worker/executor-error.ts),
 * the descriptor auth plan (acp-worker/adapter-env.ts) and the effort mapping (acp-effort.ts):
 * pure readers, no IO.
 */
import { describe, expect, it } from 'vitest'
import {
  parseGoDuration,
  readExecutorError,
  refusalMeansUsageLimit,
  turnEndFailure,
  TurnTextTail,
} from '../../src/providers/acp-worker/executor-error.js'
import { ACP_AUTH_ENV, descriptorAdapterEnv, pickAcpAuthMethod } from '../../src/providers/acp-worker/adapter-env.js'
import { effortControlOf, effortValueFor } from '../../src/providers/acp-effort.js'
import type { AcpConfigOption } from '../../src/providers/acp-worker/protocol.js'

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0)
// The warning sign the adapter writes before its mark (U+26A0).
const line = (body: string) => `\n\u26a0 agent executor error: generating and executing: ${body}\n`

describe('parseGoDuration', () => {
  it('reads Go durations as milliseconds', () => {
    expect(parseGoDuration('1h2m3.5s')).toBe(3_723_500)
    expect(parseGoDuration('34.074824224s')).toBe(34_075)
    expect(parseGoDuration('500ms')).toBe(500)
    expect(parseGoDuration('1m30s')).toBe(90_000)
    expect(parseGoDuration('2h')).toBe(7_200_000)
    expect(parseGoDuration('1500us')).toBe(2)
    expect(parseGoDuration('0')).toBe(0)
  })

  it('refuses what is not one', () => {
    for (const bad of ['', '5', 'h', '1x', '-1s', '1h foo', '1.5.2s']) expect(parseGoDuration(bad)).toBeUndefined()
  })
})

describe('readExecutorError', () => {
  it('a bad key (400 INVALID_ARGUMENT, reason API_KEY_INVALID) is auth_required', () => {
    const text = 'Partial answer.' + line('Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com reason:API_KEY_INVALID]]')
    const failure = readExecutorError(text, NOW)
    expect(failure?.kind).toBe('auth_required')
    expect(failure?.resetsAt).toBeUndefined()
    expect(failure?.words).toContain('API key not valid')
  })

  it('401 and 403 PERMISSION_DENIED are auth_required, in either shape', () => {
    expect(readExecutorError(line('Error 401, Message: Request had invalid authentication credentials., Status: UNAUTHENTICATED'), NOW)?.kind).toBe('auth_required')
    expect(readExecutorError(line('Error 403, Message: The caller does not have permission, Status: PERMISSION_DENIED'), NOW)?.kind).toBe('auth_required')
    expect(readExecutorError(line('PERMISSION_DENIED (code 403): denied'), NOW)?.kind).toBe('auth_required')
  })

  it('429, RESOURCE_EXHAUSTED and QUOTA_EXHAUSTED are usage_limit, with the reset they name', () => {
    expect(readExecutorError(line('Error 429, Message: Quota exceeded, Status: RESOURCE_EXHAUSTED, Details: [map[metadata:map[quotaResetTimeStamp:2026-11-23T20:00:00Z]]]'), NOW))
      .toMatchObject({ kind: 'usage_limit', resetsAt: Date.UTC(2026, 10, 23, 20, 0, 0) })
    expect(readExecutorError(line('Error 429, Message: Quota exceeded, Status: RESOURCE_EXHAUSTED, Details: [map[reason:QUOTA_EXHAUSTED metadata:map[quotaResetDelay:1h2m3.5s]]]'), NOW))
      .toMatchObject({ kind: 'usage_limit', resetsAt: NOW + 3_723_500 })
    expect(readExecutorError(line('RESOURCE_EXHAUSTED (code 429): try later [map[retryDelay:34s]]'), NOW))
      .toMatchObject({ kind: 'usage_limit', resetsAt: NOW + 34_000 })
    // The timestamp wins over a delay; a quota with no reset named has none.
    expect(readExecutorError(line('Error 429, Message: q, Status: RESOURCE_EXHAUSTED, Details: [map[quotaResetDelay:5m retryDelay:1s quotaResetTimeStamp:2026-11-24T00:00:00.000Z]]'), NOW)?.resetsAt)
      .toBe(Date.UTC(2026, 10, 24))
    const bare = readExecutorError(line('Error 500, Message: internal, Status: INTERNAL, Details: [map[reason:QUOTA_EXHAUSTED]]'), NOW)
    expect(bare?.kind).toBe('usage_limit')
    expect(bare?.resetsAt).toBeUndefined()
  })

  it('any other executor error is protocol', () => {
    expect(readExecutorError(line('Error 500, Message: Internal error encountered., Status: INTERNAL'), NOW)?.kind).toBe('protocol')
    expect(readExecutorError(line('stream closed'), NOW)?.kind).toBe('protocol')
  })

  it('reads only a real error line at the end: quoted mid-answer, without its sign, or none at all is nothing', () => {
    expect(readExecutorError('All done, the tests pass.', NOW)).toBeUndefined()
    expect(readExecutorError('The adapter says "agent executor error: Error 401" when the key is bad.', NOW)).toBeUndefined()
    expect(readExecutorError(line('Error 401, Message: x, Status: UNAUTHENTICATED') + 'More answer. '.repeat(400), NOW)).toBeUndefined()
  })

  it('the last line counts', () => {
    const text = line('Error 401, Message: x, Status: UNAUTHENTICATED') + line('Error 429, Message: q, Status: RESOURCE_EXHAUSTED')
    expect(readExecutorError(text, NOW)?.kind).toBe('usage_limit')
  })
})

describe('turnEndFailure and the refusal rule', () => {
  const antigravity = { agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' } }

  it('a refusal is the usage limit only when initialize names that adapter', () => {
    expect(refusalMeansUsageLimit(antigravity)).toBe(true)
    expect(refusalMeansUsageLimit({ agentInfo: { name: 'gemini-cli' } })).toBe(false)
    expect(refusalMeansUsageLimit(null)).toBe(false)
    expect(turnEndFailure({ tail: '', stopReason: 'refusal', initializeResponse: antigravity, nowMs: NOW })?.kind).toBe('usage_limit')
    expect(turnEndFailure({ tail: '', stopReason: 'refusal', initializeResponse: {}, nowMs: NOW })).toBeUndefined()
    expect(turnEndFailure({ tail: '', stopReason: 'end_turn', initializeResponse: antigravity, nowMs: NOW })).toBeUndefined()
  })

  it('reads an executor-error line only on that adapter: elsewhere it is the model\'s own text', () => {
    const tail = line('Error 429, Message: q, Status: RESOURCE_EXHAUSTED')
    expect(turnEndFailure({ tail, stopReason: 'end_turn', initializeResponse: antigravity, nowMs: NOW })?.kind).toBe('usage_limit')
    expect(turnEndFailure({ tail, stopReason: 'end_turn', initializeResponse: { agentInfo: { name: 'codex-acp' } }, nowMs: NOW })).toBeUndefined()
    expect(turnEndFailure({ tail, stopReason: 'end_turn', initializeResponse: null, nowMs: NOW })).toBeUndefined()
  })

  it('a quoted line with an explanation after it is no failure, even a short one', () => {
    const quoted = `Here is the log:\n\u26a0 agent executor error: Error 429, Message: q, Status: RESOURCE_EXHAUSTED\nThis means the quota ran out; retry later.`
    expect(turnEndFailure({ tail: quoted, stopReason: 'end_turn', initializeResponse: antigravity, nowMs: NOW })).toBeUndefined()
  })

  it('a real-length error line (long Details) is still read', () => {
    const details = 'map[@type:type.googleapis.com/google.rpc.QuotaFailure violations:[' + 'map[quotaMetric:generativelanguage.googleapis.com/generate_content quotaId:PerDay]'.repeat(60) + ']]'
    const tail = line(`Error 429, Message: Quota exceeded, Status: RESOURCE_EXHAUSTED, Details: [${details} map[retryDelay:20s]]`)
    expect(tail.length).toBeGreaterThan(5000)
    expect(turnEndFailure({ tail, stopReason: 'end_turn', initializeResponse: antigravity, nowMs: NOW })).toMatchObject({ kind: 'usage_limit', resetsAt: NOW + 20_000 })
  })

  it('a refusal with a quota line keeps the reset the line names', () => {
    const tail = line('Error 429, Message: q, Status: RESOURCE_EXHAUSTED, Details: [map[retryDelay:10s]]')
    expect(turnEndFailure({ tail, stopReason: 'refusal', initializeResponse: antigravity, nowMs: NOW })).toMatchObject({ kind: 'usage_limit', resetsAt: NOW + 10_000 })
  })

  it('the tail keeps the last characters only', () => {
    const tail = new TurnTextTail(10)
    tail.push('0123456789')
    tail.push('abc')
    expect(tail.read()).toBe('3456789abc')
    tail.reset()
    expect(tail.read()).toBe('')
  })
})

describe('the descriptor auth plan', () => {
  const init = { authMethods: [{ id: 'gemini-api-key' }, { id: 'agent-platform' }, { id: 'oauth-personal' }] }
  const plan = JSON.stringify({ byEnv: [['GEMINI_API_KEY', 'gemini-api-key'], ['GOOGLE_CLOUD_PROJECT', 'agent-platform']], otherwise: 'oauth-personal' })

  it('picks the first entry whose variable is set, else otherwise, and only an advertised method', () => {
    expect(pickAcpAuthMethod(plan, { GEMINI_API_KEY: 'k', GOOGLE_CLOUD_PROJECT: 'p' }, init)).toBe('gemini-api-key')
    expect(pickAcpAuthMethod(plan, { GOOGLE_CLOUD_PROJECT: 'p' }, init)).toBe('agent-platform')
    expect(pickAcpAuthMethod(plan, { GEMINI_API_KEY: '' }, init)).toBe('oauth-personal')
    expect(pickAcpAuthMethod(plan, {}, { authMethods: [{ id: 'gemini-api-key' }] })).toBeUndefined()
    expect(pickAcpAuthMethod(undefined, { GEMINI_API_KEY: 'k' }, init)).toBeUndefined()
    expect(pickAcpAuthMethod('not json', {}, init)).toBeUndefined()
  })

  it('rides the env as JSON beside the descriptor variables; a descriptor with neither adds nothing', () => {
    const env = descriptorAdapterEnv({ env: { A: '1' }, auth: { otherwise: 'oauth-personal' } })
    expect(env).toEqual({ A: '1', [ACP_AUTH_ENV]: JSON.stringify({ otherwise: 'oauth-personal' }) })
    expect(descriptorAdapterEnv({})).toBeUndefined()
    expect(descriptorAdapterEnv(undefined)).toBeUndefined()
  })
})

describe('effort onto the adapter effort control', () => {
  const control = (id: string, values: string[], category?: string): AcpConfigOption => ({
    id, name: id, type: 'select', currentValue: values[0], options: values.map((value) => ({ value, name: value })),
    ...(category ? { category } : {}),
  })

  it('finds the thought_level control, else one named reasoning_effort', () => {
    expect(effortControlOf([control('mode', ['default']), control('thought_level', ['low'], 'thought_level')])?.id).toBe('thought_level')
    expect(effortControlOf([control('reasoning_effort', ['low'])])?.id).toBe('reasoning_effort')
    expect(effortControlOf([control('mode', ['default'])])).toBeUndefined()
  })

  it('maps onto an offered value: exact, else the nearest below, else the lowest', () => {
    const four = control('thought_level', ['low', 'medium', 'high', 'xhigh'])
    expect(effortValueFor('high', four)).toBe('high')
    expect(effortValueFor('max', four)).toBe('xhigh')
    // Codex keeps its exact rule: an effort the model does not offer is not applied.
    expect(effortValueFor('max', four, true)).toBeUndefined()
    expect(effortValueFor('high', four, true)).toBe('high')
    expect(effortValueFor('minimal', four)).toBe('low')
    const three = control('thought_level', ['low', 'medium', 'high'])
    expect(effortValueFor('max', three)).toBe('high')
    expect(effortValueFor('xhigh', three)).toBe('high')
    expect(effortValueFor('turbo', three)).toBeUndefined()
    expect(effortValueFor('HIGH', control('x', ['HIGH']))).toBe('HIGH')
    expect(effortValueFor('high', control('x', ['fast', 'slow']))).toBeUndefined()
  })
})
