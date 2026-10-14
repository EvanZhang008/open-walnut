/**
 * `walnut.mcp.client(name).restart()` for plugins, against a REAL stdio MCP server
 * (tests/fixtures/mcp/fake-stdio-server.mjs): the restart replaces the process, and a second
 * restart inside PLUGIN_MCP_RESTART_MIN_INTERVAL_MS answers `restarted: false` without touching it,
 * so a login refusal seen by many calls at once costs one restart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-plugin-mcp-restart'))

const { createPluginMcp, PLUGIN_MCP_RESTART_MIN_INTERVAL_MS, _resetPluginMcpRestartsForTesting } = await import('../../src/core/plugins/plugin-mcp.js')
const { getMcpConnection } = await import('../../src/core/mcp-servers/registry.js')

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp/fake-stdio-server.mjs')

let dir: string
const disposers: Array<() => Promise<void> | void> = []

function pluginMcp() {
  return createPluginMcp({
    pluginId: 'test-plugin',
    own: (registration) => { disposers.push(() => registration.dispose()); return registration },
    assertLive: () => {},
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mcp-restart-'))
  _resetPluginMcpRestartsForTesting()
})

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('plugin mcp client restart', () => {
  it('replaces the process once, then refuses a second restart inside the interval', async () => {
    const mcp = pluginMcp()
    mcp.register({ name: 'restart-fake', command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_LOG: path.join(dir, 'log.jsonl') } })
    const client = mcp.client('restart-fake')
    await client.tools({ refresh: true })
    const before = getMcpConnection('restart-fake')!.pid()
    expect(before).toBeGreaterThan(0)

    const first = await client.restart()
    expect(first.restarted).toBe(true)
    expect(first.status?.state).toBe('ready')
    const after = getMcpConnection('restart-fake')!.pid()
    expect(after).toBeGreaterThan(0)
    expect(after).not.toBe(before)

    const second = await client.restart()
    expect(second.restarted).toBe(false)
    expect(getMcpConnection('restart-fake')!.pid()).toBe(after)
  })

  it('allows the next restart once the interval has passed', async () => {
    const mcp = pluginMcp()
    mcp.register({ name: 'restart-fake-2', command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_LOG: path.join(dir, 'log2.jsonl') } })
    const client = mcp.client('restart-fake-2')
    const realNow = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow)
    expect((await client.restart()).restarted).toBe(true)
    spy.mockReturnValue(realNow + PLUGIN_MCP_RESTART_MIN_INTERVAL_MS - 1)
    expect((await client.restart()).restarted).toBe(false)
    spy.mockReturnValue(realNow + PLUGIN_MCP_RESTART_MIN_INTERVAL_MS + 1)
    expect((await client.restart()).restarted).toBe(true)
    spy.mockRestore()
  })

  it('a server nobody registered refuses before anything starts', async () => {
    await expect(pluginMcp().client('nobody').restart()).rejects.toMatchObject({ stage: 'before-call' })
  })
})
