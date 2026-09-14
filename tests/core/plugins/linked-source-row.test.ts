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

  it('carries a skipped linked scan through as a flag, and only when true', () => {
    // The scan never reached this row: it may well be linked, so the store must say "not
    // checked" instead of "not linked". A row the scan did reach carries no such key at
    // all (which is why the toEqual assertions above stay exact).
    const { rows } = mergePluginRegistry([], [
      installed({ id: 'unscanned', linkedScanSkipped: true }),
      installed({ id: 'scanned', linkedScanSkipped: false }),
      installed({ id: 'sample', linked }),
    ])
    const byId = new Map(rows.map((row) => [row.id, row]))

    expect(byId.get('unscanned')!.linkedScanSkipped).toBe(true)
    expect(byId.get('unscanned')!.source).toEqual({ kind: 'local' })
    expect('linkedScanSkipped' in byId.get('scanned')!).toBe(false)
    expect('linkedScanSkipped' in byId.get('sample')!).toBe(false)
  })

  it('calls a plain folder nobody owns `local`, even when the catalog knows a git URL for that id', () => {
    // A directory copied into the plugins dir by hand: not linked, no store slug. The old
    // default said `git`, and the console drew an update chip whose click could never
    // answer (there is no source to update FROM). The catalog's URL says where the plugin
    // normally comes from, not where this copy came from.
    const entry: PluginCatalogEntry = {
      id: 'copied',
      name: 'Copied',
      source: { kind: 'git', url: 'https://example.invalid/team/plugins.git' },
    }
    const { rows } = mergePluginRegistry([entry], [
      installed({ id: 'copied' }),
      installed({ id: 'unknown-to-catalog' }),
    ])
    const byId = new Map(rows.map((row) => [row.id, row]))

    expect(byId.get('copied')!.source).toEqual({ kind: 'local' })
    expect(byId.get('unknown-to-catalog')!.source).toEqual({ kind: 'local' })
    expect('sourceSlug' in byId.get('copied')!).toBe(false)
  })

  it('never accepts `local` from a catalog file either', () => {
    const parsed = parsePluginCatalog({
      plugins: [{ id: 'sample', name: 'Sample', source: { kind: 'local' } }],
    })

    expect(parsed[0]!.source.kind).toBe('git')
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
