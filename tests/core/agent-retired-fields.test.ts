/**
 * Agent definitions are personas for Claude Code sessions. The fields of the removed
 * in-process agent loop (runner, model, provider, region, max_tokens, max_tool_rounds,
 * allowed_tools, denied_tools, working_directory, skills, stateful) are read by
 * nothing, and so are the retired config keys agent.available_models, agent.region,
 * agent.maxTokens and hosts.*.server.build_env. A config.yaml or a request that
 * still carries any of them must load and save fine (they are ignored, never an
 * error), and a `stateful.memory_project` must no longer write a template
 * MEMORY.md into the memory projects dir. Real config file in a temp WALNUT_HOME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, CONFIG_FILE, PROJECTS_MEMORY_DIR } from '../../src/constants.js'
import { getConfig } from '../../src/core/config-manager.js'
import {
  _resetForTest, createAgent, getAgent, getAllAgents, registerOwnedAgent, removeOwnedAgents, updateAgent,
} from '../../src/core/agent-registry.js'

/** Every retired field, the way an older form or a hand-written config.yaml has them. */
const RETIRED = {
  runner: 'embedded',
  model: 'made-up-model-not-in-any-list',
  provider: 'bedrock',
  region: 'us-west-2',
  max_tokens: 4096,
  max_tool_rounds: 7,
  allowed_tools: ['file_read', 'memory'],
  denied_tools: ['shell_exec'],
  working_directory: '/tmp/somewhere',
  skills: ['walnut'],
  stateful: { memory_project: 'life/tracker', memory_budget_tokens: 2000, memory_source: 'life-tracker' },
}
const RETIRED_KEYS = Object.keys(RETIRED)

type Doc = { agent: { agents: Array<Record<string, unknown>> } }
const readDoc = async () => yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Doc

beforeEach(async () => {
  _resetForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  removeOwnedAgents('plugin-a')
  _resetForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a stored agent definition carrying every retired field', () => {
  beforeEach(async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump({
      version: 1,
      agent: {
        main_model: 'acme-model-large',
        // Retired config keys an older Walnut wrote.
        available_models: ['acme-model-large'],
        region: 'us-east-1',
        maxTokens: 8192,
        agents: [{
          id: 'life-tracker', name: 'Life Tracker', system_prompt: 'You track my life.',
          context_sources: [{ id: 'global_memory', enabled: true }], ...RETIRED,
        }],
      },
      hosts: { devbox: { hostname: 'devbox.example.invalid', server: { enabled: false, build_env: { CC: 'cc' } } } },
    }), 'utf-8')
  })

  it('loads with its live fields only', async () => {
    await expect(getConfig()).resolves.toBeTruthy()
    const agent = await getAgent('life-tracker')
    expect(agent).toEqual({
      id: 'life-tracker', name: 'Life Tracker', system_prompt: 'You track my life.',
      context_sources: [{ id: 'global_memory', enabled: true }], source: 'config',
    })
    for (const k of RETIRED_KEYS) expect(Object.keys(agent!)).not.toContain(k)
    expect((await getAllAgents()).map((a) => a.id)).toContain('life-tracker')
  })

  it('saves an edit, and leaves the retired fields in the file exactly as the user had them', async () => {
    const updated = await updateAgent('life-tracker', { name: 'Life Tracker 2' })
    expect(updated).toEqual({
      id: 'life-tracker', name: 'Life Tracker 2', system_prompt: 'You track my life.',
      context_sources: [{ id: 'global_memory', enabled: true }], source: 'config',
    })
    const stored = (await readDoc()).agent.agents[0]!
    expect(stored).toMatchObject({ name: 'Life Tracker 2', ...RETIRED })
    expect(existsSync(PROJECTS_MEMORY_DIR)).toBe(false)
  })

  it('an edit that still sends retired fields succeeds and stores none of the new values', async () => {
    const updated = await updateAgent('life-tracker', {
      name: 'Renamed', model: 'another-made-up-model', stateful: { memory_project: 'other/place' },
    } as never)
    expect(updated.name).toBe('Renamed')
    const stored = (await readDoc()).agent.agents[0]!
    expect(stored.model).toBe(RETIRED.model)
    expect(stored.stateful).toEqual(RETIRED.stateful)
    expect(existsSync(PROJECTS_MEMORY_DIR)).toBe(false)
  })
})

describe('creating or updating an agent with stateful.memory_project', () => {
  it('a create succeeds, stores only the live fields and makes no memory directory', async () => {
    const agent = await createAgent({ id: 'tracker', name: 'Tracker', description: 'd', ...RETIRED } as never)
    expect(agent).toEqual({ id: 'tracker', name: 'Tracker', description: 'd', source: 'config' })
    expect((await readDoc()).agent.agents).toEqual([{ id: 'tracker', name: 'Tracker', description: 'd' }])
    expect(existsSync(PROJECTS_MEMORY_DIR)).toBe(false)
  })

  it('an update of a config agent makes no memory directory', async () => {
    await createAgent({ id: 'tracker', name: 'Tracker' })
    await updateAgent('tracker', { stateful: { memory_project: 'life/tracker' } } as never)
    expect(existsSync(PROJECTS_MEMORY_DIR)).toBe(false)
  })

  it('an update that overrides a builtin makes no memory directory and stores no retired field', async () => {
    const agent = await updateAgent('mentor', { name: 'My Mentor', ...RETIRED } as never)
    expect(agent).toMatchObject({ id: 'mentor', name: 'My Mentor', overrides_builtin: true })
    const stored = (await readDoc()).agent.agents.find((a) => a.id === 'mentor')!
    for (const k of RETIRED_KEYS) expect(Object.keys(stored)).not.toContain(k)
    expect(existsSync(PROJECTS_MEMORY_DIR)).toBe(false)
  })

  it('a plugin agent registers with the retired fields ignored and makes no memory directory', async () => {
    registerOwnedAgent('plugin-a', { id: 'plugin-a:tracker', name: 'Tracker', ...RETIRED } as never)
    expect(await getAgent('plugin-a:tracker')).toEqual({ id: 'plugin-a:tracker', name: 'Tracker', source: 'plugin' })
    expect(existsSync(PROJECTS_MEMORY_DIR)).toBe(false)
  })
})
