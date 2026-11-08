#!/usr/bin/env bun
/**
 * Builds the Walnut browser extension (packages/browser-extension) for Chrome and Firefox:
 *
 *   dist/extension/chrome/     load this with "Load unpacked"
 *   dist/extension/firefox/    load its manifest.json in about:debugging
 *   dist/web/static/downloads/walnut-extension-{chrome,firefox}.zip
 *                              what Settings → Passwords and /connect-extension offer
 *   dist/web/static/downloads/walnut-extension.json
 *                              { version, build }: the build those zips hold
 *
 * One source, two manifests: Chrome runs the background as a service worker, Firefox as an
 * event page (background.scripts) and needs a gecko id. Every script is one classic file
 * (content scripts cannot be modules), so nothing is split or loaded at run time.
 *
 * Usage: bun scripts/build-extension.mjs [--out <dir>] [--no-zip]
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'packages/browser-extension/src')
const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(ROOT, 'dist/extension')
const ZIP_DIR = join(ROOT, 'dist/web/static/downloads')
const zip = !args.includes('--no-zip')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
// A browser takes 1 to 4 dot-separated numbers only.
const version = String(pkg.version).split(/[-+]/)[0].split('.').slice(0, 4).map((n) => String(Number(n) || 0)).join('.')

const ENTRIES = ['background', 'content', 'popup', 'menu', 'savebar', 'sidepanel']
/**
 * Each page: its body class, its html class, and the script it runs (its own name's by default).
 * popup-ask.html is the toolbar popup on Ask: the side panel's page in its popup form (sidepanel.ts),
 * which shows the vault popup (popup.html) instead for a Walnut older than that.
 */
const PAGES = {
  popup: { body: 'popup' },
  menu: { body: 'menu', html: 'frame' },
  savebar: { body: 'bar', html: 'frame' },
  sidepanel: { body: 'sidepanel', html: 'panel' },
  'popup-ask': { body: 'sidepanel askpop', html: 'panel askpop', script: 'sidepanel' },
}
const SITES = ['http://*/*', 'https://*/*']

/**
 * `build`: the hash of what the extension runs (its scripts, pages and styles). The manifest
 * carries it in `version_name`, and walnut-extension.json beside the zips names it, so a copy
 * Walnut set up in a folder (Settings, Set up in Chrome) knows when Walnut holds a newer one
 * and reloads itself (background.ts selfUpdate): the version number alone stays the same
 * across many deploys.
 */
export function manifestFor(browser, build) {
  const m = {
    manifest_version: 3,
    name: 'Walnut',
    short_name: 'Walnut',
    version,
    ...(build ? { version_name: `${version} build ${build}` } : {}),
    description: 'Your own Walnut in the browser: ask Walnut about the page you are on, let your agents work here, and fill passwords from your vault.',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: { default_title: 'Walnut', default_popup: 'popup-ask.html', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
    background: browser === 'chrome' ? { service_worker: 'background.js' } : { scripts: ['background.js'] },
    content_scripts: [{ matches: SITES, js: ['content.js'], all_frames: true, run_at: 'document_idle' }],
    // alarms: agents in this browser (agent.ts) come back after the background was stopped.
    // contextMenus: "Ask Walnut about ..." on a selection or a page, which opens the side panel.
    // downloads: an agent sees the downloads it started (agent-downloads.ts).
    // clipboardRead/Write: a copied password or code is cleared after 30 s only if it is still
    // there (bg-clipboard.ts); offscreen: Chrome writes the clipboard from an offscreen page.
    // idle: Passwords lock when the computer locks or goes idle (bg-autolock.ts).
    // tabGroups: each task's agent tabs sit in one group named walnut-<task name> (agent-groups.ts).
    permissions: ['storage', 'alarms', 'contextMenus', 'scripting', 'downloads', 'clipboardRead', 'clipboardWrite', 'idle',
      ...(browser === 'chrome' ? ['sidePanel', 'offscreen', 'tabGroups'] : [])],
    // Real mouse and keys for agents (agent-trusted.ts): Chrome's debugger, only once the person
    // turns it on in Settings (the browser asks them then). Firefox gives extensions none.
    ...(browser === 'chrome' ? { optional_permissions: ['debugger'] } : {}),
    // Every web page (the same warning as http and https alone): a screenshot of an agent's
    // tab (captureVisibleTab) needs all URLs, so it is asked once, at install.
    host_permissions: ['<all_urls>'],
    // The in-page menu and save bar are this extension's pages framed into a site.
    web_accessible_resources: [{ resources: ['menu.html', 'savebar.html'], matches: SITES }],
    commands: {
      'fill-login': { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' }, description: 'Fill the login for this page' },
    },
  }
  // Walnut beside the page (sidepanel.ts): Chrome's side panel, Firefox's sidebar.
  if (browser === 'chrome') m.side_panel = { default_path: 'sidepanel.html' }
  else m.sidebar_action = { default_panel: 'sidepanel.html', default_title: 'Walnut', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' }, open_at_install: false }
  if (browser === 'firefox') {
    // It collects nothing: everything stays between the browser and the person's own Walnut.
    m.browser_specific_settings = { gecko: { id: 'extension@openwalnut.dev', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } } }
  }
  return m
}

function page(name) {
  const { body: bodyClass, html: htmlClass, script = name } = PAGES[name]
  return `<!doctype html>
<html lang="en"${htmlClass ? ` class="${htmlClass}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Walnut</title>
<link rel="stylesheet" href="ui.css">
</head>
<body class="${bodyClass}">
<div id="root"></div>
<script src="${script}.js"></script>
</body>
</html>
`
}

// ── a zip, deflated, no dependency ──

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function files(dir, base = dir) {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p, base) : [relative(base, p).split('\\').join('/')]
  })
}

export function writeZip(dir, to) {
  const local = []
  const central = []
  let offset = 0
  // A fixed time, so the same build makes the same zip.
  const dosTime = 0
  const dosDate = (2026 - 1980) << 9 | 1 << 5 | 1
  for (const name of files(dir)) {
    const data = readFileSync(join(dir, name))
    const packed = deflateRawSync(data, { level: 9 })
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8)
    head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12); head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28)
    local.push(head, nameBuf, packed)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(packed.length, 20)
    cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(0, 30); cen.writeUInt32LE(0, 34)
    cen.writeUInt32LE(0o100644 << 16 >>> 0, 38); cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += head.length + nameBuf.length + packed.length
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0)
  const end = Buffer.alloc(22)
  const count = central.length / 2
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10)
  end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16)
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, Buffer.concat([...local, ...central, end]))
}

// ── build ──

async function icons(dir) {
  const sharp = (await import('sharp')).default
  mkdirSync(join(dir, 'icons'), { recursive: true })
  const src = join(ROOT, 'web/public/walnut-icon.png')
  for (const size of [16, 32, 48, 128]) {
    await sharp(src).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(join(dir, 'icons', `${size}.png`))
  }
}

async function main() {
  const tmp = join(OUT, '.js')
  rmSync(OUT, { recursive: true, force: true })
  // Each entry on its own: one classic script per file, nothing shared at run time.
  for (const entry of ENTRIES) {
    const r = await Bun.build({
      entrypoints: [join(SRC, `${entry}.ts`)],
      outdir: tmp,
      target: 'browser',
      format: 'iife',
      // Readable as built: a store reviewer (and the person) can read what it runs.
      minify: false,
      sourcemap: 'none',
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    if (!r.success) {
      for (const log of r.logs) console.error(log)
      throw new Error(`build-extension: ${entry} failed`)
    }
  }
  // content.js may be put into a page twice (at load by the browser, and by page-reach.ts into a
  // tab older than the extension): a second run where a live copy already runs does nothing.
  const contentJs = join(tmp, 'content.js')
  writeFileSync(contentJs, `if (!(globalThis.__walnutContentLive && globalThis.__walnutContentLive())) {\n${readFileSync(contentJs, 'utf8')}\n}\n`)
  const h = createHash('sha256')
  for (const entry of ENTRIES) h.update(readFileSync(join(tmp, `${entry}.js`)))
  h.update(readFileSync(join(SRC, 'ui.css')))
  for (const name of Object.keys(PAGES)) h.update(page(name))
  const build = h.digest('hex').slice(0, 12)
  for (const browser of ['chrome', 'firefox']) {
    const dir = join(OUT, browser)
    mkdirSync(dir, { recursive: true })
    for (const entry of ENTRIES) copyFileSync(join(tmp, `${entry}.js`), join(dir, `${entry}.js`))
    copyFileSync(join(SRC, 'ui.css'), join(dir, 'ui.css'))
    for (const name of Object.keys(PAGES)) writeFileSync(join(dir, `${name}.html`), page(name))
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifestFor(browser, build), null, 2)}\n`)
    await icons(dir)
    if (zip) writeZip(dir, join(ZIP_DIR, `walnut-extension-${browser}.zip`))
  }
  if (zip) writeFileSync(join(ZIP_DIR, 'walnut-extension.json'), `${JSON.stringify({ version, build }, null, 2)}\n`)
  rmSync(tmp, { recursive: true, force: true })
  console.log(`build-extension: ${version} → ${relative(ROOT, OUT)}/{chrome,firefox}${zip ? ` and ${relative(ROOT, ZIP_DIR)}` : ''}`)
}

if (import.meta.main) await main()
