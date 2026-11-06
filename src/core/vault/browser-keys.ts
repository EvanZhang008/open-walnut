/**
 * A Walnut window's own secret for sharing an unlock made on this computer (docs/reference/passwords.md,
 * "One unlock on this computer"). To Walnut, a page and a local process (an agent's curl) look the
 * same, so a window may share an unlock made elsewhere here (the extension's, another browser's) only
 * with a secret only that browser holds: its browser key. A window gets one when the person types the
 * master password in it (setup, unlock, recovery) on this computer's own path, and keeps it in its
 * localStorage (web/src/api/vault.ts); it sends it in `x-walnut-vault-browser`.
 *
 * `browsers.json` is a side file (state.ts), sealed with the vault key: what a process that cannot
 * open the vault writes there counts for nothing, and a key change reseals it. It holds only the
 * sha256 of each key, with when the browser last proved itself (a typed password or a share), and
 * forgets a browser unseen for KEEP_DAYS, and all but the newest MAX_BROWSERS. A key alone opens nothing:
 * it only lets a window share an unlock that is live now (sessions.joinSession).
 */
import crypto from 'node:crypto'
import { dir, openKey, openSide, updateSide } from './state.js'

export const BROWSER_HEADER = 'x-walnut-vault-browser'
const FILE = 'browsers.json' as const
const KEEP_DAYS = 90
const MAX_BROWSERS = 20
/** A share renews `at` at most this often (a write of the side file). */
const TOUCH_MS = 24 * 3_600_000
const CACHE_MS = 30_000

interface Entry { hash: string; at: number; client?: string }
interface BrowsersFile { version: 1; browsers: Entry[] }

function hashOf(key: string): string {
  return crypto.createHash('sha256').update(`walnut-vault-browser\0${key}`).digest('hex')
}

/** The id a browser's own lock and share are kept under (sessions.ts joinSource): never the key itself. */
export function windowJoiner(key: string): string {
  return `window:${hashOf(key).slice(0, 24)}`
}

const fresh = (e: Entry, now: number) => now - e.at <= KEEP_DAYS * 86_400_000

function pruned(list: Entry[], now: number): Entry[] {
  return list.filter((e) => e && typeof e.hash === 'string' && typeof e.at === 'number' && fresh(e, now))
    .sort((a, b) => b.at - a.at).slice(0, MAX_BROWSERS)
}

// A status read every few seconds by a locked window must not decrypt the file each time.
let cache: { where: string; at: number; byHash: Map<string, Entry> } | null = null

async function where(): Promise<string> {
  return `${await dir()}|${(await openKey()).vaultId}`
}

async function known(now: number): Promise<Map<string, Entry>> {
  const w = await where()
  if (cache && cache.where === w && now - cache.at < CACHE_MS) return cache.byHash
  const f = await openSide<BrowsersFile>(FILE)
  const byHash = new Map(pruned(Array.isArray(f?.browsers) ? f!.browsers : [], now).map((e) => [e.hash, e]))
  cache = { where: w, at: now, byHash }
  return byHash
}

/** A key that is not a well-formed one is never looked up. */
export const browserKeyShape = (key: string | undefined): key is string => typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key)
const shapeOk = browserKeyShape

/**
 * The window joiner id for a browser key this vault knows, or null. Needs the vault open (it is
 * whenever there is an unlock to share); a closed or unreadable vault knows no browser.
 */
export async function knownBrowser(key: string | undefined, now = Date.now()): Promise<string | null> {
  if (!shapeOk(key)) return null
  try {
    const e = (await known(now)).get(hashOf(key))
    return e && fresh(e, now) ? windowJoiner(key) : null
  } catch {
    return null
  }
}

/** A share renews the browser's record (at most once a day), so a browser in use is never forgotten. */
export async function touchBrowser(key: string, now = Date.now()): Promise<void> {
  if (!shapeOk(key)) return
  const h = hashOf(key)
  const e = (await known(now).catch(() => null))?.get(h)
  if (!e || now - e.at < TOUCH_MS) return
  await write((list) => list.map((x) => (x.hash === h ? { ...x, at: now } : x)), now).catch(() => undefined)
}

async function write(fn: (list: Entry[]) => Entry[], now: number): Promise<void> {
  cache = null
  await updateSide<BrowsersFile>(FILE, (cur) => ({ version: 1, browsers: pruned(fn(Array.isArray(cur?.browsers) ? cur!.browsers : []), now) }))
  cache = null
}

/**
 * The person proved the master password in this browser: its key (the one it sent when this vault
 * knows it, else a new one, which the window keeps). Null when it could not be written (the window
 * then shares nothing, as before).
 */
export async function issueBrowserKey(presented: string | undefined, client: string, now = Date.now()): Promise<string | null> {
  const keep = shapeOk(presented) && !!(await known(now).catch(() => null))?.has(hashOf(presented))
  const key = keep ? presented! : crypto.randomBytes(32).toString('base64url')
  const h = hashOf(key)
  try {
    await write((list) => [{ hash: h, at: now, client: client.slice(0, 80) }, ...list.filter((e) => e.hash !== h)], now)
    return key
  } catch {
    return null
  }
}

/**
 * Every browser key ends (a new master password, a recovery): a browser that had one shares
 * nothing until the person types the master password in it again. Null-safe: no vault, no file.
 */
export async function forgetAllBrowsers(): Promise<void> {
  cache = null
  try {
    await updateSide<BrowsersFile>(FILE, () => ({ version: 1, browsers: [] }))
  } finally {
    cache = null
  }
}

export function resetBrowserKeysForTest(): void {
  cache = null
}
