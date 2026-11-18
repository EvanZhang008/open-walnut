/**
 * credentialHost: the host a credential ask names is the alias the person uses for that daemon.
 *
 * Two rows of one machine (an SSH row found in ~/.ssh/config, and the row it joined the host
 * network as) are joined only by the pair the daemon confirmed (host profile `sameDaemon`), and
 * only while both rows still connect where they did. Never by hostname.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-credential-host'))

import { HOST_PROFILES_DIR } from '../../../src/core/hosts/host-profile.js'
import { __setSshResolverForTest } from '../../../src/core/hosts/same-daemon-record.js'
import { credentialHost, localHostLabel, sameDaemonAliases } from '../../../src/core/hosts/credential-host.js'
import type { Config } from '../../../src/core/types.js'

const NET_KEY = 'c'.repeat(64)
const NET_ID = `net:${NET_KEY}`
const SSH_ID = JSON.stringify(['ssh', 'dev', 'box.example.test', '22'])

/** What `ssh -G` resolves each name to (no real ~/.ssh). */
let resolvesTo = 'box.example.test'

function config(extra: Record<string, unknown> = {}): Config {
  return {
    hosts: {
      'box-net': { hostname: 'box.walnut-net.invalid', transport: 'net', endpoint: NET_KEY, label: 'Big box', enabled: true, discovered: false },
      'box-ssh': { hostname: 'box.example.test', user: 'dev', port: 22, enabled: true, discovered: true },
      ...extra,
    },
  } as unknown as Config
}

async function writePair(a: string, aId: string, b: string, bId: string): Promise<void> {
  await fs.mkdir(HOST_PROFILES_DIR, { recursive: true })
  for (const [self, selfId, other, otherId] of [[a, aId, b, bId], [b, bId, a, aId]]) {
    const file = path.join(HOST_PROFILES_DIR, `${self}.json`)
    const prior = await fs.readFile(file, 'utf8').then((t) => JSON.parse(t), () => ({ host: self }))
    prior.sameDaemon = { ...(prior.sameDaemon ?? {}), [other]: { self: selfId, other: otherId, at: '2026-11-16T00:00:00.000Z' } }
    await fs.writeFile(file, JSON.stringify(prior))
  }
}

beforeEach(async () => {
  resolvesTo = 'box.example.test'
  __setSshResolverForTest(async () => ({ hostname: resolvesTo, port: 22, user: 'dev' }))
  await fs.rm(HOST_PROFILES_DIR, { recursive: true, force: true })
})

afterEach(() => {
  __setSshResolverForTest(null)
})

describe('credentialHost', () => {
  it('names the network row for the found SSH row of the same daemon, from either alias', async () => {
    await writePair('box-net', NET_ID, 'box-ssh', SSH_ID)
    expect(await credentialHost('box-ssh', config())).toEqual({ host: 'box-net', label: 'Big box' })
    expect(await credentialHost('box-net', config())).toEqual({ host: 'box-net', label: 'Big box' })
  })

  it('keeps a host with no confirmed pair as itself, even when its hostname looks alike', async () => {
    expect(await credentialHost('box-ssh', config())).toEqual({ host: 'box-ssh', label: 'box-ssh' })
  })

  it('drops a pair whose SSH row now resolves somewhere else', async () => {
    await writePair('box-net', NET_ID, 'box-ssh', SSH_ID)
    resolvesTo = 'other.example.test'
    expect(await credentialHost('box-ssh', config())).toEqual({ host: 'box-ssh', label: 'box-ssh' })
  })

  it('drops a pair whose other row is gone from Settings', async () => {
    await writePair('box-net', NET_ID, 'box-ssh', SSH_ID)
    const c = config()
    delete (c.hosts as Record<string, unknown>)['box-net']
    expect(await credentialHost('box-ssh', c)).toEqual({ host: 'box-ssh', label: 'box-ssh' })
  })

  it('follows recorded pairs through a third alias', async () => {
    const thirdId = JSON.stringify(['ssh', 'dev', 'box.example.test', '2222'])
    await writePair('box-net', NET_ID, 'box-ssh', SSH_ID)
    await writePair('box-ssh', SSH_ID, 'box-alt', thirdId)
    const c = config({ 'box-alt': { hostname: 'box.example.test', user: 'dev', port: 2222, enabled: true, discovered: true } })
    expect(await sameDaemonAliases('box-alt', c)).toEqual(['box-alt', 'box-net', 'box-ssh'])
    expect((await credentialHost('box-alt', c)).host).toBe('box-net')
  })

  it("names this Mac by the platform, never by its internal key", async () => {
    expect((await credentialHost('__local__', config())).host).toBe('__local__')
    expect((await credentialHost('__local__', config())).label).toBe(localHostLabel())
    expect(localHostLabel('darwin')).toBe('your Mac')
    expect(localHostLabel('linux')).toBe('this computer')
  })
})
