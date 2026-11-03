/**
 * The Apps page groups installed plugins by where they come from, and an install link for a
 * source that is already installed is recognised in any spelling of its URL.
 */
import { describe, expect, it } from 'vitest'
import type { PluginSource } from '../../web/src/components/settings/sections/PluginSourcesGroup'
import type { RegistryRow } from '../../web/src/components/apps-page/plugin-store-model'
import {
  BUILTIN_SECTION_TITLE,
  LOCAL_SECTION_TITLE,
  installedSourceFor,
  sourceDisplayName,
  sourceSections,
} from '../../web/src/components/apps-page/source-sections'

function row(over: Partial<RegistryRow> & { id: string }): RegistryRow {
  return {
    name: over.id,
    source: { kind: 'local' },
    installed: true,
    status: 'active',
    builtin: false,
    configurable: false,
    catalog: false,
    toggleable: true,
    ...over,
  }
}

function source(over: Partial<PluginSource> & { slug: string }): PluginSource {
  return { enabled: true, cloned: true, plugins: [], ...over }
}

const acme = source({ slug: 'acme-store', kind: 'git', url: 'ssh://git.example.com/pkg/AcmePluginStore', plugins: [{ dir: 'a', id: 'tracker', name: 'Tracker', version: '1.0.0', status: 'loaded' }] })
const zeta = source({ slug: 'zeta', kind: 'npm', spec: '@zeta/walnut-plugin@1.2.3', packageName: '@zeta/walnut-plugin' })

describe('sourceSections', () => {
  it('puts built-in and bundled plugins first, each source by name, then local folders', () => {
    const sections = sourceSections([
      row({ id: 'calendar', builtin: true, source: { kind: 'builtin' } }),
      row({ id: 'rhythm', source: { kind: 'bundled' } }),
      row({ id: 'tracker', source: { kind: 'git' }, sourceSlug: 'acme-store' }),
      row({ id: 'notes', source: { kind: 'linked' }, sourceSlug: 'acme-store' }),
      row({ id: 'folder-one', source: { kind: 'local' } }),
      row({ id: 'dev-link', source: { kind: 'linked' } }),
    ], [zeta, acme])
    expect(sections.map((s) => [s.title, s.rows.map((r) => r.id)])).toEqual([
      [BUILTIN_SECTION_TITLE, ['calendar', 'rhythm']],
      ['@zeta/walnut-plugin', []],
      ['AcmePluginStore', ['tracker', 'notes']],
      [LOCAL_SECTION_TITLE, ['folder-one', 'dev-link']],
    ])
  })

  it('keeps a source with no loaded plugin as its own empty section', () => {
    const gone = source({ slug: 'gone', kind: 'git', url: 'https://example.com/me/gone.git', cloned: false })
    const sections = sourceSections([], [gone])
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ id: 'source:gone', kind: 'source', title: 'gone', rows: [] })
  })

  it('treats a row whose source is not installed any more as local', () => {
    const sections = sourceSections([row({ id: 'orphan', source: { kind: 'git' }, sourceSlug: 'removed' })], [])
    expect(sections.map((s) => s.id)).toEqual(['local'])
  })

  it('draws no section for a group with nothing in it', () => {
    expect(sourceSections([], [])).toEqual([])
  })
})

describe('sourceDisplayName', () => {
  it('names a git source by its repo and an npm source by its package', () => {
    expect(sourceDisplayName(acme)).toBe('AcmePluginStore')
    expect(sourceDisplayName(source({ slug: 's', kind: 'git', url: 'git@github.com:me/walnut-plugin.git' }))).toBe('walnut-plugin')
    expect(sourceDisplayName(source({ slug: 's', kind: 'git', url: 'https://github.com/me/repo/' }))).toBe('repo')
    expect(sourceDisplayName(zeta)).toBe('@zeta/walnut-plugin')
    expect(sourceDisplayName(source({ slug: 'fallback', kind: 'git' }))).toBe('fallback')
  })
})

describe('installedSourceFor', () => {
  it('finds the installed source behind any spelling of the same git URL', () => {
    for (const url of [
      'ssh://git.example.com/pkg/AcmePluginStore',
      'ssh://git.example.com/pkg/AcmePluginStore.git',
      'ssh://git.example.com/pkg/AcmePluginStore/',
      'ssh://someone@git.example.com/pkg/AcmePluginStore',
      'https://git.example.com/pkg/acmepluginstore',
    ]) {
      expect(installedSourceFor({ kind: 'git', url }, [zeta, acme])?.slug, url).toBe('acme-store')
    }
  })

  it('matches the repo whatever branch the link names, and never another repo', () => {
    expect(installedSourceFor({ kind: 'git', url: 'ssh://git.example.com/pkg/AcmePluginStore', ref: 'beta' }, [acme])?.slug).toBe('acme-store')
    expect(installedSourceFor({ kind: 'git', url: 'ssh://git.example.com/pkg/OtherStore' }, [acme])).toBeNull()
    expect(installedSourceFor({ kind: 'git', url: 'ssh://other.example.com/pkg/AcmePluginStore' }, [acme])).toBeNull()
  })

  it('finds an npm package whatever version the link pins', () => {
    expect(installedSourceFor({ kind: 'npm', spec: '@zeta/walnut-plugin@2.0.0' }, [acme, zeta])?.slug).toBe('zeta')
    expect(installedSourceFor({ kind: 'npm', spec: '@zeta/walnut-plugin' }, [acme, zeta])?.slug).toBe('zeta')
    expect(installedSourceFor({ kind: 'npm', spec: 'other-plugin' }, [acme, zeta])).toBeNull()
  })
})
