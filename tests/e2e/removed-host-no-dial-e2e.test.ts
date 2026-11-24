/**
 * A host removed in Settings that ~/.ssh/config also names is never dialled again, on a real server
 * (drill round 4, R4-1; src/core/hosts/link.ts dialRefusal). The Remove writes config.yaml without the
 * row; the next read merges the Host block back as a found host waiting for the yes
 * ({enabled:false, discovered:true, connect:'ask'}). Before the gate, the background callers that ask
 * for a host by name (a session's status question and history read, a host probe, a turn snapshot)
 * found that row in config and dialled it: in the drill, two seconds after the Remove the leader was
 * back on another Walnut's shared daemon. A host turned off is the same: Walnut does not connect to it.
 *
 * The server runs behind isolateFromRealSsh: the first ssh on PATH is a stand-in that records its
 * arguments and refuses, so the test reads whom the server tried to reach. A host kept in Settings is
 * dialled the same way first, to show the stand-in sees a dial.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../helpers/isolate-ssh.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { link } from '../../src/core/hosts/link.js'
import { probeHost } from '../../src/core/sessions/host-lost.js'
import { DaemonFileReader } from '../../src/core/daemon-file-reader.js'

let server: HttpServer
let port: number
let isolation: SshIsolation

const api = (pathname: string, init?: RequestInit) => fetch(`http://localhost:${port}${pathname}`, init)
const hostsNow = async () => ((await (await api('/api/config')).json()) as { config: { hosts: Record<string, any> } }).config.hosts
const reached = (name: string) => isolation.calls().filter((line) => line.includes(name))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await updateConfig({
    hosts: {
      'gone-box': { hostname: 'gone-box.invalid', enabled: true },
      'off-box': { hostname: 'off-box.invalid', enabled: true },
      'kept-box': { hostname: 'kept-box.invalid', enabled: true },
    },
  } as never)
  isolation = isolateFromRealSsh(path.join(WALNUT_HOME, 'ssh-isolation'))
  await fs.writeFile(path.join(isolation.home, '.ssh', 'config'), ['Host gone-box', '  HostName gone-box.invalid', ''].join('\n'))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as net.AddressInfo).port
}, 60_000)

afterAll(async () => {
  await stopServer()
  isolation?.restore()
})

describe('a host that left Settings is not dialled again', () => {
  it('the stand-in ssh sees a dial of a host still in Settings', async () => {
    await link('kept-box').catch(() => { /* the stand-in refuses */ })
    expect(reached('kept-box').length).toBeGreaterThan(0)
  })

  it('after Remove (the host is in ~/.ssh/config) and Turn off, no background caller dials either host', async () => {
    const before = await hostsNow()
    // The page's write: the whole hosts map, without gone-box and with off-box turned off.
    const { 'gone-box': _gone, ...rest } = before
    const res = await api('/api/config', {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` },
      body: JSON.stringify({ hosts: { ...rest, 'off-box': { ...rest['off-box'], enabled: false } } }),
    })
    expect(res.status).toBe(200)
    const after = await hostsNow()
    // The R4-1 shape: the Remove comes back as a found host waiting for the yes.
    expect(after['gone-box']).toMatchObject({ discovered: true, connect: 'ask', enabled: false })
    expect(after['off-box']).toMatchObject({ enabled: false })

    for (const host of ['gone-box', 'off-box']) {
      // The link (every background caller: status questions, pushes on a fresh link, replica rounds).
      await expect(link(host)).rejects.toMatchObject({ name: 'UnknownHostError' })
      // A host probe (session stop, move, start elsewhere): unreachable, said at once.
      const probe = await probeHost(host, 3_000)
      expect(probe.reachable).toBe(false)
      // A session's history read: whatever it answers, it reaches nothing (the check below).
      await new DaemonFileReader(host).readFile('/tmp/never.jsonl').catch(() => null)
    }
    // Give a dial that something started a moment to reach ssh.
    await new Promise((r) => setTimeout(r, 500))
    expect(reached('gone-box')).toEqual([])
    expect(reached('off-box')).toEqual([])
  })
})
