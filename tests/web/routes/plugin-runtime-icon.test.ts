/**
 * GET /api/plugin-runtime/:id/icon and the `iconUrl` on store rows.
 *
 * Pins the contract the Settings tiles read: an installed plugin's icon comes from the
 * folder it runs from; a plugin that is not installed yet is found where its catalog
 * entry lives (the bundled store folder, the builtin folder, an example in the checkout);
 * a row advertises `iconUrl` only when the route would serve it; and the route never
 * serves a file outside the plugin folder.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import type { PluginLifecycleRecord } from '../../../src/core/plugins/plugin-manager.js'
import { createPluginRuntimeRouter } from '../../../src/web/routes/plugin-runtime.js'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>'

let base: string
let installedDirs: Map<string, string>

async function writePlugin(dir: string, id: string, extra: Record<string, unknown>, files: Record<string, string> = {}) {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: id, version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, ...extra,
  }))
  for (const [rel, body] of Object.entries(files)) await fsp.writeFile(path.join(dir, rel), body)
}

beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'plugin-icon-route-'))
  installedDirs = new Map()
  // Installed from a folder of its own, with an icon.
  await writePlugin(path.join(base, 'plugins', 'acme-plugin'), 'acme-plugin', { icon: 'icon.svg' }, { 'icon.svg': SVG })
  installedDirs.set('acme-plugin', path.join(base, 'plugins', 'acme-plugin'))
  // Installed, no icon: the row keeps its monogram.
  await writePlugin(path.join(base, 'plugins', 'plain-plugin'), 'plain-plugin', {})
  installedDirs.set('plain-plugin', path.join(base, 'plugins', 'plain-plugin'))
  // Installed, but its manifest tries to point outside the folder.
  await writePlugin(path.join(base, 'plugins', 'sneaky-plugin'), 'sneaky-plugin', { icon: '../secret.svg' })
  await fsp.writeFile(path.join(base, 'plugins', 'secret.svg'), SVG)
  installedDirs.set('sneaky-plugin', path.join(base, 'plugins', 'sneaky-plugin'))
  // Not installed: a bundled store row and an example row, both with icons.
  await writePlugin(path.join(base, 'store', 'store-plugin'), 'store-plugin', {
    icon: 'icon.svg', server: 'dist/server.mjs', catalog: { adds: ['App'] },
  }, { 'icon.svg': SVG })
  await writePlugin(path.join(base, 'checkout', 'examples', 'sample-plugin'), 'sample-plugin', { icon: 'icon.svg' }, { 'icon.svg': SVG })
  await fsp.mkdir(path.join(base, 'home'), { recursive: true })
  await fsp.writeFile(path.join(base, 'home', 'plugin-registry.json'), JSON.stringify({
    plugins: [
      { id: 'sample-plugin', name: 'Sample Plugin', source: { kind: 'example', path: 'examples/sample-plugin' } },
      { id: 'remote-plugin', name: 'Remote Plugin', source: { kind: 'git', url: 'https://example.com/remote-plugin.git' } },
      { id: 'escape-plugin', name: 'Escape Plugin', source: { kind: 'example', path: '../plugins/acme-plugin' } },
    ],
  }))
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

function record(id: string): PluginLifecycleRecord {
  return { id, name: id, state: 'active', builtin: false, failureCount: 0 }
}

function setup() {
  const deps = {
    registry: new IntegrationRegistry(),
    list: () => ['acme-plugin', 'plain-plugin', 'sneaky-plugin'].map(record),
    reload: vi.fn(),
    disable: vi.fn(),
    clearQuarantine: vi.fn(),
    pluginSourceOwners: async () => new Map<string, { slug: string; kind: 'git' | 'npm' }>(),
    unconfiguredSchemas: async () => new Map<string, Record<string, unknown> | undefined>(),
    linked: { detect: vi.fn(async () => null), list: vi.fn(async () => new Map()), check: vi.fn(), update: vi.fn() },
    walnutHome: path.join(base, 'home'),
    bundledStoreDir: path.join(base, 'store'),
    pluginDirOf: async (pluginId: string) => installedDirs.get(pluginId),
    builtinPluginDir: path.join(base, 'builtin'),
    exampleRoot: path.join(base, 'checkout'),
  }
  const app = express()
  app.use('/api/plugin-runtime', createPluginRuntimeRouter(deps as never))
  return app
}

describe('GET /api/plugin-runtime/:id/icon', () => {
  it('serves an installed plugin\'s SVG with a short cache and a locked-down CSP', async () => {
    const response = await request(setup()).get('/api/plugin-runtime/acme-plugin/icon').expect(200)
    expect(response.headers['content-type']).toMatch(/^image\/svg\+xml/)
    expect(response.headers['cache-control']).toBe('private, max-age=300')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.headers['content-security-policy']).toContain('sandbox')
    expect(Buffer.isBuffer(response.body) ? response.body.toString('utf-8') : response.text).toBe(SVG)
  })

  it('serves a bundled and an example plugin before they are installed', async () => {
    const app = setup()
    await request(app).get('/api/plugin-runtime/store-plugin/icon').expect(200).expect('Content-Type', /svg/)
    await request(app).get('/api/plugin-runtime/sample-plugin/icon').expect(200).expect('Content-Type', /svg/)
  })

  it('answers 404 for a plugin without an icon, and for one that is not here at all', async () => {
    const app = setup()
    const plain = await request(app).get('/api/plugin-runtime/plain-plugin/icon').expect(404)
    expect(plain.body.error).toContain('declares no icon')
    await request(app).get('/api/plugin-runtime/remote-plugin/icon').expect(404)
    await request(app).get('/api/plugin-runtime/nobody/icon').expect(404)
  })

  it('refuses traversal: in the manifest, in a catalog path, and in the request', async () => {
    const app = setup()
    const sneaky = await request(app).get('/api/plugin-runtime/sneaky-plugin/icon').expect(404)
    expect(sneaky.body.error).toContain('inside the plugin folder')
    // A catalog example path with `..` resolves to nothing, not to another plugin's folder.
    await request(app).get('/api/plugin-runtime/escape-plugin/icon').expect(404)
    await request(app).get('/api/plugin-runtime/..%2F..%2Fetc/icon').expect(400)
    await request(app).get('/api/plugin-runtime/Acme-Plugin/icon').expect(400)
  })
})

describe('GET /api/plugin-runtime/registry: iconUrl', () => {
  it('carries iconUrl exactly where the icon route would serve one', async () => {
    const app = setup()
    const response = await request(app).get('/api/plugin-runtime/registry').expect(200)
    const byId = new Map((response.body.rows as Array<{ id: string; installed: boolean; iconUrl?: string }>)
      .map((row) => [row.id, row]))

    expect(byId.get('acme-plugin')).toMatchObject({ installed: true, iconUrl: expect.stringMatching(/^\/api\/plugin-runtime\/acme-plugin\/icon\?v=/) })
    expect(byId.get('store-plugin')).toMatchObject({ installed: false, iconUrl: expect.stringMatching(/^\/api\/plugin-runtime\/store-plugin\/icon\?v=/) })
    expect(byId.get('sample-plugin')).toMatchObject({ installed: false, iconUrl: expect.stringMatching(/^\/api\/plugin-runtime\/sample-plugin\/icon\?v=/) })
    for (const id of ['plain-plugin', 'sneaky-plugin', 'remote-plugin', 'escape-plugin']) {
      expect(byId.get(id)?.iconUrl, id).toBeUndefined()
    }

    // Every advertised URL is one the route answers.
    for (const row of byId.values()) {
      if (row.iconUrl) await request(app).get(row.iconUrl).expect(200)
    }
  })
})
