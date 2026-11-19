/**
 * The bench of the follower-by-default manager tests (src/core/host-server/manager.ts with
 * follower-default.ts and eligibility.ts): a follower the stream reaches, the manager's deps with
 * the experiment on and a Walnut Health that writes down what it hears, and a roomy fake host.
 * Call it once per test file, at the top level: it registers its own beforeEach and afterEach.
 */
import { afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { HostServerSettings, ManagerDeps } from '../../src/core/host-server/manager.js'
import type { HostFile, HostFileSource } from '../../src/core/host-server/host-file.js'
import { fakeHost, type FakeHost } from './host-server-fake-host.js'

export const LINUX = 'os=Linux\narch=x86_64\nlibc=glibc\ntranslated=0\nglibc=2.26\n'
/** Plenty: 16 GB, 12 GB free, 40 GB of disk free (in KB, as the probe prints them). */
export const ROOMY = 'mem_total_kb=16777216\nmem_avail_kb=12582912\ndisk_free_kb=41943040\n'
/** 8 GB in all, 256 MB free. */
export const FREE_SHORT = 'mem_total_kb=8388608\nmem_avail_kb=262144\ndisk_free_kb=41943040\n'

export const ON_BY_DEFAULT: HostServerSettings = { enabled: true, byDefault: true, expose: { enabled: false, provider: null, options: {} } }
export const TURNED_ON: HostServerSettings = { enabled: true, expose: { enabled: false, provider: null, options: {} } }

export interface DefaultBench {
  /** What every host's settings read now (one value for all hosts unless `settingsOf` is overridden). */
  settings: HostServerSettings
  /** What Walnut Health heard: `failed <host>: <message>[ (tries again)]`, `settled <host>`. */
  health: string[]
  files(): HostFileSource
  deps(over?: Partial<ManagerDeps>): ManagerDeps
  /** A roomy host on Linux that reports at once; `key` names it. */
  host(key?: string): FakeHost
}

export function defaultFollowerBench(): DefaultBench {
  let follower: http.Server
  let followerPort = 0
  let dir = ''
  const bench: DefaultBench = {
    settings: ON_BY_DEFAULT,
    health: [],
    files: () => ({
      buildId: async () => ({ id: '0.6.7-abc1234', version: '0.6.7', commit: 'abc1234' }),
      file: async (target) => ({ id: '0.6.7-abc1234', version: '0.6.7', commit: 'abc1234', target, gz: Buffer.alloc(2 ** 20), sha256: 'c'.repeat(64), gzSha256: 'd'.repeat(64) } satisfies HostFile),
    }),
    deps: (over = {}) => ({
      settingsOf: async () => bench.settings,
      label: async () => 'Dev box',
      walnutId: async () => 'wmac01',
      home: '/Users/me/.open-walnut',
      holdTunnelPort: async () => 5555,
      releaseTunnelPort: async () => {},
      hostFile: bench.files(),
      stateFile: path.join(dir, 'host-servers.json'),
      now: Date.now,
      installPollMs: 1,
      pollMs: 60_000,
      servingSince: 0,
      everyHost: () => true,
      health: {
        failed: (host, message, retries) => bench.health.push(`failed ${host}: ${message}${retries ? ' (tries again)' : ''}`),
        settled: (host) => bench.health.push(`settled ${host}`),
      },
      ...over,
    }),
    host: (key = 'devbox') => {
      const h = fakeHost({ followerPort: () => followerPort })
      h.hostKey = key
      h.pollsUntilReady = 1
      h.room = ROOMY
      return h
    },
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsd-'))
    bench.settings = ON_BY_DEFAULT
    bench.health = []
    follower = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"need":[]}') })
    await new Promise<void>((r) => follower.listen(0, '127.0.0.1', () => r()))
    followerPort = (follower.address() as net.AddressInfo).port
  })

  afterEach(() => {
    follower.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  return bench
}
