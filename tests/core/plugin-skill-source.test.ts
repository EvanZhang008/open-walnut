/**
 * A plugin's RUNTIME-registered skill: visible in the load record, labelled 'plugin',
 * and loud when the registered directory is not the root above `<name>/SKILL.md`.
 *
 * What this file pins:
 *  - `registry.skill` at activate is observable WITHOUT changing what hasSkills means:
 *    `Plugin loaded` carries `registeredSkillDirs`, `Plugin loading complete` names the
 *    owner, and /api/integrations/settings reports `registeredSkills: true` while
 *    `hasSkills` stays false (that one is a manifest capability plus a stat of
 *    `<pluginDir>/skills` — a different claim about a different directory).
 *  - A skill under a plugin-contributed root resolves to source 'plugin' instead of
 *    falling through to 'claude' (the user's own CLI store), while ~/.claude/skills and
 *    the shipped dir keep theirs. A plugin skill is not Walnut's to rewrite or delete.
 *  - Misregistration is loud: handing over the skill FOLDER warns "register its parent",
 *    an existing directory with no skill in it warns, a missing one stays silent (a
 *    plugin may create it later), and all three still register and dispose cleanly.
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('plugin-skill-source-test'))

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    provider: { type: 'bedrock' },
    plugins: {},
  })),
  updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
  seedConfigDefaults: vi.fn(async () => {}),
}))

// The loader's own log lines ARE the contract here: nothing else tells an author that a
// runtime registration was seen, so they are captured rather than trusted.
const captured = vi.hoisted(() => ({
  entries: [] as Array<{ subsystem: string; message: string; meta?: Record<string, unknown> }>,
}))
vi.mock('../../src/logging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logging/index.js')>()
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      info: (message: string, meta?: Record<string, unknown>) => {
        captured.entries.push({ subsystem, message, meta })
      },
    }),
  }
})

import {
  WALNUT_HOME,
  TASKS_FILE,
  CLAUDE_SKILLS_DIR,
  BUILTIN_SKILLS_DIR,
} from '../../src/constants.js'
import { registry as globalRegistry, IntegrationRegistry } from '../../src/core/integration-registry.js'
import { loadPlugins, disposeLoadedPlugins } from '../../src/core/integration-loader.js'
import { integrationsRouter } from '../../src/web/routes/integrations.js'
import { clearSkillsCache, getPluginSkillDirs } from '../../src/core/skill-loader.js'
import { deleteSkill, getSkill, listAllSkills, updateSkill } from '../../src/core/skill-store.js'
import {
  listOwnedSkillDirs,
  resetOwnedSkillDirsForTesting,
} from '../../src/core/plugins/skill-registry.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { createTestPluginApi } from './plugin-test-utils.js'

const PLUGIN_ID = 'skill-runtime'

const loadedRegistries: IntegrationRegistry[] = []
const contexts: PluginContext[] = []

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  await fsp.mkdir(path.join(root, name), { recursive: true })
  await fsp.writeFile(
    path.join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody for ${name}.\n`,
    'utf-8',
  )
}

/**
 * A unified plugin whose ONLY skill arrives through `registry.skill` at activate:
 * no `skills/` directory (the root is `agent-skills/`) and no manifest capability, so
 * hasSkills has to stay false while the skill is live.
 */
async function bootSkillPlugin(): Promise<string> {
  const pluginDir = path.join(WALNUT_HOME, 'plugins', PLUGIN_ID)
  const skillRoot = path.join(pluginDir, 'agent-skills')
  await writeSkill(skillRoot, 'runtime-plugin-skill', 'Registered at activate.')
  await fsp.writeFile(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify({
      id: PLUGIN_ID,
      name: 'Skill Runtime',
      apiVersion: 1,
      engines: { walnut: '>=0.0.0' },
      server: 'dist/server.mjs',
    }),
  )
  await fsp.mkdir(path.join(pluginDir, 'dist'), { recursive: true })
  await fsp.writeFile(
    path.join(pluginDir, 'dist', 'server.mjs'),
    `export function activate(walnut) {
  const skill = walnut.registry.skill({ id: 'runtime', directory: ${JSON.stringify(skillRoot)} })
  return { dispose: () => skill.dispose() }
}
`,
  )

  loadedRegistries.push(globalRegistry)
  await loadPlugins(globalRegistry)
  clearSkillsCache()
  return skillRoot
}

function settingsApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/integrations', integrationsRouter)
  return app
}

function pluginApi(pluginId: string) {
  const logger: PluginLogger = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(() => logger),
  }
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
  return { api, context, logger }
}

function warnings(logger: PluginLogger): string[] {
  return (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]))
}

beforeEach(async () => {
  captured.entries.length = 0
  await fsp.mkdir(path.join(WALNUT_HOME, 'plugins'), { recursive: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
})

afterEach(async () => {
  // Plugins DOWN before their files go away: a built-in that owns a resource keeps it
  // until its dispose runs, and the next test would then fail on ENOTEMPTY.
  for (const one of loadedRegistries.splice(0)) await disposeLoadedPlugins(one)
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  resetOwnedSkillDirsForTesting()
  clearSkillsCache()
  globalRegistry.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a skill registered at activate', () => {
  it('is in the load record and the integrations listing without claiming hasSkills', async () => {
    const skillRoot = await bootSkillPlugin()

    const loadedLine = captured.entries.find(
      e => e.message === 'Plugin loaded' && e.meta?.id === PLUGIN_ID,
    )
    expect(loadedLine).toBeDefined()
    expect(loadedLine!.meta).toMatchObject({ hasSkills: false, registeredSkillDirs: 1 })

    const completeLine = [...captured.entries].reverse().find(e => e.message === 'Plugin loading complete')
    expect(completeLine).toBeDefined()
    expect(completeLine!.meta!.registeredSkillDirs as string[]).toContain(PLUGIN_ID)
    // hasSkills keeps its old meaning: a manifest capability + <pluginDir>/skills.
    expect(completeLine!.meta!.skillDirs as string[]).not.toContain(PLUGIN_ID)

    const plugin = globalRegistry.get(PLUGIN_ID)
    expect(plugin).toBeDefined()
    expect(plugin!.hasSkills).toBe(false)
    expect(plugin!.registeredSkills).toBe(true)

    const res = await request(settingsApp()).get('/api/integrations/settings')
    expect(res.status).toBe(200)
    const row = (res.body as Array<Record<string, unknown>>).find(p => p.id === PLUGIN_ID)
    expect(row).toMatchObject({ hasSkills: false, registeredSkills: true })

    // …and the contribution really is live, not just reported.
    expect(getPluginSkillDirs()).toContain(skillRoot)
  })

  it('reports source plugin, while the claude store and the shipped dir keep theirs', async () => {
    await bootSkillPlugin()
    await writeSkill(CLAUDE_SKILLS_DIR, 'claude-store-skill', 'In the CLI store.')
    await writeSkill(BUILTIN_SKILLS_DIR, 'shipped-skill', 'Shipped with walnut.')
    clearSkillsCache()

    const bySource = Object.fromEntries((await listAllSkills()).map(s => [s.dirName, s.source]))
    expect(bySource['runtime-plugin-skill']).toBe('plugin')
    expect(bySource['claude-store-skill']).toBe('claude')
    expect(bySource['shipped-skill']).toBe('walnut')

    expect((await getSkill('runtime-plugin-skill'))?.source).toBe('plugin')

    // The plugin owns that directory: an edit here lasts until its next update, and a
    // delete would rm -rf inside an installed plugin. Both routers map these to 403.
    await expect(updateSkill('runtime-plugin-skill', '# edited')).rejects.toThrow(/Cannot modify plugin skills/)
    await expect(deleteSkill('runtime-plugin-skill')).rejects.toThrow(/Cannot delete plugin skills/)
  })
})

describe('registry.skill directory layout', () => {
  it('says "register its parent" when handed the skill folder itself', async () => {
    const parent = path.join(WALNUT_HOME, 'contrib')
    await writeSkill(parent, 'my-skill', 'A skill folder, not a root.')
    const { api, logger } = pluginApi('layout-self')

    const registration = api.registry.skill({ id: 'wrong', directory: path.join(parent, 'my-skill') })

    await vi.waitFor(() => {
      expect(warnings(logger)).toEqual([
        'Plugin skill directory is the skill folder itself; register its parent',
      ])
    })
    expect((logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]).toMatchObject({
      pluginId: 'layout-self',
      skillId: 'wrong',
      directory: path.join(parent, 'my-skill'),
    })
    // Registration still happened, and disposal is clean.
    expect(listOwnedSkillDirs()).toEqual([path.join(parent, 'my-skill')])
    registration.dispose()
    expect(listOwnedSkillDirs()).toEqual([])
  })

  it('says "holds no <name>/SKILL.md" for an existing directory with no skill in it', async () => {
    const empty = path.join(WALNUT_HOME, 'contrib-empty')
    await fsp.mkdir(path.join(empty, 'notes'), { recursive: true })
    await fsp.writeFile(path.join(empty, 'README.md'), '# not a skill\n')
    const { api, logger } = pluginApi('layout-empty')

    const registration = api.registry.skill({ id: 'empty', directory: empty })

    await vi.waitFor(() => {
      expect(warnings(logger)).toEqual(['Plugin skill directory holds no <name>/SKILL.md'])
    })
    registration.dispose()
    expect(listOwnedSkillDirs()).toEqual([])
  })

  it('stays silent for a missing directory and for the categorized layout', async () => {
    const { api, logger } = pluginApi('layout-quiet')
    const missing = path.join(WALNUT_HOME, 'not-created-yet')

    const registration = api.registry.skill({ id: 'later', directory: missing })

    const categorized = path.join(WALNUT_HOME, 'contrib-categorized')
    await writeSkill(path.join(categorized, 'mail'), 'triage', 'A categorized skill.')
    const second = api.registry.skill({ id: 'categorized', directory: categorized })

    // Both probes are fire-and-forget; give them a real turn before claiming silence.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(warnings(logger)).toEqual([])

    registration.dispose()
    second.dispose()
    expect(listOwnedSkillDirs()).toEqual([])
  })
})
