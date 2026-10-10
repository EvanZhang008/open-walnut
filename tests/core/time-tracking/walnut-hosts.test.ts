/**
 * The hostnames this Mac's Walnut was opened under in a browser: learned from
 * the heartbeat requests, kept on this Mac, added to the config's names, so a
 * tab on a LAN or tailnet name is never read as "another app".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-hosts'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { cleanHost, noteWalnutHost, resetWalnutHosts, walnutHostsFor } from '../../../src/core/time-tracking/walnut-hosts.js'

const FILE = () => path.join(WALNUT_HOME, 'time-tracking', 'outside', 'walnut-hosts.json')

beforeEach(async () => {
  resetWalnutHosts()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

describe('walnut hosts', () => {
  it('cleans a hostname and refuses loopback and junk', () => {
    expect(cleanHost(' Mac-Mini.Local. ')).toBe('mac-mini.local')
    expect(cleanHost('192.168.1.20')).toBe('192.168.1.20')
    for (const bad of ['localhost', '127.0.0.1', '[::1]', '', 'a b', 'x/y', 'é.example', 42, null]) expect(cleanHost(bad)).toBeNull()
  })

  it('remembers a new name once, on this Mac, and adds it to the config names', async () => {
    await noteWalnutHost('mac-mini.local')
    await noteWalnutHost('mac-mini.local')
    await noteWalnutHost('localhost')
    expect(JSON.parse(await fs.readFile(FILE(), 'utf8'))).toEqual({ hosts: ['mac-mini.local'] })
    const all = await walnutHostsFor({ cloud_bridge: { url: 'https://companion.example.org' } } as never)
    expect(all).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', 'companion.example.org', 'mac-mini.local']))
    // A fresh process reads the file back.
    resetWalnutHosts()
    expect(await walnutHostsFor(undefined)).toContain('mac-mini.local')
  })

  it('keeps the newest 32 and survives a broken file', async () => {
    await fs.mkdir(path.dirname(FILE()), { recursive: true })
    await fs.writeFile(FILE(), '{not json')
    for (let i = 0; i < 40; i++) await noteWalnutHost(`host-${i}.lan`)
    const saved = JSON.parse(await fs.readFile(FILE(), 'utf8')).hosts as string[]
    expect(saved).toHaveLength(32)
    expect(saved[0]).toBe('host-8.lan')
    expect(saved.at(-1)).toBe('host-39.lan')
  })
})
