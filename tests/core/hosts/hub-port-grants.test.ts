/**
 * Hub port grants a plugin makes (src/core/hosts/hub-port-grants.ts, `walnut.hosts.allowHubPort`
 * in src/core/plugins/plugin-hosts.ts): only a port the running plugin's manifest declares, never
 * Walnut's own ports, never this machine; a granted host's stream is taken through the same door
 * `net.hub_ports` uses (core/hosts/hub-ports.ts), a revoked or stopped plugin's is refused, a
 * removed plugin's grants are dropped, the grants survive a restart, and `hub[]` says who allowed
 * each port. Streams arrive through a real link-stream endpoint; the service is a loopback server
 * this test owns.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { validatePlugin } from '../../../packages/plugin-cli/src/manifest.js'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-hub-grants'))
const config = vi.hoisted(() => ({ value: { hosts: { 'home-pc': { hostname: 'home-pc.walnut-net.invalid' }, lab: { hostname: 'lab.example.test' } } } as Record<string, unknown> }))
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: vi.fn(async () => config.value) }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { acceptHubStream, hubPortStatus, resetHubPortsForTest, type HubDoorDeps } from '../../../src/core/hosts/hub-ports.js'
import {
  declareHubPorts, dropHubGrantsNotDeclared, hubPortGrantRules, listHubPortGrants, resetHubPortGrantsForTest, setHubPortGrantsFileForTest,
} from '../../../src/core/hosts/hub-port-grants.js'
import { parseManifestHubPorts } from '../../../src/core/hosts/hub-port-manifest.js'
import { allowPluginHubPort, getPluginHost, revokePluginHubPort } from '../../../src/core/plugins/plugin-hosts.js'
import { createStreamEndpoint } from '../../../src/lib/link-stream.js'

const servers: net.Server[] = []
const grantsFile = () => path.join(WALNUT_HOME, 'local', 'hub-port-grants.json')
const noWalnutPorts = async () => [] as number[]

beforeEach(() => {
  fs.rmSync(path.join(WALNUT_HOME, 'local'), { recursive: true, force: true })
  setHubPortGrantsFileForTest(null)
  resetHubPortGrantsForTest()
  config.value = { hosts: { 'home-pc': { hostname: 'home-pc.walnut-net.invalid' }, lab: { hostname: 'lab.example.test' } } }
})
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  resetHubPortsForTest()
  resetHubPortGrantsForTest()
})

async function service(): Promise<number> {
  const s = net.createServer({ allowHalfOpen: true }, (c) => { c.on('error', () => {}); c.pipe(c) })
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return (s.address() as net.AddressInfo).port
}

/** The primary's door with config.yaml listing nothing: only the plugins' grants in force let a stream in. */
function door(over: Partial<HubDoorDeps> = {}): HubDoorDeps {
  return {
    config: async () => ({ hosts: config.value.hosts }),
    takes: () => true,
    connect: (port, host) => net.connect({ port, host, allowHalfOpen: true }),
    log: () => {},
    now: () => Date.now(),
    walnutPorts: async () => [],
    pluginRules: hubPortGrantRules,
    ...over,
  }
}

/** Open one hub stream of `host` to `port`; resolves the server's answer to the daemon. */
async function open(host: string, port: number, d: HubDoorDeps): Promise<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = []
  const ep = createStreamEndpoint({ send: (f) => { frames.push(f) }, accept: (info) => (info.from === 'hub' ? acceptHubStream(host, info, d) : null) })
  const sid = `r${Math.random().toString(36).slice(2)}`
  ep.handle({ ev: 'stream-open', sid, from: 'hub', port })
  for (let i = 0; i < 300; i++) {
    const f = frames.find((x) => x.sid === sid && (x.cmd === 'stream.accept' || x.cmd === 'stream.close'))
    if (f) { ep.handle({ ev: 'stream-close', sid }); return f }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('no answer')
}

describe('manifest hubPorts', () => {
  it('keeps a port with why; drops a bad port, a missing why, a duplicate, and past eight', () => {
    expect(parseManifestHubPorts(undefined)).toEqual({ dropped: [] })
    expect(parseManifestHubPorts({ port: 1 }).dropped).toHaveLength(1)
    const r = parseManifestHubPorts([
      { port: 18403, why: '  Model requests\nfrom your other machines ' },
      { port: 0, why: 'x' }, { port: 18404 }, { port: 18403, why: 'again' }, { port: 70000, why: 'x' }, 'junk',
    ])
    expect(r.hubPorts).toEqual([{ port: 18403, why: 'Model requests from your other machines' }])
    expect(r.dropped).toHaveLength(5)
    const many = parseManifestHubPorts(Array.from({ length: 10 }, (_, i) => ({ port: 20000 + i, why: 'w' })))
    expect(many.hubPorts).toHaveLength(8)
    expect(many.dropped).toEqual([expect.stringMatching(/at most 8/), expect.stringMatching(/at most 8/)])
  })

  it('walnut-plugin validate reports exactly what the host drops', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ports-validate-'))
    try {
      const hubPorts = [{ port: 18403, why: 'spokes reach the hub' }, { port: 0, why: 'x' }, { port: 18404 }]
      fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify({ id: 'acme-relay', name: 'Acme Relay', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs', hubPorts }))
      const r = await validatePlugin(base)
      expect(r.errors).toEqual(parseManifestHubPorts(hubPorts).dropped.map((d) => `manifest.${d}`))
      expect(r.errors).toHaveLength(2)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('walnut.hosts.allowHubPort', () => {
  it('refuses a port the running plugin did not declare, Walnut\'s own port, this machine and an unknown host; stores nothing', async () => {
    // Not running at all: nothing is declared.
    await expect(allowPluginHubPort('relay', 'home-pc', 18403, noWalnutPorts)).rejects.toMatchObject({ code: 'undeclared_port' })
    const release = declareHubPorts('relay', [{ port: 18403, why: 'model proxy' }, { port: 3456, why: 'pretends to be its own' }])
    await expect(allowPluginHubPort('relay', 'home-pc', 18404, noWalnutPorts)).rejects.toMatchObject({ code: 'undeclared_port' })
    // Another plugin's declaration is not this one's.
    await expect(allowPluginHubPort('other', 'home-pc', 18403, noWalnutPorts)).rejects.toMatchObject({ code: 'undeclared_port' })
    // Declared, but Walnut's own server port on this machine: never.
    await expect(allowPluginHubPort('relay', 'home-pc', 3456, async () => [3456, 7890])).rejects.toMatchObject({ code: 'walnut_port' })
    await expect(allowPluginHubPort('relay', '__local__', 18403, noWalnutPorts)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(allowPluginHubPort('relay', 'stranger', 18403, noWalnutPorts)).rejects.toMatchObject({ code: 'unknown_host' })
    await expect(allowPluginHubPort('relay', 'home-pc', 1.5, noWalnutPorts)).rejects.toMatchObject({ code: 'bad_request' })
    expect(await listHubPortGrants()).toEqual([])
    expect(fs.existsSync(grantsFile())).toBe(false)
    release()
  })

  it('a granted host\'s stream is taken, another host\'s is not, and after a revoke it is refused', async () => {
    const svc = await service()
    const release = declareHubPorts('relay', [{ port: svc, why: 'model proxy' }])
    const d = door()
    expect((await open('home-pc', svc, d)).cmd).toBe('stream.close')
    expect(await allowPluginHubPort('relay', 'home-pc', svc, noWalnutPorts)).toEqual({ added: true })
    expect(await allowPluginHubPort('relay', 'home-pc', svc, noWalnutPorts)).toEqual({ added: false })
    expect((await open('home-pc', svc, d)).cmd).toBe('stream.accept')
    const other = await open('lab', svc, d)
    expect(other).toMatchObject({ cmd: 'stream.close', error: `port ${svc} on this Walnut is not open to lab (net.hub_ports, or a plugin grant)` })
    expect(await revokePluginHubPort('relay', 'home-pc', svc)).toEqual({ removed: true })
    expect(await revokePluginHubPort('relay', 'home-pc', svc)).toEqual({ removed: false })
    expect((await open('home-pc', svc, d)).cmd).toBe('stream.close')
    release()
  })

  it('every refusal of net.hub_ports still holds for a granted port: Walnut\'s own ports, and 127.0.0.1 only', async () => {
    const svc = await service()
    const release = declareHubPorts('relay', [{ port: svc, why: 'model proxy' }])
    await allowPluginHubPort('relay', 'home-pc', svc, noWalnutPorts)
    // The port became Walnut's own after the grant (its server moved there): refused at the door too.
    const own = await open('home-pc', svc, door({ walnutPorts: async () => [svc] }))
    expect(own).toMatchObject({ cmd: 'stream.close', error: expect.stringMatching(/Walnut's own/) })
    const frames: Array<Record<string, unknown>> = []
    const ep = createStreamEndpoint({ send: (f) => { frames.push(f) }, accept: (info) => acceptHubStream('home-pc', info, door()) })
    ep.handle({ ev: 'stream-open', sid: 'rx', from: 'hub', port: svc, host: '10.0.0.9' })
    for (let i = 0; i < 100 && !frames.length; i++) await new Promise((r) => setTimeout(r, 10))
    expect(frames[0]).toMatchObject({ cmd: 'stream.close', error: expect.stringMatching(/only this Walnut's own 127\.0\.0\.1/) })
    release()
  })

  it('a grant is in force only while its plugin runs and declares the port; it is kept across a stop and a restart', async () => {
    const svc = await service()
    const release = declareHubPorts('relay', [{ port: svc, why: 'model proxy' }])
    await allowPluginHubPort('relay', 'home-pc', svc, noWalnutPorts)
    release() // the plugin stopped (switched off, reloading, removed)
    expect((await open('home-pc', svc, door())).cmd).toBe('stream.close')
    // Stored still, so a plugin switched back on has it again.
    expect(JSON.parse(fs.readFileSync(grantsFile(), 'utf8')).grants).toEqual([expect.objectContaining({ pluginId: 'relay', host: 'home-pc', port: svc })])
    // A restart reads the file again.
    resetHubPortGrantsForTest()
    const again = declareHubPorts('relay', [{ port: svc, why: 'model proxy' }])
    expect((await open('home-pc', svc, door())).cmd).toBe('stream.accept')
    again()
    // A new version that no longer declares the port: not in force either.
    const v2 = declareHubPorts('relay', [{ port: svc + 1, why: 'moved' }])
    expect((await open('home-pc', svc, door())).cmd).toBe('stream.close')
    v2()
    // A reload's newer declaration survives the older generation's late release.
    const g1 = declareHubPorts('relay', [{ port: svc, why: 'model proxy' }])
    const g2 = declareHubPorts('relay', [{ port: svc, why: 'model proxy' }])
    g1()
    expect((await open('home-pc', svc, door())).cmd).toBe('stream.accept')
    g2()
  })

  it('a removed plugin\'s grants are dropped; one switched off keeps them; a port its manifest dropped goes', async () => {
    const release = declareHubPorts('relay', [{ port: 18403, why: 'a' }, { port: 18404, why: 'b' }])
    const other = declareHubPorts('keeper', [{ port: 18500, why: 'c' }])
    await allowPluginHubPort('relay', 'home-pc', 18403, noWalnutPorts)
    await allowPluginHubPort('relay', 'lab', 18404, noWalnutPorts)
    await allowPluginHubPort('keeper', 'home-pc', 18500, noWalnutPorts)
    release(); other()
    // `keeper` is installed (switched off: discovered, its manifest declares 18500); relay's manifest now declares only 18403.
    expect(await dropHubGrantsNotDeclared(new Map([['relay', new Set([18403])], ['keeper', new Set([18500])]]))).toBe(1)
    expect((await listHubPortGrants()).map((g) => `${g.pluginId}:${g.host}:${g.port}`).sort()).toEqual(['keeper:home-pc:18500', 'relay:home-pc:18403'])
    // relay is removed: none of its grants is left, on disk too.
    expect(await dropHubGrantsNotDeclared(new Map([['keeper', new Set([18500])]]))).toBe(1)
    resetHubPortGrantsForTest()
    expect((await listHubPortGrants()).map((g) => g.pluginId)).toEqual(['keeper'])
  })

  it('an unreadable grants file lets nothing in', async () => {
    fs.mkdirSync(path.dirname(grantsFile()), { recursive: true })
    fs.writeFileSync(grantsFile(), '{ not json')
    const svc = await service()
    const release = declareHubPorts('relay', [{ port: svc, why: 'model proxy' }])
    expect(await hubPortGrantRules()).toEqual([])
    expect((await open('home-pc', svc, door())).cmd).toBe('stream.close')
    release()
  })
})

describe('hub[] says who allowed each port', () => {
  it('a plugin grant, config.yaml, or both; a host with neither has no hub', async () => {
    config.value = { ...config.value, net: { hub_ports: [{ port: 18403, hosts: ['lab'] }] } }
    const release = declareHubPorts('relay', [{ port: 18403, why: 'model proxy' }])
    await allowPluginHubPort('relay', 'home-pc', 18403, noWalnutPorts)
    await allowPluginHubPort('relay', 'lab', 18403, noWalnutPorts)
    expect(await hubPortStatus('home-pc', { link: null })).toEqual([expect.objectContaining({ port: 18403, allowedBy: [{ kind: 'plugin', pluginId: 'relay' }] })])
    expect((await hubPortStatus('lab', { link: null }))[0].allowedBy).toEqual([{ kind: 'config' }, { kind: 'plugin', pluginId: 'relay' }])
    expect((await getPluginHost('home-pc'))?.hub?.[0]).toMatchObject({ port: 18403, allowedBy: [{ kind: 'plugin', pluginId: 'relay' }] })
    release()
    // Stopped: the plugin's allowance is not shown, config.yaml's still is.
    expect((await getPluginHost('home-pc'))?.hub).toBeUndefined()
    expect((await hubPortStatus('lab', { link: null }))[0].allowedBy).toEqual([{ kind: 'config' }])
  })
})
