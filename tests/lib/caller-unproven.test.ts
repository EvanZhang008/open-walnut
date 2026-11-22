/**
 * A relayed call whose session sid the host's daemon could not prove (src/lib/caller-unproven.ts):
 * the relay hands the daemon's mark to the op, and every self-call of the op carries it, so the
 * start-mode ceiling reads the caller as an outside one (tests/core/sessions/cap-start-mode.test.ts).
 * The mark only lowers trust: a caller that writes it caps itself, and nothing reads it as more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-caller-unproven-test'))

import { CALLER_UNPROVEN_HEADER, callerUnprovenOf, relayedCallerUnproven } from '../../src/lib/caller-unproven.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import * as ops from '../../src/ops/index.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'

afterEach(() => { vi.restoreAllMocks() })

describe('reading the mark', () => {
  it('a relayed payload carries it only as the literal true', () => {
    expect(relayedCallerUnproven({ name: 'task_start', callerUnproven: true })).toBe(true)
    for (const v of [undefined, 'true', 1, {}, false, null]) expect(relayedCallerUnproven({ callerUnproven: v }), JSON.stringify(v)).toBe(false)
    expect(relayedCallerUnproven(null)).toBe(false)
    expect(relayedCallerUnproven('callerUnproven')).toBe(false)
  })

  it('a request carries it with any non-empty value: a mangled or repeated header still caps', () => {
    expect(callerUnprovenOf({ headers: { [CALLER_UNPROVEN_HEADER]: '1' } })).toBe(true)
    expect(callerUnprovenOf({ headers: { [CALLER_UNPROVEN_HEADER]: 'yes' } })).toBe(true)
    expect(callerUnprovenOf({ headers: { [CALLER_UNPROVEN_HEADER]: ['', '1'] } })).toBe(true)
    for (const v of [undefined, '', '  ', []]) expect(callerUnprovenOf({ headers: { [CALLER_UNPROVEN_HEADER]: v as never } }), JSON.stringify(v)).toBeUndefined()
    expect(callerUnprovenOf({ headers: {} })).toBeUndefined()
    expect(callerUnprovenOf(undefined)).toBeUndefined()
  })
})

describe('the op executor\'s self-calls', () => {
  it('carry the mark only for a marked call, beside the sid it keeps as provenance', async () => {
    const seen: Array<{ unproven?: string; sid?: string }> = []
    const server = http.createServer((req, res) => {
      seen.push({ unproven: req.headers[CALLER_UNPROVEN_HEADER] as string | undefined, sid: req.headers['x-walnut-caller-sid'] as string | undefined })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ host: 'devbox', jobs: [] }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      const opts = { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: 'sid-1' }
      expect((await executeOp('host_exec_list', { host: 'devbox' }, { ...opts, callerUnproven: true })).ok).toBe(true)
      expect((await executeOp('host_exec_list', { host: 'devbox' }, opts)).ok).toBe(true)
      // A person's call never carries it (no ceiling reads a person's call as a session's).
      expect((await executeOp('host_exec_list', { host: 'devbox' }, { ...opts, callerMode: 'human', callerUnproven: true })).ok).toBe(true)
      expect(seen).toEqual([{ unproven: '1', sid: 'sid-1' }, { unproven: undefined, sid: 'sid-1' }, { unproven: undefined, sid: undefined }])
    } finally {
      server.close()
    }
  })
})

describe('the gateway relay', () => {
  it('hands the daemon\'s mark to the op, and nothing for a payload without the literal true', async () => {
    const given: Array<Record<string, unknown>> = []
    vi.spyOn(ops, 'executeOp').mockImplementation((async (_name: string, _args: unknown, options: Record<string, unknown>) => {
      given.push(options)
      return { ok: true, result: { tasks: [] } }
    }) as never)
    for (const callerUnproven of [true, 'true', undefined]) {
      const out = await handleGatewayCapability('tools.call', 'sid-1', { name: 'task_list', args: {}, ...(callerUnproven === undefined ? {} : { callerUnproven }) }, 'devbox')
      expect(out.ok).toBe(true)
    }
    expect(given.map((o) => [o.callerSid, o.callerUnproven])).toEqual([['sid-1', true], ['sid-1', undefined], ['sid-1', undefined]])
  })
})
