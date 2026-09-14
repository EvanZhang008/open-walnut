import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const sourceMocks = vi.hoisted(() => ({
  addSource: vi.fn(),
  addNpmSource: vi.fn(),
  updateSource: vi.fn(),
  checkSource: vi.fn(),
  removeSource: vi.fn(),
  listSources: vi.fn(),
}))

vi.mock('../../../src/core/plugin-sources.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/core/plugin-sources.js')>(),
  ...sourceMocks,
}))
vi.mock('../../../src/core/integration-registry.js', () => ({
  registry: { has: vi.fn(() => false), get: vi.fn(() => undefined) },
}))
vi.mock('../../../src/core/integration-loader.js', () => ({
  getUnconfiguredPlugins: vi.fn(() => []),
  getUnsupportedPlugins: vi.fn(() => []),
  getDuplicatePluginIds: vi.fn(() => []),
  getUnmetDependencyPlugins: vi.fn(() => []),
  getPluginLifecycleRecords: vi.fn(() => []),
}))

import { UpdateStatusCache } from '../../../src/core/plugins/update-status-cache.js'
import { sourceRowKey } from '../../../src/core/plugins/update-status.js'
import { createPluginSourcesRouter, type PluginSourcesRouterDeps } from '../../../src/web/routes/plugin-sources.js'

function app(deps: PluginSourcesRouterDeps = {}, softReload = async () => undefined) {
  const instance = express()
  instance.use(express.json({ strict: false }))
  instance.use('/api/plugin-sources', createPluginSourcesRouter(softReload, deps))
  return instance
}

function source(slug = 'demo', overrides: Record<string, unknown> = {}) {
  return {
    slug,
    kind: 'git' as const,
    url: `https://example.test/${slug}.git`,
    enabled: true,
    cloned: true,
    plugins: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sourceMocks.listSources.mockResolvedValue([])
  sourceMocks.removeSource.mockResolvedValue(undefined)
  sourceMocks.checkSource.mockResolvedValue({ behind: 0, updateAvailable: false })
  sourceMocks.updateSource.mockResolvedValue({ updated: false })
})

describe('Plugin sources route boundaries', () => {
  it.each(['5', '"text"', 'null', '[]'])('returns JSON 400 for primitive body %s', async (body) => {
    const response = await request(app())
      .post('/api/plugin-sources')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(400)

    expect(response.type).toBe('application/json')
    expect(response.body.error).toMatch(/url or spec is required/)
    expect(sourceMocks.addSource).not.toHaveBeenCalled()
    expect(sourceMocks.addNpmSource).not.toHaveBeenCalled()
  })

  it('rejects ambiguous source forms', async () => {
    await request(app())
      .post('/api/plugin-sources')
      .send({ url: 'https://example.test/demo.git', spec: 'demo-plugin' })
      .expect(400, { error: 'provide exactly one source form: url/share snippet or spec' })

    expect(sourceMocks.addSource).not.toHaveBeenCalled()
    expect(sourceMocks.addNpmSource).not.toHaveBeenCalled()
  })

  it('rejects internal and traversal-shaped slugs before any mutation', async () => {
    for (const slug of ['.staging-demo', '.backup-demo', '..evil']) {
      await request(app()).delete(`/api/plugin-sources/${slug}`).expect(400, { error: 'invalid slug' })
    }
    expect(sourceMocks.listSources).not.toHaveBeenCalled()
    expect(sourceMocks.removeSource).not.toHaveBeenCalled()
  })

  it('does not delete an unconfigured directory', async () => {
    await request(app()).delete('/api/plugin-sources/orphan').expect(404, { error: 'source not found' })
    expect(sourceMocks.removeSource).not.toHaveBeenCalled()
  })

  it('removes only a configured source', async () => {
    sourceMocks.listSources.mockResolvedValue([source('demo')])
    await request(app()).delete('/api/plugin-sources/demo').expect(200, {
      removed: true,
      restartRequired: false,
    })
    expect(sourceMocks.removeSource).toHaveBeenCalledWith('demo')
  })

  it('says needs-dependency for a plugin that is also recorded as unsupported', async () => {
    // Both can be true of one row: a plugin held back by a missing dependency was never
    // imported, so "needs a newer Walnut" is a guess while the dependency is a fact. The
    // order of the checks in statusFor is what decides, so it is pinned here.
    const loader = await import('../../../src/core/integration-loader.js')
    vi.mocked(loader.getUnmetDependencyPlugins).mockReturnValue([
      { id: 'mail-imap', name: 'Mail IMAP', missing: [{ id: 'mail', range: '^1', reason: 'absent', note: 'not installed' }] },
    ])
    vi.mocked(loader.getUnsupportedPlugins).mockReturnValue([
      { id: 'mail-imap', name: 'Mail IMAP', capabilities: [], reason: 'Requires Walnut >=9.0.0' },
    ])
    sourceMocks.listSources.mockResolvedValue([{
      ...source('mail'),
      plugins: [{ dir: '/tmp/mail-imap', id: 'mail-imap', name: 'Mail IMAP', version: '1.0.0' }],
    }])

    try {
      const response = await request(app()).get('/api/plugin-sources').expect(200)
      expect(response.body[0].plugins[0].status).toBe('needs-dependency')
    } finally {
      // vitest is configured without mockReset, so an implementation set here would
      // otherwise leak into every later test in this file.
      vi.mocked(loader.getUnmetDependencyPlugins).mockReturnValue([])
      vi.mocked(loader.getUnsupportedPlugins).mockReturnValue([])
    }
  })

  it('returns JSON when list, update, or check fails', async () => {
    sourceMocks.listSources.mockRejectedValueOnce(new Error('state unreadable'))
    const update = await request(app()).post('/api/plugin-sources/demo/update').expect(500)
    expect(update.type).toBe('application/json')
    expect(update.body).toEqual({ error: 'state unreadable' })

    sourceMocks.listSources.mockRejectedValueOnce(new Error('state unreadable'))
    const check = await request(app()).post('/api/plugin-sources/demo/check').expect(500)
    expect(check.type).toBe('application/json')
    expect(check.body).toEqual({ error: 'state unreadable' })
  })
})

/**
 * Installing a source installs THAT source. Anything its plugins turn out to need is
 * reported, then installed only when the user says yes a second time — the consent is
 * the point, so both halves are pinned here: the first response must add nothing extra,
 * and the second must add exactly what it named.
 */
describe('Two-phase dependency install', () => {
  let home = ''
  /** Sources that really exist, so "nothing else was installed" is a length, not a hope. */
  let installedSources: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-sources-deps-'))
  })

  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  /** The user's catalog overlay, re-read on every request, so each test can describe a
   *  different world without a new server. */
  async function writeCatalog(plugins: unknown[]): Promise<void> {
    await fs.writeFile(path.join(home, 'plugin-registry.json'), JSON.stringify({ version: 1, plugins }))
  }

  function view(slug: string, plugins: Array<{ id: string; name?: string }> = []) {
    return {
      slug,
      kind: 'git' as const,
      url: `https://example.test/${slug}.git`,
      enabled: true,
      cloned: true,
      plugins: plugins.map((plugin) => ({
        dir: `/tmp/${plugin.id}`,
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        version: '1.0.0',
      })),
    }
  }

  function blocked(id: string, missing: Array<{ id: string; range: string; reason?: string }>) {
    return {
      id,
      name: id,
      missing: missing.map((dep) => ({
        id: dep.id,
        range: dep.range,
        reason: dep.reason ?? 'absent',
        note: `"${dep.id}" is not installed`,
      })),
    }
  }

  async function unmet(plugins: unknown[]): Promise<void> {
    const loader = await import('../../../src/core/integration-loader.js')
    vi.mocked(loader.getUnmetDependencyPlugins).mockReturnValue(plugins as never)
  }

  async function lifecycle(records: unknown[]): Promise<void> {
    const loader = await import('../../../src/core/integration-loader.js')
    vi.mocked(loader.getPluginLifecycleRecords).mockReturnValue(records as never)
  }

  beforeEach(async () => {
    installedSources = []
    sourceMocks.listSources.mockImplementation(async () => installedSources)
    sourceMocks.addSource.mockImplementation(async (url: string) => {
      const slug = /\/([^/]+)\.git$/.exec(url)?.[1] ?? 'added'
      const added = view(slug, [{ id: slug }])
      installedSources.push(added)
      return added
    })
    sourceMocks.addNpmSource.mockImplementation(async (spec: string) => {
      const added = { ...view(spec, [{ id: spec }]), kind: 'npm' as const, spec }
      installedSources.push(added)
      return added
    })
    await writeCatalog([])
    await unmet([])
    await lifecycle([])
  })

  it('installs only what was asked for, and names what is still missing', async () => {
    await writeCatalog([
      { id: 'alpha', name: 'Alpha', source: { kind: 'git', url: 'https://example.test/alpha.git' } },
    ])
    await unmet([blocked('beta', [{ id: 'alpha', range: '^1' }])])

    const response = await request(app({ walnutHome: home }))
      .post('/api/plugin-sources')
      .send({ url: 'https://example.test/beta.git' })
      .expect(201)

    // ONE source, the requested one. The dependency is described, not installed.
    expect(installedSources).toHaveLength(1)
    expect(installedSources[0]!.slug).toBe('beta')
    expect(sourceMocks.addNpmSource).not.toHaveBeenCalled()
    expect(response.body.pendingDependencies).toEqual([
      { id: 'alpha', range: '^1', resolvable: 'catalog', source: { kind: 'git', url: 'https://example.test/alpha.git' } },
    ])
  })

  it('leaves pendingDependencies off an install that needs nothing', async () => {
    const response = await request(app({ walnutHome: home }))
      .post('/api/plugin-sources')
      .send({ url: 'https://example.test/beta.git' })
      .expect(201)

    expect('pendingDependencies' in response.body).toBe(false)
  })

  it('installs the plan through the ordinary installers on the second yes', async () => {
    await writeCatalog([
      { id: 'alpha', name: 'Alpha', source: { kind: 'git', url: 'https://example.test/alpha.git' } },
    ])
    installedSources.push(view('beta', [{ id: 'beta' }]))
    await unmet([blocked('beta', [{ id: 'alpha', range: '^1' }])])
    const softReload = vi.fn(async () => undefined)

    const response = await request(app({ walnutHome: home }, softReload))
      .post('/api/plugin-sources/beta/dependencies')
      .expect(200)

    expect(sourceMocks.addSource).toHaveBeenCalledWith('https://example.test/alpha.git', undefined)
    expect(response.body.installed).toEqual([
      { id: 'alpha', action: 'installed', kind: 'git', slug: 'alpha', url: 'https://example.test/alpha.git' },
    ])
    expect(response.body.skipped).toEqual([])
    expect(response.body.plugins.slug).toBe('beta')
    // One reload for the batch: the additive load path brings the dependent back itself.
    expect(softReload).toHaveBeenCalledTimes(1)
    expect(installedSources).toHaveLength(2)
  })

  it('installs an npm dependency through the npm installer', async () => {
    await writeCatalog([{ id: 'alpha', name: 'Alpha', source: { kind: 'npm', spec: 'alpha@1.0.0' } }])
    installedSources.push(view('beta', [{ id: 'beta' }]))
    await unmet([blocked('beta', [{ id: 'alpha', range: '^1' }])])

    const response = await request(app({ walnutHome: home }))
      .post('/api/plugin-sources/beta/dependencies')
      .expect(200)

    expect(sourceMocks.addNpmSource).toHaveBeenCalledWith('alpha@1.0.0')
    expect(response.body.installed).toEqual([
      { id: 'alpha', action: 'installed', kind: 'npm', slug: 'alpha@1.0.0', spec: 'alpha@1.0.0' },
    ])
  })

  it('never installs an example source, and hands back the command that would', async () => {
    await writeCatalog([
      { id: 'alpha', name: 'Alpha', source: { kind: 'example', path: 'examples/plugins/alpha' } },
    ])
    installedSources.push(view('beta', [{ id: 'beta' }]))
    await unmet([blocked('beta', [{ id: 'alpha', range: '^1' }])])
    const softReload = vi.fn(async () => undefined)

    const response = await request(app({ walnutHome: home }, softReload))
      .post('/api/plugin-sources/beta/dependencies')
      .expect(200)

    expect(response.body.installed).toEqual([])
    expect(response.body.skipped).toEqual([
      { id: 'alpha', reason: 'example', command: 'walnut-plugin link examples/plugins/alpha' },
    ])
    expect(sourceMocks.addSource).not.toHaveBeenCalled()
    expect(softReload).not.toHaveBeenCalled()
  })

  it('turns a dependency that is already here back on instead of installing it again', async () => {
    installedSources.push(view('beta', [{ id: 'beta' }]))
    await lifecycle([{ id: 'alpha', name: 'Alpha', state: 'disabled', builtin: true, failureCount: 0 }])
    await unmet([blocked('beta', [{ id: 'alpha', range: '^1', reason: 'inactive' }])])
    const reloadPlugin = vi.fn(async () => ({ state: 'active' }))

    const response = await request(app({ walnutHome: home, reloadPlugin }))
      .post('/api/plugin-sources/beta/dependencies')
      .expect(200)

    expect(reloadPlugin).toHaveBeenCalledWith('alpha')
    expect(response.body.installed).toEqual([{ id: 'alpha', action: 'turned-on' }])
    expect(sourceMocks.addSource).not.toHaveBeenCalled()
  })

  it('never claims a turn-on the plugin refused, and says where it landed', async () => {
    // A plugin can take the config write and come straight back to needs-config. Reporting
    // "turned on" there is a confident wrong answer the user then acts on.
    installedSources.push(view('beta', [{ id: 'beta' }]))
    await lifecycle([{ id: 'alpha', name: 'Alpha', state: 'disabled', builtin: true, failureCount: 0 }])
    await unmet([blocked('beta', [{ id: 'alpha', range: '^1', reason: 'inactive' }])])
    const reloadPlugin = vi.fn(async () => ({ state: 'needs-config' }))

    const response = await request(app({ walnutHome: home, reloadPlugin }))
      .post('/api/plugin-sources/beta/dependencies')
      .expect(200)

    expect(response.body.installed).toEqual([])
    expect(response.body.skipped).toEqual([{ id: 'alpha', reason: 'not-active', state: 'needs-config' }])
  })

  it('counts one repo once when two waiting ids come from it', async () => {
    // Two unmet ids naming the same source is the common case (one repo, several plugins).
    // Adding it twice is an error the user did nothing to deserve.
    await writeCatalog([
      { id: 'alpha', name: 'Alpha', source: { kind: 'git', url: 'https://example.test/pack.git' } },
      { id: 'delta', name: 'Delta', source: { kind: 'git', url: 'https://example.test/pack.git' } },
    ])
    installedSources.push(view('beta', [{ id: 'beta' }]))
    await unmet([blocked('beta', [{ id: 'alpha', range: '^1' }, { id: 'delta', range: '^1' }])])

    const response = await request(app({ walnutHome: home }))
      .post('/api/plugin-sources/beta/dependencies')
      .expect(200)

    expect(sourceMocks.addSource).toHaveBeenCalledTimes(1)
    expect(response.body.installed).toEqual([
      { id: 'alpha', action: 'installed', kind: 'git', slug: 'pack', url: 'https://example.test/pack.git' },
      { id: 'delta', action: 'already-added', kind: 'git', slug: 'pack', url: 'https://example.test/pack.git' },
    ])
    expect(response.body.skipped).toEqual([])
  })

  it('stops rather than looping when two catalog entries require each other', async () => {
    await writeCatalog([
      { id: 'alpha', name: 'Alpha', source: { kind: 'git', url: 'https://example.test/alpha.git' }, requires: { omega: '^1' } },
      { id: 'omega', name: 'Omega', source: { kind: 'git', url: 'https://example.test/omega.git' }, requires: { alpha: '^1' } },
    ])
    installedSources.push(view('beta', [{ id: 'beta' }]))
    await unmet([blocked('beta', [{ id: 'alpha', range: '^1' }])])

    const response = await request(app({ walnutHome: home }))
      .post('/api/plugin-sources/beta/dependencies')
      .expect(200)

    // Each id is visited once, so the walk ends even though the requires do not.
    expect(response.body.installed.map((entry: { id: string }) => entry.id)).toEqual(['alpha', 'omega'])
    expect(response.body.skipped).toEqual([])
  })

  it('follows a dependency chain three hops and refuses the fourth', async () => {
    await writeCatalog([
      { id: 'alpha', name: 'Alpha', source: { kind: 'git', url: 'https://example.test/alpha.git' }, requires: { hop2: '^1' } },
      { id: 'hop2', name: 'Hop 2', source: { kind: 'git', url: 'https://example.test/hop2.git' }, requires: { hop3: '^1' } },
      { id: 'hop3', name: 'Hop 3', source: { kind: 'git', url: 'https://example.test/hop3.git' }, requires: { hop4: '^1' } },
      { id: 'hop4', name: 'Hop 4', source: { kind: 'git', url: 'https://example.test/hop4.git' } },
    ])
    installedSources.push(view('beta', [{ id: 'beta' }]))
    await unmet([blocked('beta', [{ id: 'alpha', range: '^1' }])])

    const response = await request(app({ walnutHome: home }))
      .post('/api/plugin-sources/beta/dependencies')
      .expect(200)

    expect(response.body.installed.map((entry: { id: string }) => entry.id)).toEqual(['alpha', 'hop2', 'hop3'])
    expect(response.body.skipped).toEqual([{ id: 'hop4', reason: 'depth' }])
  })

  it('says unresolvable rather than guessing, and reports an installer failure', async () => {
    installedSources.push(view('beta', [{ id: 'beta' }]))
    await unmet([blocked('beta', [{ id: 'ghost', range: '^1' }])])

    const missing = await request(app({ walnutHome: home }))
      .post('/api/plugin-sources/beta/dependencies')
      .expect(200)
    expect(missing.body.skipped).toEqual([{ id: 'ghost', reason: 'unresolvable' }])

    await writeCatalog([
      { id: 'alpha', name: 'Alpha', source: { kind: 'git', url: 'https://example.test/alpha.git' } },
    ])
    await unmet([blocked('beta', [{ id: 'alpha', range: '^1' }])])
    sourceMocks.addSource.mockRejectedValueOnce(new Error('git clone failed'))
    const failed = await request(app({ walnutHome: home }))
      .post('/api/plugin-sources/beta/dependencies')
      .expect(200)
    expect(failed.body.skipped).toEqual([{ id: 'alpha', reason: 'error', error: 'git clone failed' }])
  })

  it('refuses an unknown or traversal-shaped slug before reading a catalog', async () => {
    await request(app({ walnutHome: home }))
      .post('/api/plugin-sources/..evil/dependencies')
      .expect(400, { error: 'invalid slug' })
    await request(app({ walnutHome: home }))
      .post('/api/plugin-sources/orphan/dependencies')
      .expect(404, { error: 'source not found' })
    expect(sourceMocks.addSource).not.toHaveBeenCalled()
  })
})

/**
 * The check and update actions feed the update-status cache the store's chips read from,
 * and both are bounded. Old response fields stay exactly as they were; `state` and
 * `checkedAt` ride alongside. The cache has fake ops: these routes only write it.
 */
describe('Plugin source check/update and the update-status cache', () => {
  function cacheFor() {
    return new UpdateStatusCache({
      filePath: path.join(os.tmpdir(), `plugin-sources-cache-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      ops: {
        checkLinked: vi.fn(async () => ({ behind: 0, ahead: 0, dirty: false, sha: 'a'.repeat(40), branch: 'main', fetched: true })),
        checkSource: vi.fn(async () => ({ behind: 0, updateAvailable: false })),
      },
    })
  }

  it('check answers the old fields plus the derived state, and writes the cache', async () => {
    const cache = cacheFor()
    sourceMocks.listSources.mockResolvedValue([source('acme-plugins')])
    sourceMocks.checkSource.mockResolvedValue({ behind: 3, updateAvailable: true })

    const response = await request(app({ cache })).post('/api/plugin-sources/acme-plugins/check').expect(200)

    expect(response.body).toMatchObject({ behind: 3, updateAvailable: true })
    expect(response.body.state).toEqual({ kind: 'available', behind: 3 })
    expect(Date.parse(response.body.checkedAt)).not.toBeNaN()
    expect(cache.entry(sourceRowKey('acme-plugins'))?.state).toEqual({ kind: 'available', behind: 3 })
    // The fetch ran unattended: no terminal prompt, no askpass window.
    const [, opts] = sourceMocks.checkSource.mock.calls[0] as [string, { env?: NodeJS.ProcessEnv }]
    expect(opts.env?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(opts.env?.GIT_ASKPASS).toBe('/usr/bin/true')
  })

  it('check without a cache answers exactly what it always did', async () => {
    sourceMocks.listSources.mockResolvedValue([source('acme-plugins')])
    sourceMocks.checkSource.mockResolvedValue({ behind: 0, updateAvailable: false })

    const response = await request(app()).post('/api/plugin-sources/acme-plugins/check').expect(200)

    expect(response.body).toEqual({ behind: 0, updateAvailable: false })
  })

  it('check on a source that is not cloned here derives missing, never unreachable (C47)', async () => {
    const cache = cacheFor()
    sourceMocks.listSources.mockResolvedValue([source('acme-plugins', { cloned: false })])
    sourceMocks.checkSource.mockResolvedValue({ behind: 0, updateAvailable: false, error: 'fatal: not a git repository' })

    const response = await request(app({ cache })).post('/api/plugin-sources/acme-plugins/check').expect(200)

    expect(response.body.state).toEqual({ kind: 'missing' })
  })

  it('npm check carries the version an update would move to', async () => {
    const cache = cacheFor()
    sourceMocks.listSources.mockResolvedValue([source('npm-sample', { kind: 'npm', url: undefined, spec: '@acme/plugin', resolved: '@acme/plugin@1.2.0' })])
    sourceMocks.checkSource.mockResolvedValue({ behind: 1, updateAvailable: true, resolved: '@acme/plugin@1.3.0' })

    const response = await request(app({ cache })).post('/api/plugin-sources/npm-sample/check').expect(200)

    expect(response.body).toMatchObject({ behind: 1, updateAvailable: true, resolved: '@acme/plugin@1.3.0' })
    expect(response.body.state).toEqual({ kind: 'available', toVersion: '1.3.0' })
  })

  it('update marks the row current at the sha that landed and keeps restartRequired', async () => {
    const cache = cacheFor()
    sourceMocks.listSources.mockResolvedValue([source('acme-plugins')])
    sourceMocks.updateSource.mockResolvedValue({ updated: true, fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40) })
    const softReload = vi.fn(async () => undefined)

    const response = await request(app({ cache }, softReload)).post('/api/plugin-sources/acme-plugins/update').expect(200)

    expect(response.body).toMatchObject({ updated: true, fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40), restartRequired: false, state: { kind: 'current' } })
    expect(Date.parse(response.body.checkedAt)).not.toBeNaN()
    expect(cache.entry(sourceRowKey('acme-plugins'))?.state).toEqual({ kind: 'current' })
    expect(softReload).toHaveBeenCalledTimes(1)
  })

  it('a restored clone (was cloned:false) is current afterwards, so Restore turns into Up to date', async () => {
    const cache = cacheFor()
    sourceMocks.listSources.mockResolvedValue([source('acme-plugins', { cloned: false, plugins: [] })])
    sourceMocks.checkSource.mockResolvedValue({ behind: 0, updateAvailable: false, error: 'ENOENT: no such file or directory' })
    await request(app({ cache })).post('/api/plugin-sources/acme-plugins/check').expect(200)
    expect(cache.entry(sourceRowKey('acme-plugins'))?.state).toEqual({ kind: 'missing' })
    sourceMocks.updateSource.mockResolvedValue({ updated: true, toSha: 'c'.repeat(40) })

    const response = await request(app({ cache })).post('/api/plugin-sources/acme-plugins/update').expect(200)

    expect(response.body.state).toEqual({ kind: 'current' })
    expect(cache.entry(sourceRowKey('acme-plugins'))?.state).toEqual({ kind: 'current' })
  })

  it('a failed update answers 502 with one scrubbed sentence, the cause and the raw text as detail (N1), leaving the row as it was', async () => {
    const cache = cacheFor()
    sourceMocks.listSources.mockResolvedValue([source('acme-plugins')])
    sourceMocks.updateSource.mockResolvedValue({ updated: false, error: 'fatal: Not possible to fast-forward, aborting.' })

    const response = await request(app({ cache })).post('/api/plugin-sources/acme-plugins/update').expect(502)

    // The row reports it; the request logger must not add an incident card (N3-1).
    expect(response.headers['x-walnut-handled-failure']).toBe('1')
    expect(response.body).toEqual({
      updated: false,
      error: 'not possible to fast-forward, aborting.',
      cause: 'unknown',
      detail: 'fatal: Not possible to fast-forward, aborting.',
      restartRequired: false,
    })
    expect(cache.entry(sourceRowKey('acme-plugins'))).toBeUndefined()

    // A remote that is gone: the sentence names no path and no host; Details keeps the raw text (credentials masked).
    sourceMocks.updateSource.mockResolvedValue({ updated: false, error: "git exited 1: fatal: 'https://someone:tok@example.invalid/acme/plugins.git' does not appear to be a git repository\nfatal: Could not read from remote repository." })
    const gone = await request(app({ cache })).post('/api/plugin-sources/acme-plugins/update').expect(502)
    expect(gone.body.error).toBe("'the remote' does not appear to be a git repository.")
    expect(gone.body.error).not.toMatch(/\/|@|fatal|git exited/)
    expect(gone.body.detail).toContain('***@example.invalid')
    expect(gone.body.detail).not.toContain('tok@')
    sourceMocks.updateSource.mockResolvedValue({ updated: false, error: 'ssh: Could not resolve hostname example.invalid: nodename nor servname provided' })
    const offline = await request(app({ cache })).post('/api/plugin-sources/acme-plugins/update').expect(502)
    expect(offline.body).toMatchObject({ error: 'the remote could not be reached.', cause: 'network' })
  })

  it('an update that replaced loaded code marks those plugins pending-restart in the sources list (N7)', async () => {
    const { registry } = await import('../../../src/core/integration-registry.js')
    const { clearRestartPendingForTesting, isRestartPending } = await import('../../../src/core/plugins/restart-pending.js')
    clearRestartPendingForTesting()
    ;(registry.has as ReturnType<typeof vi.fn>).mockImplementation((id: string) => id === 'acme-tracker')
    const loaded = source('acme-plugins', { plugins: [{ dir: '/x/acme-plugins/acme-tracker', id: 'acme-tracker', name: 'Acme Tracker', version: '1.0.0' }] })
    sourceMocks.listSources.mockResolvedValue([loaded])
    sourceMocks.updateSource.mockResolvedValue({ updated: true, fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40) })
    try {
      const before = await request(app()).get('/api/plugin-sources').expect(200)
      expect(before.body[0].plugins[0].status).toBe('loaded')

      const updated = await request(app()).post('/api/plugin-sources/acme-plugins/update').expect(200)
      expect(updated.body.restartRequired).toBe(true)
      expect(isRestartPending('acme-tracker')).toBe(true)

      const after = await request(app()).get('/api/plugin-sources').expect(200)
      expect(after.body[0].plugins[0].status).toBe('pending-restart')
    } finally {
      clearRestartPendingForTesting()
      ;(registry.has as ReturnType<typeof vi.fn>).mockImplementation(() => false)
    }
  })

  it('update answers 504 past its deadline and does not mark the row current', async () => {
    const cache = cacheFor()
    sourceMocks.listSources.mockResolvedValue([source('acme-plugins')])
    sourceMocks.updateSource.mockReturnValue(new Promise(() => undefined))
    const softReload = vi.fn(async () => undefined)

    const response = await request(app({ cache, updateDeadlineMs: 50 }, softReload)).post('/api/plugin-sources/acme-plugins/update').expect(504)

    expect(response.body).toEqual({ error: 'Update timed out after 60 s. The checkout was not changed unless git finished on its own; check again.' })
    expect(response.headers['x-walnut-handled-failure']).toBe('1')
    expect(cache.entry(sourceRowKey('acme-plugins'))).toBeUndefined()
    expect(softReload).not.toHaveBeenCalled()
  })
})
