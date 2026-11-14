/**
 * A Claude Code session of a task in a project with `claude_plugins_off` spawns with
 * `--settings {"enabledPlugins":{"<id>":false}}`, plus `skillListingMaxDescChars` when config
 * `session.skill_listing_desc_chars` is set (src/providers/claude-scope-settings.ts); an Inbox
 * task, or a project without the key, spawns with neither. Drives the REAL send() against a
 * mock daemon, with the real task store and config under a temp WALNUT_HOME.
 *
 * ZERO real side effects: the CLI is a MockDaemon-spawned mock-claude.mjs, and all stores
 * are redirected into a temp dir by createMockConstants.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getProjectMetadata, setProjectMetadata, updateTask } from '../../src/core/task-manager.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { ProjectSettingsError } from '../../src/core/sessions/project-launch-defaults.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')
let daemon: MockDaemon

async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
}

/** Spawn one local session (fresh, or a resume of `resumeId`) through the mock daemon and return its argv. */
async function spawnArgs(taskId: string, project: string, resumeId?: string): Promise<string[]> {
  const session = new ClaudeCodeSession(taskId, project, MOCK_CLI)
  ;(session as unknown as { _testDaemonUrl?: string })._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`
  session.send('hello', WALNUT_HOME, resumeId, 'bypass')
  await session.awaitSpawn().catch(() => {})
  const sid = session.sessionId!
  await waitUntil(() => daemon.getCommandHistoryFor('start').some((e) => e.payload.sid === sid))
  const args = daemon.getCommandHistoryFor('start').find((e) => e.payload.sid === sid)!.payload.args as string[]
  await session.gracefulStop(true).catch(() => {})
  return args
}

function settingsOf(args: string[]): Record<string, unknown> {
  expect(args.filter((a) => a === '--settings')).toHaveLength(1)
  return JSON.parse(args[args.indexOf('--settings') + 1]) as Record<string, unknown>
}

beforeAll(async () => {
  daemon = await createMockDaemon()
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})
afterAll(async () => {
  await daemon.stop()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})
beforeEach(async () => {
  daemon.clearCommandHistory()
  // A section write merges (core/config-section-write.ts): clear the key itself.
  await updateConfig({ session: { skill_listing_desc_chars: undefined } })
})

describe('claude_plugins_off in project settings', () => {
  it('is stored, returned, cleared by [] and by a clear, and refused when malformed', async () => {
    const merged = await setProjectMetadata('Scope Store', { claude_plugins_off: ['work-tools@acme', ' work-tools@acme', 'b@m'] })
    expect(merged.claude_plugins_off).toEqual(['work-tools@acme', 'b@m'])
    expect((await getProjectMetadata('scope store'))?.claude_plugins_off).toEqual(['work-tools@acme', 'b@m'])
    await expect(setProjectMetadata('Scope Store', { claude_plugins_off: ['not-an-id'] })).rejects.toThrow(ProjectSettingsError)
    await expect(setProjectMetadata('Scope Store', { claude_plugins_off: 'work-tools@acme' })).rejects.toThrow(ProjectSettingsError)
    // A refused write leaves the row as it was, and a write that does not name the key keeps it.
    await setProjectMetadata('Scope Store', { default_cwd: '/w' })
    expect((await getProjectMetadata('Scope Store'))?.claude_plugins_off).toEqual(['work-tools@acme', 'b@m'])
    await setProjectMetadata('Scope Store', { claude_plugins_off: [] })
    expect(await getProjectMetadata('Scope Store')).toEqual({ default_cwd: '/w' })
    await setProjectMetadata('Scope Store', { claude_plugins_off: ['b@m'] })
    // The routes turn JSON null into undefined: a clear.
    await setProjectMetadata('Scope Store', { claude_plugins_off: undefined })
    expect(await getProjectMetadata('Scope Store')).toEqual({ default_cwd: '/w' })
  })
})

describe('Claude Code spawn: plugins off and the skill listing cap', () => {
  it('a task in a project with claude_plugins_off spawns with each plugin off, plus the cap config sets', async () => {
    // One task per spawn: a task holds one active session at a time.
    const taskIn = async (project: string) => (await addTask({ title: 'scoped work', project })).task.id
    await setProjectMetadata('Scope Lab', { claude_plugins_off: ['work-tools@acme', 'notes@example-market'] })

    const plain = settingsOf(await spawnArgs(await taskIn('Scope Lab'), 'Scope Lab'))
    expect(plain.enabledPlugins).toEqual({ 'work-tools@acme': false, 'notes@example-market': false })
    expect(plain).not.toHaveProperty('skillListingMaxDescChars')
    // The rest of the settings arg is untouched: the hooks still ride it.
    expect(plain.hooks).toBeTruthy()
    expect((plain.permissions as { allow?: unknown[] } | undefined)?.allow?.length).toBeGreaterThan(0)

    await updateConfig({ session: { skill_listing_desc_chars: 200 } })
    const capped = settingsOf(await spawnArgs(await taskIn('Scope Lab'), 'Scope Lab'))
    expect(capped.enabledPlugins).toEqual({ 'work-tools@acme': false, 'notes@example-market': false })
    expect(capped.skillListingMaxDescChars).toBe(200)

    // A resume carries the same keys as a fresh spawn.
    const resumed = await spawnArgs(await taskIn('Scope Lab'), 'Scope Lab', '11111111-2222-4333-8444-555555555555')
    expect(resumed).toContain('--resume')
    expect(settingsOf(resumed).enabledPlugins).toEqual({ 'work-tools@acme': false, 'notes@example-market': false })
    expect(settingsOf(resumed).skillListingMaxDescChars).toBe(200)
  })

  it('follows the task to the project it is in now', async () => {
    const { task } = await addTask({ title: 'moved work', project: 'Scope Old' })
    await setProjectMetadata('Scope New', { claude_plugins_off: ['work-tools@acme'] })
    await updateTask(task.id, { project: 'Scope New' })
    // The session was made under the old project name; the task's project now decides.
    expect(settingsOf(await spawnArgs(task.id, 'Scope Old')).enabledPlugins).toEqual({ 'work-tools@acme': false })
  })

  it('an Inbox task, or a project without the key, spawns with neither', async () => {
    const { task: inbox } = await addTask({ title: 'loose thought', project: '' })
    const { task: plain } = await addTask({ title: 'plain work', project: 'Scope Plain' })
    await setProjectMetadata('Scope Plain', { default_cwd: '/w' })
    for (const t of [inbox, plain]) {
      const settings = settingsOf(await spawnArgs(t.id, t.project ?? ''))
      expect(settings).not.toHaveProperty('enabledPlugins')
      expect(settings).not.toHaveProperty('skillListingMaxDescChars')
    }
    // The cap alone reaches an Inbox task too: it is a config choice, not a project one.
    await updateConfig({ session: { skill_listing_desc_chars: 300 } })
    const { task: inbox2 } = await addTask({ title: 'another loose thought', project: '' })
    const capped = settingsOf(await spawnArgs(inbox2.id, ''))
    expect(capped).not.toHaveProperty('enabledPlugins')
    expect(capped.skillListingMaxDescChars).toBe(300)
  })
})
