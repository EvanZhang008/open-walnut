/**
 * React binding for the plugin update status controller. One module singleton so the
 * Installed list and the Sources group (two consumers on the same page) read one snapshot
 * and never double the passive GET; the controller starts with the first mounted consumer
 * and stops when the last one unmounts.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { wsClient } from '@/api/ws'
import {
  createPluginUpdatesController,
  type PluginUpdatesController,
  type PluginUpdatesSnapshot,
} from './pluginUpdatesController'

let singleton: PluginUpdatesController | null = null
let consumers = 0
/**
 * The last consumer's stop is deferred one tick: StrictMode mounts an effect, cleans it up
 * and mounts it again synchronously, and an immediate stop aborted the first GET and issued
 * a second one in the same millisecond (N3-18). A real unmount still stops on the next tick.
 */
let stopTimer: ReturnType<typeof setTimeout> | null = null

function controller(): PluginUpdatesController {
  if (!singleton) singleton = createPluginUpdatesController({ wsClient })
  return singleton
}

/** Tests only: drop the singleton so the next mount builds a fresh controller. */
export function resetPluginUpdatesForTesting(): void {
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null }
  singleton?.stop()
  singleton = null
  consumers = 0
}

export type PluginUpdatesActions = Pick<
  PluginUpdatesController,
  'checkAll' | 'checkRow' | 'setBusy' | 'applyRow' | 'retry' | 'reload'
>

export type UsePluginUpdates = PluginUpdatesSnapshot & PluginUpdatesActions

export function usePluginUpdates(enabled = true): UsePluginUpdates {
  const ctl = controller()
  const snapshot = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot, ctl.getSnapshot)

  useEffect(() => {
    if (!enabled) return
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null }
    consumers += 1
    ctl.start()
    return () => {
      consumers -= 1
      if (consumers <= 0) {
        consumers = 0
        if (stopTimer) clearTimeout(stopTimer)
        stopTimer = setTimeout(() => {
          stopTimer = null
          if (consumers === 0) ctl.stop()
        }, 0)
      }
    }
  }, [ctl, enabled])

  const actions = useMemo<PluginUpdatesActions>(() => ({
    checkAll: () => ctl.checkAll(),
    checkRow: (rowKey, target) => ctl.checkRow(rowKey, target),
    setBusy: (rowKey, kind) => ctl.setBusy(rowKey, kind),
    applyRow: (rowKey, row, checkedAt) => ctl.applyRow(rowKey, row, checkedAt),
    retry: () => ctl.retry(),
    reload: () => ctl.reload(),
  }), [ctl])

  return { ...snapshot, ...actions }
}
