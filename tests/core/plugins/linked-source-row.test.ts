/**
 * What a linked plugin's store ROW says. Pure merge, no disk and no git: the question here
 * is only which source description wins and what it carries.
 */

import { describe, expect, it } from 'vitest'
import {
  mergePluginRegistry,
  parsePluginCatalog,
  type InstalledPluginFacts,
  type PluginCatalogEntry,
} from '../../../src/core/plugins/plugin-catalog.js'

const linked = {
  path: '/Users/dev/code/plugins-repo/sample',
  checkout: '/Users/dev/code/plugins-repo',
  branch: 'main',
  sha: 'c'.repeat(40),
  remote: 'https://example.invalid/team/plugins.git',
  dirty: false,
}

function installed(overrides: Partial<InstalledPluginFacts> & { id: string }): InstalledPluginFacts {
  return { name: overrides.id, state: 'active', builtin: false, ...overrides }
}

describe('linked checkouts in the store list', () => {
  it('describes an installed row by the checkout it runs from', () => {
    const { rows } = mergePluginRegistry([], [installed({ id: 'sample', linked })])

    expect(rows[0]!.source).toEqual({ kind: 'linked', ...linked })
  })

  it('drops a remote it does not have, and carries a dirty tree through', () => {
    const { rows } = mergePluginRegistry([], [installed({
      id: 'sample',
      linked: { ...linked, remote: undefined, dirty: true },
    })])

    expect(rows[0]!.source).toEqual({
      kind: 'linked',
      path: linked.path,
      checkout: linked.checkout,
      branch: 'main',
      sha: 'c'.repeat(40),
      dirty: true,
    })
  })

  it('lets the link win over the catalog entry that describes where it normally comes from', () => {
    // The catalog says "install this from git"; on this machine it is a working copy. The
    // code that RUNS is the checkout, and it is the only copy Check and Update can act on.
    const entry: PluginCatalogEntry = {
      id: 'sample',
      name: 'Sample',
      adds: ['Task sync'],
      source: { kind: 'git', url: 'https://example.invalid/team/plugins.git' },
    }

    const { rows } = mergePluginRegistry([entry], [installed({ id: 'sample', linked })])

    expect(rows[0]!.source.kind).toBe('linked')
    // Catalog copy still fills in what a manifest does not carry.
    expect(rows[0]!.adds).toEqual(['Task sync'])
  })

  it('leaves builtin, git and npm rows exactly as they were', () => {
    const { rows } = mergePluginRegistry([], [
      installed({ id: 'builtin-one', builtin: true }),
      installed({ id: 'from-git', sourceKind: 'git', sourceSlug: 'plugins-repo' }),
      installed({ id: 'from-npm', sourceKind: 'npm', sourceSlug: 'npm-sample' }),
    ])
    const byId = new Map(rows.map((row) => [row.id, row]))

    expect(byId.get('builtin-one')!.source).toEqual({ kind: 'builtin' })
    expect(byId.get('from-git')!.source).toEqual({ kind: 'git' })
    expect(byId.get('from-npm')!.source).toEqual({ kind: 'npm' })
  })

  it('never accepts `linked` from a catalog file', () => {
    // A linked checkout is DISCOVERED on disk. A catalog document claiming it would put a
    // Check button on a row with no checkout behind it, so the kind falls back to git.
    const parsed = parsePluginCatalog({
      plugins: [{ id: 'sample', name: 'Sample', source: { kind: 'linked', path: '/tmp/anywhere' } }],
    })

    expect(parsed[0]!.source.kind).toBe('git')
  })
})
