/**
 * useAutoSave (same options, same debounce, same current/baseline contract)
 * plus a FLUSH: a save that is still pending when the pane unmounts, the page
 * is hidden (pagehide) or the tab goes to the background runs at once instead
 * of being dropped with the cleared timer. Pane mode unmounts sections on every
 * pane switch, so without the flush an edit made 200ms before a click is lost.
 */
import { useEffect, useRef } from 'react'
import { AUTOSAVE_DELAY_MS } from '@/hooks/useAutoSave'

export interface UseSettingsAutoSaveOptions {
  current: string
  baseline: string
  save: () => Promise<void>
  enabled?: boolean
  delayMs?: number
}

export function useSettingsAutoSave({
  current,
  baseline,
  save,
  enabled = true,
  delayMs = AUTOSAVE_DELAY_MS,
}: UseSettingsAutoSaveOptions) {
  const saveRef = useRef(save)
  saveRef.current = save
  const pendingRef = useRef(false)
  // Mounting a pane never writes. A section whose local state hydrates from
  // config in an effect differs from its baseline on the first render only;
  // StrictMode's simulated unmount (and a real one) would flush that stale
  // first-render value (Remote Hosts wrote `hosts: {}`). A mismatch counts as
  // an edit only once the section has matched its baseline, or once `current`
  // moved away from the value it mounted with.
  const mountCurrentRef = useRef(current)
  const syncedRef = useRef(false)
  if (current === baseline) syncedRef.current = true

  useEffect(() => {
    const edited = syncedRef.current || current !== mountCurrentRef.current
    if (!enabled || current === baseline || !edited) {
      pendingRef.current = false
      return
    }
    pendingRef.current = true
    const t = setTimeout(() => {
      if (!pendingRef.current) return
      pendingRef.current = false
      saveRef.current().catch(() => {})
    }, delayMs)
    return () => clearTimeout(t)
  }, [current, baseline, enabled, delayMs])

  useEffect(() => {
    const flush = () => {
      if (!pendingRef.current) return
      pendingRef.current = false
      saveRef.current().catch(() => {})
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      flush()
    }
  }, [])
}
