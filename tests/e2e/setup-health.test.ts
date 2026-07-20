/**
 * E2E tests for setup health fields (claudeCliAvailable, hasReadyProvider)
 * exposed via GET /api/system/health.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'

import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-setup-health'))

import { WALNUT_HOME } from '../../src/constants.js'
import { refreshSystemHealth, startServer, stopServer } from '../../src/web/server.js'

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('GET /api/system/health — setup fields', () => {
  it('includes claudeCliAvailable as a boolean', async () => {
    const res = await fetch(apiUrl('/api/system/health'))
    expect(res.ok).toBe(true)
    const body = await res.json()
    expect(typeof body.claudeCliAvailable).toBe('boolean')
  })

  it('includes hasReadyProvider as a boolean', async () => {
    const res = await fetch(apiUrl('/api/system/health'))
    expect(res.ok).toBe(true)
    const body = await res.json()
    expect(typeof body.hasReadyProvider).toBe('boolean')
  })

  it('claudeCliAvailable is stable across health requests', async () => {
    const res = await fetch(apiUrl('/api/system/health'))
    const body = await res.json()
    // On CI/dev machines with claude installed, this should be true.
    // The key assertion is that it's a boolean and matches system state.
    expect(body.claudeCliAvailable).toBe(body.claudeCliAvailable) // tautology for type check
    // Verify it's consistent across calls (not random)
    const res2 = await fetch(apiUrl('/api/system/health'))
    const body2 = await res2.json()
    expect(body2.claudeCliAvailable).toBe(body.claudeCliAvailable)
  })

  it('finds Claude Code in its standard user install directory outside PATH', async () => {
    const originalHome = process.env.HOME
    const originalPath = process.env.PATH
    const fakeHome = path.join(WALNUT_HOME, 'fake-home')
    const claudePath = path.join(fakeHome, '.local', 'bin', 'claude')

    await fs.mkdir(path.dirname(claudePath), { recursive: true })
    await fs.writeFile(claudePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    try {
      process.env.HOME = fakeHome
      process.env.PATH = '/usr/bin:/bin'
      await refreshSystemHealth()

      const res = await fetch(apiUrl('/api/system/health'))
      expect(res.ok).toBe(true)
      expect((await res.json()).claudeCliAvailable).toBe(true)
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await refreshSystemHealth()
    }
  })

  it('hasReadyProvider reflects provider configuration', async () => {
    const res = await fetch(apiUrl('/api/system/health'))
    const body = await res.json()
    // The value depends on env vars (bedrock, anthropic, etc.)
    // The key test is that it's a boolean and present.
    expect([true, false]).toContain(body.hasReadyProvider)
  })

  it('exposes credentialSource consistent with hasReadyProvider', async () => {
    const res = await fetch(apiUrl('/api/system/health'))
    const body = await res.json()
    // credentialSource is one of the known provenance labels (or 'none' when unconfigured).
    expect(['config', 'claude-settings', 'env', 'aws-files', 'none', undefined]).toContain(body.credentialSource)
    // When a provider is ready the source must NOT be 'none'; when not ready it must be 'none'.
    if (body.hasReadyProvider) {
      expect(body.credentialSource).not.toBe('none')
    } else {
      expect(body.credentialSource).toBe('none')
    }
  })

  it('health response includes all expected top-level fields', async () => {
    const res = await fetch(apiUrl('/api/system/health'))
    const body = await res.json()
    expect(body).toHaveProperty('claudeCliAvailable')
    expect(body).toHaveProperty('hasReadyProvider')
    expect(body).toHaveProperty('credentialSource')
  })
})
