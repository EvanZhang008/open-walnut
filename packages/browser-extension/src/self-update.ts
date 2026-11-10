/**
 * A copy of the extension Walnut set up in a folder (Settings, Set up in Chrome; the server's
 * extension-install.ts) keeps up with Walnut: Walnut brings the folder up to the build it ships
 * when asked which build that is, and this copy, seeing a newer one, reloads itself from the
 * folder. Only an unpacked copy ("development" install) does; a store copy updates through the
 * store.
 *
 * Only the copy in the very folder that Walnut keeps reloads: its own files must hold Walnut's
 * marker (walnut-folder.json) naming the folder id Walnut reports, and its own manifest on disk
 * must already be the build Walnut names (the folder was brought up to it). Any other copy (a
 * developer's build, an unpacked zip, a browser started with --load-extension) never reloads:
 * Chrome turns a command-line unpacked extension off after a reload when Developer mode is off,
 * and a reload would not change its files anyway. One reload per build Walnut names.
 */
import { ext } from './ext'
import { call, connection } from './walnut-api'
import { keepForReload } from './agent-keep'
import { CLEAR_MS } from './bg-clipboard'

const EVERY_MS = 10 * 60_000
let checkedAt = 0

export function buildOf(versionName: unknown): string | null {
  const m = typeof versionName === 'string' ? /\bbuild ([0-9a-f]{6,64})\b/.exec(versionName) : null
  return m ? m[1] : null
}

/** One of this copy's own files as it is on disk now (an unpacked copy reads its folder). */
async function ownFile(name: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(ext.runtime.getURL(name), { cache: 'no-store' })
    return r.ok ? await r.json() as Record<string, unknown> : null
  } catch { return null }
}

export async function selfUpdate(force = false): Promise<void> {
  if (!force && Date.now() - checkedAt < EVERY_MS) return
  checkedAt = Date.now()
  const own = buildOf(ext.runtime.getManifest().version_name)
  if (!own || !(await connection())) return
  const self = await Promise.resolve(ext.management?.getSelf?.()).catch(() => null)
  if (self?.installType !== 'development') return
  const r = await call<{ extension?: { build?: unknown; folder?: unknown } }>('GET', '/browser/panel', undefined, { noSession: true, timeoutMs: 20_000 }).catch(() => null)
  const want = typeof r?.extension?.build === 'string' ? r.extension.build : ''
  const folder = typeof r?.extension?.folder === 'string' ? r.extension.folder : ''
  if (!want || want === own || !folder) return
  // This copy is in the folder Walnut keeps, and that folder now holds the build Walnut names.
  const marker = await ownFile('walnut-folder.json')
  if (marker?.folder !== folder) return
  if (buildOf((await ownFile('manifest.json'))?.version_name) !== want) return
  const { reloadedFor } = await ext.storage.local.get('reloadedFor')
  if (reloadedFor === want) return
  // A copied secret still due to be cleared off the clipboard: the reload would forget it (its
  // mark is in storage.session only), so it waits for the next check (a clear that failed holds
  // it up a minute at most).
  const copied = (await Promise.resolve(ext.storage.session?.get('clipboardCopied')).catch(() => undefined))?.clipboardCopied as { at?: number } | undefined
  if (typeof copied?.at === 'number' && Date.now() - copied.at < CLEAR_MS + 60_000) return
  await ext.storage.local.set({ reloadedFor: want })
  // What the agent holds, stamped, so the reload keeps it (agent-keep.ts).
  await keepForReload().catch(() => undefined)
  ext.runtime.reload?.()
}

export function initSelfUpdate(): void {
  void Promise.resolve(ext.alarms.create('walnut-update', { periodInMinutes: 10 })).catch(() => undefined)
  ext.alarms.onAlarm.addListener((a) => { if (a.name === 'walnut-update') void selfUpdate(true).catch(() => undefined) })
  ext.runtime.onStartup?.addListener(() => { void selfUpdate(true).catch(() => undefined) })
  void selfUpdate(true).catch(() => undefined)
}
