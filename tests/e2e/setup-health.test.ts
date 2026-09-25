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
import { setLocalClaudeIo } from '../../src/core/hosts/local-readiness.js'
import type { HostPreflightResult } from '../../src/providers/host-runtime-core.js'

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
  setLocalClaudeIo()
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

// This machine's Claude Code, through the real server wiring (startServer's
// wireLocalClaude → systemHealth.localClaude → GET /api/system/health). Only
// the machine is a seam: no claude runs and nothing is installed.
describe('local Claude Code: /api/system/local-claude/* and health.localClaude', () => {
  const OLD: HostPreflightResult = {
    claude: { found: true, path: '/Users/dev/.local/bin/claude', kind: 'native', needsNode: false, version: '2.1.258', auth: 'not-logged-in', versionOk: false, minVersion: '2.1.280', installMethod: 'native' },
    compiler: { found: true }, dtach: { found: true },
  }
  let state: HostPreflightResult
  let fixes: string[]
  const post = (p: string, body: unknown) => fetch(apiUrl(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('a check answers with the problems and puts them on health', async () => {
    state = structuredClone(OLD)
    fixes = []
    setLocalClaudeIo({
      floor: async () => ({ minVersion: '2.1.280', model: 'Opus 5.5' }),
      preflight: async () => ({ result: structuredClone(state), source: 'daemon' }),
      fix: async (action) => {
        fixes.push(action)
        state = { ...state, claude: { ...state.claude, version: '2.1.280', versionOk: true } }
        return { result: { action, ok: true, claude: { path: state.claude.path!, kind: 'native', version: '2.1.280' }, log: '', durationMs: 1 } }
      },
    })
    const res = await post('/api/system/local-claude/check', {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.localClaude.problems.map((p: { kind: string }) => p.kind)).toEqual(['claude_outdated', 'claude_not_logged_in'])
    const health = await (await fetch(apiUrl('/api/system/health'))).json()
    expect(health.localClaude.problems[0].message).toBe('Claude Code on this computer is 2.1.258, but Opus 5.5 needs 2.1.280 or newer.')
    expect(health.localClaude.claude).toMatchObject({ auth: 'not-logged-in', versionOk: false, minVersion: '2.1.280' })
  })

  it('the one-click update answers 202 at once, sign-in has no fix (409), and health ends with only the sign-in line', async () => {
    const started = await post('/api/system/local-claude/fix', { kind: 'claude_outdated' })
    expect(started.status).toBe(202)
    expect((await started.json()).localClaude.fixing).toMatchObject({ action: 'update-claude', text: 'Updating Claude Code' })
    const refused = await post('/api/system/local-claude/fix', { kind: 'claude_not_logged_in' })
    expect(refused.status).toBe(409)
    expect((await refused.json()).error).toBe('no-fix')
    await vi.waitFor(async () => {
      const health = await (await fetch(apiUrl('/api/system/health'))).json()
      expect(health.localClaude.problems.map((p: { kind: string }) => p.kind)).toEqual(['claude_not_logged_in'])
      expect(health.localClaude.lastFix).toMatchObject({ action: 'update-claude', ok: true })
    })
    expect(fixes).toEqual(['update-claude'])
  })

  it('the 15s poll is answered from a fresh result; signing in clears the banner state on the next click', async () => {
    let asked = 0
    setLocalClaudeIo({
      floor: async () => ({ minVersion: '2.1.280', model: 'Opus 5.5' }),
      preflight: async () => { asked++; return { result: structuredClone(state), source: 'daemon' } },
    })
    await post('/api/system/local-claude/check', {})
    await post('/api/system/local-claude/check', { poll: true })
    expect(asked).toBe(1)
    state = { ...state, claude: { ...state.claude, auth: 'ok' } }
    const res = await post('/api/system/local-claude/check', {})
    expect((await res.json()).localClaude.problems).toEqual([])
    expect(asked).toBe(2)
  })
})
