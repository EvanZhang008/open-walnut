/**
 * A machine found in ~/.ssh/config that has joined the host network is listed once, as the
 * joined machine. 2026-11-03: Remote Hosts showed `studio-mac 10.20.30.40 · Not connected` (from
 * ~/.ssh/config) above the joined Studio-MacBook, Connected: the same Mac twice, and the
 * user read it as a join that did not work.
 *
 * Only the list leaves it out: the config keeps the row (its sessions, server and settings),
 * and a save from the editor writes it back as it was.
 *
 * Real: config.yaml in a temp Walnut home, getConfig, the GET /api/hosts/net route on a real
 * HTTP server. The data is the shape the Mac had that day (documentation addresses here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import express from 'express'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-joined-twins'))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { getConfig, _configRepairIdleForTest, _resetWriteLockForTest } from '../../../src/core/config-manager.js'
import { joinedTwins } from '../../../src/core/hosts/joined-twins.js'
import { hostsNetRouter } from '../../../src/web/routes/hosts-net.js'
import { noteWhere, whereOf } from '../../../src/core/net/net-where.js'
import { computeLaunchOptions } from '../../../src/core/sessions/mobile-launch.js'
import { recordDirectory } from '../../../src/core/frequent-dirs.js'

const MAC = 'a'.repeat(64)
const PC = 'b'.repeat(64)
const hosts = () => ({
  'studio-mac': { hostname: '10.20.30.40', user: 'sam', discovered: true, enabled: true, shell_setup: 'source ~/.profile' },
  'Studio-MacBook': { hostname: 'Studio-MacBook.walnut-net.invalid', label: 'Studio-MacBook', transport: 'net', endpoint: MAC, enabled: true },
  'home-pc': { hostname: 'home-pc.walnut-net.invalid', label: 'home-pc', transport: 'net', endpoint: PC, enabled: true },
  devbox: { hostname: 'dev.example.com', user: 'me', enabled: true },
})
// `addrs`: every address the Mac reached or kept for the machine; `self`: what the machine
// itself reported last time.
const net = () => ({
  enabled: true,
  where: {
    [MAC]: { addrs: ['10.20.30.40:62955', '192.168.1.10:5000', '203.0.113.69:62955'], self: ['[2001:db8::c54]:64142', '10.20.30.40:62955', '203.0.113.69:62955'] },
    [PC]: { addrs: ['203.0.113.69:59344', '172.18.0.9:53482'], self: ['203.0.113.69:59344', '172.18.0.9:53482'] },
  },
})

describe('joinedTwins', () => {
  it('a found row at a private address the joined machine reported is that machine', () => {
    expect(joinedTwins(hosts(), net())).toEqual([{ alias: 'studio-mac', joined: 'Studio-MacBook' }])
  })

  it('an address only kept from an earlier network, a public IPv4, loopback or link-local names no machine', () => {
    // 192.168.1.10: where the Mac once reached it (a cafe), not one of its own addresses now.
    const h = {
      ...hosts(), nas: { hostname: '192.168.1.10', discovered: true }, router: { hostname: '203.0.113.69', discovered: true },
      vm: { hostname: '127.0.0.1', discovered: true }, ll: { hostname: 'fe80::1', discovered: true },
    }
    const w = net()
    w.where[MAC].self.push('127.0.0.1:2222', '[fe80::1]:22')
    expect(joinedTwins(h, w).map((t) => t.alias)).toEqual(['studio-mac'])
  })

  it('an address or a name two joined machines have names neither', () => {
    const w = net()
    w.where[PC].self.push('10.20.30.40:1')
    expect(joinedTwins(hosts(), w)).toEqual([])
    const h = { ...hosts(), box: { hostname: 'box.local', discovered: true }, 'box-a': { hostname: 'x.walnut-net.invalid', label: 'box', transport: 'net', endpoint: 'c'.repeat(64) }, 'box-b': { hostname: 'y.walnut-net.invalid', label: 'box', transport: 'net', endpoint: 'd'.repeat(64) } }
    expect(joinedTwins(h, net()).map((t) => t.alias)).toEqual(['studio-mac'])
  })

  it("an IPv6 address and the machine's own name, bare or on the local network, match too", () => {
    const h = {
      ...hosts(), v6: { hostname: '2001:DB8::C54', discovered: true }, mdns: { hostname: 'Studio-MacBook.local', discovered: true },
      bare: { hostname: 'studio-macbook', discovered: true }, lan: { hostname: 'Studio-MacBook.home.arpa', discovered: true },
    }
    expect(joinedTwins(h, net()).map((t) => t.alias).sort()).toEqual(['bare', 'lan', 'mdns', 'studio-mac', 'v6'])
  })

  it('a name under a domain is another machine, whatever its first label (a hidden host would be gone from every picker)', () => {
    const h = { ...hosts(), work: { hostname: 'studio-macbook.corp.example.com', discovered: true }, ts: { hostname: 'studio-macbook.example.net', discovered: true } }
    expect(joinedTwins(h, net()).map((t) => t.alias)).toEqual(['studio-mac'])
  })

  it('a joined row that cannot be used hides nothing: disabled, or the host network turned off', () => {
    const h = hosts()
    expect(joinedTwins({ ...h, 'Studio-MacBook': { ...h['Studio-MacBook'], enabled: false } }, net())).toEqual([])
    expect(joinedTwins(h, { ...net(), enabled: false })).toEqual([])
    const { enabled: _on, ...never } = net()
    expect(joinedTwins(h, never)).toEqual([])
  })

  it('leaves a row the user added, and everything when no machine joined or none reported its addresses', () => {
    const h = hosts()
    expect(joinedTwins({ ...h, 'studio-mac': { ...h['studio-mac'], discovered: false } }, net())).toEqual([])
    expect(joinedTwins({ 'studio-mac': h['studio-mac'], devbox: h.devbox }, net())).toEqual([])
    expect(joinedTwins(h, undefined)).toEqual([])
    // An older Walnut kept only `addrs`: no `self`, no match by address.
    expect(joinedTwins(h, { where: { [MAC]: { addrs: ['10.20.30.40:62955'] } } })).toEqual([])
  })
})

describe('GET /api/hosts/net and the config', () => {
  let server: import('node:http').Server | null = null
  beforeEach(async () => {
    _resetWriteLockForTest()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, hosts: hosts(), net: net() }))
  })
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = null
    await _configRepairIdleForTest()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  })

  it("a machine's own addresses are replaced at each sighting, while the Mac's address book keeps the old ones", async () => {
    await noteWhere(MAC, { addrs: ['192.168.50.4:62955'], self: ['192.168.50.4:62955'] })
    const w = whereOf((await getConfig()).net)[MAC]
    expect(w.self).toEqual(['192.168.50.4:62955'])
    expect(w.addrs).toEqual(expect.arrayContaining(['192.168.50.4:62955', '10.20.30.40:62955']))
    // It left the home network: the found row at its old address is a machine of its own again.
    expect(joinedTwins((await getConfig()).hosts as Parameters<typeof joinedTwins>[0], (await getConfig()).net)).toEqual([])
    // A sighting that does not say (the Mac's own dial) keeps the last report.
    await noteWhere(MAC, { addrs: ['192.168.50.4:1'] })
    expect(whereOf((await getConfig()).net)[MAC].self).toEqual(['192.168.50.4:62955'])
  })

  it('the launchers list the machine once: the phone and the transfer list', async () => {
    const aliases = (await computeLaunchOptions()).hosts.map((h) => h.alias)
    expect(aliases).toContain('Studio-MacBook')
    expect(aliases).not.toContain('studio-mac')
    expect(aliases).toContain('devbox')
  })

  it('a folder used on the found row before the join is offered on the joined machine, once', async () => {
    await recordDirectory('/Users/sam/code/app', 'studio-mac')
    await recordDirectory('/Users/sam/code/app', 'Studio-MacBook')
    await recordDirectory('/Users/sam/notes', 'studio-mac')
    const dirs = (await computeLaunchOptions()).dirs.map((d) => `${d.host}:${d.cwd}`).sort()
    expect(dirs).toEqual(['Studio-MacBook:/Users/sam/code/app', 'Studio-MacBook:/Users/sam/notes'])
  })

  it('names the found row as the joined machine, and the config keeps it with its settings', async () => {
    const app = express()
    app.use('/api/hosts/net', hostsNetRouter)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((r) => server!.on('listening', () => r()))
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/hosts/net`)
    expect(res.status).toBe(200)
    expect((await res.json()).twins).toEqual({ 'studio-mac': 'Studio-MacBook' })
    // Sessions, a server and the editor's save all read the row from the config: it stays.
    expect((await getConfig()).hosts?.['studio-mac']).toMatchObject({ hostname: '10.20.30.40', shell_setup: 'source ~/.profile' })
  }, 20_000)
})
