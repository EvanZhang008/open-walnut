import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants())
import { selectClaudeLaunchMode, managedModePresent } from '../../src/providers/claude-launch-mode.js'
import { readEngineSettings, type EngineSettingsView } from '../../src/core/agents/engine-settings-service.js'
import '../../src/ops/index.js'
import { walnutCoordinationAllowRules } from '../../src/providers/claude-walnut-allow.js'

async function view(files: Record<string, unknown>): Promise<EngineSettingsView> {
  return readEngineSettings('claude', '__local__', {
    read: async p => p in files ? Buffer.from(JSON.stringify(files[p])) : null,
    writeAtomic: async () => { throw new Error('Unexpected write') },
  }, { cwd: '/work/repo' })
}

describe('Claude launch permission default', () => {
  it('uses Auto only when no engine setting names a default and the engine supports it', async () => {
    const empty = await view({})
    expect(selectClaudeLaunchMode(empty, '2.1.284')).toEqual({ mode: 'auto', source: 'fallback', cli: 'auto' })
    for (const version of [undefined, '1.0.1', '2.1.198']) {
      expect(selectClaudeLaunchMode(empty, version)).toEqual({ mode: 'default', source: 'engine' })
    }
  })
  it.each([['plan', 'plan'], ['bypassPermissions', 'bypass'], ['default', 'default'], ['auto', 'auto'], ['manual', 'default']])('keeps the explicit engine setting %s without overriding managed policy', async (cli, mode) => {
    const saved = await view({ '~/.claude/settings.json': { permissions: { defaultMode: cli } } })
    expect(selectClaudeLaunchMode(saved, '2.1.284')).toEqual({ mode, source: 'settings' })
  })
  it('follows local project, shared project, then user settings', async () => {
    const files = {
      '~/.claude/settings.json': { permissions: { defaultMode: 'bypassPermissions' } },
      '/work/repo/.claude/settings.json': { permissions: { defaultMode: 'plan' } },
      '/work/repo/.claude/settings.local.json': { permissions: { defaultMode: 'acceptEdits' } },
    }
    expect(selectClaudeLaunchMode(await view(files), '2.1.284').mode).toBe('accept')
    delete (files as Record<string, unknown>)['/work/repo/.claude/settings.local.json']
    expect(selectClaudeLaunchMode(await view(files), '2.1.284').mode).toBe('plan')
  })
  it('leaves unreadable or unknown settings to the engine', () => {
    expect(selectClaudeLaunchMode(null, '2.1.284')).toEqual({ mode: 'default', source: 'engine' })
  })
  it('never supplies the Auto fallback over a managed default or unreadable policy', async () => {
    expect(await managedModePresent(async p => p.includes('/etc/') ? Buffer.from('{"permissions":{"defaultMode":"plan"}}') : null)).toBe(true)
    expect(await managedModePresent(async () => Buffer.from('invalid json'))).toBe(true)
    expect(await managedModePresent(async () => null)).toBe(false)
    expect(await managedModePresent(async () => Buffer.from('{}'))).toBe(true)
  })
  it('preapproves task creation and reporting through both transports without a general shell or MCP grant', () => {
    const rules = walnutCoordinationAllowRules()
    expect(rules).toContain('mcp__walnut__task_create')
    expect(rules).toContain('Bash(walnut tools call task_create:*)')
    expect(rules).toContain('mcp__walnut__task_send')
    for (const name of ['host_exec', 'secret_get', 'password_get', 'browser', 'mcp_call']) {
      expect(rules.some(rule => rule === `mcp__walnut__${name}` || rule === `Bash(walnut tools call ${name}:*)`)).toBe(false)
    }
    expect(rules).not.toContain('Bash')
    expect(rules).not.toContain('mcp__walnut__*')
  })
})
