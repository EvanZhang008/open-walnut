/**
 * Hosts found in ~/.ssh/config, on a real server (src/core/hosts/found-hosts.ts,
 * found-hosts-store.ts): at start the server decides the found hosts an older Walnut
 * left (one that ever connected stays a normal host, one nobody used waits for the
 * question), a host that waits reads as off everywhere (config, the status list, the
 * connect button), the person's answer is written with the switch it implies, and an
 * editor from before the field cannot undo it.
 *
 * The server runs behind isolateFromRealSsh: its HOME is a throwaway home whose
 * ~/.ssh/config this test writes, and the first ssh on PATH is a stand-in that records
 * its arguments and refuses, so the test can read whom the server tried to reach.
 * The older Walnut's rows are written to config.yaml the way its Remote Hosts save did.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import type net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../helpers/isolate-ssh.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { updateConfig } from '../../src/core/config-manager.js'

let server: HttpServer
let port: number
let isolation: SshIsolation

async function api(pathname: string, init?: RequestInit) {
  return fetch(`http://localhost:${port}${pathname}`, init)
}
const post = (pathname: string, body?: unknown) => api(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
async function stored(): Promise<Record<string, any>> {
  return yaml.load(await fs.readFile(CONFIG_FILE, 'utf8')) as Record<string, any>
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.join(WALNUT_HOME, 'hosts'), { recursive: true })
  // What an older Walnut wrote: found hosts merged on, no answer on them.
  await updateConfig({
    hosts: {
      devbox: { label: 'Dev box', hostname: 'devbox.invalid', enabled: true, discovered: false },
      'lab-mac': { hostname: 'lab-mac.invalid', enabled: true, discovered: true },
      'used-box': { hostname: 'used-box.invalid', enabled: true, discovered: true },
      'off-box': { hostname: 'off-box.invalid', enabled: false, discovered: true },
    },
  } as never)
  // used-box's daemon answered once (a probed profile): someone uses it.
  await fs.writeFile(path.join(WALNUT_HOME, 'hosts', 'used-box.json'), JSON.stringify({
    host: 'used-box', kind: 'dev-box', kindReasons: [], observed: { repoPaths: {}, reaches: {} },
    probed: { os: 'linux' }, updatedAt: '2026-10-01T00:00:00.000Z',
  }))
  // used-mem is only in ~/.ssh/config (an older Walnut merged it in memory) and ever
  // connected; quiet-box is only there and never used; fresh-box shows up later.
  await fs.writeFile(path.join(WALNUT_HOME, 'hosts', 'used-mem.json'), JSON.stringify({
    host: 'used-mem', kind: 'dev-box', kindReasons: [], observed: { repoPaths: {}, reaches: {} },
    probed: { os: 'linux' }, updatedAt: '2026-10-01T00:00:00.000Z',
  }))
  isolation = isolateFromRealSsh(path.join(WALNUT_HOME, 'ssh-isolation'))
  await fs.writeFile(path.join(isolation.home, '.ssh', 'config'), [
    'Host lab-mac', '  HostName lab-mac.invalid',
    'Host used-mem', '  HostName used-mem.invalid',
    'Host quiet-box', '  HostName quiet-box.invalid', '',
  ].join('\n'))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as net.AddressInfo).port
}, 60_000)

afterAll(async () => {
  await stopServer()
  isolation?.restore()
})

const config = async () => ((await (await api('/api/config')).json()) as { config: { hosts: Record<string, any> } }).config

describe('found hosts on a real server', () => {
  it('decides the rows an older Walnut left at start, from what Walnut recorded', async () => {
    const doc = await stored()
    expect(doc.hosts['lab-mac']).toMatchObject({ connect: 'ask', enabled: false, discovered: true })
    // Walnut's own yes (it found the host in use): dialled when used, never warmed at every start.
    expect(doc.hosts['used-box']).toMatchObject({ connect: 'yes', connect_by: 'walnut', enabled: true, discovered: true })
    expect(doc.hosts['off-box']).toMatchObject({ connect: 'not_now', enabled: false })
    expect(doc.hosts.devbox.connect).toBeUndefined()
    // Only in memory before: the used one is written as a yes, the unused one is not written.
    expect(doc.hosts['used-mem']).toMatchObject({ hostname: 'used-mem.invalid', connect: 'yes', enabled: true, discovered: true })
    expect(doc.hosts['quiet-box']).toBeUndefined()
    expect(typeof doc.hosts_found?.asking_since).toBe('string')
  })

  it('a host found now waits for the yes, and nothing tried to reach a waiting host', async () => {
    expect((await config()).hosts['quiet-box']).toMatchObject({ discovered: true, connect: 'ask', enabled: false })
    await fs.appendFile(path.join(isolation.home, '.ssh', 'config'), 'Host fresh-box\n  HostName fresh-box.invalid\n')
    // The scanner keys its cache on the file's mtime: make sure it moved.
    const later = new Date(Date.now() + 5_000)
    await fs.utimes(path.join(isolation.home, '.ssh', 'config'), later, later)
    expect((await config()).hosts['fresh-box']).toMatchObject({ discovered: true, connect: 'ask', enabled: false })
    const reached = isolation.calls().join('\n')
    for (const waiting of ['lab-mac.invalid', 'quiet-box.invalid', 'fresh-box.invalid', 'off-box.invalid']) expect(reached).not.toContain(waiting)
  })

  it('a host waiting for the yes is off in config, absent from the status list, and refused by Connect now', async () => {
    expect((await config()).hosts['lab-mac']).toMatchObject({ enabled: false, connect: 'ask' })
    const status = await (await api('/api/hosts/status')).json() as { hosts: Array<{ host: string; discovered?: boolean }> }
    const keys = status.hosts.map((h) => h.host)
    expect(keys).not.toContain('lab-mac')
    expect(keys).toContain('used-box')
    // Walnut's own yes (used-box was in use) stays a found host, dialled when used, as before.
    expect(status.hosts.find((h) => h.host === 'used-box')?.discovered).toBe(true)
    const refused = await post('/api/hosts/lab-mac/connect')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'host_found' })
  })

  it('the answer route writes the answer with its switch; a hand-added host or a bad answer is refused', async () => {
    expect((await post('/api/hosts/lab-mac/found-answer', { answer: 'maybe' })).status).toBe(400)
    expect((await post('/api/hosts/devbox/found-answer', { answer: 'yes' })).status).toBe(409)
    expect((await post('/api/hosts/nope/found-answer', { answer: 'yes' })).status).toBe(404)

    const notNow = await post('/api/hosts/lab-mac/found-answer', { answer: 'not_now' })
    expect(notNow.status).toBe(200)
    expect((await stored()).hosts['lab-mac']).toMatchObject({ connect: 'not_now', enabled: false })

    const yes = await post('/api/hosts/lab-mac/found-answer', { answer: 'yes' })
    expect(yes.status).toBe(200)
    expect(await yes.json()).toMatchObject({ ok: true, host: 'lab-mac', answer: 'yes' })
    expect((await stored()).hosts['lab-mac']).toMatchObject({ connect: 'yes', enabled: true, discovered: true })
    expect((await stored()).hosts['lab-mac'].connect_by).toBeUndefined()
    const status = await (await api('/api/hosts/status')).json() as { hosts: Array<{ host: string; discovered?: boolean }> }
    expect(status.hosts.map((h) => h.host)).toContain('lab-mac')
    // The person's yes is a configured host: warmed at start and counted like one.
    expect(status.hosts.find((h) => h.host === 'lab-mac')?.discovered).toBeUndefined()
  })

  it('a save from an editor that predates the field keeps every answer', async () => {
    const res = await api('/api/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hosts: {
          devbox: { label: 'Dev box', hostname: 'devbox.invalid', enabled: true, discovered: false },
          'lab-mac': { hostname: 'lab-mac.invalid', enabled: true, discovered: true },
          'used-box': { hostname: 'used-box.invalid', enabled: true, discovered: true },
          // The older editor shows the off row as on after the person flips nothing: still Not now, still off.
          'off-box': { hostname: 'off-box.invalid', enabled: true, discovered: true },
        },
      }),
    })
    expect(res.status).toBe(200)
    const doc = await stored()
    expect(doc.hosts['lab-mac']).toMatchObject({ connect: 'yes', enabled: true })
    // An editor that does not know `connect_by` never turns Walnut's yes into the person's.
    expect(doc.hosts['used-box']).toMatchObject({ connect: 'yes', connect_by: 'walnut', enabled: true })
    expect(doc.hosts['off-box']).toMatchObject({ connect: 'not_now', enabled: false })
  })

  it('a host the person said yes to follows a port changed in ~/.ssh/config, across a Settings save, until they set one here', async () => {
    const sshConfig = path.join(isolation.home, '.ssh', 'config')
    const writeSsh = async (port: number, at: number) => {
      await fs.writeFile(sshConfig, ['Host lab-mac', '  HostName lab-mac.invalid', `  Port ${port}`, 'Host used-mem', '  HostName used-mem.invalid', 'Host quiet-box', '  HostName quiet-box.invalid', ''].join('\n'))
      await fs.utimes(sshConfig, at, at)
    }
    // The yes above was taken with no port: the fixed config now names one.
    await writeSsh(2222, 1_900_000_000)
    expect((await config()).hosts['lab-mac'].port).toBe(2222)
    // An editor from before the record saves the row as it read it: it still follows the file.
    const row = (await config()).hosts['lab-mac']
    const { scanned: _record, ...withoutRecord } = row
    const save = (hosts: Record<string, unknown>) => api('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hosts }) })
    expect((await save({ 'lab-mac': withoutRecord })).status).toBe(200)
    await writeSsh(2300, 1_900_000_100)
    expect((await config()).hosts['lab-mac'].port).toBe(2300)
    // The person sets a port in Settings: that one stays, whatever the file says next.
    const now = (await config()).hosts['lab-mac']
    const { scanned: _r2, ...edited } = now
    expect((await save({ 'lab-mac': { ...edited, port: 2999 } })).status).toBe(200)
    await writeSsh(2400, 1_900_000_200)
    expect((await config()).hosts['lab-mac'].port).toBe(2999)
  })
})
