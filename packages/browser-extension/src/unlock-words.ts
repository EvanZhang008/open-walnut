/**
 * What the lock screen says it unlocks: passwords for the site the person is on, by its name,
 * never the address of the Walnut server they come from (review R2-13: "Unlock to fill passwords
 * from localhost:3640" on a shop's sign-in page).
 */
import { ext } from './ext'

/**
 * A web page's host as Walnut names its site (url-match.ts `displayHost` of a page address), with no
 * public suffix list: the side panel's script carries this, and tldts was three quarters of it
 * (review R3-7). '' for no web page.
 */
export function pageHost(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() : ''
  } catch { return '' }
}

/** The site of the active tab (of `windowId`, else the window last used), unless it is a Walnut page or none. */
export async function siteForUnlock(windowId: number | undefined, serverUrl: string | undefined): Promise<string> {
  try {
    const [t] = await ext.tabs.query(windowId !== undefined ? { active: true, windowId } : { active: true, lastFocusedWindow: true })
    return siteOfPage(t?.url, serverUrl)
  } catch { return '' }
}

/** A page's site as the lock screen names it: '' for no web page, or a page of Walnut itself. */
export function siteOfPage(url: string | undefined, serverUrl: string | undefined): string {
  if (!url || !/^https?:/.test(url)) return ''
  try {
    if (serverUrl && new URL(url).origin === new URL(serverUrl).origin) return ''
  } catch { return '' }
  return pageHost(url)
}

export function unlockWords(site: string): string {
  return site ? `Unlock to fill passwords on ${site}.` : 'Unlock to use your passwords.'
}
