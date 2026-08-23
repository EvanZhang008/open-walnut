/**
 * Frontend slash-command registry: owner tiers.
 *
 * Two shipped bugs this pins:
 *  1. `refreshMarkdownCommands()` used to delete every command whose source wasn't
 *     'hardcoded' or 'skill' — which silently unregistered /compact, /session and
 *     /task (source 'control') and never restored them. A refresh must now be able to
 *     touch its OWN owner only.
 *  2. Command-beats-skill used to depend on load order (the skill bridge skipped names
 *     it saw already registered). With owner tiers the winner is the same whichever
 *     bridge finishes first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiGetText: vi.fn(async () => 'module source'),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}))
vi.mock('@/api/ws', () => ({
  wsClient: {
    onEvent: vi.fn(),
    onConnectionChange: vi.fn(),
    sendRpc: vi.fn(),
    subscribeAll: vi.fn(() => () => undefined),
  },
}))
vi.mock('@/api/device-token', () => ({ getDeviceToken: vi.fn(() => null) }))
vi.mock('@/api/commands', () => ({ fetchCommands: vi.fn(async () => []) }))
vi.mock('@/api/skills', () => ({ fetchSkills: vi.fn(async () => []) }))
vi.mock('@/api/chat', () => ({ compactChatHistory: vi.fn() }))
vi.mock('@/utils/log', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../web/src/plugins/views.tsx', () => ({
  createPluginViews: () => ({
    CalendarView: () => null,
    FileView: () => null,
    NoteView: () => null,
    TerminalView: () => null,
    SessionView: () => null,
    TaskView: () => null,
    ChatView: () => null,
  }),
}))

import { fetchCommands, type CommandDef } from '../../web/src/api/commands.js'
import { fetchSkills, type SkillInfo } from '../../web/src/api/skills.js'
import { apiGet } from '../../web/src/api/client.js'
import { getCommand, listCommands } from '../../web/src/commands/index.js'
import { refreshMarkdownCommands } from '../../web/src/commands/markdown-bridge.js'
import { refreshSkillCommands } from '../../web/src/commands/skill-bridge.js'
import { removeOwner } from '../../web/src/commands/registry.js'
import {
  disposeWebPluginsForTesting,
  refreshWebPluginsWithCommands,
  setWebPluginImporterForTesting,
} from '../../web/src/plugins/loader.js'

/** Commands the hardcoded 'core' tier owns — none of them may ever be refreshed away. */
const CORE_NAMES = ['compact', 'session', 'task', 'help', 'plan', 'check-tasks', 'tasks']

function serverCommand(name: string, source: CommandDef['source']): CommandDef {
  return { name, description: `${name} description`, content: `body of ${name}`, source }
}

function skill(name: string): SkillInfo {
  return {
    dirName: name,
    name,
    description: `${name} skill`,
    source: 'walnut',
    location: `/skills/${name}/SKILL.md`,
    content: '',
    eligible: true,
    enabled: true,
    hasReferences: false,
  }
}

beforeEach(() => {
  vi.mocked(fetchCommands).mockResolvedValue([])
  vi.mocked(fetchSkills).mockResolvedValue([])
})

afterEach(async () => {
  removeOwner('markdown')
  removeOwner('skill')
  await disposeWebPluginsForTesting()
  vi.clearAllMocks()
})

describe('slash-command owner tiers', () => {
  it('keeps the hardcoded commands across a markdown refresh', async () => {
    vi.mocked(fetchCommands).mockResolvedValue([
      serverCommand('user-cmd', 'user'),
      serverCommand('demo:ship', 'plugin'),
    ])

    await refreshMarkdownCommands()

    for (const name of CORE_NAMES) expect(getCommand(name), name).toBeDefined()
    expect(getCommand('compact')?.source).toBe('control')
    expect(getCommand('session')?.source).toBe('control')
    expect(getCommand('task')?.source).toBe('control')
    expect(getCommand('demo:ship')?.source).toBe('plugin')
    expect(getCommand('user-cmd')?.source).toBe('user')

    // A second refresh that returns nothing drops only this owner's entries.
    vi.mocked(fetchCommands).mockResolvedValue([])
    await refreshMarkdownCommands()

    expect(getCommand('demo:ship')).toBeUndefined()
    for (const name of CORE_NAMES) expect(getCommand(name), name).toBeDefined()
  })

  it('keeps the hardcoded commands across a skill refresh', async () => {
    vi.mocked(fetchSkills).mockResolvedValue([skill('deep-reading'), skill('compact')])

    await refreshSkillCommands()

    for (const name of CORE_NAMES) expect(getCommand(name), name).toBeDefined()
    expect(getCommand('deep-reading')?.source).toBe('skill')
    // A skill named like a core command never shadows it…
    expect(getCommand('compact')?.source).toBe('control')
    // …and is not listed twice either.
    expect(listCommands().filter((cmd) => cmd.name === 'compact')).toHaveLength(1)

    vi.mocked(fetchSkills).mockResolvedValue([])
    await refreshSkillCommands()
    expect(getCommand('deep-reading')).toBeUndefined()
    for (const name of CORE_NAMES) expect(getCommand(name), name).toBeDefined()
  })

  it('lets a command outrank a same-named skill whichever loads first', async () => {
    vi.mocked(fetchCommands).mockResolvedValue([serverCommand('notes', 'user')])
    vi.mocked(fetchSkills).mockResolvedValue([skill('notes')])

    await refreshMarkdownCommands()
    await refreshSkillCommands()
    expect(getCommand('notes')?.source).toBe('user')

    // Reverse the order — the skill bridge finishing last must not change the winner.
    removeOwner('markdown')
    removeOwner('skill')
    await refreshSkillCommands()
    await refreshMarkdownCommands()
    expect(getCommand('notes')?.source).toBe('user')
    expect(listCommands().filter((cmd) => cmd.name === 'notes')).toHaveLength(1)

    // Dropping the command exposes the skill of the same name again.
    removeOwner('markdown')
    expect(getCommand('notes')?.source).toBe('skill')
  })
})

describe('plugin runtime change refreshes the palette', () => {
  it('re-reads commands and skills after a plugin reload, without disturbing core', async () => {
    vi.mocked(apiGet).mockResolvedValue({ plugins: [], tombstones: [], modules: [], moduleErrors: [] })
    setWebPluginImporterForTesting(async () => ({ activate: () => undefined }))
    vi.mocked(fetchCommands).mockResolvedValue([serverCommand('demo:ship', 'plugin')])
    vi.mocked(fetchSkills).mockResolvedValue([skill('demo-bundled-skill')])

    await refreshWebPluginsWithCommands()

    expect(fetchCommands).toHaveBeenCalled()
    expect(fetchSkills).toHaveBeenCalled()
    expect(getCommand('demo:ship')?.source).toBe('plugin')
    expect(getCommand('demo-bundled-skill')?.source).toBe('skill')
    for (const name of CORE_NAMES) expect(getCommand(name), name).toBeDefined()
  })
})
