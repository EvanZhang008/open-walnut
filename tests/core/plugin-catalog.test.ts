/**
 * The store's list is a MERGE of a curated catalog and what is actually on disk, and
 * every judgement it makes is a sentence a user reads ("off", "needs setup", "restart
 * to activate"). Those judgements live in one pure function so they can be pinned
 * here without a server, a plugin or a disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  listInstalledBundledDirs,
  overlayBundledCatalog,
  parseManifestCatalog,
  scanBundledStore,
} from '../../src/core/plugins/bundled-store.js'
import {
  blockedDependencyIds,
  isToggleable,
  loadPluginCatalog,
  mergePluginRegistry,
  overlayPluginCatalog,
  parsePluginCatalog,
  planPluginDependencies,
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
    // Blocked by another plugin, not by its own setup — a different sentence to show.
    expect(storeStatusFor('needs-dependency')).toBe('needs-dependency')
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
    // activateManaged() throws for all four, so a switch would flip back on its own.
    expect(isToggleable('needs-config')).toBe(false)
    expect(isToggleable('needs-dependency')).toBe(false)
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

  it('carries which dependencies hold a row back, so the store can name them', () => {
    const { rows } = mergePluginRegistry([], [installed({
      id: 'mail-imap',
      name: 'Mail IMAP',
      state: 'needs-dependency',
      reason: 'Missing dependencies: mail@^1 (not installed)',
      missingDependencies: [
        { id: 'mail', range: '^1', reason: 'absent', note: '"mail" is not installed' },
      ],
    })])
    const row = rows[0]!
    expect(row.status).toBe('needs-dependency')
    expect(row.missingDependencies).toEqual([
      { id: 'mail', range: '^1', reason: 'absent', note: '"mail" is not installed' },
    ])
    // No switch: PluginManager would refuse the activation, so a toggle would flip back.
    expect(row.toggleable).toBe(false)
  })

  it('leaves missingDependencies off a row that has none', () => {
    const { rows } = mergePluginRegistry([], [installed({ id: 'plain', state: 'active' })])
    expect('missingDependencies' in rows[0]!).toBe(false)
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

/**
 * A dependency plan is the difference between a dead-end row ("needs another plugin")
 * and a row with a button on it. It is computed here, purely, from three facts: what the
 * row asks for, what the catalog offers, and what is already on this machine.
 */
describe('dependency plans', () => {
  const alphaGit: PluginCatalogEntry = {
    id: 'alpha',
    name: 'Alpha',
    source: { kind: 'git', url: 'https://example.invalid/alpha.git' },
  }
  const alphaExample: PluginCatalogEntry = {
    id: 'alpha',
    name: 'Alpha',
    source: { kind: 'example', path: 'examples/plugins/alpha' },
  }
  const alphaBuiltin: PluginCatalogEntry = { id: 'alpha', name: 'Alpha', source: { kind: 'builtin' } }

  it('offers the catalog source when the dependency is not on this machine', () => {
    expect(planPluginDependencies([{ id: 'alpha', range: '^1' }], [alphaGit], [])).toEqual([
      { id: 'alpha', range: '^1', resolvable: 'catalog', source: alphaGit.source },
    ])
  })

  it('offers nothing for a builtin entry that this build does not carry', () => {
    // "Ships with Walnut" plus "absent from the lifecycle records" means it is not here at
    // all: turning it on throws "not discovered", and there is no source to install.
    expect(planPluginDependencies([{ id: 'alpha', range: '^1' }], [alphaBuiltin], [])).toEqual([
      { id: 'alpha', range: '^1', resolvable: 'none' },
    ])
  })

  it('withholds the switch where the plugin manager would refuse the activation', () => {
    // needs-config / unsupported / quarantined take the config write and land straight back
    // where they were, so "Turn on jira" would report a success that never happened.
    for (const state of ['needs-config', 'unsupported', 'quarantined', 'needs-dependency']) {
      expect(planPluginDependencies(
        [{ id: 'alpha', range: '^1' }],
        [alphaGit],
        [installed({ id: 'alpha', state })],
      )).toEqual([{ id: 'alpha', range: '^1', resolvable: 'none' }])
    }
    // Off, failed and never-activated CAN be switched on.
    for (const state of ['disabled', 'failed', 'discovered']) {
      expect(planPluginDependencies(
        [{ id: 'alpha', range: '^1' }],
        [alphaGit],
        [installed({ id: 'alpha', state })],
      )).toEqual([{ id: 'alpha', range: '^1', resolvable: 'installed' }])
    }
  })

  it('says none when nothing on this machine or in the catalog can supply it', () => {
    expect(planPluginDependencies([{ id: 'alpha', range: '^1' }], [], [])).toEqual([
      { id: 'alpha', range: '^1', resolvable: 'none' },
    ])
  })

  it('says installed when the dependency is here but not running', () => {
    // The fix is a switch, not an install, so the two must not read the same.
    expect(planPluginDependencies(
      [{ id: 'alpha', range: '^1', reason: 'inactive' }],
      [alphaGit],
      [installed({ id: 'alpha', state: 'disabled' })],
    )).toEqual([{ id: 'alpha', range: '^1', resolvable: 'installed' }])
  })

  it('refuses to promise a fix for a version, unversioned or cycle problem', () => {
    // The catalog carries no version, so "install it from the catalog" would be a
    // confident wrong answer; each of these is copy-only.
    for (const reason of ['version', 'unversioned', 'cycle'] as const) {
      expect(planPluginDependencies(
        [{ id: 'alpha', range: '^2', reason }],
        [alphaGit],
        [installed({ id: 'alpha', state: 'active', version: '1.2.0' })],
      )).toEqual([{ id: 'alpha', range: '^2', resolvable: 'none' }])
    }
  })

  it('asks once per id and keeps the order it was given', () => {
    const plan = planPluginDependencies(
      [{ id: 'beta', range: '^1' }, { id: 'alpha', range: '^1' }, { id: 'alpha', range: '^2' }],
      [alphaGit],
      [],
    )
    expect(plan.map((item) => item.id)).toEqual(['beta', 'alpha'])
    expect(plan[1]!.range).toBe('^1')
  })

  it('counts none and hand-linked example sources as blocking, nothing else', () => {
    // An example lives in a checkout: only `walnut-plugin link` can install it, so a
    // button there would be a control that cannot work.
    expect(blockedDependencyIds(planPluginDependencies(
      [{ id: 'alpha', range: '^1' }],
      [alphaExample],
      [],
    ))).toEqual(['alpha'])
    expect(blockedDependencyIds(planPluginDependencies([{ id: 'alpha', range: '^1' }], [], [])))
      .toEqual(['alpha'])
    expect(blockedDependencyIds(planPluginDependencies([{ id: 'alpha', range: '^1' }], [alphaGit], [])))
      .toEqual([])
  })
})

describe('mergePluginRegistry dependency plans', () => {
  const alphaGit: PluginCatalogEntry = {
    id: 'alpha',
    name: 'Alpha',
    source: { kind: 'git', url: 'https://example.invalid/alpha.git' },
  }
  const gammaNeedsAlpha: PluginCatalogEntry = {
    id: 'gamma',
    name: 'Gamma',
    source: { kind: 'git', url: 'https://example.invalid/gamma.git' },
    requires: { alpha: '^1' },
  }

  it('plans an available row from its requires, without touching row order', () => {
    const { rows } = mergePluginRegistry(
      [gammaNeedsAlpha, alphaGit, { id: 'zeta', name: 'Zeta', source: { kind: 'npm', spec: 'zeta' } }],
      [installed({ id: 'beta', name: 'Beta', state: 'active' })],
    )
    expect(rows.map((row) => row.id)).toEqual(['beta', 'alpha', 'gamma', 'zeta'])
    const gamma = rows.find((row) => row.id === 'gamma')!
    expect(gamma.dependencyPlan).toEqual([
      { id: 'alpha', range: '^1', resolvable: 'catalog', source: alphaGit.source },
    ])
    expect('blockedBy' in gamma).toBe(false)
  })

  it('leaves an available row alone when its requires are already running', () => {
    const { rows } = mergePluginRegistry(
      [gammaNeedsAlpha],
      [installed({ id: 'alpha', name: 'Alpha', state: 'active', version: '1.0.0' })],
    )
    const gamma = rows.find((row) => row.id === 'gamma')!
    expect('dependencyPlan' in gamma).toBe(false)
    expect('blockedBy' in gamma).toBe(false)
  })

  it('names an available row as blocked when only a hand-run link could supply it', () => {
    const { rows } = mergePluginRegistry(
      [gammaNeedsAlpha, { id: 'alpha', name: 'Alpha', source: { kind: 'example', path: 'examples/plugins/alpha' } }],
      [],
    )
    const gamma = rows.find((row) => row.id === 'gamma')!
    expect(gamma.dependencyPlan).toEqual([
      { id: 'alpha', range: '^1', resolvable: 'catalog', source: { kind: 'example', path: 'examples/plugins/alpha' } },
    ])
    expect(gamma.blockedBy).toEqual(['alpha'])
  })

  it('gives a blocked installed row a plan beside the reasons it already carries', () => {
    const { rows } = mergePluginRegistry([alphaGit], [installed({
      id: 'beta',
      name: 'Beta',
      state: 'needs-dependency',
      reason: 'Missing dependencies: alpha@^1 (not installed)',
      missingDependencies: [
        { id: 'alpha', range: '^1', reason: 'absent', note: '"alpha" is not installed' },
      ],
    })])
    const beta = rows.find((row) => row.id === 'beta')!
    expect(beta.missingDependencies).toHaveLength(1)
    expect(beta.dependencyPlan).toEqual([
      { id: 'alpha', range: '^1', resolvable: 'catalog', source: alphaGit.source },
    ])
    expect(beta.blockedBy).toBeUndefined()
  })

  it('plans a blocked row whose dependency is installed but switched off', () => {
    const { rows } = mergePluginRegistry([], [
      installed({ id: 'alpha', name: 'Alpha', state: 'disabled', version: '1.0.0' }),
      installed({
        id: 'beta',
        name: 'Beta',
        state: 'needs-dependency',
        missingDependencies: [
          { id: 'alpha', range: '^1', found: '1.0.0', reason: 'inactive', note: '"alpha" was turned off' },
        ],
      }),
    ])
    expect(rows.find((row) => row.id === 'beta')!.dependencyPlan).toEqual([
      { id: 'alpha', range: '^1', resolvable: 'installed' },
    ])
  })

  it('names the version in the way, and offers nothing that would not fix it', () => {
    // Alpha 1.0.0 IS here and running; gamma wants ^2. Nothing in the store can change
    // that, so the row carries the fact and no button.
    const { rows } = mergePluginRegistry(
      [{ ...gammaNeedsAlpha, requires: { alpha: '^2' } }, alphaGit],
      [installed({ id: 'alpha', name: 'Alpha', state: 'active', version: '1.0.0' })],
    )
    const gamma = rows.find((row) => row.id === 'gamma')!
    expect(gamma.dependencyPlan).toEqual([
      { id: 'alpha', range: '^2', found: '1.0.0', resolvable: 'none' },
    ])
    expect(gamma.blockedBy).toEqual(['alpha'])
  })

  it('treats a dependency with no version in its manifest as unfixable, not as absent', () => {
    // Nothing to compare the range against, and no `found` to print: copy only, and the
    // row says so rather than offering an install that would change nothing.
    const { rows } = mergePluginRegistry(
      [gammaNeedsAlpha],
      [installed({ id: 'alpha', name: 'Alpha', state: 'active' })],
    )
    const gamma = rows.find((row) => row.id === 'gamma')!
    expect(gamma.dependencyPlan).toEqual([{ id: 'alpha', range: '^1', resolvable: 'none' }])
    expect(gamma.blockedBy).toEqual(['alpha'])
  })

  it('adds nothing at all to rows with no unmet dependencies', () => {
    // Byte-identical to before the plan existed: a row without dependencies must not
    // grow a field the store then has to explain away.
    const before = mergePluginRegistry(
      [{ id: 'acme-notes', name: 'Acme Notes', source: { kind: 'git', url: 'https://example.invalid/a.git' } }],
      [installed({ id: 'plain', name: 'Plain', state: 'active' })],
    )
    for (const row of before.rows) {
      expect('dependencyPlan' in row).toBe(false)
      expect('blockedBy' in row).toBe(false)
    }
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

  it('reads requires, dropping junk ranges and an empty map', () => {
    const [entry] = parsePluginCatalog({
      plugins: [{ id: 'gamma', requires: { alpha: '^1', beta: 7, '  ': '^1' } }],
    })
    expect(entry!.requires).toEqual({ alpha: '^1' })
    expect('requires' in parsePluginCatalog({ plugins: [{ id: 'gamma', requires: {} }] })[0]!).toBe(false)
    expect('requires' in parsePluginCatalog({ plugins: [{ id: 'gamma', requires: ['alpha'] }] })[0]!).toBe(false)
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
      expect(['builtin', 'git', 'npm', 'example', 'bundled']).toContain(entry.source.kind)
      // A git/npm row prefills the install form, so it needs something to prefill.
      if (entry.source.kind === 'git') expect(entry.source.url).toBeTruthy()
      if (entry.source.kind === 'npm') expect(entry.source.spec).toBeTruthy()
      // An example row shows a `walnut-plugin link <path>` command, so the path must
      // actually exist in this checkout — otherwise the command is a dead end.
      // A bundled row is synthesised from a folder in this checkout, so the same holds.
      if (entry.source.kind === 'example' || entry.source.kind === 'bundled') {
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

describe('the bundled store folder', () => {
  let base: string
  let store: string

  async function writePlugin(dirName: string, manifest: unknown, files: Record<string, string> = {}): Promise<void> {
    const dir = path.join(store, dirName)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(
      path.join(dir, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    )
    for (const [rel, content] of Object.entries(files)) {
      await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
      await fsp.writeFile(path.join(dir, rel), content)
    }
  }

  beforeEach(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'bundled-catalog-'))
    store = path.join(base, 'plugin-store')
    await fsp.mkdir(store, { recursive: true })
  })

  afterEach(async () => {
    await fsp.rm(base, { recursive: true, force: true })
  })

  it('turns each readable manifest into one bundled entry', async () => {
    await writePlugin('omega', {
      id: 'omega',
      name: 'Omega',
      description: 'Ships with Walnut.',
      version: '2.1.0',
      apiVersion: 1,
      catalog: { adds: ['App', 7, ''], homepage: 'https://example.invalid/omega', docs: 'plugin-store/omega/README.md' },
    })

    const entries = await scanBundledStore(store)

    expect(entries).toEqual([{
      id: 'omega',
      name: 'Omega',
      description: 'Ships with Walnut.',
      version: '2.1.0',
      // Junk inside `catalog` costs that value, never the entry.
      adds: ['App'],
      homepage: 'https://example.invalid/omega',
      docs: 'plugin-store/omega/README.md',
      source: { kind: 'bundled', path: 'plugin-store/omega' },
    }])
  })

  it('skips what it cannot read instead of failing the whole store', async () => {
    await writePlugin('broken', '{ not json')
    await writePlugin('array', '[]')
    await writePlugin('upper', { id: 'Upper', name: 'Upper' })
    await writePlugin('reserved', { id: 'local', name: 'Local' })
    await fsp.mkdir(path.join(store, 'no-manifest'), { recursive: true })
    await fsp.writeFile(path.join(store, 'README.md'), '# not a plugin')
    await writePlugin('fine', { id: 'fine' })

    const entries = await scanBundledStore(store)

    // A manifest with no name still lists, under its id.
    expect(entries.map((entry) => [entry.id, entry.name])).toEqual([['fine', 'fine']])
    expect(await scanBundledStore(path.join(base, 'absent'))).toEqual([])
    expect(await scanBundledStore(null)).toEqual([])
  })

  it('parses the manifest catalog field defensively', () => {
    expect(parseManifestCatalog(undefined)).toBeUndefined()
    expect(parseManifestCatalog('App')).toBeUndefined()
    expect(parseManifestCatalog(['App'])).toBeUndefined()
    expect(parseManifestCatalog({ adds: 'App', homepage: 3 })).toBeUndefined()
    expect(parseManifestCatalog({ adds: ['Task sync'], docs: ' docs/x.md ' })).toEqual({ adds: ['Task sync'], docs: 'docs/x.md' })
  })

  it('lets the curated catalog reword a bundled entry, never move it', () => {
    const bundled: PluginCatalogEntry = {
      id: 'omega',
      name: 'Omega',
      version: '2.1.0',
      description: 'From the manifest.',
      source: { kind: 'bundled', path: 'plugin-store/omega' },
    }
    const merged = overlayBundledCatalog([bundled], [
      // Same id, claiming a git source: the text wins, the source does not.
      { id: 'omega', name: 'Omega Deluxe', description: 'From the catalog.', adds: ['App'], source: { kind: 'git', url: 'https://example.invalid/o.git' } },
      // A bundled claim with no folder behind it would offer an Install that can only fail.
      { id: 'ghost', name: 'Ghost', source: { kind: 'bundled', path: 'plugin-store/ghost' } },
      gitEntry,
    ])

    expect(merged.find((entry) => entry.id === 'omega')).toEqual({
      id: 'omega',
      name: 'Omega Deluxe',
      version: '2.1.0',
      description: 'From the catalog.',
      adds: ['App'],
      source: { kind: 'bundled', path: 'plugin-store/omega' },
    })
    expect(merged.some((entry) => entry.id === 'ghost')).toBe(false)
    expect(merged.some((entry) => entry.id === gitEntry.id)).toBe(true)
  })

  it('keeps the folder name when a text-only overlay entry names no plugin', () => {
    const merged = overlayBundledCatalog(
      [{ id: 'omega', name: 'Omega', source: { kind: 'bundled', path: 'plugin-store/omega' } }],
      // parsePluginCatalog defaults a missing name to the id.
      parsePluginCatalog({ plugins: [{ id: 'omega', description: 'Reworded.' }] }),
    )
    expect(merged[0]).toMatchObject({ name: 'Omega', description: 'Reworded.', source: { kind: 'bundled' } })
  })

  it('loads bundled < shipped < user overlay, with the user text on top', async () => {
    await writePlugin('omega', { id: 'omega', name: 'Omega', description: 'From the manifest.' })
    const home = path.join(base, 'home')
    await fsp.mkdir(home, { recursive: true })
    await fsp.writeFile(path.join(home, 'plugin-registry.json'), JSON.stringify({
      plugins: [{ id: 'omega', name: 'My Omega', description: 'Mine.', source: { kind: 'npm', spec: 'omega' } }],
    }))

    const entries = await loadPluginCatalog(home, { bundledStoreDir: store })
    const omega = entries.find((entry) => entry.id === 'omega')!

    expect(omega).toMatchObject({ name: 'My Omega', description: 'Mine.', source: { kind: 'bundled', path: 'plugin-store/omega' } })
    // The shipped file still contributes its own entries alongside.
    expect(entries.some((entry) => entry.id === 'walnut-time')).toBe(true)
    // And `null` really means "no store".
    expect((await loadPluginCatalog(home, { bundledStoreDir: null })).find((entry) => entry.id === 'omega')?.source.kind).toBe('npm')
  })

  it('merges an uninstalled bundled entry as available and an installed one as bundled', () => {
    const entry: PluginCatalogEntry = {
      id: 'omega', name: 'Omega', version: '2.1.0', adds: ['App'], source: { kind: 'bundled', path: 'plugin-store/omega' },
    }

    const available = mergePluginRegistry([entry], []).rows[0]!
    expect(available).toMatchObject({
      id: 'omega', installed: false, status: 'available', builtin: false, toggleable: false, version: '2.1.0',
      source: { kind: 'bundled', path: 'plugin-store/omega' },
    })

    const running = mergePluginRegistry([entry], [installed({ id: 'omega', version: '2.1.0', sourceKind: 'bundled' })]).rows[0]!
    expect(running).toMatchObject({
      id: 'omega', installed: true, status: 'active', builtin: false, toggleable: true, adds: ['App'],
      source: { kind: 'bundled', path: 'plugin-store/omega' },
    })

    // Installed from somewhere else (a link, a source): the bundled folder does not
    // claim it, so it gets no bundled Remove.
    const elsewhere = mergePluginRegistry([entry], [installed({ id: 'omega', sourceKind: 'git', sourceSlug: 'omega-src' })]).rows[0]!
    expect(elsewhere.source.kind).toBe('git')
  })

  it('offers an uninstalled bundled dependency as something the store can install', () => {
    const plan = planPluginDependencies(
      [{ id: 'omega', range: '^2' }],
      [{ id: 'omega', name: 'Omega', source: { kind: 'bundled', path: 'plugin-store/omega' } }],
      [],
    )
    expect(plan).toEqual([{ id: 'omega', range: '^2', resolvable: 'catalog', source: { kind: 'bundled', path: 'plugin-store/omega' } }])
    expect(blockedDependencyIds(plan)).toEqual([])
  })

  it('accepts bundled as a catalog source kind', () => {
    const [entry] = parsePluginCatalog({ plugins: [{ id: 'omega', source: { kind: 'bundled', path: 'plugin-store/omega' }, version: '1.0.0' }] })
    expect(entry).toMatchObject({ source: { kind: 'bundled', path: 'plugin-store/omega' }, version: '1.0.0' })
  })

  it('discovers only folders that are explicitly installed and built', async () => {
    const server = 'export function activate() {}\n'
    await writePlugin('built', { id: 'built', server: 'dist/server.mjs' }, { 'dist/server.mjs': server })
    await writePlugin('unbuilt', { id: 'unbuilt', server: 'dist/server.mjs' })
    await writePlugin('escape', { id: 'escape', server: '../outside.mjs' })
    await writePlugin('off', { id: 'off', server: 'dist/server.mjs' }, { 'dist/server.mjs': server })
    await writePlugin('unset', { id: 'unset', server: 'dist/server.mjs' }, { 'dist/server.mjs': server })

    const { dirs, skipped } = await listInstalledBundledDirs(store, {
      built: { enabled: true },
      unbuilt: { enabled: true },
      escape: { enabled: true },
      off: { enabled: false },
      // `unset` has no key at all: shipped, not installed.
    })

    expect(dirs.map((entry) => entry.id)).toEqual(['built'])
    expect(skipped.map((entry) => path.basename(entry.dir)).sort()).toEqual(['escape', 'unbuilt'])
    expect(skipped.find((entry) => entry.dir.endsWith('unbuilt'))!.reason).toContain('not built')
  })
})
