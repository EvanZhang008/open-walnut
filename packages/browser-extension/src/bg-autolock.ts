/**
 * Locks the extension's vault session after the time the person chose with no use of it, and
 * when the computer locks (or goes idle that long), through chrome.idle where the `idle`
 * permission is granted. Walnut's own auto-lock (Settings in Walnut) still applies on top.
 * "Use" is the person working with Walnut here: the popup, the menu, a fill or a save, never a
 * page loading in the background.
 */
import { ext } from './ext'
import { vaultSession } from './walnut-api'
import { getSettings, lockMinutes } from './settings'

const ALARM = 'walnut-autolock'
let lastWrite = 0

/** The person used the extension now. */
export async function touch(force = false): Promise<void> {
  if (!force && Date.now() - lastWrite < 5_000) return
  lastWrite = Date.now()
  await ext.storage.session.set({ lastActive: Date.now() })
}

/** Locks now when the chosen time has passed with no use. */
export async function lockIfIdle(lock: () => Promise<void>): Promise<boolean> {
  if (!(await vaultSession())) return false
  const minutes = lockMinutes((await getSettings()).autoLock)
  if (minutes === null) return false
  const { lastActive } = await ext.storage.session.get('lastActive')
  if (typeof lastActive !== 'number') { await touch(true); return false }
  if (Date.now() - lastActive < minutes * 60_000) return false
  await lock()
  return true
}

async function setIdleInterval(): Promise<void> {
  const minutes = lockMinutes((await getSettings()).autoLock)
  // The browser's least is 15 s; with no timed lock, the computer's lock still counts.
  try { ext.idle?.setDetectionInterval(Math.max(15, (minutes ?? 60) * 60)) } catch { /* no idle permission */ }
}

export function initAutoLock(lock: () => Promise<void>): void {
  void Promise.resolve(ext.alarms.create(ALARM, { periodInMinutes: 1 })).catch(() => undefined)
  ext.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void lockIfIdle(lock) })
  void setIdleInterval()
  ext.storage.onChanged.addListener((changes, area) => { if (area === 'local' && 'settings' in changes) void setIdleInterval() })
  ext.idle?.onStateChanged.addListener((state) => {
    void (async () => {
      if (state === 'active' || !(await vaultSession())) return
      const choice = (await getSettings()).autoLock
      if (choice === 'never') return
      // The computer locked: always. Idle as long as the chosen time: only a timed choice.
      if (state === 'locked' || lockMinutes(choice) !== null) await lock()
    })()
  })
}
