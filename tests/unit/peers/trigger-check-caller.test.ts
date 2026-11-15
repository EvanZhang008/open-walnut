/**
 * The small pieces of trigger-caller-v1 (core/hosts/trigger-caller.ts), each where it lives:
 * - the daemon's token table and how it relays a check's call (trigger-check-core.ts);
 * - the server keeps a daemon's triggerCaller (and callerProof) only from a daemon that says it
 *   drops a forged one (gateway-core.ts vouchedGatewayPayload, read by daemon-connection.ts);
 * - the gateway CLI sends a check's call with its run's token to its run's socket, a session's own
 *   id always winning (wn-cli.ts resolveWalnutCliEndpoint);
 * - the installed CLI hands a check's task-only host op to that daemon, and nothing else
 *   (commands/tools-daemon-fallback.ts callThroughCheckDaemon, lib/task-host-ops.ts);
 * - a test run's id and a held trigger expire (trigger-caller.ts).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  CHECK_SOCKET_ENV, CHECK_TOKEN_ENV, checkCallerEnv, checkGatewayCall, createCheckCallers, testCheckCaller, withoutTriggerCaller,
} from '../../../src/providers/trigger-check-core.js'
import { CALLER_PROOF_CAPABILITY, TRIGGER_CALLER_CAPABILITY, vouchedGatewayPayload } from '../../../src/providers/gateway-core.js'
import { resolveWalnutCliEndpoint, type WalnutSocketInfo } from '../../../src/providers/wn-cli.js'
import { callThroughCheckDaemon } from '../../../src/commands/tools-daemon-fallback.js'
import { isTaskHostOpPath } from '../../../src/lib/task-host-ops.js'
import { holdRelayTrigger, legacyCheckActsFor, noteTestRun } from '../../../src/core/hosts/trigger-caller.js'

describe('the daemon\'s check tokens', () => {
  it('vouch for their run while it runs, and for nothing after', () => {
    let n = 0
    const callers = createCheckCallers(() => `t${++n}`)
    const run = callers.mint({ kind: 'armed', id: 'trg-1' })
    expect(run.sid).toBe('trigger-check:t1')
    expect(callers.resolve(run.sid)).toEqual({ kind: 'armed', id: 'trg-1' })
    expect(callers.resolve('a-session-id')).toBeUndefined()
    expect(callers.resolve(undefined)).toBeUndefined()
    run.release()
    expect(callers.resolve(run.sid)).toBeNull()
    expect(callers.size()).toBe(0)
  })

  it('a check\'s run env names only the check\'s own variables', () => {
    expect(checkCallerEnv('trigger-check:x', '/d/agent-gateway.sock')).toEqual({ [CHECK_TOKEN_ENV]: 'trigger-check:x', [CHECK_SOCKET_ENV]: '/d/agent-gateway.sock' })
    expect(Object.keys(checkCallerEnv('trigger-check:x', '/s'))).not.toContain('WALNUT_SESSION_ID')
  })

  it('relays a live run\'s tools.call with its trigger, and drops one the caller wrote', () => {
    const forged = { name: 'host_exec', args: {}, triggerCaller: { kind: 'armed', id: 'someone-else' } }
    expect(checkGatewayCall('tools.call', forged, { kind: 'test', id: 'tt-abcdefgh' })).toEqual({ local: false, args: { name: 'host_exec', args: {}, triggerCaller: { kind: 'test', id: 'tt-abcdefgh' } } })
    expect(checkGatewayCall('tools.call', forged, null)).toEqual({ local: false, args: { name: 'host_exec', args: {} } })
    expect(checkGatewayCall('tools.list', { triggerCaller: 1 }, { kind: 'armed', id: 'x' })).toEqual({ local: false, args: {} })
    expect(checkGatewayCall('tools.call', { name: 'op_card_record', args: {} }, { kind: 'armed', id: 'x' })).toEqual({ local: true })
    expect(withoutTriggerCaller({ a: 1, triggerCaller: 2 })).toEqual({ a: 1 })
  })

  it('takes a test run id only in the server\'s shape', () => {
    expect(testCheckCaller('tt-abcdefgh12')).toEqual({ kind: 'test', id: 'tt-abcdefgh12' })
    expect(testCheckCaller('trg-1')).toBeUndefined()
    expect(testCheckCaller({ kind: 'armed', id: 'x' })).toBeUndefined()
  })
})

describe('the server reads a daemon\'s word only from a daemon that keeps it its own', () => {
  const body = { name: 'host_exec', triggerCaller: { kind: 'armed', id: 'x' }, callerProof: { v: 1, verified: true } }
  it('an older daemon passes on what a caller wrote: both are dropped', () => {
    expect(vouchedGatewayPayload(body, () => false)).toEqual({ name: 'host_exec' })
  })
  it('each is kept only under its own capability', () => {
    expect(vouchedGatewayPayload(body, (c) => c === TRIGGER_CALLER_CAPABILITY)).toEqual({ name: 'host_exec', triggerCaller: body.triggerCaller })
    expect(vouchedGatewayPayload(body, (c) => c === CALLER_PROOF_CAPABILITY)).toEqual({ name: 'host_exec', callerProof: body.callerProof })
    expect(vouchedGatewayPayload('x', () => true)).toBeUndefined()
  })
})

describe('the gateway CLI in a check', () => {
  const trusted: WalnutSocketInfo = { isSocket: true, uid: 501, mode: 0o600 }
  const probe = () => trusted
  it('sends with the run\'s token to the run\'s socket', () => {
    expect(resolveWalnutCliEndpoint({ WALNUT_CHECK_TOKEN: 'trigger-check:t', WALNUT_CHECK_SOCKET: '/d/s.sock' }, probe, 501))
      .toEqual({ ok: true, socketPath: '/d/s.sock', sid: 'trigger-check:t', external: true })
  })
  it('a session\'s own id and socket always win', () => {
    expect(resolveWalnutCliEndpoint({ WALNUT_SESSION_ID: 's1', WALNUT_AGENT_SOCKET: '/a.sock', WALNUT_CHECK_TOKEN: 'trigger-check:t', WALNUT_CHECK_SOCKET: '/d/s.sock' }, probe, 501))
      .toEqual({ ok: true, socketPath: '/a.sock', sid: 's1', external: false })
  })
  it('outside a check and a session: external, as before', () => {
    const r = resolveWalnutCliEndpoint({ WALNUT_AGENT_SOCKET: '/a.sock' }, probe, 501)
    expect(r).toEqual({ ok: true, socketPath: '/a.sock', sid: 'external', external: true })
  })
})

describe('the installed CLI in a check', () => {
  it('names exactly the task-only host ops', () => {
    for (const p of ['/hosts/:host/exec', '/hosts/:host/exec/:job_id', '/hosts/:host/exec/:job_id/stop', '/hosts/:host/mcp', '/hosts/:host/mcp/:server/call',
      '/hosts/:host/mcp-calls/:call_id', '/hosts/:host/http', '/hosts/:host/daemon-update', '/host-exec/grants/:grant_id/exec', '/host-copy', '/host-copy/:copy_id']) {
      expect(isTaskHostOpPath(p), p).toBe(true)
    }
    for (const p of ['/hosts/load', '/hosts/:host', '/hosts/:host/profile', '/host-exec/grants', '/routines/trigger', undefined]) expect(isTaskHostOpPath(p), String(p)).toBe(false)
  })

  it('hands the call to the check\'s daemon only in a check, with no session, while its socket is there', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-'))
    const sock = path.join(dir, 's.sock')
    expect(await callThroughCheckDaemon('host_exec_list', {}, {})).toBeNull()
    expect(await callThroughCheckDaemon('host_exec_list', {}, { WALNUT_CHECK_TOKEN: 'trigger-check:t', WALNUT_CHECK_SOCKET: sock })).toBeNull()
    const server = net.createServer(() => {}).listen(sock)
    await new Promise<void>((r) => server.once('listening', () => r()))
    try {
      expect(await callThroughCheckDaemon('host_exec_list', {}, { WALNUT_SESSION_ID: 's1', WALNUT_CHECK_TOKEN: 'trigger-check:t', WALNUT_CHECK_SOCKET: sock })).toBeNull()
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the server\'s holds expire', () => {
  it('a held trigger and a test run', () => {
    const t0 = 1_000_000
    expect(holdRelayTrigger({ kind: 'armed', id: 'trg-1' }, 'devbox', t0)).toMatch(/^[0-9a-f]{48}$/)
    expect(holdRelayTrigger({ kind: 'armed', id: 'bad id!' }, 'devbox', t0)).toBeUndefined()
    expect(holdRelayTrigger({ kind: 'test', id: 'not-a-test' }, 'devbox', t0)).toBeUndefined()
    expect(holdRelayTrigger({ kind: 'armed', id: 'trg-1' }, '', t0)).toBeUndefined()
    expect(noteTestRun('', 'devbox', 30, t0)).toBeUndefined()
    expect(noteTestRun('task-1', 'devbox', 30, t0)).toMatch(/^tt-[0-9a-f]{24}$/)
  })

  it('only a trigger saved before checkActsFor (no field at all) falls back to its owner or target', () => {
    const executor = { type: 'session', config: { target: 'task-target' } }
    expect(legacyCheckActsFor({ ownerTaskId: 'task-owner', executor })).toBe('task-owner')
    expect(legacyCheckActsFor({ executor })).toBe('task-target')
    // The server decided "no task" (''), or a task: never the owner or target a caller wrote.
    expect(legacyCheckActsFor({ checkActsFor: '', ownerTaskId: 'task-owner', executor })).toBeUndefined()
    expect(legacyCheckActsFor({ checkActsFor: 'task-mine', ownerTaskId: 'task-owner', executor })).toBeUndefined()
    expect(legacyCheckActsFor({})).toBeUndefined()
  })
})
