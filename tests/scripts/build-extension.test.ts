/**
 * scripts/build-extension.mjs: the two manifests (what each browser needs, and no permission
 * beyond what the extension uses), and the zip it writes reads back byte for byte. Plus the
 * name a connected extension gets in Settings (browser-pair.ts extensionDeviceName).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
// @ts-expect-error a plain .mjs script with no types
import { manifestFor, writeZip } from '../../scripts/build-extension.mjs'
import { extensionDeviceName } from '../../src/web/routes/browser-pair'

describe('extension manifests', () => {
  it('Chrome runs a service worker, Firefox an event page with its gecko id', () => {
    const c = manifestFor('chrome')
    const f = manifestFor('firefox')
    expect(c.manifest_version).toBe(3)
    expect(c.background).toEqual({ service_worker: 'background.js' })
    expect(c.browser_specific_settings).toBeUndefined()
    expect(f.background).toEqual({ scripts: ['background.js'] })
    expect(f.browser_specific_settings.gecko.id).toMatch(/@/)
    expect(f.browser_specific_settings.gecko.strict_min_version).toBe('128.0') // host permissions granted at install
    expect(f.browser_specific_settings.gecko.data_collection_permissions).toEqual({ required: ['none'] })
    expect(c.version).toMatch(/^\d+(\.\d+){0,3}$/)
  })

  it('asks for storage and web pages only, and exposes only the two framed pages', () => {
    for (const b of ['chrome', 'firefox']) {
      const m = manifestFor(b)
      expect(m.permissions).toEqual(['storage'])
      expect(m.host_permissions).toEqual(['http://*/*', 'https://*/*'])
      expect(m.web_accessible_resources).toEqual([{ resources: ['menu.html', 'savebar.html'], matches: ['http://*/*', 'https://*/*'] }])
      expect(m.content_scripts[0].all_frames).toBe(true)
    }
  })
})

describe('writeZip', () => {
  it('writes a zip whose entries read back as the files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-src-'))
    fs.mkdirSync(path.join(dir, 'icons'))
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"a":1}\n')
    fs.writeFileSync(path.join(dir, 'icons', '16.png'), Buffer.from([0, 1, 2, 3, 255]))
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zip-out-')), 'x.zip')
    writeZip(dir, out)
    const buf = fs.readFileSync(out)
    const got: Record<string, Buffer> = {}
    let off = 0
    while (buf.readUInt32LE(off) === 0x04034b50) {
      const size = buf.readUInt32LE(off + 18)
      const nameLen = buf.readUInt16LE(off + 26)
      const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8')
      const data = buf.subarray(off + 30 + nameLen, off + 30 + nameLen + size)
      got[name] = inflateRawSync(data)
      off += 30 + nameLen + size
    }
    expect(Object.keys(got).sort()).toEqual(['icons/16.png', 'manifest.json'])
    expect(got['manifest.json'].toString()).toBe('{"a":1}\n')
    expect([...got['icons/16.png']]).toEqual([0, 1, 2, 3, 255])
    // The end record counts both entries.
    expect(buf.readUInt16LE(buf.length - 22 + 10)).toBe(2)
  })
})

describe('extensionDeviceName', () => {
  it('names the browser and the computer', () => {
    expect(extensionDeviceName('Mac Chrome')).toBe('Walnut extension (Chrome on Mac)')
    expect(extensionDeviceName('Windows Firefox')).toBe('Walnut extension (Firefox on Windows)')
    expect(extensionDeviceName('Android phone Chrome')).toBe('Walnut extension (Chrome on Android phone)')
    expect(extensionDeviceName('Browser')).toBe('Walnut extension')
  })
})
