/**
 * The warmup must NOT run under vitest — and this is the file that proves it on
 * the real server, not on a hand-built gate call.
 *
 * Why it matters: 182 test files boot `startServer({ port: 0, dev: true })`, and
 * getConfig() merges every Host block of the developer's REAL ~/.ssh/config into
 * config.hosts. A warming server would therefore ssh the developer's actual
 * machines from a unit test, install daemons on them, and fight the production
 * server for the singleton daemon on each. So the boot asserted here is the
 * common case for the whole suite: an explicitly configured, enabled,
 * non-discovered host in config.yaml, and still no warmup and no connection.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-warmup-gating'))

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { closeDb } from '../../src/core/task-db.js'
import { getHostWarmup } from '../../src/core/hosts/host-warmup-registry.js'
import { hostWarmupGateReason } from '../../src/core/hosts/host-warmup.js'
import { getDaemonPoolStatus } from '../../src/providers/daemon-connection.js'

/** Longer than the warmup's own 3s startup delay, so "never dialled" is real. */
const PAST_STARTUP_DELAY_MS = 4_000

let server: HttpServer
let port: number

beforeAll(async () => {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  // An explicitly configured host (not discovered, not disabled): exactly what
  // the warmup exists to connect on a real box.
  await fs.writeFile(CONFIG_FILE, [
    'hosts:',
    '  warm-target:',
    '    hostname: warm-target.example.test',
    '    user: builder',
    '    label: Warm target',
    '',
  ].join('\n'), 'utf-8')

  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  expect(port).toBeGreaterThan(0)
}, 120_000)

afterAll(async () => {
  await stopServer().catch(() => {})
  closeDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('host warmup gating under vitest', () => {
  it('registers NO warmup, even with an eligible host in config', async () => {
    // Sanity: the config really did reach the server, so "no warmup" is not a
    // vacuous pass from an empty hosts map.
    const res = await fetch(`http://127.0.0.1:${port}/api/hosts/status`)
    expect(res.status).toBe(200)
    const body = await res.json() as { hosts: Array<{ host: string; phase: string; warmup?: string }> }
    const target = body.hosts.find((h) => h.host === 'warm-target')
    expect(target).toBeDefined()
    expect(target!.phase).toBe('idle')
    expect(target!.warmup).toBeUndefined()

    expect(getHostWarmup()).toBeNull()
  })

  it('never dials the configured host, well past the startup delay', async () => {
    await new Promise((r) => setTimeout(r, PAST_STARTUP_DELAY_MS))
    expect(getHostWarmup()).toBeNull()
    // Nothing put a connection in the pool for it: no ssh was attempted.
    expect(getDaemonPoolStatus().some((d) => d.host === 'warm-target')).toBe(false)
  }, 30_000)

  it('the gate refuses THIS process for the reason we expect', () => {
    expect(process.env.VITEST).toBeTruthy()
    expect(hostWarmupGateReason({
      cloudMode: false, ephemeral: false, env: process.env, config: {},
    })).toBe('vitest')
    // …and a replica is refused for its own reason, before vitest is even read.
    expect(hostWarmupGateReason({
      cloudMode: true, ephemeral: false, env: process.env, config: {},
    })).toBe('cloud mode')
  })
})
