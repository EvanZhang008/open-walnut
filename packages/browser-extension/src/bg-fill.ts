/**
 * Sending what was picked into the page: a login, a one-time code, a card or an address, only
 * to frames on the top page's origin (content.ts checks that origin again), and what follows a
 * login fill: the item is marked used, remembered for its code page, and its one-time code is
 * copied (a Settings switch, on by default, as Bitwarden does).
 */
import { ext } from './ext'
import { api } from './walnut-api'
import type { VaultItem } from '../../../src/core/vault/types'
import { getSettings } from './settings'
import { copyText } from './bg-clipboard'
import { originOf, stores } from './bg-vault'
import { reachPage, sleep } from './page-reach'

/**
 * Send a login to fill: to `frameId` alone (the menu's frame), else to the tab's frames that
 * registered a login form on the top page's origin, top frame first. The tab is read again
 * right before, and every frame checks `origin` against its own.
 */
export async function fillFrames(tabId: number, frameId: number | undefined, creds: { username?: string; password?: string; totp?: string }, mode: 'login' | 'totp', expected: string): Promise<boolean> {
  const tab = await ext.tabs.get(tabId).catch(() => undefined)
  const origin = originOf(tab?.url ?? '')
  if (!origin || origin !== originOf(expected)) return false
  const msg = { type: 'fill', mode, origin, ...creds }
  const { frames } = stores
  // A tab older than the extension has no page script yet (and so no frames known): put it in first.
  if (frameId === undefined && !Object.keys((await frames.get(tabId)) ?? {}).length) {
    // Its frames register as the script starts and finds the login fields: wait for them a little.
    if ((await reachPage(tabId, false)).ok) {
      for (let i = 0; i < 10 && !Object.keys((await frames.get(tabId)) ?? {}).length; i++) await sleep(200)
    }
  }
  const targets = frameId !== undefined
    ? [frameId]
    : Object.entries((await frames.get(tabId)) ?? {}).filter(([, f]) => f.origin === origin).map(([id]) => Number(id)).sort((a, b) => a - b)
  for (const id of targets) {
    const r = await ext.tabs.sendMessage(tabId, msg, { frameId: id }).catch(() => null)
    if (r?.filled) return true
  }
  return false
}

/** A card or address into the menu's frame (or the top frame), checked against the page's origin. */
export async function fillWalletFrame(tabId: number, frameId: number, values: Record<string, string>, kind: string, expected: string): Promise<boolean> {
  const tab = await ext.tabs.get(tabId).catch(() => undefined)
  const origin = originOf(tab?.url ?? '')
  if (!origin || origin !== originOf(expected)) return false
  const r = await ext.tabs.sendMessage(tabId, { type: 'fill-wallet', origin, kind, values }, { frameId }).catch(() => null)
  return r?.filled === true
}

/** The menu or save bar is still on screen as Walnut drew it (content.ts tampered()); else it is closed. */
export async function stillShown(tabId: number, frameId: number, which: 'menu' | 'bar'): Promise<boolean> {
  const r = await ext.tabs.sendMessage(tabId, { type: 'check-shown', which }, { frameId }).catch(() => null)
  return r?.ok === true
}
export const COVERED = { ok: false, error: 'Something on the page covers Walnut, so it did nothing.' }

export function credsOf(item: VaultItem): { username?: string; password?: string } {
  return { ...(item.username ? { username: item.username } : {}), ...(item.password ? { password: item.password } : {}) }
}

export async function toastIn(tabId: number, frameId: number, text: string): Promise<void> {
  await ext.tabs.sendMessage(tabId, { type: 'toast', text }, { frameId }).catch(() => undefined)
}

/**
 * A login was filled on a tab. `code` comes back when its code should be copied but the
 * background has no clipboard here (no offscreen document): the page that asked, which has the
 * person's click, copies it then.
 */
export async function afterLoginFill(tabId: number, frameId: number | undefined, item: VaultItem, url: string): Promise<{ code?: string }> {
  void api.used(item.id)
  await stores.lastLogin.set(tabId, { itemId: item.id, url, hasTotp: !!item.totp, at: Date.now() })
  if (!item.totp || !(await getSettings()).copyTotp) return {}
  const code = await api.totp(item.id).then((t) => t.code, () => '')
  if (!code) return {}
  if (await copyText(code)) { await toastIn(tabId, frameId ?? 0, 'Code copied'); return {} }
  return { code }
}

/** Open the popup to unlock; where the browser refuses (no user gesture left), a small window. */
export async function openUnlock(): Promise<void> {
  try {
    if (ext.action.openPopup) { await ext.action.openPopup(); return }
  } catch { /* falls through */ }
  await ext.windows.create({ url: ext.runtime.getURL('popup.html?window=1'), type: 'popup', width: 380, height: 560, focused: true })
}
