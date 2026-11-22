/**
 * The hub mount's listing role (src/commands/mcp.ts mountListingRole): WALNUT_MCP_ROLE, which
 * walnutMcpProfile sets for Main and the asks, counts only while the experiment
 * mcp_tools_by_role is on in config.yaml. Read at the mount's start, so the switch reaches a
 * session at its next mount start; anything unreadable lists everything, as before.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-mount-role'))

import { CONFIG_FILE } from '../../src/constants.js'
import { mountListingRole } from '../../src/commands/mcp.js'

const writeConfig = (text: string) => {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, text)
}

describe('the hub mount\'s listing role', () => {
  beforeEach(() => { fs.rmSync(CONFIG_FILE, { force: true }) })

  it('is the env\'s role while the experiment is on', async () => {
    writeConfig('experimental:\n  mcp_tools_by_role: true\n')
    expect(await mountListingRole({ WALNUT_MCP_ROLE: 'org' })).toBe('org')
    expect(await mountListingRole({ WALNUT_MCP_ROLE: 'worker' })).toBe('worker')
  })

  it('is none (every tool listed) with the experiment off or unset, no role, an unknown role, or no config', async () => {
    writeConfig('experimental:\n  mcp_tools_by_role: false\n')
    expect(await mountListingRole({ WALNUT_MCP_ROLE: 'org' })).toBeUndefined()
    writeConfig('user:\n  name: Ada\n')
    expect(await mountListingRole({ WALNUT_MCP_ROLE: 'org' })).toBeUndefined()
    writeConfig('experimental:\n  mcp_tools_by_role: true\n')
    expect(await mountListingRole({})).toBeUndefined()
    expect(await mountListingRole({ WALNUT_MCP_ROLE: 'router' })).toBeUndefined()
    fs.rmSync(CONFIG_FILE, { force: true })
    expect(await mountListingRole({ WALNUT_MCP_ROLE: 'org' })).toBeUndefined()
    writeConfig(': not yaml : [')
    expect(await mountListingRole({ WALNUT_MCP_ROLE: 'org' })).toBeUndefined()
  })
})
