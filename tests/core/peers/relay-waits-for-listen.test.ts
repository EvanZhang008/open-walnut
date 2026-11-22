/**
 * A relay that reaches this server while it still boots waits for the listen.
 *
 * Incident this pins (2026-11-22, the "gateway relay refused" log spike): at every deploy the
 * new server connected to the local daemon about a second before it listened, the daemon handed
 * over the relays its sessions had sent while the server restarted (host_exec_read waits, mostly),
 * and each one's call to the server's own API met the port hold (port-hold.ts), which cuts every
 * connection: ECONNRESET, read as lost, answered `hub_timeout`. The caller's `walnut` call failed.
 *
 * The router here is a stand-in that makes the same kind of call to this server's own port, so the
 * test runs the real port hold and a real listen: the part that broke.
 */
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const routed = vi.hoisted(() => ({ calls: 0, root: '' }))
vi.mock('../../../src/core/peers/capability-router.js', () => ({
  handleGatewayCapability: async () => {
    routed.calls++
    try {
      const res = await fetch(`${routed.root}/api/v1/ping`)
      return { ok: true, result: (await res.json()) as Record<string, unknown> }
    } catch (err) {
      return { ok: false, error: { code: 'hub_timeout', message: `lost: ${(err as Error).message}` } }
    }
  },
}))

import { answerRelayedCall, RELAY_LISTEN_MARGIN_MS, resetRelayedCallsForTest } from '../../../src/core/peers/gateway-answer.js'
import { endSelfApiStarting, markSelfApiStarting, selfApiStarting, setSelfApiRoot, whenSelfApiListening } from '../../../src/lib/self-api-root.js'
import { holdPort } from '../../../src/web/port-hold.js'

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

const deps = (over: { deadlineMs?: number } = {}) => ({
  hostKey: '__local__', hasCapability: () => true, label: 'test', receivedAt: Date.now(),
  deadlineMs: over.deadlineMs ?? 20_000, send: async () => true,
})
const call = { relayId: 1, capability: 'tools.call', callerSid: 'external', payload: { name: 'host_exec_read', args: {} } }

const servers: http.Server[] = []
afterEach(async () => {
  setSelfApiRoot(null)
  endSelfApiStarting()
  routed.calls = 0
  resetRelayedCallsForTest()
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
})

/** Boot the way server.ts does: hold the port, mark starting, later release, listen, set the root. */
async function boot(port: number) {
  const hold = await holdPort(port, '127.0.0.1')
  markSelfApiStarting()
  routed.root = `http://127.0.0.1:${port}`
  return async () => {
    await hold?.release()
    const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"pong":true}') })
    servers.push(server)
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
    setSelfApiRoot(routed.root)
  }
}

describe('a relay that comes while the server boots', () => {
  it('without the wait, the call to its own port meets the hold and is lost (the bug)', async () => {
    const listen = await boot(await freePort())
    endSelfApiStarting() // as before the fix: nothing marks the boot
    const reply = await answerRelayedCall(call, deps())
    expect(reply.errorCode).toBe('hub_timeout')
    await listen()
  })

  it('waits for the listen, then runs once and answers', async () => {
    const listen = await boot(await freePort())
    const answer = answerRelayedCall(call, deps())
    await new Promise((r) => setTimeout(r, 150))
    expect(routed.calls).toBe(0)
    await listen()
    expect(await answer).toEqual({ relayId: 1, result: { pong: true } })
    expect(routed.calls).toBe(1)
  })

  it('answers "still starting, nothing ran" when the listen does not come within its deadline', async () => {
    await boot(await freePort())
    const reply = await answerRelayedCall(call, deps({ deadlineMs: RELAY_LISTEN_MARGIN_MS + 80 }))
    expect(reply).toMatchObject({ relayId: 1, errorCode: 'hub_unreachable' })
    expect(String(reply.error)).toMatch(/nothing ran/)
    expect(routed.calls).toBe(0)
  })

  it('a server already listening answers at once', async () => {
    const listen = await boot(await freePort())
    await listen()
    expect(selfApiStarting()).toBe(false)
    expect(await answerRelayedCall(call, deps())).toEqual({ relayId: 1, result: { pong: true } })
  })
})

describe('whenSelfApiListening', () => {
  it('is true at once with no boot under way (the CLI, a server that listens)', async () => {
    expect(await whenSelfApiListening(0)).toBe(true)
  })
  it('ends with the listen, with a stop before it, or at its own limit', async () => {
    markSelfApiStarting()
    expect(await whenSelfApiListening(20)).toBe(false)
    const waiting = whenSelfApiListening(5_000)
    setSelfApiRoot('http://127.0.0.1:1')
    expect(await waiting).toBe(true)
    markSelfApiStarting()
    const stopped = whenSelfApiListening(5_000)
    endSelfApiStarting()
    expect(await stopped).toBe(true)
  })
})

describe('ratchet: every way a relay reaches the router waits for the listen first', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '../../../', rel), 'utf8')

  it('the capability router is called only from answerRelayedCall, after the listen wait and before the journal drain', () => {
    const callers = execFileSync('git', ['grep', '-l', 'handleGatewayCapability(', '--', 'src'], { cwd: join(__dirname, '../../../'), encoding: 'utf8' })
      .trim().split('\n').filter((f) => f !== 'src/core/peers/capability-router.ts')
    expect(callers).toEqual(['src/core/peers/gateway-answer.ts'])
    const src = read('src/core/peers/gateway-answer.ts')
    const body = src.slice(src.indexOf('export async function answerRelayedCall'))
    const wait = body.indexOf('whenSelfApiListening(')
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThan(body.indexOf('deps.before()'))
    expect(wait).toBeLessThan(body.indexOf('handleGatewayCapability('))
  })

  it('the server marks its boot right after it holds its port, before the local daemon starts, and ends it on stop', () => {
    const src = read('src/web/server.ts')
    const hold = src.indexOf('serverPortHold = await holdPort(')
    const mark = src.indexOf('markSelfApiStarting()')
    expect(hold).toBeGreaterThan(0)
    expect(mark).toBeGreaterThan(hold)
    expect(mark).toBeLessThan(src.indexOf("bootPolicy('local-daemon')", hold))
    expect(src).toMatch(/void serverPortHold\?\.release\(\)\n\s+serverPortHold = null\n\s+endSelfApiStarting\(\)/)
  })
})
