#!/usr/bin/env bun
/**
 * The Walnut extension's Chrome Web Store submission in one folder, ready to upload by hand
 * (submitting is the maintainer's step: it publishes under their developer account):
 *
 *   <out>/walnut-extension-chrome-<version>.zip   the upload (the Chrome build, as Load unpacked takes it)
 *   <out>/icon-128.png                            the store icon
 *   <out>/LISTING.md, <out>/PRIVACY.md            the listing text, permission reasons, privacy policy
 *   <out>/screenshots/                            put the 1280x800 screenshots here (LISTING.md, Images)
 *
 * Usage: bun scripts/extension-store-package.mjs [--out <dir>]   (default dist/extension-store)
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { writeZip } from './build-extension.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(ROOT, 'dist/extension-store')
/** Marks a folder this script made: only such a folder (or an empty one) is replaced. */
const MARK = '.walnut-extension-store'
if (!OUT) throw new Error('extension-store-package: --out needs a folder')
if (existsSync(OUT) && readdirSync(OUT).length && !existsSync(join(OUT, MARK))) {
  throw new Error(`extension-store-package: ${OUT} holds other files; name an empty or new folder`)
}

const built = mkdtempSync(join(tmpdir(), 'walnut-ext-store-'))
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/build-extension.mjs'), '--out', built, '--no-zip'], { stdio: 'inherit' })
  const chrome = join(built, 'chrome')
  const manifest = JSON.parse(readFileSync(join(chrome, 'manifest.json'), 'utf8'))
  // The store takes no key and no update address of its own: it signs and updates the copy itself.
  for (const k of ['key', 'update_url']) if (k in manifest) throw new Error(`extension-store-package: the manifest carries ${k}`)
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'screenshots'), { recursive: true })
  writeFileSync(join(OUT, MARK), '')
  const zip = join(OUT, `walnut-extension-chrome-${manifest.version}.zip`)
  writeZip(chrome, zip)
  copyFileSync(join(chrome, 'icons/128.png'), join(OUT, 'icon-128.png'))
  for (const f of ['LISTING.md', 'PRIVACY.md']) copyFileSync(join(ROOT, 'packages/browser-extension/store', f), join(OUT, f))
  console.log(`extension-store-package: ${manifest.version_name ?? manifest.version} → ${relative(ROOT, OUT) || OUT}`)
} finally {
  rmSync(built, { recursive: true, force: true })
}
