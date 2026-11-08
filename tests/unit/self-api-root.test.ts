/**
 * A server's own ops, and the local sessions it launches, talk to THAT server.
 *
 * Incident this pins (2026-09-23): a session launched by a `web --ephemeral`
 * server ran `walnut tools call task_create …` and the task landed on the
 * user's real Walnut (:3456). Every op client defaulted to :3456 and no server
 * told its sessions (or its own executor) where it actually listened.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { demoApiHeaders, getSelfApiRoot, setSelfApiRoot, walnutApiEnvForSession } from '../../src/lib/self-api-root.js'
import { executeOp, resolveApiBase } from '../../src/ops/executor.js'
import '../../src/ops/index.js'

const saved = process.env.OPEN_WALNUT_API_URL

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  setSelfApiRoot(null)
  if (saved === undefined) delete process.env.OPEN_WALNUT_API_URL
  else process.env.OPEN_WALNUT_API_URL = saved
})

describe('walnutApiEnvForSession', () => {
  it('is empty when no server listens in this process (CLI, MCP child, unit tests)', () => {
    expect(getSelfApiRoot()).toBeNull()
    expect(walnutApiEnvForSession(undefined)).toEqual({})
  })

  it('points a LOCAL session at the launching server', () => {
    setSelfApiRoot('http://127.0.0.1:45678')
    const expected = { OPEN_WALNUT_API_URL: 'http://127.0.0.1:45678' }
    expect(walnutApiEnvForSession(undefined)).toEqual(expected)
    expect(walnutApiEnvForSession(null)).toEqual(expected)
    expect(walnutApiEnvForSession('__local__')).toEqual(expected)
  })

  it('leaves remote sessions alone: 127.0.0.1 there is that host, not this server', () => {
    setSelfApiRoot('http://127.0.0.1:45678')
    expect(walnutApiEnvForSession('devbox')).toEqual({})
  })
})

describe('Demo op generation headers', () => {
  it('lists every self-API fetch file so a new one cannot skip generation review', () => {
    const root = path.resolve(import.meta.dirname, '../../src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          const source = fs.readFileSync(full, 'utf8')
          if (source.includes('fetch(') && /getSelfApiRoot|getPluginApiBase|triggerCheckBaseUrl/.test(source)) files.push(path.relative(root, full))
        }
      }
    }
    walk(root)
    expect(files.sort()).toEqual([
      'commands/trigger-check.ts', 'core/plugins/plugin-control-relay.ts', 'core/plugins/server-api.ts',
      'ops/executor.ts', 'web/v1-forward/target.ts',
    ])
    for (const file of ['commands/trigger-check.ts', 'core/plugins/plugin-control-relay.ts', 'ops/executor.ts']) {
      expect(fs.readFileSync(path.join(root, file), 'utf8'), file).toContain('...demoApiHeaders(url)')
    }
    // server-api is a plugin's external HTTP client; v1-forward is a remote bridge, disabled in Demo.
  })
  it('the shared header rule uses the child generation only on the canonical Demo origin', () => {
    vi.stubEnv('WALNUT_DEMO_GENERATION', 'old-generation')
    for (const url of ['http://127.0.0.1:3458/api/tasks', new URL('http://127.0.0.1:3458/api/v1/check')]) {
      expect(demoApiHeaders(url)).toEqual({ 'x-walnut-demo-generation': 'old-generation' })
    }
    for (const url of ['http://localhost:3458/api/tasks', 'http://127.0.0.1:3456/api/tasks', 'not a URL']) expect(demoApiHeaders(url)).toEqual({})
    vi.stubEnv('WALNUT_DEMO_GENERATION', '')
    expect(demoApiHeaders('http://127.0.0.1:3458/api/tasks')).toEqual({})
  })

  it('stamps only its own Demo origin and never another Walnut', async () => {
    vi.stubEnv('WALNUT_DEMO_GENERATION', 'old-generation')
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ task: { id: 't1' } }))
    vi.stubGlobal('fetch', request)
    for (const apiBase of ['http://127.0.0.1:3458', 'http://127.0.0.1:3456', 'http://demo.example:3458']) {
      await executeOp('task_get', { id: 't1' }, { apiBase, callerMode: 'human' })
      const headers = new Headers(request.mock.calls.at(-1)![1]?.headers)
      expect(headers.get('x-walnut-demo-generation')).toBe(apiBase.endsWith('127.0.0.1:3458') ? 'old-generation' : null)
    }
  })
})

describe('resolveApiBase precedence', () => {
  it('explicit override > this server > OPEN_WALNUT_API_URL > the :3456 default', () => {
    delete process.env.OPEN_WALNUT_API_URL
    expect(resolveApiBase()).toBe('http://127.0.0.1:3456/api/v1')

    process.env.OPEN_WALNUT_API_URL = 'http://127.0.0.1:3456'
    expect(resolveApiBase()).toBe('http://127.0.0.1:3456/api/v1')

    // Inside a test server whose env still names the real Walnut (inherited from
    // the agent session that launched it), the server's own ops stay home.
    setSelfApiRoot('http://127.0.0.1:45678')
    expect(resolveApiBase()).toBe('http://127.0.0.1:45678/api/v1')

    expect(resolveApiBase('http://127.0.0.1:9/')).toBe('http://127.0.0.1:9/api/v1')
  })
})
