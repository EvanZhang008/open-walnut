/**
 * Finding the person's Walnut before asking for its address: the addresses it may be at, most
 * likely first, each asked "are you Walnut?" (GET /api/v1/instance, public, it answers only
 * which box it is). The first that answers is offered; the person still presses Connect, sees
 * the address, and may type another. Only places the person or Walnut chose are tried: the
 * Walnut connect page open in this tab, the Walnut that set up this extension's folder
 * (walnut-folder.json), the Walnut last connected to, and this computer's default port. No other
 * web page can put an address here.
 */
import { ext } from './ext'
import { DEFAULT_SERVER } from './walnut-api'

const PROBE_MS = 1500

export interface Hints { tabUrl?: string; folderServer?: string; last?: string }

function origin(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch { return null }
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/

/**
 * Where to look, in order, each once. A tab counts only on a connect page of a Walnut already
 * known (this computer, the folder's Walnut, the last one connected): any site can serve a page
 * at /connect-extension, and an address it put here would be paired with on one click.
 */
export function walnutCandidates(h: Hints): string[] {
  const folder = origin(h.folderServer)
  const last = origin(h.last)
  const onConnectPage = !!h.tabUrl && (() => { try { return new URL(h.tabUrl).pathname.replace(/\/+$/, '') === '/connect-extension' } catch { return false } })()
  const tabOrigin = onConnectPage ? origin(h.tabUrl) : null
  const known = (o: string) => LOOPBACK.test(new URL(o).hostname) || o === folder || o === last
  const tab = tabOrigin && known(tabOrigin) ? tabOrigin : null
  const all = [tab, folder, last, DEFAULT_SERVER, DEFAULT_SERVER.replace('localhost', '127.0.0.1')]
  return [...new Set(all.filter((x): x is string => !!x))]
}

/** Is a Walnut answering at `base`? */
export async function isWalnut(base: string, timeoutMs = PROBE_MS): Promise<boolean> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(`${base}/api/v1/instance`, { cache: 'no-store', credentials: 'omit', signal: ctl.signal })
    if (!r.ok) return false
    const body = await r.json() as { instance?: unknown }
    return typeof body.instance === 'string' && body.instance.length > 0
  } catch { return false } finally { clearTimeout(t) }
}

async function hints(): Promise<Hints> {
  const [tab, folder, stored] = await Promise.all([
    Promise.resolve(ext.tabs.query({ active: true, currentWindow: true })).then((t) => t?.[0]?.url).catch(() => undefined),
    fetch(ext.runtime.getURL('walnut-folder.json'), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => (typeof j?.serverUrl === 'string' ? j.serverUrl : undefined)).catch(() => undefined),
    Promise.resolve(ext.storage.local.get('lastServer')).then((r) => (typeof r?.lastServer === 'string' ? r.lastServer : undefined)).catch(() => undefined),
  ])
  return { tabUrl: tab, folderServer: folder, last: stored }
}

/** The first candidate (in order) that answers as Walnut, all asked at once; null when none does. */
export async function findWalnut(probe = isWalnut): Promise<string | null> {
  const order = walnutCandidates(await hints())
  const answers = await Promise.all(order.map((o) => probe(o)))
  return order[answers.indexOf(true)] ?? null
}

/** Kept when the person connects, so after a disconnect the popup offers the same Walnut. */
export function rememberServer(url: string): void {
  const o = origin(url.includes('://') ? url : `http://${url}`)
  if (o) void Promise.resolve(ext.storage.local.set({ lastServer: o })).catch(() => undefined)
}
