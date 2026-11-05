/**
 * The background's view of the vault and of each tab: item summaries (cached 5 s while
 * unlocked, so a Lock elsewhere shows soon), the logins, cards and identities a page gets, and
 * the per-tab state that must outlive the service worker (tab-store.ts).
 */
import { ext, type Tab } from './ext'
import { ApiError, DEFAULT_SERVER, api, connection, vaultSession } from './walnut-api'
import { insecureOnly, siteKey } from '../../../src/core/vault/url-match'
import type { VaultItemSummary } from '../../../src/core/vault/types'
import type { FieldRules } from './field-rules'
import { tabStore } from './tab-store'
import { recent, tiersFor, view, type MenuItem } from './login-pick'

export { view, type MenuItem }

export type Reply = Record<string, unknown> & { ok: boolean }
export const fail = (err: unknown): Reply => err instanceof ApiError
  ? { ok: false, error: err.message, code: err.code, ...(err.waitMs ? { waitMs: err.waitMs } : {}) }
  : { ok: false, error: err instanceof Error ? err.message : String(err) }

let cache: { at: number; items: VaultItemSummary[] } | null = null
export async function summaries(): Promise<VaultItemSummary[]> {
  if (cache && Date.now() - cache.at < 5_000) return cache.items
  const items = (await api.items()).filter((i) => !i.trashedAt)
  cache = { at: Date.now(), items }
  return items
}
export const forget = () => { cache = null }

/** Logins offered on a page (tier 1): the same host first, then favorites, then most recently used. */
export async function matchesFor(page: string): Promise<MenuItem[]> {
  return tiersFor(await summaries(), page).first
}

/** Both tiers: `others` are saved for other parts of the page's site, listed apart, never offered first. */
export async function tiersOf(page: string): Promise<{ first: MenuItem[]; others: MenuItem[] }> {
  return tiersFor(await summaries(), page)
}

/** Logins saved for https only, on this plain http page: said, never offered. */
export async function insecureFor(page: string): Promise<number> {
  return (await summaries()).filter((i) => i.type === 'login' && insecureOnly(i.urls, page)).length
}

/** The person's cards or identities, favorites and the most recently used first. */
export async function walletItems(kind: 'card' | 'identity'): Promise<MenuItem[]> {
  return (await summaries()).filter((i) => i.type === kind).sort(recent).map((i) => ({ ...view(i), type: kind }))
}

export async function state(): Promise<{ connected: boolean; unlocked: boolean; serverUrl?: string; device?: string }> {
  const conn = await connection()
  if (!conn) return { connected: false, unlocked: false }
  return { connected: true, unlocked: !!(await vaultSession()), serverUrl: conn.serverUrl, device: conn.device }
}

export const originOf = (url: string): string => { try { return new URL(url).origin } catch { return '' } }
export const nonce = (): string => crypto.getRandomValues(new Uint32Array(4)).join('-')
export function siteOf(url: string): string {
  return siteKey(url)?.domain ?? new URL(url).hostname
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
/** The same server under another loopback name (127.0.0.1 for localhost, and so on). */
function sameServer(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.protocol === y.protocol && x.port === y.port && LOOPBACK.has(x.hostname) && LOOPBACK.has(y.hostname)
  } catch { return false }
}

/**
 * Walnut's own pages (its lock screen, Settings): the extension stays out of them. Every page of
 * Walnut also says so itself (content.ts reads its marker), which covers the addresses this list
 * does not know (its tunnel, Tailscale).
 */
export async function isWalnutPage(url: string): Promise<boolean> {
  const conn = await connection()
  const o = originOf(url)
  return !!o && (sameServer(o, conn?.serverUrl ?? '') || sameServer(o, DEFAULT_SERVER))
}

/** The page the person is on: in the window named (the side panel's), else the last one they used. */
export async function activeTab(windowId?: number): Promise<Tab | undefined> {
  return (await ext.tabs.query(typeof windowId === 'number' ? { active: true, windowId } : { active: true, lastFocusedWindow: true }))[0]
}

// ── per-tab state (storage.session: it outlives the service worker, and content scripts cannot read it) ──

/** The in-page menu that is open, and the frame that opened it; `nonce` is in its page's URL. */
export interface MenuOwner {
  tabId: number; frameId: number; url: string; role: string; kind: string; nonce: string
  /** What the new-password field accepts, and the strong password the menu shows for it. */
  rules?: FieldRules; suggestion?: string
}

/** A saved login a sent one could update instead. */
export interface Choice { id: string; title: string; username?: string }

/** A login seen being sent, offered for save or update. The page never holds it. */
export interface Pending {
  url: string
  username?: string
  password: string
  /** On a change form, the password it replaced: it tells which saved login is being changed. */
  current?: string
  kind: 'save' | 'update'
  itemId?: string
  title?: string
  /** The saved logins of this site the person may pick to update (several accounts on one site). */
  choices?: Choice[]
  at: number
  /** Compared with the saved logins (needs the vault open); a login seen while locked is not yet. */
  checked: boolean
  /** The save bar's page carries it in its URL; its messages must too. */
  nonce: string
  /** When a save bar first showed it: from then on it waits as long as the bar may stay (BAR_MS). */
  shownAt?: number
}

export const stores = {
  pendingSave: tabStore<Pending>('pendingSave'),
  /** The login a newer one replaced while its bar was on screen: that bar still acts on it. */
  pendingPrev: tabStore<Pending>('pendingPrev'),
  seenUsername: tabStore<{ url: string; username: string; at: number }>('seenUsername'),
  connecting: tabStore<string>('connecting'),
  menus: tabStore<MenuOwner>('menus'),
  /** Frames that may be filled: on the top page's origin, holding a login form. */
  frames: tabStore<Record<string, { origin: string; at: number }>>('frames'),
  /** The strong password the menu last made on a tab: a sign-up sent with it is saved without typing. */
  generated: tabStore<{ password: string; url: string; at: number }>('generated'),
  /** The login last filled or sent on a tab: its code page offers that login's code. */
  lastLogin: tabStore<{ itemId: string; url: string; hasTotp: boolean; at: number }>('lastLogin'),
}

export const PENDING_MS = 3 * 60_000
/** A login whose save bar is on screen waits this long for the person's answer. */
export const BAR_MS = 30 * 60_000
/** A sent login is offered for PENDING_MS; once its bar showed, its bar acts on it for BAR_MS. */
export const pendingAlive = (p: Pending, now = Date.now()) => now - p.at < (p.shownAt ? BAR_MS : PENDING_MS)
/** The code page of a sign in comes within this long. */
export const CODE_PAGE_MS = 5 * 60_000
