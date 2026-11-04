/**
 * A copy of the extension Walnut set up in a folder (Settings, Set up in Chrome; the server's
 * extension-install.ts) keeps up with Walnut: Walnut brings the folder up to the build it ships
 * when asked which build that is, and this copy, seeing a newer one, reloads itself from the
 * folder. Only an unpacked copy ("development" install) does; a store copy updates through the
 * store. One reload per build Walnut names, so a copy loaded from some other folder (which stays
 * as it is) never reloads again and again. Pages open at the time get the new copy when reloaded.
 */
import { ext } from './ext'
import { call, connection } from './walnut-api'

const EVERY_MS = 10 * 60_000
let checkedAt = 0

export function buildOf(versionName: unknown): string | null {
  const m = typeof versionName === 'string' ? /\bbuild ([0-9a-f]{6,64})\b/.exec(versionName) : null
  return m ? m[1] : null
}

export async function selfUpdate(force = false): Promise<void> {
  if (!force && Date.now() - checkedAt < EVERY_MS) return
  checkedAt = Date.now()
  const own = buildOf(ext.runtime.getManifest().version_name)
  if (!own || !(await connection())) return
  const self = await Promise.resolve(ext.management?.getSelf?.()).catch(() => null)
  if (self?.installType !== 'development') return
  const r = await call<{ extension?: { build?: unknown } }>('GET', '/browser/panel', undefined, { noSession: true, timeoutMs: 20_000 }).catch(() => null)
  const want = typeof r?.extension?.build === 'string' ? r.extension.build : ''
  if (!want || want === own) return
  const { reloadedFor } = await ext.storage.local.get('reloadedFor')
  if (reloadedFor === want) return
  await ext.storage.local.set({ reloadedFor: want })
  ext.runtime.reload?.()
}

export function initSelfUpdate(): void {
  void Promise.resolve(ext.alarms.create('walnut-update', { periodInMinutes: 10 })).catch(() => undefined)
  ext.alarms.onAlarm.addListener((a) => { if (a.name === 'walnut-update') void selfUpdate(true).catch(() => undefined) })
  ext.runtime.onStartup?.addListener(() => { void selfUpdate(true).catch(() => undefined) })
  void selfUpdate(true).catch(() => undefined)
}
