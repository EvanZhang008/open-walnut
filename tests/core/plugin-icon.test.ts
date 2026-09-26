/**
 * The manifest `icon` field: the server-side path rule, the file lookup behind the icon
 * route, and the author CLI's `validate`, which must agree on what a usable icon is.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_ICON_MAX_BYTES,
  findPluginIcon,
  pluginIconUrl,
  validatePluginIconPath,
} from '../../src/core/plugins/plugin-icon.js'
import { validatePlugin } from '../../packages/plugin-cli/src/manifest.js'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>'
const roots: string[] = []

async function pluginDir(manifest: Record<string, unknown>, files: Record<string, string> = {}): Promise<string> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'plugin-icon-'))
  roots.push(base)
  const dir = path.join(base, 'acme-plugin')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'acme-plugin',
    name: 'Acme Plugin',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    ...manifest,
  }))
  for (const [rel, body] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fsp.writeFile(path.join(dir, rel), body)
  }
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })))
})

describe('validatePluginIconPath', () => {
  it('accepts a relative .svg path and normalizes it', () => {
    expect(validatePluginIconPath('icon.svg')).toEqual({ ok: true, rel: 'icon.svg' })
    expect(validatePluginIconPath('./assets/Icon.SVG')).toEqual({ ok: true, rel: 'assets/Icon.SVG' })
    expect(validatePluginIconPath('assets\\icon.svg')).toEqual({ ok: true, rel: 'assets/icon.svg' })
    // `..` is a segment rule, not a substring rule.
    expect(validatePluginIconPath('v1..2.svg')).toEqual({ ok: true, rel: 'v1..2.svg' })
  })

  it.each([
    ['../x.svg', 'inside the plugin folder'],
    ['assets/../../x.svg', 'inside the plugin folder'],
    ['/abs.svg', 'not an absolute path'],
    ['C:/icons/x.svg', 'not an absolute path'],
    ['https://example.com/x.svg', 'not a URL'],
    ['data:image/svg+xml,<svg/>', 'not a URL'],
    ['icon.png', 'must be an .svg file'],
    ['', 'must name a file'],
    [42, 'must name a file'],
  ])('rejects %j in plain words', (raw, words) => {
    const checked = validatePluginIconPath(raw)
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.error).toContain(words)
  })
})

describe('findPluginIcon', () => {
  it('finds the declared SVG and builds a versioned URL', async () => {
    const dir = await pluginDir({ icon: 'icon.svg' }, { 'icon.svg': SVG })
    const found = await findPluginIcon(dir)
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.size).toBe(SVG.length)
    expect(pluginIconUrl('acme-plugin', found)).toMatch(/^\/api\/plugin-runtime\/acme-plugin\/icon\?v=[a-z0-9]+-[a-z0-9]+$/)
  })

  it('reports no icon when the manifest declares none or the file is missing', async () => {
    expect(await findPluginIcon(await pluginDir({}))).toMatchObject({ ok: false, status: 404 })
    expect(await findPluginIcon(await pluginDir({ icon: 'icon.svg' }))).toMatchObject({ ok: false, status: 404 })
  })

  it('never reads outside the plugin folder, through ".." or a symlink', async () => {
    const dir = await pluginDir({ icon: '../outside.svg' })
    await fsp.writeFile(path.join(path.dirname(dir), 'outside.svg'), SVG)
    expect(await findPluginIcon(dir)).toMatchObject({ ok: false, status: 404 })

    const linked = await pluginDir({ icon: 'icon.svg' })
    await fsp.symlink(path.join(path.dirname(dir), 'outside.svg'), path.join(linked, 'icon.svg'))
    expect(await findPluginIcon(linked)).toMatchObject({ ok: false, error: expect.stringContaining('inside the plugin folder') })
  })

  it('refuses an icon over the size cap', async () => {
    const big = `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(PLUGIN_ICON_MAX_BYTES)}--></svg>`
    const dir = await pluginDir({ icon: 'icon.svg' }, { 'icon.svg': big })
    expect(await findPluginIcon(dir)).toMatchObject({ ok: false, status: 413, error: expect.stringContaining('64 KB') })
  })
})

describe('walnut-plugin validate: icon', () => {
  it('accepts an icon.svg that exists', async () => {
    const dir = await pluginDir({ icon: 'icon.svg', web: 'dist/web.mjs' }, { 'icon.svg': SVG })
    expect((await validatePlugin(dir)).errors).toEqual([])
  })

  it.each([
    ['../x.svg', 'manifest.icon must be a path inside the plugin folder'],
    ['/abs.svg', 'manifest.icon must be a path inside the plugin folder'],
    ['icon.png', 'manifest.icon must be an .svg file'],
    ['missing.svg', 'manifest.icon file does not exist: missing.svg'],
    ['icon#1.svg', 'manifest.icon contains characters a file name cannot use here'],
  ])('rejects %j', async (icon, message) => {
    const dir = await pluginDir({ icon, web: 'dist/web.mjs' }, { 'icon.png': 'png' })
    expect((await validatePlugin(dir)).errors).toEqual([expect.stringContaining(message)])
  })

  it('rejects an icon the host would refuse for its size, so it never ships as a silent monogram', async () => {
    const big = `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(PLUGIN_ICON_MAX_BYTES)}--></svg>`
    const dir = await pluginDir({ icon: 'icon.svg', web: 'dist/web.mjs' }, { 'icon.svg': big })
    expect(await findPluginIcon(dir)).toMatchObject({ ok: false, status: 413 })
    expect((await validatePlugin(dir)).errors).toEqual([expect.stringContaining('an icon must be at most 64 KB')])
  })
})
