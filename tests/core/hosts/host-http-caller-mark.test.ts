/**
 * Guard: a host_http request to the host Walnut's own server runs on carries the calling session's
 * mark, so it never reads as the person at his window.
 *
 * Found 2026-11-28 (review of the Slack console's person-only guard): a task on another host could
 * host_http POST http://127.0.0.1:3456/api/plugins/slack/messages on the server's host with no
 * Walnut header; the server read it as the person (web/routes/person-caller.ts) and posted to Slack
 * in his name, past the approval letter. Every person-only route had the same hole through this op.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => ({ calls: [] as Array<{ cmd: string; payload: Record<string, unknown> }>, caller: { sid: 'sess-1', taskId: 't-1', taskTitle: 'a task', host: 'devbox' } }))

vi.mock('../../../src/core/hosts/host-exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/hosts/host-exec.js')>()
  return {
    ...real,
    callerOf: async () => ({ ...sent.caller }),
    targetHost: async (h: string) => (!h || h === 'local' ? '__local__' : h),
    grantFor: async () => 'g-1',
    assertStillGranted: async () => 'g-1',
    budgetLeft: () => 60_000,
    redact: async (text: string) => ({ text, redacted: 0 }),
    dial: async () => ({
      send: async (cmd: string, payload: Record<string, unknown>) => {
        sent.calls.push({ cmd, payload })
        return { ok: true, status: 200, statusText: 'OK', url: payload.url, headers: {}, contentType: 'application/json', body: '{}', bodyBytes: 2, truncated: false, ms: 1 }
      },
    }),
  }
})

vi.mock('../../../src/core/hosts/exec-grants.js', () => ({ noteRun: async () => undefined }))

import { httpOnHost, outgoingHeaders, resetHostHttpForTest } from '../../../src/core/hosts/host-http.js'

const SLACK_POST = { url: 'http://127.0.0.1:3456/api/plugins/slack/messages', method: 'POST', body: '{"channel":"C1","text":"hi"}' }

function headersSent(): Record<string, string> {
  const last = sent.calls.at(-1)
  expect(last?.cmd).toBe('http.request')
  return (last?.payload.headers ?? {}) as Record<string, string>
}

beforeEach(() => {
  sent.calls.length = 0
  sent.caller = { sid: 'sess-1', taskId: 't-1', taskTitle: 'a task', host: 'devbox' }
  resetHostHttpForTest()
})

describe('host_http to the server\'s own host carries the caller\'s mark', () => {
  it('stamps the session id on a request to the server\'s loopback', async () => {
    await httpOnHost({ host: '__local__', ...SLACK_POST, headers: { 'content-type': 'application/json' } }, 'sess-1')
    expect(headersSent()).toEqual({ 'content-type': 'application/json', 'x-walnut-caller-sid': 'sess-1' })
  })

  it('stamps it whatever address reaches the server (a LAN name too), and with no headers given', async () => {
    await httpOnHost({ host: 'local', url: 'http://macbox.lan:3456/api/approvals/x/answer', method: 'POST', body: '{}' }, 'sess-1')
    expect(headersSent()['x-walnut-caller-sid']).toBe('sess-1')
  })

  it('replaces a caller mark the agent wrote itself, in any case', async () => {
    await httpOnHost({ host: '__local__', ...SLACK_POST, headers: { 'X-Walnut-Caller-Sid': '', 'x-walnut-caller-kind': '' } }, 'sess-1')
    const headers = headersSent()
    expect(Object.keys(headers).map((k) => k.toLowerCase()).filter((k) => k.startsWith('x-walnut-caller'))).toEqual(['x-walnut-caller-sid'])
    expect(headers['x-walnut-caller-sid']).toBe('sess-1')
  })

  it('marks a call with no session (a trigger check\'s) as automation', () => {
    expect(outgoingHeaders({}, '__local__', { sid: '' })).toEqual({ 'x-walnut-caller-kind': 'automation' })
  })

  it('sends another host only the caller\'s own headers: the session id is no business of an outside service', async () => {
    await httpOnHost({ host: 'devbox2', url: 'http://127.0.0.1:5173/', headers: { accept: 'text/html' } }, 'sess-1')
    expect(headersSent()).toEqual({ accept: 'text/html' })
  })
})
