/**
 * The Walnut browser extension set up from Walnut itself (Settings, Browser extension, Set up in
 * Chrome). A browser lets only the person load an extension that is not from its store (Chrome's
 * Developer mode and Load unpacked), so Walnut does everything around those two clicks: it puts
 * the extension this server ships into a folder of its own on this machine, copies the folder's
 * path, and opens the browser's extensions page.
 *
 * The folder is kept current: whenever the extension asks which build Walnut holds
 * (GET /api/v1/browser/panel), a folder that holds an older build is replaced first, and the
 * extension, seeing a newer build, reloads itself from it (background.ts selfUpdate). So an
 * extension set up this way updates with every Walnut deploy.
 *
 * Where: macOS ~/Library/Application Support/Walnut/Browser Extension/<browser>, Windows
 * %LOCALAPPDATA%\Walnut\Browser Extension\<browser>, else $XDG_DATA_HOME (~/.local/share)/
 * walnut/browser-extension/<browser>: per machine, never synced, never a cache a cleanup
 * may take (the browser loads the extension from it on every start). A throwaway server (an
 * ephemeral one, a data home in a temp dir) uses its own data home instead and opens nothing.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import { IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'
import { isThrowawayDataDir } from '../helper-build.js'
import { resolveStaticDir } from '../../web/static-dir.js'

export type ExtBrowser = 'chrome' | 'firefox'
export const EXT_BROWSERS: readonly ExtBrowser[] = ['chrome', 'firefox']

export interface BundledExtension { version: string; build: string }

/** This server is a real install on the person's machine (not a test or ephemeral one). */
export function realInstall(): boolean {
  return !IS_EPHEMERAL && !isThrowawayDataDir(WALNUT_HOME)
}

export function installRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (env.WALNUT_EXTENSION_INSTALL_DIR) return env.WALNUT_EXTENSION_INSTALL_DIR
  if (!realInstall()) return path.join(WALNUT_HOME, 'browser-extension')
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Walnut', 'Browser Extension')
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Walnut', 'Browser Extension')
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'walnut', 'browser-extension')
}

const downloads = () => path.join(resolveStaticDir(import.meta.url), 'downloads')

/** The build this server ships (scripts/build-extension.mjs writes it beside the zips). */
export function bundledExtension(dir = downloads()): BundledExtension | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'walnut-extension.json'), 'utf8')) as Partial<BundledExtension>
    return typeof j.build === 'string' && j.build ? { version: String(j.version ?? ''), build: j.build } : null
  } catch { return null }
}

/** `0.6.25 build 1a2b3c4d5e6f` → `1a2b3c4d5e6f` (the build an extension's manifest names). */
export function buildOfVersionName(v: unknown): string | null {
  const m = typeof v === 'string' ? /\bbuild ([0-9a-f]{6,64})\b/.exec(v) : null
  return m ? m[1] : null
}

/** The build a set-up folder holds, or null when there is none. */
export function installedBuild(browser: ExtBrowser, root = installRoot()): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, browser, 'manifest.json'), 'utf8')) as { version_name?: string }
    return buildOfVersionName(m.version_name)
  } catch { return null }
}

// ── a zip reader for the zips build-extension writes (stored or deflated, no zip64) ──

export function readZip(buf: Buffer): Array<{ name: string; data: Buffer }> {
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new Error('not a zip')
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const out: Array<{ name: string; data: Buffer }> = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory')
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + size)
    // Every name stays inside the folder: no absolute path, no `..` segment.
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some((s) => s === '..')) throw new Error(`unsafe name in zip: ${name}`)
    if (name.endsWith('/')) continue
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : (() => { throw new Error(`zip method ${method}`) })() })
  }
  return out
}

/** One setup or refresh at a time per folder: two at once would swap one folder twice. */
const inFlight = new Map<string, Promise<{ dir: string; build: string | null }>>()

/** Puts the extension this server ships into the folder (a whole new folder, swapped in). */
export function installExtension(browser: ExtBrowser, root = installRoot(), from = downloads()): Promise<{ dir: string; build: string | null }> {
  const key = path.join(root, browser)
  const running = inFlight.get(key)
  if (running) return running
  const work = (async () => {
    const zip = await fsp.readFile(path.join(from, `walnut-extension-${browser}.zip`))
    const files = readZip(zip)
    if (!files.some((f) => f.name === 'manifest.json')) throw new Error('the extension zip has no manifest')
    await fsp.mkdir(root, { recursive: true })
    const next = `${key}.new-${process.pid}`
    const old = `${key}.old-${process.pid}`
    await fsp.rm(next, { recursive: true, force: true })
    for (const f of files) {
      const to = path.join(next, f.name)
      await fsp.mkdir(path.dirname(to), { recursive: true })
      await fsp.writeFile(to, f.data)
    }
    // The browser reads the folder at its own times: it moves aside and back in one rename each.
    await fsp.rm(old, { recursive: true, force: true })
    if (fs.existsSync(key)) await fsp.rename(key, old)
    await fsp.rename(next, key)
    await fsp.rm(old, { recursive: true, force: true })
    return { dir: key, build: installedBuild(browser, root) }
  })()
  inFlight.set(key, work)
  return work.finally(() => { if (inFlight.get(key) === work) inFlight.delete(key) })
}

/**
 * A set-up folder holding an older build gets this server's (no folder: nothing happens, since
 * only the person sets one up). Returns the browsers refreshed.
 */
export async function refreshInstalled(root = installRoot(), from = downloads()): Promise<ExtBrowser[]> {
  const bundled = bundledExtension(from)
  if (!bundled) return []
  const done: ExtBrowser[] = []
  for (const b of EXT_BROWSERS) {
    if (!fs.existsSync(path.join(root, b, 'manifest.json'))) continue
    if (installedBuild(b, root) === bundled.build) continue
    await installExtension(b, root, from)
    done.push(b)
  }
  return done
}

function run(cmd: string, args: string[], input?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child
    try { child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] }) } catch { resolve(false); return }
    const t = setTimeout(() => { child.kill(); resolve(false) }, 8000)
    child.on('error', () => { clearTimeout(t); resolve(false) })
    child.on('exit', (code) => { clearTimeout(t); resolve(code === 0) })
    if (input !== undefined) child.stdin?.end(input)
  })
}

/**
 * On this Mac: the folder's path on the clipboard (for the folder window's Go to Folder), and
 * the browser's extensions page opened. Elsewhere, and on a throwaway server, nothing: the page
 * shows the path and the steps.
 */
export async function openForSetup(browser: ExtBrowser, dir: string): Promise<{ copied: boolean; opened: boolean }> {
  if (process.platform !== 'darwin' || !realInstall()) return { copied: false, opened: false }
  const copied = await run('pbcopy', [], dir)
  const opened = browser === 'chrome'
    ? await run('open', ['-b', 'com.google.Chrome', 'chrome://extensions/'])
    : await run('open', ['-b', 'org.mozilla.firefox', 'about:debugging#/runtime/this-firefox'])
  return { copied, opened }
}
