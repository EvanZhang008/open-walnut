/**
 * The boot seed (seedConfigDefaults) writes the Claude default set: a Claude model
 * list under agent.available_models and `provider: {type: claude-code}`. A config
 * whose main provider is something else keeps only what its user wrote
 * (2026-10-30: a Path D config with main_provider ollama grew 13 Claude ids and a
 * claude-code provider block at first start). A Claude setup is seeded as before.
 * Real file in a temp WALNUT_HOME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js'
import * as cm from '../../src/core/config-manager.js'
import { KNOWN_PROVIDERS } from '../../src/model/providers/defaults.js'

const TIMINGS = { readRetryMs: 30, settleMs: 150, quietMs: 400, deadlineMs: 5_000, lateWriteWatchMs: 700 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  cm._resetWriteLockForTest()
  cm._setConfigTimingsForTest(TIMINGS)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  await cm._configRepairIdleForTest()
  cm._setConfigTimingsForTest(null)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

/** The user writes config.yaml by hand, then starts Walnut. */
async function bootWith(text: string): Promise<string> {
  await fs.writeFile(CONFIG_FILE, text, 'utf-8')
  await sleep(TIMINGS.settleMs * 2)
  await cm.seedConfigDefaults()
  return fs.readFile(CONFIG_FILE, 'utf-8')
}

const PATH_D = [
  'agent:',
  '  main_provider: ollama',
  '  main_model: qwen3-coder:30b',
  'providers:',
  '  ollama:',
  '    api: ollama',
  '    base_url: http://localhost:11434',
  'defaults:',
  '  engine: opencode',
  '',
].join('\n')

describe('seedConfigDefaults and the main provider', () => {
  it('a Path D config (Ollama + OpenCode) is left byte for byte', async () => {
    expect(await bootWith(PATH_D)).toBe(PATH_D)
  })

  it('an OpenAI-compatible local server named by the user is left alone too', async () => {
    const text = 'agent:\n  main_provider: lmstudio\n  main_model: qwen3-coder-30b\nproviders:\n  lmstudio:\n    api: openai-chat\n    base_url: http://localhost:1234/v1\n'
    expect(await bootWith(text)).toBe(text)
  })

  it('a Bedrock setup is seeded as before', async () => {
    const doc = yaml.load(await bootWith('agent:\n  main_provider: bedrock\n')) as Record<string, any>
    expect(doc.agent.available_models.length).toBeGreaterThan(0)
    expect(doc.provider).toEqual({ type: 'claude-code' })
  })

  it('a config that names no provider (the Claude default) is seeded as before', async () => {
    const doc = yaml.load(await bootWith('user:\n  name: A\n')) as Record<string, any>
    expect(doc.agent.available_models.length).toBeGreaterThan(0)
    expect(doc.user.name).toBe('A')
  })

  it('a first run with no config.yaml is seeded as before', async () => {
    await cm.seedConfigDefaults()
    const doc = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>
    expect(doc.agent.available_models.length).toBeGreaterThan(0)
  })

  // Ratchet: every known provider is decided, and only Claude-catalog ones seed.
  it.each(Object.entries(KNOWN_PROVIDERS))('known provider %s', (name, template) => {
    const claude = cm.CLAUDE_CATALOG_PROTOCOLS.has(template.api)
    expect(cm.seedsClaudeDefaults({ agent: { main_provider: name } })).toBe(claude)
    expect(['bedrock', 'anthropic', 'claude_cli'].includes(name)).toBe(claude)
  })
})
