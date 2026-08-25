/**
 * The store's list is a MERGE of a curated catalog and what is actually on disk, and
 * every judgement it makes is a sentence a user reads ("off", "needs setup", "restart
 * to activate"). Those judgements live in one pure function so they can be pinned
 * here without a server, a plugin or a disk.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  isToggleable,
  loadPluginCatalog,
  mergePluginRegistry,
  overlayPluginCatalog,
  parsePluginCatalog,
  storeStatusFor,
  type InstalledPluginFacts,
  type PluginCatalogEntry,
} from '../../src/core/plugins/plugin-catalog.js'

const builtinEntry: PluginCatalogEntry = {
  id: 'walnut-time',
  name: 'Time',
  description: 'Your day as a timeline.',
  adds: ['App'],
  source: { kind: 'builtin' },
}

const gitEntry: PluginCatalogEntry = {
  id: 'acme-notes',
  name: 'Acme Notes',
  source: { kind: 'git', url: 'https://example.invalid/acme-notes.git' },
}

function installed(overrides: Partial<InstalledPluginFacts> & { id: string }): InstalledPluginFacts {
  return { name: overrides.id, state: 'active', builtin: false, ...overrides }
}

describe('storeStatusFor', () => {
  it('maps every lifecycle state to one word', () => {
    expect(storeStatusFor('active')).toBe('active')
    expect(storeStatusFor('activating')).toBe('active')
    // Mid-teardown is still running code, so it must not read as off.
    expect(storeStatusFor('disposing')).toBe('active')
    expect(storeStatusFor('disabled')).toBe('disabled')
    expect(storeStatusFor('needs-config')).toBe('needs-config')
    expect(storeStatusFor('unsupported')).toBe('unsupported')
    expect(storeStatusFor('failed')).toBe('failed')
    expect(storeStatusFor('quarantined')).toBe('quarantined')
  })

  it('never calls a merely-discovered plugin active', () => {
    // Discovered means found and not disabled, but nothing activated it in this
    // process. Saying "on" there would be a confident wrong answer.
    expect(storeStatusFor('discovered')).toBe('pending-restart')
    expect(storeStatusFor('something-new')).toBe('pending-restart')
  })
})

describe('isToggleable', () => {
  it('offers a switch only where turning it on can actually work', () => {
    expect(isToggleable('active')).toBe(true)
    expect(isToggleable('disabled')).toBe(true)
    expect(isToggleable('failed')).toBe(true)
    expect(isToggleable('pending-restart')).toBe(true)
  })

  it('withholds the switch where the plugin manager would refuse to activate', () => {
    // activateManaged() throws for all three, so a switch would flip back on its own.
    expect(isToggleable('needs-config')).toBe(false)
    expect(isToggleable('unsupported')).toBe(false)
    expect(isToggleable('quarantined')).toBe(false)
    expect(isToggleable('available')).toBe(false)
  })
})

describe('mergePluginRegistry', () => {
  it('marks a catalog entry that is on disk as installed, with its live state', () => {
    const { rows, installedCount, availableCount } = mergePluginRegistry(
      [builtinEntry, gitEntry],
      [installed({ id: 'walnut-time', name: 'Time', state: 'disabled', builtin: true, version: '0.1.0' })],
    )
    expect(installedCount).toBe(1)
    expect(availableCount).toBe(1)
    const time = rows.find((row) => row.id === 'walnut-time')!
    expect(time.installed).toBe(true)
    expect(time.status).toBe('disabled')
    expect(time.state).toBe('disabled')
    expect(time.version).toBe('0.1.0')
    expect(time.toggleable).toBe(true)
    // Catalog copy fills in what a manifest does not carry.
    expect(time.adds).toEqual(['App'])
    expect(time.catalog).toBe(true)
  })

  it('lists a catalog entry that is not on disk as available and not toggleable', () => {
    const { rows } = mergePluginRegistry([gitEntry], [])
    const row = rows[0]!
    expect(row.installed).toBe(false)
    expect(row.status).toBe('available')
    expect(row.toggleable).toBe(false)
    expect(row.source).toEqual({ kind: 'git', url: 'https://example.invalid/acme-notes.git' })
  })

  it('keeps a discovered plugin the catalog has never heard of', () => {
    // The catalog is an addition to the truth on disk, never a filter on it.
    const { rows, installedCount } = mergePluginRegistry(
      [builtinEntry],
      [installed({ id: 'home-grown', name: 'Home Grown', state: 'active' })],
    )
    expect(installedCount).toBe(1)
    const row = rows.find((r) => r.id === 'home-grown')!
    expect(row.catalog).toBe(false)
    expect(row.status).toBe('active')
  })

  it('hides the local fallback from both lists', () => {
    const { rows } = mergePluginRegistry(
      [{ id: 'local', name: 'Local', source: { kind: 'builtin' } }],
      [installed({ id: 'local', name: 'Local (fallback)', state: 'active', builtin: true })],
    )
    expect(rows).toHaveLength(0)
  })

  it('carries the reason a plugin is not running, and what it is missing', () => {
    const { rows } = mergePluginRegistry([], [installed({
      id: 'jira',
      name: 'Jira',
      state: 'needs-config',
      builtin: true,
      missingConfig: ['base_url'],
      reason: 'Missing configuration: base_url',
    })])
    const row = rows[0]!
    expect(row.status).toBe('needs-config')
    expect(row.missingConfig).toEqual(['base_url'])
    expect(row.reason).toBe('Missing configuration: base_url')
    expect(row.toggleable).toBe(false)
  })

  it('prefers the installed source kind over the catalog claim', () => {
    // Catalog says builtin, disk says it arrived from a git source: disk wins, and the
    // slug rides along so Update/Remove act on the right thing.
    const { rows } = mergePluginRegistry([builtinEntry], [installed({
      id: 'walnut-time',
      name: 'Time',
      state: 'active',
      sourceSlug: 'time-repo',
      sourceKind: 'git',
    })])
    expect(rows[0]!.source.kind).toBe('git')
    expect(rows[0]!.sourceSlug).toBe('time-repo')
  })

  it('puts installed rows first, each group alphabetical, and never duplicates an id', () => {
    const { rows } = mergePluginRegistry(
      [gitEntry, builtinEntry, { id: 'zeta', name: 'Zeta', source: { kind: 'npm', spec: 'zeta' } }],
      [
        installed({ id: 'walnut-time', name: 'Time', state: 'active', builtin: true }),
        installed({ id: 'walnut-time', name: 'Time duplicate', state: 'failed' }),
        installed({ id: 'beta', name: 'Beta', state: 'active' }),
      ],
    )
    expect(rows.map((row) => row.id)).toEqual(['beta', 'walnut-time', 'acme-notes', 'zeta'])
    expect(rows.filter((row) => row.installed).map((row) => row.name)).toEqual(['Beta', 'Time'])
    // First record for an id wins; the duplicate does not create a second row.
    expect(rows.find((row) => row.id === 'walnut-time')!.status).toBe('active')
  })
})

describe('parsePluginCatalog', () => {
  it('skips junk entries instead of failing the whole catalog', () => {
    const entries = parsePluginCatalog({
      plugins: [
        null,
        'nope',
        { name: 'no id' },
        { id: '  ' },
        { id: 'ok', name: 'Ok', source: { kind: 'npm', spec: 'ok@1.0.0' }, adds: ['App', 7] },
      ],
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'ok', name: 'Ok', adds: ['App'] })
    expect(entries[0]!.source).toEqual({ kind: 'npm', spec: 'ok@1.0.0' })
  })

  it('defaults an unknown or absent source kind to git rather than inventing one', () => {
    expect(parsePluginCatalog({ plugins: [{ id: 'a' }] })[0]!.source.kind).toBe('git')
    expect(parsePluginCatalog({ plugins: [{ id: 'a', source: { kind: 'ftp' } }] })[0]!.source.kind).toBe('git')
  })

  it('returns nothing for a document with no plugins array', () => {
    expect(parsePluginCatalog(null)).toEqual([])
    expect(parsePluginCatalog({})).toEqual([])
    expect(parsePluginCatalog({ plugins: 'no' })).toEqual([])
  })
})

describe('overlayPluginCatalog', () => {
  it('lets a user entry replace a shipped one and add new ids', () => {
    const merged = overlayPluginCatalog(
      [builtinEntry, gitEntry],
      [{ id: 'walnut-time', name: 'My Time', source: { kind: 'builtin' } }, { id: 'extra', name: 'Extra', source: { kind: 'git' } }],
    )
    expect(merged.map((entry) => entry.id).sort()).toEqual(['acme-notes', 'extra', 'walnut-time'])
    expect(merged.find((entry) => entry.id === 'walnut-time')!.name).toBe('My Time')
  })
})

describe('the shipped catalog file', () => {
  it('parses, and every entry describes an install path the UI implements', async () => {
    const entries = await loadPluginCatalog()
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/)
      expect(entry.name).toBeTruthy()
      expect(['builtin', 'git', 'npm', 'example']).toContain(entry.source.kind)
      // A git/npm row prefills the install form, so it needs something to prefill.
      if (entry.source.kind === 'git') expect(entry.source.url).toBeTruthy()
      if (entry.source.kind === 'npm') expect(entry.source.spec).toBeTruthy()
      // An example row shows a `walnut-plugin link <path>` command, so the path must
      // actually exist in this checkout — otherwise the command is a dead end.
      if (entry.source.kind === 'example') {
        expect(entry.source.path).toBeTruthy()
        const dir = path.resolve(process.cwd(), entry.source.path!)
        expect(fs.existsSync(path.join(dir, 'manifest.json')), `${entry.source.path}/manifest.json`).toBe(true)
      }
    }
  })

  it('never lists the local fallback', async () => {
    const entries = await loadPluginCatalog()
    expect(entries.some((entry) => entry.id === 'local')).toBe(false)
  })
})
