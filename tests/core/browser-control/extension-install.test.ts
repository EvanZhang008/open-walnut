/**
 * core/browser-control/extension-install.ts: the folder the extension is set up in (per platform,
 * a throwaway server's own data home), the zips build-extension writes read back, a folder
 * swapped in whole (one at a time), and a refresh that touches only a folder the person set up.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-ext-install'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  MARKER, buildOfVersionName, bundledExtension, folderId, installExtension, installRoot, installedBuild, readMarker, readZip, refreshInstalled,
} from '../../../src/core/browser-control/extension-install'
// @ts-expect-error a plain .mjs script with no types
import { manifestFor, writeZip } from '../../../scripts/build-extension.mjs'

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `walnut-ext-${name}-`))
}

/** A downloads dir as the build makes it: both zips and walnut-extension.json, for `build`. */
function downloads(build: string, extra: Record<string, string> = {}): string {
  const dl = tmp('dl')
  for (const b of ['chrome', 'firefox']) {
    const src = tmp(`src-${b}`)
    fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify(manifestFor(b, build)))
    fs.mkdirSync(path.join(src, 'icons'))
    fs.writeFileSync(path.join(src, 'icons', '16.png'), Buffer.from([1, 2, 3]))
    fs.writeFileSync(path.join(src, 'background.js'), `// ${b} ${build}\n`)
    for (const [n, v] of Object.entries(extra)) fs.writeFileSync(path.join(src, n), v)
    writeZip(src, path.join(dl, `walnut-extension-${b}.zip`))
  }
  fs.writeFileSync(path.join(dl, 'walnut-extension.json'), JSON.stringify({ version: '0.6.25', build }))
  return dl
}

describe('where the extension is set up', () => {
  it('a throwaway server (a test, an ephemeral one) keeps it in its own data home', () => {
    expect(installRoot({}, 'darwin', '/Users/a')).toBe(path.join(WALNUT_HOME, 'browser-extension'))
    expect(installRoot({ WALNUT_EXTENSION_INSTALL_DIR: '/x/y' }, 'darwin', '/Users/a')).toBe('/x/y')
  })
})

describe('the build an extension names', () => {
  it('reads the build from the manifest\'s version_name', () => {
    expect(manifestFor('chrome', 'abc123def456').version_name).toBe(`${manifestFor('chrome').version} build abc123def456`)
    expect(manifestFor('chrome').version_name).toBeUndefined()
    expect(buildOfVersionName('0.6.25 build abc123def456')).toBe('abc123def456')
    expect(buildOfVersionName('0.6.25')).toBeNull()
    expect(buildOfVersionName(undefined)).toBeNull()
  })

  it('walnut-extension.json names the build the zips hold', () => {
    expect(bundledExtension(downloads('aaaaaa111111'))).toEqual({ version: '0.6.25', build: 'aaaaaa111111' })
    expect(bundledExtension(tmp('empty'))).toBeNull()
  })
})

describe('the zip and the folder', () => {
  it('reads back what build-extension wrote, nested folders included', () => {
    const dl = downloads('bbbbbb222222', { 'ui.css': 'body{}' })
    const files = readZip(fs.readFileSync(path.join(dl, 'walnut-extension-chrome.zip')))
    expect(files.map((f) => f.name).sort()).toEqual(['background.js', 'icons/16.png', 'manifest.json', 'ui.css'])
    expect(files.find((f) => f.name === 'icons/16.png')!.data).toEqual(Buffer.from([1, 2, 3]))
  })

  it('refuses a zip with a name that leaves the folder', () => {
    const dir = tmp('evil')
    fs.writeFileSync(path.join(dir, 'a.js'), 'x')
    const zip = path.join(dir, 'z.zip')
    writeZip(dir, zip)
    const buf = fs.readFileSync(zip)
    // Rename a.js to ../ (same length) in both headers.
    const evil = Buffer.from(buf.toString('latin1').split('a.js').join('../x'), 'latin1')
    expect(() => readZip(evil)).toThrow(/unsafe name/)
    expect(() => readZip(Buffer.from('not a zip at all, just some bytes'))).toThrow(/not a zip/)
  })

  it('sets the folder up whole, replaces it with a newer build, and runs one setup at a time', async () => {
    const root = tmp('root')
    const first = await installExtension('chrome', root, downloads('cccccc333333'))
    expect(first).toEqual({ dir: path.join(root, 'chrome'), build: 'cccccc333333' })
    fs.writeFileSync(path.join(root, 'chrome', 'stale.js'), 'old')
    const dl = downloads('dddddd444444')
    const [a, b] = await Promise.all([installExtension('chrome', root, dl), installExtension('chrome', root, dl)])
    expect(a).toEqual(b)
    expect(installedBuild('chrome', root)).toBe('dddddd444444')
    // Whole: a file the new build does not have is gone; nothing half-made is left beside it.
    expect(fs.existsSync(path.join(root, 'chrome', 'stale.js'))).toBe(false)
    expect(fs.readdirSync(root).sort()).toEqual(['.walnut-folder-id', 'chrome'])
  })

  it('a refresh brings only a folder the person set up to this build', async () => {
    const root = tmp('refresh')
    expect(await refreshInstalled(root, downloads('eeeeee555555'))).toEqual([])
    expect(fs.readdirSync(root)).toEqual([])
    await installExtension('chrome', root, downloads('eeeeee555555'))
    expect(await refreshInstalled(root, downloads('eeeeee555555'))).toEqual([])
    expect(await refreshInstalled(root, downloads('ffffff666666'))).toEqual(['chrome'])
    expect(installedBuild('chrome', root)).toBe('ffffff666666')
    expect(fs.existsSync(path.join(root, 'firefox'))).toBe(false)
    // A folder set up from an older Walnut, before builds were named, is brought up too.
    fs.writeFileSync(path.join(root, 'chrome', 'manifest.json'), JSON.stringify(manifestFor('chrome')))
    expect(await refreshInstalled(root, downloads('ffffff666666'))).toEqual(['chrome'])
  })

  it('marks the folder as the one Walnut keeps, with one id kept across refreshes', async () => {
    const root = tmp('marker')
    expect(folderId(root)).toBeNull()
    await installExtension('chrome', root, downloads('aaaaaa111111'), 'http://localhost:3456')
    const id = folderId(root)
    expect(id).toMatch(/^[0-9a-f]{24}$/)
    expect(readMarker(path.join(root, 'chrome'))).toEqual({ folder: id, browser: 'chrome', serverUrl: 'http://localhost:3456' })
    // A refresh to a new build keeps the id and the address it had.
    expect(await refreshInstalled(root, downloads('bbbbbb222222'))).toEqual(['chrome'])
    expect(readMarker(path.join(root, 'chrome'))).toEqual({ folder: id, browser: 'chrome', serverUrl: 'http://localhost:3456' })
    // A folder an older Walnut set up (no marker) gets one without being replaced.
    fs.rmSync(path.join(root, 'chrome', MARKER))
    fs.writeFileSync(path.join(root, 'chrome', 'mine.txt'), 'kept')
    expect(await refreshInstalled(root, downloads('bbbbbb222222'), 'http://localhost:4000')).toEqual([])
    expect(readMarker(path.join(root, 'chrome'))).toEqual({ folder: id, browser: 'chrome', serverUrl: 'http://localhost:4000' })
    expect(fs.existsSync(path.join(root, 'chrome', 'mine.txt'))).toBe(true)
    // The zip itself never carries a marker: a copy unpacked anywhere else has none.
    expect(readZip(fs.readFileSync(path.join(downloads('cccccc333333'), 'walnut-extension-chrome.zip'))).some((f) => f.name === MARKER)).toBe(false)
  })
})
