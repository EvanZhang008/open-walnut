/** The toolbar icon's badge: how many saved logins fit the tab's page, per tab; none when locked. */
import { ext } from './ext'

export async function setBadge(tabId: number, count: number): Promise<void> {
  await ext.action.setBadgeText({ tabId, text: count > 0 ? String(Math.min(count, 99)) : '' }).catch(() => undefined)
}

export async function clearBadges(): Promise<void> {
  await ext.action.setBadgeText({ text: '' }).catch(() => undefined)
  for (const t of await ext.tabs.query({}).catch(() => [])) if (t.id !== undefined) await setBadge(t.id, 0)
}

export function initBadge(): void {
  void Promise.resolve(ext.action.setBadgeBackgroundColor({ color: '#8a5a2b' })).catch(() => undefined)
}
