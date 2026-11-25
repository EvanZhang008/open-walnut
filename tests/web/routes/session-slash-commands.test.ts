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
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
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

// One remote host the tests may scan; the daemon reads are fakes the test drives.
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { box: { hostname: 'box.example.test' } } }),
}))
vi.mock('../../../src/core/hosts/link.js', () => ({ link: async () => ({}) }))
// The host-read bound runs the read as it is: the fakes below decide how long it takes.
vi.mock('../../../src/core/hosts/remote-read-bound.js', () => ({
  boundHostRead: (_host: string, read: () => Promise<unknown>) => read(),
  hostReadFailureLevel: () => 'warn',
}))
const listRemoteSkills = vi.fn()
vi.mock('../../../src/core/remote-skill-loader.js', () => ({
  listRemoteSkills: () => listRemoteSkills(),
  listRemoteProjectCommands: async () => [],
  listRemoteProjectSkills: async () => [],
}))

import {
  composeCliPalette, buildSessionSlashCommandItems, resetRemoteSlashCacheForTest, type SlashCommandItem,
} from '../../../src/web/routes/slash-commands.js'
import { PALETTE_HOST_BUDGET_MS } from '../../../src/web/routes/slash-commands-cache.js'
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
    listRemoteSkills.mockReset()
    listRemoteSkills.mockResolvedValue([])
    resetRemoteSlashCacheForTest()
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

  it('a Codex session offers the commands Codex takes, never the folder\'s Claude skills', async () => {
    getSessionByClaudeId.mockResolvedValue({ claudeSessionId: 'cx', cwd: '/tmp', engine: 'codex' })
    const out = await buildSessionSlashCommandItems({ sessionId: 'cx' })
    const names = out.items.map((i) => i.name)
    expect(names).toEqual(expect.arrayContaining(['plan', 'compact', 'review', 'review-branch', 'review-commit', 'status', 'mcp', 'skills']))
    expect(names).not.toContain('deploy')
    expect(out.items.every((i) => i.description.length > 0)).toBe(true)
    expect(findByClaudeId).not.toHaveBeenCalled()
  })

  it('every command the palette offers a Codex session is one the client takes', async () => {
    const { CODEX_COMMANDS, parseSlashCommand } = await import('../../../src/providers/codex-app-server/commands.js')
    for (const { name } of CODEX_COMMANDS) expect(parseSlashCommand(`/${name}`)?.name).toBe(name)
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

  it('marks project skills separately from project commands for the Skills shortcut', async () => {
    const cwd = path.join(WALNUT_HOME, 'project')
    const skillsDir = path.join(cwd, '.claude', 'skills', 'project-helper')
    const commandsDir = path.join(cwd, '.claude', 'commands')
    await fs.mkdir(skillsDir, { recursive: true })
    await fs.mkdir(commandsDir, { recursive: true })
    await fs.writeFile(path.join(skillsDir, 'SKILL.md'), '---\nname: project-helper\ndescription: Help with the project\n---\n')
    await fs.writeFile(path.join(commandsDir, 'review.md'), '---\ndescription: Review changes\n---\n')
    getSessionByClaudeId.mockResolvedValue({ claudeSessionId: 's-project', cwd })
    findByClaudeId.mockReturnValue({ cliSlashCommands: { names: ['project-helper', 'review'], at: Date.now() } })
    const result = await buildSessionSlashCommandItems({ sessionId: 's-project' })
    expect(result.items.find((item) => item.name === 'project-helper')).toMatchObject({ source: 'project', kind: 'skill' })
    expect(result.items.find((item) => item.name === 'review')).toMatchObject({ source: 'project' })
    expect(result.items.find((item) => item.name === 'review')).not.toHaveProperty('kind')
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
    expect(res.stillLoading).toBeUndefined()
    expect(res.items.map((i) => i.name)).toEqual(['deploy', 'review', 'usage'])
    expect(res.items.find((i) => i.name === 'usage')?.description).toBe('Show plan usage limits')
  })
})

/** A promise the test settles by hand: a host read that has not answered yet. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now()
  const value = await work
  return { value, ms: Date.now() - t0 }
}

/**
 * The palette never waits out a host (2026-11-25: after a wake and two deploys,
 * eleven reads in an hour took 7 to 15 s, each a cold scan of the same host
 * for another session folder, several at once on one link, plus a stream tail
 * re-read on every ask for a session mid-turn).
 */
describe('buildSessionSlashCommandItems: a slow host never holds the request', () => {
  beforeAll(async () => {
    // One ask first, alone: it loads every module the route imports on demand.
    // Dynamic imports of a mocked module made in one tick can hand some of them
    // the real module (.claude/skills/walnut-testing/SKILL.md, "a vi.mock module
    // factory may not reach it").
    getSessionByClaudeId.mockResolvedValue({ claudeSessionId: 'warm', cwd: '/work/warm', host: 'box' })
    findByClaudeId.mockReturnValue({ cliSlashCommands: null, seedCliSlashCommands: () => {} })
    recoverFromStream.mockResolvedValue(null)
    listRemoteSkills.mockResolvedValue([])
    await buildSessionSlashCommandItems({ sessionId: 'warm' })
  })
  beforeEach(() => {
    findByClaudeId.mockReset()
    getSessionByClaudeId.mockReset()
    recoverFromStream.mockReset()
    listRemoteSkills.mockReset()
    resetRemoteSlashCacheForTest()
  })

  it('a cold scan that does not answer: the CLI names within the budget, then the late scan serves the next ask at once', async () => {
    const scan = deferred<Array<{ dirName: string; description: string; plugin: string }>>()
    listRemoteSkills.mockReturnValue(scan.promise)
    getSessionByClaudeId.mockResolvedValue({ claudeSessionId: 'r1', cwd: '/work/a', host: 'box' })
    findByClaudeId.mockReturnValue({ cliSlashCommands: { names: ['deploy', 'compact'], at: Date.now() } })

    const first = await timed(buildSessionSlashCommandItems({ sessionId: 'r1' }))
    expect(first.ms).toBeLessThan(PALETTE_HOST_BUDGET_MS + 1_000)
    // Still being read, not unreachable: the palette says so instead of "Host unreachable".
    expect(first.value).toMatchObject({ source: 'cli', degraded: true, stillLoading: true })
    expect(first.value.items.map((i) => i.name)).toEqual(['compact', 'deploy'])

    // The scan lands after its request was answered: it still fills the cache.
    scan.resolve([{ dirName: 'deploy', description: 'Ship it', plugin: '__flat__' }])
    await new Promise((r) => setTimeout(r, 10))
    const second = await timed(buildSessionSlashCommandItems({ sessionId: 'r1' }))
    expect(second.ms).toBeLessThan(200)
    expect(second.value.degraded).toBeUndefined()
    expect(second.value.items.find((i) => i.name === 'deploy')?.description).toBe('Ship it')
    expect(listRemoteSkills).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('sessions in different folders of one host, asking together, share ONE scan of its skills', async () => {
    const scan = deferred<Array<{ dirName: string; description: string; plugin: string }>>()
    listRemoteSkills.mockReturnValue(scan.promise)
    getSessionByClaudeId.mockImplementation(async (id: string) => ({ claudeSessionId: id, cwd: `/work/${id}`, host: 'box' }))
    findByClaudeId.mockReturnValue({ cliSlashCommands: { names: ['deploy'], at: Date.now() } })

    // Each ask is in before the next starts (asks started in one tick can get the
    // real module behind a dynamic import, see beforeAll); all wait on the scan.
    const asks: Array<ReturnType<typeof buildSessionSlashCommandItems>> = []
    for (const id of ['a', 'b', 'c']) {
      asks.push(buildSessionSlashCommandItems({ sessionId: id }))
      await new Promise((r) => setTimeout(r, 30))
    }
    scan.resolve([{ dirName: 'deploy', description: 'Ship it', plugin: '__flat__' }])
    const out = await Promise.all(asks)
    expect(listRemoteSkills).toHaveBeenCalledTimes(1)
    for (const res of out) expect(res.items.find((i) => i.name === 'deploy')?.description).toBe('Ship it')
    // A fourth folder later: the host's skills are cached, nothing asks it again.
    await buildSessionSlashCommandItems({ sessionId: 'd' })
    expect(listRemoteSkills).toHaveBeenCalledTimes(1)
  })

  it('a stream recovery that does not answer: discovery within the budget; the late names seed the live session', async () => {
    listRemoteSkills.mockResolvedValue([{ dirName: 'deploy', description: 'Ship it', plugin: '__flat__' }])
    const recovery = deferred<{ names: string[]; fileSize: number } | null>()
    recoverFromStream.mockReturnValue(recovery.promise)
    const seed = vi.fn()
    getSessionByClaudeId.mockResolvedValue({ claudeSessionId: 'r2', cwd: '/work/a', host: 'box' })
    findByClaudeId.mockReturnValue({ cliSlashCommands: null, seedCliSlashCommands: seed })

    const first = await timed(buildSessionSlashCommandItems({ sessionId: 'r2' }))
    expect(first.ms).toBeLessThan(PALETTE_HOST_BUDGET_MS + 1_000)
    expect(first.value.source).toBe('discovery')
    expect(first.value.items.map((i) => i.name)).toContain('deploy')

    // A second ask while the first recovery still runs joins it.
    const joined = buildSessionSlashCommandItems({ sessionId: 'r2' })
    await new Promise((r) => setTimeout(r, 50))
    recovery.resolve({ names: ['deploy', 'compact'], fileSize: 10 })
    expect((await joined).source).toBe('cli')
    expect(recoverFromStream).toHaveBeenCalledTimes(1)
    expect(seed).toHaveBeenCalledWith(['deploy', 'compact'], expect.any(Number))
  }, 10_000)
})

