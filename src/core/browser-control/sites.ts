/**
 * Which sites agents may use in the person's browser (`WALNUT_HOME/browser-control.json`).
 * `any` (the default since 2026-11-04: the person who turns agents on in the extension has
 * already let them use the browser, and a second ask per site only got in the way): every site.
 * `ask`, for whoever picks it in Settings: a site is used only after the person approved it once
 * (a Walnut approval on their Mac or phone), and stays allowed until they remove it there. A file
 * an older Walnut wrote keeps the mode it names. Some pages are never an agent's, whatever the setting: Walnut itself and the
 * browser's own pages (the extension refuses those too).
 *
 * A site is a registrable domain (url-match.ts siteKey), the same unit Passwords uses.
 */
import path from 'node:path'
import { siteKey } from '../vault/url-match.js'

export interface SitesFile {
  mode: 'ask' | 'any'
  sites: Array<{ site: string; addedAt: string; by: string }>
}

const EMPTY: SitesFile = { mode: 'any', sites: [] }
const modeOf = (m: unknown): SitesFile['mode'] => (m === 'ask' ? 'ask' : 'any')

async function file(): Promise<string> {
  const { WALNUT_HOME } = await import('../../constants.js')
  return path.join(WALNUT_HOME, 'browser-control.json')
}

export async function readSites(): Promise<SitesFile> {
  const { readJsonFile } = await import('../../utils/fs.js')
  const f = await readJsonFile<SitesFile>(await file(), EMPTY)
  return { mode: modeOf(f.mode), sites: Array.isArray(f.sites) ? f.sites.filter((s) => typeof s?.site === 'string') : [] }
}

async function update(mutate: (f: SitesFile) => void): Promise<SitesFile> {
  const { updateJsonFile } = await import('../../utils/fs.js')
  return updateJsonFile<SitesFile>(await file(), EMPTY, (f) => {
    const next: SitesFile = { mode: modeOf(f.mode), sites: Array.isArray(f.sites) ? [...f.sites] : [] }
    mutate(next)
    return next
  })
}

/** The site of a URL, or null for anything that is not a web page. */
export function siteOf(url: string): string | null {
  return siteKey(url)?.domain ?? null
}

export async function allowSite(site: string, by: string): Promise<SitesFile> {
  return update((f) => { if (!f.sites.some((s) => s.site === site)) f.sites.push({ site, addedAt: new Date().toISOString(), by }) })
}

export async function removeSite(site: string): Promise<SitesFile> {
  return update((f) => { f.sites = f.sites.filter((s) => s.site !== site) })
}

export async function setMode(mode: 'ask' | 'any'): Promise<SitesFile> {
  return update((f) => { f.mode = mode })
}

/** What the extension checks a tab against before it acts in it. */
export function allowOf(f: SitesFile): { any: boolean; sites: string[] } {
  return { any: f.mode === 'any', sites: f.sites.map((s) => s.site) }
}

export function isAllowed(f: SitesFile, url: string): boolean {
  const site = siteOf(url)
  if (!site) return false
  return f.mode === 'any' || f.sites.some((s) => s.site === site)
}
