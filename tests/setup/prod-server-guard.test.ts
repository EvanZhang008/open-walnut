/**
 * The production-server guard (tests/setup/prod-server-guard.ts).
 *
 * Nothing here ever dials :3456, not even to prove the guard refuses it: a
 * broken guard would then write to the user's real Walnut. The live checks
 * refuse a SCRATCH port instead (the guard's port set is the same code path),
 * and the :3456 decision itself is checked on the pure predicate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

// Read BEFORE this file loads the guard module itself (a static import would be
// hoisted above this line), so it proves the harness's setup files installed it.
const installedByHarness = (globalThis as unknown as Record<symbol, { installed?: boolean } | undefined>)[
  Symbol.for('open-walnut.test.prod-server-guard')
]?.installed === true
const {
  PROD_SERVER_PORT, connectTarget, failOnViolations, guardState, isThisMachine, modelApiReason, productionTargetReason,
} = await import('./prod-server-guard.js')

describe('modelApiReason: which targets are a real model API', () => {
  it('refuses the model APIs a test could call with the user\'s credentials', () => {
    const hosts = [
      'api.anthropic.com', 'API.Anthropic.com.', 'anthropic.com',
      'bedrock-runtime.us-west-2.amazonaws.com', 'bedrock-runtime-fips.us-east-1.amazonaws.com',
      'bedrock.eu-central-1.amazonaws.com', 'bedrock-agent-runtime.ap-northeast-1.amazonaws.com',
      'us-east5-aiplatform.googleapis.com', 'api.openai.com',
    ]
    for (const host of hosts) expect(modelApiReason({ host, port: 443 }), host).toContain('a model API')
  })

  it('lets everything else through, and the live tier through everything', () => {
    for (const host of ['s3.us-west-2.amazonaws.com', 'sts.amazonaws.com', 'example.com', 'notanthropic.com.evil', '127.0.0.1', 'github.com']) {
      expect(modelApiReason({ host, port: 443 }), host).toBeNull()
    }
    expect(modelApiReason({ port: 443 })).toBeNull()
    expect(modelApiReason({ host: 'api.anthropic.com', port: 443 }, { WALNUT_TEST_REAL_CLAUDE: '1' })).toBeNull()
  })

  it('refuses a real connect before it leaves this machine', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
        net.connect({ host: 'api.anthropic.com', port: 443 }).on('error', resolve)
      })
      expect(err.code).toBe('ERR_TEST_PROD_SERVER')
      expect(err.message).toContain('tests run on mocks, never a real model')
      expect(guardState.violations).toHaveLength(1)
      expect(() => failOnViolations('during this test')).toThrow(/api\.anthropic\.com, a model API/)
      expect(printed).toHaveBeenCalledTimes(1)
    } finally {
      guardState.violations.splice(0)
    }
  })
})

describe('productionTargetReason: which targets are the production Walnut', () => {
  it('refuses :3456 on every name of this machine', () => {
    const local = ['localhost', 'LOCALHOST.', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1', '0.0.0.0', os.hostname()]
    for (const host of local) {
      expect(productionTargetReason({ host, port: PROD_SERVER_PORT }), host).toContain(':3456')
    }
    // No host at all is net's default, localhost.
    expect(productionTargetReason({ port: PROD_SERVER_PORT })).toContain('localhost:3456')
  })

  it('refuses :3456 on a LAN address of this machine (a server bound to 0.0.0.0 answers there)', () => {
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && !a.internal)
    if (!lan) return // an offline box has no LAN address to check
    expect(productionTargetReason({ host: lan.address, port: PROD_SERVER_PORT })).not.toBeNull()
  })

  it('lets every other port and every other machine through', () => {
    expect(productionTargetReason({ host: '127.0.0.1', port: 3457 })).toBeNull()
    expect(productionTargetReason({ host: 'localhost', port: 0 })).toBeNull()
    expect(productionTargetReason({ host: '192.0.2.10', port: PROD_SERVER_PORT })).toBeNull()
    expect(productionTargetReason({ host: 'example.com', port: PROD_SERVER_PORT })).toBeNull()
    expect(productionTargetReason({})).toBeNull()
  })

  it('refuses unix sockets inside the production runtime dir, and only there', () => {
    expect(productionTargetReason({ path: '/tmp/open-walnut/agent-gateway.sock' })).toContain('production runtime dir')
    expect(productionTargetReason({ path: '/private/tmp/open-walnut/agent-gateway.sock' })).not.toBeNull()
    expect(productionTargetReason({ path: '/tmp/open-walnut' })).not.toBeNull()
    // Siblings (the per-worker test runtime dirs) and escapes are not production.
    expect(productionTargetReason({ path: '/tmp/open-walnut-test-runtime-123/agent-gateway.sock' })).toBeNull()
    expect(productionTargetReason({ path: '/tmp/open-walnut/../elsewhere.sock' })).toBeNull()
    expect(productionTargetReason({ path: `${os.tmpdir()}/some.sock` })).toBeNull()
  })

  it('isThisMachine treats a missing host as localhost and a stranger as a stranger', () => {
    expect(isThisMachine(undefined)).toBe(true)
    expect(isThisMachine('')).toBe(true)
    expect(isThisMachine('192.0.2.10')).toBe(false)
  })
})

describe('wiring: every vitest config loads the guard', () => {
  it('directly, or through the base config\'s runtime-dir-isolation setup file', () => {
    // A config that declares its own `setupFiles` REPLACES the base list, so a
    // new config is one line away from letting its tests reach :3456 again.
    const repoRoot = path.resolve(import.meta.dirname, '..', '..')
    const configs = fs.readdirSync(repoRoot).filter((f) => /^vitest(\..+)?\.config\.ts$/.test(f))
    expect(configs.length).toBeGreaterThan(5)
    expect(fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf-8')).toContain('tests/setup/runtime-dir-isolation.ts')
    expect(fs.readFileSync(path.join(import.meta.dirname, 'runtime-dir-isolation.ts'), 'utf-8'))
      .toMatch(/^import '\.\/prod-server-guard\.js'$/m)

    const missing = configs.filter((rel) => {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf-8')
      if (src.includes('prod-server-guard') || src.includes('runtime-dir-isolation')) return false
      // mergeConfig(baseConfig, ...) inherits the base setupFiles unless it declares its own.
      return !(src.includes('mergeConfig') && !/setupFiles\s*:/.test(src))
    })
    expect(missing, 'these vitest configs would let a test reach the production Walnut').toEqual([])
  })
})

describe('connectTarget: every Socket#connect call shape', () => {
  it('reads the pre-normalized [options, cb] array net.connect passes', () => {
    expect(connectTarget([[{ host: 'localhost', port: 3456 }, () => {}]])).toEqual({ host: 'localhost', port: 3456 })
    expect(connectTarget([[{ path: '/tmp/open-walnut/a.sock' }, null]])).toEqual({ path: '/tmp/open-walnut/a.sock' })
  })

  it('reads (options), (port, host), (numeric string) and (path)', () => {
    expect(connectTarget([{ port: '3456' }])).toEqual({ host: undefined, port: 3456 })
    expect(connectTarget([3456, '127.0.0.1'])).toEqual({ host: '127.0.0.1', port: 3456 })
    expect(connectTarget(['3456'])).toEqual({ host: undefined, port: 3456 })
    expect(connectTarget(['/tmp/x.sock'])).toEqual({ path: '/tmp/x.sock' })
    expect(connectTarget([])).toEqual({})
  })
})

describe('the installed guard, on a scratch port', () => {
  const scratchPorts: number[] = []
  afterEach(() => {
    for (const p of scratchPorts.splice(0)) guardState.ports.delete(p)
    vi.restoreAllMocks()
  })

  /** A local server that counts the connections it accepts. */
  async function countingServer(): Promise<{ port: number; accepted: () => number; close: () => Promise<void> }> {
    let accepted = 0
    const server = http.createServer((_req, res) => res.end('ok'))
    server.on('connection', () => { accepted++ })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      port: (server.address() as AddressInfo).port,
      accepted: () => accepted,
      close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
    }
  }

  it('is installed in this worker by the setup files, before any test module loads', () => {
    expect(installedByHarness, 'runtime-dir-isolation.ts (or the config) must load prod-server-guard').toBe(true)
    expect(net.Socket.prototype.connect.name).toBe('guarded')
    expect(guardState.ports.has(PROD_SERVER_PORT)).toBe(true)
  })

  it('refuses fetch, http and net before any byte leaves, records each attempt, and lets the port through once released', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {})
    const target = await countingServer()
    try {
      guardState.ports.add(target.port)
      scratchPorts.push(target.port)
      const url = `http://127.0.0.1:${target.port}/api/v1/tasks/x`

      const viaFetch = await fetch(url, { method: 'PATCH', body: '{"phase":"TODO"}' }).then(() => null, (e: unknown) => e)
      expect((viaFetch as { cause?: { code?: string } } | null)?.cause?.code).toBe('ERR_TEST_PROD_SERVER')

      const viaHttp = await new Promise<NodeJS.ErrnoException>((resolve) => {
        http.request(url, { method: 'PATCH' }).on('error', resolve).end('{}')
      })
      expect(viaHttp.code).toBe('ERR_TEST_PROD_SERVER')

      const viaNet = await new Promise<NodeJS.ErrnoException>((resolve) => {
        net.connect(target.port, 'localhost').on('error', resolve)
      })
      expect(viaNet.code).toBe('ERR_TEST_PROD_SERVER')
      expect(viaNet.message).toContain('tests must never reach the user\'s real Walnut')

      expect(target.accepted(), 'no connection reached the server').toBe(0)
      expect(guardState.violations).toHaveLength(3)
      expect(printed).toHaveBeenCalledTimes(3)

      // The hook that fails the test: it throws with every attempt, then is clear.
      expect(() => failOnViolations('during this test')).toThrow(/3 connection attempt\(s\) to the production Walnut or a model API were refused/)
      expect(guardState.violations).toHaveLength(0)
      expect(() => failOnViolations('during this test')).not.toThrow()

      // Everything else still connects.
      guardState.ports.delete(target.port)
      expect(await (await fetch(url)).text()).toBe('ok')
      expect(target.accepted()).toBe(1)
    } finally {
      guardState.violations.splice(0)
      await target.close()
    }
  })

  it('still fails the connect when the test runs fake timers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const target = await countingServer()
    try {
      guardState.ports.add(target.port)
      scratchPorts.push(target.port)
      vi.useFakeTimers()
      const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
        net.connect({ port: target.port }).on('error', resolve)
      })
      expect(err.code).toBe('ERR_TEST_PROD_SERVER')
      expect(target.accepted()).toBe(0)
    } finally {
      vi.useRealTimers()
      guardState.violations.splice(0)
      await target.close()
    }
  })
})
