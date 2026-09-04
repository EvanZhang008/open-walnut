/**
 * The composer palette for a LIVE session lists what the CLI advertised in its
 * `system/init` line — Walnut's directory scan only decorates those names.
 *
 * Incident this pins (2026-09-04): right after a deploy the remote daemon was
 * mid-upgrade, the SSH discovery hit its 15s timeout, and the palette silently
 * shrank to "Walnut + 4 built-ins" until the user found the Refresh button.
 * With the CLI list as the source of truth, an unreachable host can only cost
 * descriptions (flagged `degraded`), never the list itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-session-slash'))

const findByClaudeId = vi.fn()
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { findByClaudeId: (id: string) => findByClaudeId(id) },
}))

const getSessionByClaudeId = vi.fn()
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: (id: string) => getSessionByClaudeId(id),
}))

const recoverFromStream = vi.fn()
vi.mock('../../../src/core/sessions/cli-slash-commands-recover.js', () => ({
  recoverCliSlashCommandsFromStream: (id: string, host: string | null | undefined) => recoverFromStream(id, host),
}))

import {
  composeCliPalette, buildSessionSlashCommandItems, type SlashCommandItem,
} from '../../../src/web/routes/slash-commands.js'
import { SessionControlError } from '../../../src/core/sessions/session-controls.js'
import { WALNUT_HOME, GLOBAL_SKILLS_DIR } from '../../../src/constants.js'

const scanned: SlashCommandItem[] = [
  { name: 'deploy', description: 'Ship it', source: 'skill' },
  { name: 'review', description: 'Review the diff', source: 'project' },
  { name: 'walnut-only', description: 'Not known to the CLI', source: 'skill' },
  { name: 'compact', description: 'scan wording', source: 'built-in' },
]

describe('composeCliPalette', () => {
  it('the CLI list decides membership; the scan only decorates', () => {
    const items = composeCliPalette(['review', 'deploy', 'compact', 'plugin-skill', '__remote-workflow', 'usage'], scanned)
    const names = items.map((i) => i.name)
    // Sorted, the internal `__` name hidden, the scan-only extra NOT offered.
    expect(names).toEqual(['compact', 'deploy', 'plugin-skill', 'review', 'usage'])
    expect(names).not.toContain('walnut-only')
    // Decorated from the scan when known...
    expect(items.find((i) => i.name === 'deploy')).toEqual({ name: 'deploy', description: 'Ship it', source: 'skill' })
    expect(items.find((i) => i.name === 'review')?.source).toBe('project')
    // ...the scan wins over the built-in table when it has an entry...
    expect(items.find((i) => i.name === 'compact')?.description).toBe('scan wording')
    // ...a built-in the scan does not know gets the CLI's own wording...
    expect(items.find((i) => i.name === 'usage')).toEqual({ name: 'usage', description: 'Show plan usage limits', source: 'built-in' })
    // ...and an unknown name is still listed, bare, as a skill.
    expect(items.find((i) => i.name === 'plugin-skill')).toEqual({ name: 'plugin-skill', description: '', source: 'skill' })
  })

  it('plugin skills match under the CLI\'s <plugin>:<skill> name, label folded into the name', () => {
    const withPlugins: SlashCommandItem[] = [
      { name: 'oncall', description: '[acme-tools] Run the oncall runbook', source: 'skill', plugin: 'acme-tools' },
      { name: 'oncall', description: '[other-tools] A different oncall', source: 'skill', plugin: 'other-tools' },
      { name: 'bare-label', description: '[acme-tools]', source: 'skill', plugin: 'acme-tools' },
    ]
    const items = composeCliPalette(['acme-tools:oncall', 'other-tools:oncall', 'acme-tools:bare-label', 'oncall'], withPlugins)
    expect(items.map((i) => i.name)).toEqual(['acme-tools:bare-label', 'acme-tools:oncall', 'oncall', 'other-tools:oncall'])
    expect(items.find((i) => i.name === 'acme-tools:oncall')?.description).toBe('Run the oncall runbook')
    expect(items.find((i) => i.name === 'other-tools:oncall')?.description).toBe('A different oncall')
    expect(items.find((i) => i.name === 'acme-tools:bare-label')?.description).toBe('')
    // A bare CLI name still finds the first bare scan entry (label kept: the name alone says nothing).
    expect(items.find((i) => i.name === 'oncall')?.description).toBe('[acme-tools] Run the oncall runbook')
  })

  it('a missing scan (host unreachable) keeps every CLI name', () => {
    const items = composeCliPalette(['deploy', 'compact'], null)
    expect(items.map((i) => i.name)).toEqual(['compact', 'deploy'])
    expect(items.find((i) => i.name === 'deploy')?.description).toBe('')
  })
})

describe('buildSessionSlashCommandItems', () => {
  beforeEach(async () => {
    findByClaudeId.mockReset()
    getSessionByClaudeId.mockReset()
    recoverFromStream.mockReset()
    recoverFromStream.mockResolvedValue(null)
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(GLOBAL_SKILLS_DIR, { recursive: true })
    // A Walnut-only skill the CLI would never list, plus one it does.
    for (const name of ['walnut-only', 'deploy']) {
      await fs.mkdir(path.join(GLOBAL_SKILLS_DIR, name), { recursive: true })
      await fs.writeFile(path.join(GLOBAL_SKILLS_DIR, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} desc\n---\nbody\n`)
    }
  })
  afterEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  it('404 for an unknown session', async () => {
    getSessionByClaudeId.mockResolvedValue(null)
    await expect(buildSessionSlashCommandItems({ sessionId: 'nope' })).rejects.toBeInstanceOf(SessionControlError)
  })

  it('falls back to discovery (flagged) when no init was seen and the stream has none', async () => {
    getSessionByClaudeId.mockResolvedValue({ claudeSessionId: 's1', cwd: WALNUT_HOME })
    findByClaudeId.mockReturnValue(undefined)
    const res = await buildSessionSlashCommandItems({ sessionId: 's1' })
    expect(recoverFromStream).toHaveBeenCalledWith('s1', undefined)
    expect(res.source).toBe('discovery')
    expect(res.items.map((i) => i.name)).toEqual(expect.arrayContaining(['walnut-only', 'deploy', 'compact']))
  })

  it('post-restart: recovers the CLI list from the stream tail and seeds the live instance', async () => {
    getSessionByClaudeId.mockResolvedValue({ claudeSessionId: 's4', cwd: WALNUT_HOME, host: 'box' })
    const seed = vi.fn()
    findByClaudeId.mockReturnValue({ cliSlashCommands: null, seedCliSlashCommands: seed })
    recoverFromStream.mockResolvedValue({ names: ['deploy', 'compact'], fileSize: 4096 })
    const res = await buildSessionSlashCommandItems({ sessionId: 's4' })
    expect(recoverFromStream).toHaveBeenCalledWith('s4', 'box')
    expect(seed).toHaveBeenCalledWith(['deploy', 'compact'], expect.any(Number))
    expect(res.source).toBe('cli')
    expect(res.items.map((i) => i.name)).toEqual(['compact', 'deploy'])
  })

  it('a live capture wins: the stream is not read', async () => {
    getSessionByClaudeId.mockResolvedValue({ claudeSessionId: 's5', cwd: WALNUT_HOME })
    findByClaudeId.mockReturnValue({ cliSlashCommands: { names: ['clear'], at: Date.now() } })
    await buildSessionSlashCommandItems({ sessionId: 's5' })
    expect(recoverFromStream).not.toHaveBeenCalled()
  })

  it('serves the CLI list, decorated, for a local session', async () => {
    getSessionByClaudeId.mockResolvedValue({ claudeSessionId: 's2', cwd: WALNUT_HOME })
    findByClaudeId.mockReturnValue({ cliSlashCommands: { names: ['deploy', 'clear', 'compact'], at: Date.now() } })
    const res = await buildSessionSlashCommandItems({ sessionId: 's2' })
    expect(res.source).toBe('cli')
    expect(res.degraded).toBeUndefined()
    expect(res.items.map((i) => i.name)).toEqual(['clear', 'compact', 'deploy'])
    expect(res.items.find((i) => i.name === 'deploy')?.description).toBe('deploy desc')
    // `clear` is a CLI built-in the old hardcoded list never offered.
    expect(res.items.find((i) => i.name === 'clear')?.source).toBe('built-in')
  })

  it('an unreachable remote host costs descriptions, never the list', async () => {
    // No such host in config → remote discovery throws before any SSH.
    getSessionByClaudeId.mockResolvedValue({ claudeSessionId: 's3', cwd: '/remote/repo', host: 'ghost-box' })
    findByClaudeId.mockReturnValue({ cliSlashCommands: { names: ['deploy', 'review', 'usage'], at: Date.now() } })
    const res = await buildSessionSlashCommandItems({ sessionId: 's3' })
    expect(res.source).toBe('cli')
    expect(res.degraded).toBe(true)
    expect(res.items.map((i) => i.name)).toEqual(['deploy', 'review', 'usage'])
    expect(res.items.find((i) => i.name === 'usage')?.description).toBe('Show plan usage limits')
  })
})
