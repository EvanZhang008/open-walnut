/**
 * Where a project's code comes from (src/core/workspaces/project-source.ts): the legacy fold,
 * an explicit source, the suggestions' order, the write check and the bounded usage counts.
 * Pure functions only; the routes are proven in tests/e2e/project-first-start-e2e.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  AUTO_PROVIDER, MAX_SUGGESTIONS, MAX_USAGE_FIELDS, MAX_USAGE_VALUES, bumpUsage, checkWorkspaceSourceShape, countedInputs,
  effectiveWorkspaceSource, explicitWorkspaceSource, projectStartAsk, sourceSuggestions, startSourceOf,
} from '../../src/core/workspaces/project-source.js'
import type { ProviderInfo } from '../../src/core/workspaces/registry.js'

const plugin: ProviderInfo = {
  id: 'monorepo-tool', displayName: 'Monorepo workspace', priority: 50, builtin: false,
  inputSchema: { type: 'object', properties: { packages: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['fresh', 'reuse'] } } },
}

describe('the effective source', () => {
  it('folds a legacy project (default_cwd + isolated_workspace on) to auto, and nothing else', () => {
    expect(effectiveWorkspaceSource({ default_cwd: '/src/marina', isolated_workspace: 'on' })).toEqual({ provider: AUTO_PROVIDER, anchor: '/src/marina', inputs: {} })
    expect(effectiveWorkspaceSource({ default_cwd: '/src/marina', isolated_workspace: 'off' })).toBeNull()
    expect(effectiveWorkspaceSource({ default_cwd: '/src/marina' })).toBeNull()
    expect(effectiveWorkspaceSource({ isolated_workspace: 'on' })).toBeNull()
    expect(effectiveWorkspaceSource(null)).toBeNull()
  })

  it('an explicit source wins over the fold, and its anchor falls back to default_cwd', () => {
    const meta = { default_cwd: '/src/acme', isolated_workspace: 'on', workspace_source: { provider: 'monorepo-tool', inputs: { packages: ['Alpha'] } } }
    expect(effectiveWorkspaceSource(meta)).toEqual({ provider: 'monorepo-tool', anchor: '/src/acme', inputs: { packages: ['Alpha'] } })
    expect(effectiveWorkspaceSource({ ...meta, workspace_source: { provider: 'git-worktree', anchor: '~/code/acme' } }))
      .toEqual({ provider: 'git-worktree', anchor: '~/code/acme', inputs: {} })
    // No folder anywhere: nothing to start from.
    expect(effectiveWorkspaceSource({ workspace_source: { provider: 'git-worktree' } })).toBeNull()
    expect(explicitWorkspaceSource({ workspace_source: { provider: '' } })).toBeNull()
    expect(explicitWorkspaceSource({ workspace_source: 'git-worktree' })).toBeNull()
  })
})

describe('suggestions', () => {
  it('lists the favourites first, then the used values by count, de-duplicated', () => {
    const usage = { packages: { Beta: 3, Gamma: 7, Alpha: 9, Delta: 3 } }
    expect(sourceSuggestions({ packages: ['Beta'] }, usage, plugin.inputSchema)).toEqual({ packages: ['Beta', 'Alpha', 'Gamma', 'Delta'] })
  })

  it('keeps at most 30, and only array fields', () => {
    const counts = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`P${i}`, 100 - i]))
    const out = sourceSuggestions({ mode: 'fresh' }, { packages: counts, mode: { fresh: 2 } }, plugin.inputSchema)
    expect(out.packages).toHaveLength(MAX_SUGGESTIONS)
    expect(out.packages[0]).toBe('P0')
    expect(out.mode).toBeUndefined()
  })

  it('without a schema (auto) reads the array fields from the inputs and the usage', () => {
    expect(sourceSuggestions({ packages: ['Alpha'] }, { tags: { x: 1 } })).toEqual({ packages: ['Alpha'], tags: ['x'] })
  })
})

describe('usage counts', () => {
  it('counts only the array fields the provider\'s schema names, once per value', () => {
    const counted = countedInputs(plugin.inputSchema, { packages: ['Alpha', 'Beta', 'Alpha'], mode: 'fresh', junk: ['X'], flag: true })
    expect(counted).toEqual({ packages: ['Alpha', 'Beta'] })
    const once = bumpUsage({}, counted)
    expect(once).toEqual({ packages: { Alpha: 1, Beta: 1 } })
    expect(bumpUsage(once, { packages: ['Beta'] })).toEqual({ packages: { Alpha: 1, Beta: 2 } })
  })

  it('counts nothing without a schema (a provider this machine does not know, or none)', () => {
    expect(countedInputs(undefined, { packages: ['Alpha'] })).toEqual({})
    expect(countedInputs(plugin.inputSchema, ['Alpha'])).toEqual({})
  })

  it(`counts at most ${MAX_USAGE_FIELDS} fields, values cut to 200 characters`, () => {
    const properties = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { type: 'array' as const, items: { type: 'string' as const } }]))
    const inputs = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, ['x'.repeat(500)]]))
    const counted = countedInputs({ type: 'object', properties }, inputs)
    expect(Object.keys(counted)).toHaveLength(MAX_USAGE_FIELDS)
    expect(counted.f0[0]).toHaveLength(200)
    // Stored counts that already hold the most fields take no new one.
    const full = Object.fromEntries(Array.from({ length: MAX_USAGE_FIELDS }, (_, i) => [`old${i}`, { v: 1 }]))
    expect(Object.keys(bumpUsage(full, { fresh: ['v'], old0: ['v'] }))).toHaveLength(MAX_USAGE_FIELDS)
    expect(bumpUsage(full, { old0: ['v'] }).old0).toEqual({ v: 2 })
  })

  it(`keeps at most ${MAX_USAGE_VALUES} values a field, dropping the least used`, () => {
    let usage = bumpUsage({}, { packages: ['Keep'] })
    usage = bumpUsage(usage, { packages: ['Keep'] })
    usage = bumpUsage(usage, { packages: Array.from({ length: MAX_USAGE_VALUES + 20 }, (_, i) => `N${String(i).padStart(3, '0')}`) })
    expect(Object.keys(usage.packages)).toHaveLength(MAX_USAGE_VALUES)
    expect(usage.packages.Keep).toBe(2)
    expect(usage.packages.N219).toBeUndefined()
  })
})

describe('the write check', () => {
  it('takes a good source and a clear', () => {
    expect(checkWorkspaceSourceShape({ workspace_source: { provider: 'git-worktree', anchor: '/src/marina' } })).toBeNull()
    expect(checkWorkspaceSourceShape({ workspace_source: { provider: 'auto', anchor: '~/marina', inputs: { packages: ['Alpha'] } } })).toBeNull()
    expect(checkWorkspaceSourceShape({ workspace_source: undefined })).toBeNull()
    expect(checkWorkspaceSourceShape({ default_cwd: '/x' })).toBeNull()
  })

  it.each([
    [{ workspace_source: 'git-worktree' }, /must be an object/],
    [{ workspace_source: { provider: 7 } }, /provider must be/],
    [{ workspace_source: { provider: 'Bad Id!' } }, /provider must be/],
    [{ workspace_source: { provider: 'git-worktree', anchor: 'relative/path' } }, /anchor must be an absolute/],
    [{ workspace_source: { provider: 'git-worktree', inputs: ['Alpha'] } }, /inputs must be an object/],
    [{ workspace_source: { provider: 'git-worktree', command: ['rm'] } }, /unknown field/],
    [{ workspace_source: { provider: 'git-worktree', inputs: { big: 'x'.repeat(20_000) } } }, /too large/],
    [{ workspace_source_usage: { packages: { Alpha: 'many' } } }, /workspace_source_usage/],
    [{ workspace_source_usage: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, { v: 1 }])) }, /at most 16 fields/],
    [{ workspace_source_usage: { packages: { ['x'.repeat(201)]: 1 } } }, /200 characters a value/],
  ])('refuses %j', (patch, why) => {
    expect(checkWorkspaceSourceShape(patch as Record<string, unknown>)).toMatch(why)
  })
})

describe('the row shape', () => {
  it('names the provider, the host and its fields from the local catalog', () => {
    const row = startSourceOf(
      { default_host: 'devbox', workspace_source: { provider: 'monorepo-tool', anchor: '/ws/acme', inputs: { packages: ['Alpha'] } }, workspace_source_usage: { packages: { Beta: 2 } } },
      { providers: [plugin], hostLabel: (h) => (h === 'devbox' ? 'Dev box' : undefined) },
    )
    expect(row).toEqual({
      provider: 'monorepo-tool', provider_name: 'Monorepo workspace', anchor: '/ws/acme', host: 'devbox', host_label: 'Dev box',
      inputs: { packages: ['Alpha'] }, suggestions: { packages: ['Alpha', 'Beta'] }, input_schema: plugin.inputSchema,
    })
  })

  it('keeps auto as auto, on this machine, with no schema', () => {
    const row = startSourceOf({ default_cwd: '/src/marina', isolated_workspace: 'on' }, { providers: [plugin], hostLabel: () => undefined })
    expect(row).toMatchObject({ provider: 'auto', anchor: '/src/marina', host: '__local__', inputs: {}, suggestions: {} })
    expect(row).not.toHaveProperty('input_schema')
    expect(row).not.toHaveProperty('provider_name')
  })
})

describe('the start body', () => {
  it('refuses an ask, bad inputs and a bad host', () => {
    expect(projectStartAsk({ walnutAgent: true })).toMatchObject({ status: 400 })
    expect(projectStartAsk({ workspaceInputs: ['Alpha'] })).toMatchObject({ status: 400 })
    expect(projectStartAsk({ host: 3 })).toMatchObject({ status: 400 })
    expect(projectStartAsk({ host: 'devbox', workspaceInputs: { packages: ['Alpha'] } })).toEqual({ host: 'devbox', inputs: { packages: ['Alpha'] } })
  })
})
