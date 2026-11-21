/**
 * Where the real front (src/replica/front.ts) serves the host call entry: on its own unix socket
 * in the daemon dir (0600 in a 0700 dir), opened once the `host_call_entry` experiment is on and
 * told to the daemon in the report (status().callSocket); never on the public listener the host's
 * tunnel reaches, where the path is a plain 404 that is never forwarded to the leader.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'

vi.mock('../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/config-manager.js')>()),
  getConfig: async () => ({ experimental: { host_call_entry: true } }),
}))

import { startReplicaFront, type ReplicaFront } from '../../src/replica/front.js'
import { createLinkEvents } from '../../src/core/link/link.js'
import type { FollowerLink } from '../../src/core/link/follower-link.js'
import type { FollowerView } from '../../src/host-server/daemon-link.js'
import type { DeviceCopy } from '../../src/host-server/device-copy.js'
import { HOST_CALL_ANSWER_HEADER, HOST_CALL_PATH } from '../../src/providers/host-call-client-core.js'
import { hostCallSocketPath } from '../../src/providers/host-call-token-core.js'
import { HOST_CALL_CAPABILITY } from '../../src/replica/host-call-entry.js'

const TOKEN = 'a'.repeat(64)
const LINE = { v: 1, op: 'tools.call', sid: 'sid-1', args: { name: 'task_get', args: {}, callId: 'oc-abcdefgh21' } }
let scratch = ''
let front: ReplicaFront
let frontStopped = false
let pub: http.Server
let pubPort = 0
const streamsOpened: string[] = []
const gatewayLines: Array<Record<string, unknown>> = []

function fakeLink(): FollowerLink {
  const events = createLinkEvents()
  const view = {
    walnutId: 'w-acme', home: '/acme', epoch: 1, holder: 'primary', backup: false,
    primaryConnected: true, primaryHeardAgoMs: 0, takeoverMs: 30_000, quietMs: 30_000, drainablePending: 0,
    bridge: { connected: false, companion: null }, settings: {},
  } as unknown as FollowerView
  return {
    peer: { host: 'marina', walnutId: 'w-acme' },
    state: () => 'up',
    heard: () => 0,
    request: async (cmd: string, params: Record<string, unknown>) => {
      if (cmd === 'follower.gateway') { gatewayLines.push(params.request as Record<string, unknown>); return { ok: true, response: { ok: true, result: { via: 'entry' } } } }
      return { ok: false, error: 'not in this test' }
    },
    on: (event, cb) => events.on(event, cb),
    openStream: (to: string) => { streamsOpened.push(to); return Promise.reject(new Error('no leader stream in this test')) },
    start: () => {},
    stop: () => {},
    view: () => ({ view, at: Date.now() }),
    linkState: () => 'following',
    lastError: () => null,
    report: () => {},
    capabilities: () => ['replica-ops-v1', HOST_CALL_CAPABILITY],
  } as unknown as FollowerLink
}

function post(opts: { port?: number; socketPath?: string; headers?: Record<string, string> }): Promise<{ status: number; entry: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      ...(opts.socketPath ? { socketPath: opts.socketPath } : { host: '127.0.0.1', port: opts.port }),
      path: HOST_CALL_PATH, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) },
    }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, entry: res.headers[HOST_CALL_ANSWER_HEADER] as string | undefined, body: b }))
    })
    r.on('error', reject)
    r.end(JSON.stringify(LINE))
  })
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hcf-'))
  front = startReplicaFront({
    env: { publicPort: 0, daemonDir: scratch, leaderHome: '/acme', walnutId: 'w-acme', followerToken: 'tok-acme', label: 'marina' },
    devices: { hash: () => '' } as unknown as DeviceCopy,
    acceptFromLeader: (stream) => { stream.destroy() },
    link: fakeLink(),
    localCalls: true,
  })
  pub = http.createServer((req, res) => front.middleware(req, res, () => { res.writeHead(200); res.end('replica app') }))
  await new Promise<void>((resolve) => pub.listen(0, '127.0.0.1', () => resolve()))
  pubPort = (pub.address() as net.AddressInfo).port
})

afterAll(async () => {
  if (!frontStopped) await front?.stop()
  await new Promise((r) => pub.close(r))
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the front serves the host call entry on its own socket only', () => {
  it('opens a 0600 socket in a 0700 dir of the daemon dir, says it in its report, and takes calls there', async () => {
    const want = hostCallSocketPath(path, crypto, scratch, 'w-acme')
    for (let i = 0; i < 100 && front.status().callSocket !== want; i++) await new Promise((r) => setTimeout(r, 50))
    expect(front.status().callSocket).toBe(want)
    expect(fs.lstatSync(want).isSocket()).toBe(true)
    expect(fs.statSync(want).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(want)).mode & 0o777).toBe(0o700)
    const r = await post({ socketPath: want })
    expect(r).toMatchObject({ status: 200, entry: '1' })
    expect(JSON.parse(r.body)).toEqual({ ok: true, result: { via: 'entry' } })
    expect(gatewayLines).toEqual([LINE])
    // A forwarded request is refused there too, before the daemon hears of it.
    expect(await post({ socketPath: want, headers: { 'x-forwarded-for': '203.0.113.9' } })).toMatchObject({ status: 403, entry: '1' })
    expect(gatewayLines).toHaveLength(1)
  })

  it('the public listener (the one the tunnel reaches) answers 404 for the entry path, not the entry, and never forwards it', async () => {
    const r = await post({ port: pubPort })
    expect(r.status).toBe(404)
    expect(r.entry).toBeUndefined()
    expect(gatewayLines).toHaveLength(1)
    expect(streamsOpened).toEqual([])
  })

  it('stop closes the socket and removes it', async () => {
    const want = hostCallSocketPath(path, crypto, scratch, 'w-acme')
    frontStopped = true
    await front.stop()
    expect(fs.existsSync(want)).toBe(false)
  })
})
