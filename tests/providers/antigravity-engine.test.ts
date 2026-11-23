/**
 * The Antigravity engine (`agy acp`) against its real ACP answers (fixture recorded from agy
 * 1.5.14): its effort-qualified catalog reads as one row per model with efforts, its adapter
 * env keeps a host's own SSH_CONNECTION, it signs in by the method its env selects, and a
 * missing CLI names the official installer.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineCaps } from '../../src/core/agents/engine-registry.js'
import { _resetEngineProbeCache, probeEngine } from '../../src/core/agents/engine-probe.js'
import { withInstallHint } from '../../src/core/agents/host-engines.js'
import {
  ACP_ENV_DEFAULTS_KEY,
  bracketHyphenEffort,
  mergeAcpSpawnEnv,
  snapshotAcpConfigOptions,
  snapshotAcpModels,
} from '../../src/providers/acp-worker/protocol.js'
import { ACP_AUTH_ENV, descriptorAdapterEnv, pickAcpAuthMethod } from '../../src/providers/acp-worker/adapter-env.js'
import { splitAcpModelId } from '../../src/providers/acp-session.js'
import { effortControlOf, effortValueFor } from '../../src/providers/acp-effort.js'

const ANSWERS = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/antigravity/acp-answers.json'), 'utf-8')) as {
  initialize: unknown
  sessionNew: Record<string, unknown>
  setModelFlash: { configOptions: unknown[] }
}

describe('the Antigravity catalog', () => {
  const catalog = snapshotAcpModels(ANSWERS.sessionNew)

  it('reads every hyphen-qualified id as base[effort], with agy\'s own names', () => {
    expect(catalog.availableModels).toHaveLength(25)
    expect(catalog.availableModels[0]).toEqual({ modelId: 'gemini-4-neon[high]', name: 'Gemini 4 Neon (High)' })
    expect(catalog.availableModels.map((m) => m.modelId)).toContain('gemini-4-neon[xhigh]')
    expect(catalog.availableModels.map((m) => m.modelId)).toContain('gemini-3.8-flash[medium]')
    // Every id splits back into a base the model select takes and an effort.
    const bases = new Set((ANSWERS.sessionNew.configOptions as Array<{ id: string; options: Array<{ value: string }> }>)
      .find((o) => o.id === 'model')!.options.map((o) => o.value))
    for (const { modelId } of catalog.availableModels) {
      const { base, effort } = splitAcpModelId(modelId)
      expect(bases.has(base), modelId).toBe(true)
      expect(effort, modelId).toMatch(/^(low|medium|high|xhigh)$/)
    }
    expect(new Set(catalog.availableModels.map((m) => splitAcpModelId(m.modelId).base)).size).toBe(8)
  })

  it('names the current model from the selects: Gemini 3.1 Pro at low', () => {
    expect(catalog.currentModelId).toBe('gemini-3.1-pro[low]')
  })

  it('follows a model switch: the select\'s new model with its thought level', () => {
    const after = snapshotAcpModels({ ...ANSWERS.sessionNew, configOptions: ANSWERS.setModelFlash.configOptions })
    expect(after.currentModelId).toBe('gemini-3.8-flash[low]')
    expect(after.availableModels).toHaveLength(25)
  })

  it('a pick of Gemini 4 Neon at High sets model=gemini-4-neon and thought_level=high', () => {
    const { base, effort } = splitAcpModelId('gemini-4-neon[high]')
    expect(base).toBe('gemini-4-neon')
    const controls = snapshotAcpConfigOptions({ configOptions: ANSWERS.setModelFlash.configOptions })
    const control = effortControlOf(controls)
    expect(control?.id).toBe('thought_level')
    expect(effortValueFor(effort!, control!)).toBe('high')
    // "max" on a model whose levels stop at high is its highest.
    expect(effortValueFor('max', control!)).toBe('high')
  })
})

describe('bracketHyphenEffort', () => {
  const choices = [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { value: 'model-high', name: 'A model named high' }]

  it('brackets only a listed base with an effort word', () => {
    expect(bracketHyphenEffort('gemini-4-neon-xhigh', choices)).toBe('gemini-4-neon[xhigh]')
    expect(bracketHyphenEffort('gemini-4-neon-turbo', choices)).toBe('gemini-4-neon-turbo')
    expect(bracketHyphenEffort('gemini-5-neon-high', choices)).toBe('gemini-5-neon-high')
    expect(bracketHyphenEffort('gemini-4-neon', choices)).toBe('gemini-4-neon')
  })

  it('keeps a model whose own listed name ends in an effort word', () => {
    expect(bracketHyphenEffort('model-high', choices)).toBe('model-high')
  })

  it('leaves other engines\' catalogs alone: no thought_level select, no rewrite', () => {
    const response = {
      models: { availableModels: [{ modelId: 'm-high', name: 'M' }] },
      configOptions: [{ id: 'model', type: 'select', category: 'model', currentValue: 'm', options: [{ value: 'm', name: 'M' }] }],
    }
    expect(snapshotAcpModels(response).availableModels[0].modelId).toBe('m-high')
  })
})

describe('the Antigravity adapter env', () => {
  const adapter = engineCaps('antigravity').acpAdapter!
  const env = descriptorAdapterEnv(adapter)!

  it('forces file storage, carries SSH_CONNECTION as a default and the sign-in plan', () => {
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1')
    expect(env.SSH_CONNECTION).toBeUndefined()
    expect(JSON.parse(env[ACP_ENV_DEFAULTS_KEY])).toEqual({ SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0' })
    expect(JSON.parse(env[ACP_AUTH_ENV]).otherwise).toBe('oauth-personal')
  })

  it('keeps a host\'s real SSH_CONNECTION and sets the default only where there is none', () => {
    const real = '10.0.0.5 51234 10.0.0.9 22'
    expect(mergeAcpSpawnEnv({ SSH_CONNECTION: real }, env).SSH_CONNECTION).toBe(real)
    expect(mergeAcpSpawnEnv({}, env).SSH_CONNECTION).toBe('127.0.0.1 0 127.0.0.1 0')
    expect(mergeAcpSpawnEnv({ SSH_CONNECTION: '' }, env).SSH_CONNECTION).toBe('127.0.0.1 0 127.0.0.1 0')
  })

  it('the operator overlay still wins: a value replaces it, \'\' unsets it', () => {
    expect(mergeAcpSpawnEnv({}, { ...env, SSH_CONNECTION: 'x' }).SSH_CONNECTION).toBe('x')
    expect(mergeAcpSpawnEnv({ SSH_CONNECTION: 'real' }, { ...env, SSH_CONNECTION: '' }).SSH_CONNECTION).toBeUndefined()
  })

  it('the worker\'s second merge over the daemon\'s merged env changes nothing', () => {
    const daemonSide = mergeAcpSpawnEnv({ SSH_CONNECTION: 'real' }, env)
    expect(mergeAcpSpawnEnv(daemonSide, env)).toEqual(daemonSide)
  })

  it('signs in with the API key when one is set, else the account sign-in', () => {
    expect(pickAcpAuthMethod(env[ACP_AUTH_ENV], { GEMINI_API_KEY: 'k' }, ANSWERS.initialize)).toBe('gemini-api-key')
    expect(pickAcpAuthMethod(env[ACP_AUTH_ENV], { GOOGLE_CLOUD_PROJECT: 'p' }, ANSWERS.initialize)).toBe('agent-platform')
    expect(pickAcpAuthMethod(env[ACP_AUTH_ENV], {}, ANSWERS.initialize)).toBe('oauth-personal')
  })
})

describe('a missing agy names the installer', () => {
  const INSTALL = 'curl -fsSL https://antigravity.google/cli/install.sh | bash'

  it('on this machine', async () => {
    _resetEngineProbeCache()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-missing-'))
    const availability = await probeEngine('antigravity', { env: { PATH: '/nonexistent', HOME: home }, systemDirectories: [], cwd: home })
    _resetEngineProbeCache()
    expect(availability.installed).toBe(false)
    expect(availability.reason).toContain(INSTALL)
    expect(availability.reason).toContain('WALNUT_ANTIGRAVITY_PATH')
  })

  it('on another host, after the daemon\'s own words', () => {
    expect(withInstallHint('antigravity', 'agy is not installed')).toBe(`agy is not installed: install it with \`${INSTALL}\``)
    expect(withInstallHint('antigravity', 'WALNUT_ANTIGRAVITY_PATH names /x, which is not an executable file'))
      .toBe('WALNUT_ANTIGRAVITY_PATH names /x, which is not an executable file')
    expect(withInstallHint('opencode', 'opencode is not installed')).toBe('opencode is not installed')
  })
})
