/**
 * Owner-scoped plugin CONTRIBUTIONS of slash commands and skill directories.
 *
 * What this file pins:
 *  - A plugin command is host-named `<pluginId>:<localId>`; a slash in the local id is
 *    refused (the name has to survive as one URL path segment), and a duplicate id from
 *    the same owner is refused instead of silently replacing the first.
 *  - Priority in command-store is strictly user > plugin > builtin, and a namespaced
 *    lookup bypasses the user/builtin slug pattern (which has no `:`) instead of being
 *    rejected as an invalid name.
 *  - Plugin commands are read-only: update/delete raise the same Cannot modify /
 *    Cannot delete contract builtins use, and the REST route maps both to 403 with the
 *    shape unchanged apart from the new `source: 'plugin'`.
 *  - A registered skill directory joins discovery last, deduped by normalized path,
 *    and both edges of the registration clear the skills cache.
 *  - With ZERO registrations the skills prompt is byte-identical to what it was before
 *    the feature existed — the prompt sits in the cached prefix, so "no plugin skills"
 *    has to mean "not one byte different".
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('plugin-command-skill-test'))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ plugins: {} })),
  updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
}))

import { WALNUT_HOME, COMMANDS_DIR, BUILTIN_COMMANDS_DIR } from '../../src/constants.js'
import {
  getOwnedCommand,
  isPluginCommandName,
  listOwnedCommands,
  registerOwnedCommand,
  removeOwnedCommands,
  resetOwnedCommandsForTesting,
} from '../../src/core/plugins/command-registry.js'
import {
  listOwnedSkillDirs,
  registerOwnedSkillDir,
  removeOwnedSkillDirs,
  resetOwnedSkillDirsForTesting,
} from '../../src/core/plugins/skill-registry.js'
import {
  createCommand,
  deleteCommand,
  getCommand,
  listCommands,
  updateCommand,
} from '../../src/core/command-store.js'
import {
  buildSkillsPrompt,
  clearSkillsCache,
  getPluginSkillDirs,
  getPromptSearchDirs,
  listAvailableSkills,
} from '../../src/core/skill-loader.js'
import { createCommandsRouter } from '../../src/web/routes/commands.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { createTestPluginApi } from './plugin-test-utils.js'

const logger: PluginLogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  child: vi.fn(() => logger),
}

const contexts: PluginContext[] = []

function pluginApi(pluginId: string) {
  const context = new PluginContext({
    id: pluginId,
    dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId),
    logger,
  })
  contexts.push(context)
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginId })
  const api = createServerPluginApi({
    context,
    pluginName: pluginId,
    legacyApi,
    contributions: collected,
    integrationRegistry: new IntegrationRegistry(),
  })
  return { api, context }
}

async function writeCommandFile(dir: string, name: string, description: string, body: string) {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${name}.md`), `---\ndescription: ${description}\n---\n${body}\n`, 'utf-8')
}

async function writeSkill(dir: string, name: string, description: string) {
  await fsp.mkdir(path.join(dir, name), { recursive: true })
  await fsp.writeFile(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody for ${name}.\n`,
    'utf-8',
  )
}

function commandsApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/commands', createCommandsRouter())
  return app
}

beforeEach(async () => {
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  resetOwnedCommandsForTesting()
  resetOwnedSkillDirsForTesting()
  clearSkillsCache()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('plugin command registry', () => {
  it('namespaces every command under its owning plugin', () => {
    registerOwnedCommand('demo', { id: 'ship', description: 'Ship it', content: 'Do the release.' })

    expect(listOwnedCommands()).toEqual([
      { name: 'demo:ship', description: 'Ship it', content: 'Do the release.', source: 'plugin' },
    ])
    expect(getOwnedCommand('demo:ship')?.content).toBe('Do the release.')
    expect(getOwnedCommand('ship')).toBeNull()
    expect(isPluginCommandName('demo:ship')).toBe(true)
    expect(isPluginCommandName('ship')).toBe(false)
  })

  it('refuses a bad id, a slash in the id, empty content, and a duplicate', () => {
    expect(() => registerOwnedCommand('demo', { id: 'Ship It', description: 'x', content: 'y' }))
      .toThrow(/Invalid plugin command id/)
    // A slash would survive registration but not the `/api/commands/:name` route.
    expect(() => registerOwnedCommand('demo', { id: 'nested/ship', description: 'x', content: 'y' }))
      .toThrow(/Invalid plugin command id/)
    expect(() => registerOwnedCommand('demo', { id: 'ship', description: 'x', content: '  ' }))
      .toThrow(/non-empty content/)

    registerOwnedCommand('demo', { id: 'ship', description: 'x', content: 'y' })
    expect(() => registerOwnedCommand('demo', { id: 'ship', description: 'x', content: 'z' }))
      .toThrow(/already registered/)
    expect(listOwnedCommands()).toHaveLength(1)
  })

  it('disposes per registration and per owner', () => {
    const registration = registerOwnedCommand('demo', { id: 'one', description: 'a', content: 'a' })
    registerOwnedCommand('demo', { id: 'two', description: 'b', content: 'b' })
    registerOwnedCommand('other', { id: 'one', description: 'c', content: 'c' })

    registration.dispose()
    expect(listOwnedCommands().map((cmd) => cmd.name)).toEqual(['demo:two', 'other:one'])

    expect(removeOwnedCommands('demo')).toBe(1)
    expect(listOwnedCommands().map((cmd) => cmd.name)).toEqual(['other:one'])
  })
})

describe('command-store with plugin commands', () => {
  it('keeps user precedence and reserves the plugin namespace', async () => {
    await writeCommandFile(COMMANDS_DIR, 'shared', 'user copy', 'user body')
    await writeCommandFile(BUILTIN_COMMANDS_DIR, 'shared', 'builtin copy', 'builtin body')
    await writeCommandFile(BUILTIN_COMMANDS_DIR, 'builtin-only', 'builtin only', 'builtin body')
    await writeCommandFile(COMMANDS_DIR, 'demo:claimed', 'ignored file', 'user body')
    registerOwnedCommand('demo', { id: 'claimed', description: 'plugin owns namespace', content: 'plugin body' })
    registerOwnedCommand('demo', { id: 'ship', description: 'plugin only', content: 'plugin body' })

    const commands = await listCommands()
    const bySource = Object.fromEntries(commands.map((cmd) => [cmd.name, cmd.source]))

    expect(bySource).toEqual({
      'builtin-only': 'builtin',
      'demo:claimed': 'plugin',
      'demo:ship': 'plugin',
      shared: 'user',
    })
    expect(commands.map((cmd) => cmd.name)).toEqual([...commands.map((cmd) => cmd.name)].sort())
  })

  it('resolves a namespaced name that the slug pattern would reject', async () => {
    registerOwnedCommand('demo', { id: 'ship', description: 'Ship it', content: 'Do the release.' })

    await expect(getCommand('demo:ship')).resolves.toEqual({
      name: 'demo:ship', description: 'Ship it', content: 'Do the release.', source: 'plugin',
    })
    await expect(getCommand('demo:missing')).resolves.toBeNull()
    // Ordinary names keep the old path exactly: user dir, then builtin, no plugin lookup.
    await expect(getCommand('ship')).resolves.toBeNull()
  })

  it('keeps plugin commands read-only and still refuses a namespaced create', async () => {
    registerOwnedCommand('demo', { id: 'ship', description: 'Ship it', content: 'Do the release.' })

    await expect(updateCommand('demo:ship', { content: 'nope' })).rejects.toThrow(/Cannot modify/)
    await expect(deleteCommand('demo:ship')).rejects.toThrow(/Cannot delete/)
    await expect(updateCommand('demo:absent', { content: 'nope' })).rejects.toThrow(/not found/)
    await expect(deleteCommand('demo:absent')).rejects.toThrow(/not found/)
    await expect(createCommand('demo:ship', 'body')).rejects.toThrow(/Invalid command name/)
  })
})

describe('commands REST route', () => {
  it('lists plugin commands, serves one, and answers 403 on a write', async () => {
    await writeCommandFile(COMMANDS_DIR, 'user-cmd', 'a user command', 'user body')
    registerOwnedCommand('demo', { id: 'ship', description: 'Ship it', content: 'Do the release.' })
    const app = commandsApp()

    const list = await request(app).get('/api/commands').expect(200)
    expect(list.body.commands).toEqual([
      { name: 'demo:ship', description: 'Ship it', content: 'Do the release.', source: 'plugin' },
      { name: 'user-cmd', description: 'a user command', content: 'user body', source: 'user' },
    ])

    const one = await request(app).get('/api/commands/demo:ship').expect(200)
    expect(one.body.command).toMatchObject({ name: 'demo:ship', source: 'plugin' })

    await request(app).put('/api/commands/demo:ship').send({ content: 'nope' }).expect(403)
    await request(app).delete('/api/commands/demo:ship').expect(403)
    await request(app).get('/api/commands/demo:absent').expect(404)

    // Untouched by the write attempts.
    expect(getOwnedCommand('demo:ship')?.content).toBe('Do the release.')
  })
})

describe('plugin skill directories', () => {
  it('appends registered dirs last and dedupes normalized paths', async () => {
    const real = path.join(WALNUT_HOME, 'contrib-skills')
    await writeSkill(real, 'plugin-demo-skill', 'A skill a plugin brought along.')
    registerOwnedSkillDir('demo', { id: 'bundle', directory: real })
    registerOwnedSkillDir('other', { id: 'bundle', directory: `${real}${path.sep}.` })

    expect(listOwnedSkillDirs()).toHaveLength(2)
    expect(getPluginSkillDirs()).toEqual([real])
    // Registered roots come last, after every first-party source.
    expect(getPromptSearchDirs().at(-1)).toBe(real)
  })

  it('refuses a relative directory', () => {
    expect(() => registerOwnedSkillDir('demo', { id: 'bundle', directory: 'relative/skills' }))
      .toThrow(/absolute path/)
    expect(() => registerOwnedSkillDir('demo', { id: 'bundle', directory: '' }))
      .toThrow(/requires a directory path/)
  })

  it('leaves the skills prompt byte-identical when nothing is registered', async () => {
    const before = await buildSkillsPrompt()
    expect(getPluginSkillDirs()).toEqual([])

    const dir = path.join(WALNUT_HOME, 'contrib-skills')
    await writeSkill(dir, 'plugin-demo-skill', 'A skill a plugin brought along.')
    const registration = registerOwnedSkillDir('demo', { id: 'bundle', directory: dir })
    clearSkillsCache()

    const withPlugin = await buildSkillsPrompt()
    expect(withPlugin).toContain('plugin-demo-skill')
    expect(withPlugin).not.toBe(before)

    registration.dispose()
    removeOwnedSkillDirs('demo')
    clearSkillsCache()

    expect(await buildSkillsPrompt()).toBe(before)
  })

  it('clears the skills cache on both edges of a registry.skill() registration', async () => {
    const dir = path.join(WALNUT_HOME, 'contrib-skills')
    await writeSkill(dir, 'plugin-demo-skill', 'A skill a plugin brought along.')
    const names = async () => (await listAvailableSkills()).map((skill) => skill.dirName)

    // Warm the cache first: without an invalidation the new skill would stay invisible.
    expect(await names()).not.toContain('plugin-demo-skill')

    const { api, context } = pluginApi('demo')
    const registration = api.registry.skill({ id: 'bundle', directory: dir })
    expect(await names()).toContain('plugin-demo-skill')

    registration.dispose()
    expect(await names()).not.toContain('plugin-demo-skill')

    // …and the owner's registration goes away with the plugin, not just by hand.
    api.registry.skill({ id: 'bundle-again', directory: dir })
    expect(await names()).toContain('plugin-demo-skill')
    await context.dispose()
    expect(listOwnedSkillDirs()).toEqual([])
    expect(await names()).not.toContain('plugin-demo-skill')
  })
})

describe('registry.command through the plugin API', () => {
  it('registers, serves, and disposes with its owner', async () => {
    const { api, context } = pluginApi('demo')
    api.registry.command({ id: 'ship', description: 'Ship it', content: 'Do the release.' })

    await expect(getCommand('demo:ship')).resolves.toMatchObject({ source: 'plugin' })

    await context.dispose()

    expect(listOwnedCommands()).toEqual([])
    await expect(getCommand('demo:ship')).resolves.toBeNull()
  })
})
