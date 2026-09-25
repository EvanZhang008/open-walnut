/**
 * Rhythm's web entry: one App, its CSS, and the badge.
 *
 * The store starts at activation, not when the App opens, so the badge shows the
 * minutes left in a running focus block wherever the person is in the console. The
 * badge is cleared whenever no block is running.
 */
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { RhythmApp } from './web/app'
import { createRhythmStore } from './web/store'
import { RHYTHM_CSS } from './web/styles'

/** The documented default weight for a plugin App (core screens use 10 to 1000). */
const APP_ORDER = 500
const BADGE_TICK_MS = 30_000

export async function activate(walnut: WalnutWebApi) {
  const store = createRhythmStore(walnut)

  function RhythmIcon({ size = 18 }: { size?: number }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="13" r="7.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 9.2V13l2.6 1.7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9.6 3.4h4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }

  function RhythmAppRoot(props: AppProps) {
    return <RhythmApp {...props} walnut={walnut} store={store} />
  }

  const app = walnut.ui.app({
    id: 'main',
    title: 'Rhythm',
    icon: RhythmIcon,
    component: RhythmAppRoot,
    badge: null,
    order: APP_ORDER,
    fullBleed: true,
  })
  walnut.ui.injectCss(RHYTHM_CSS)

  let lastBadge: string | null | undefined
  const updateBadge = () => {
    const state = store.get()
    const running = state?.focus.phase === 'focus' && state.focus.endsAt !== null
    const minutes = running ? Math.max(0, Math.ceil((state.focus.endsAt! - store.serverNow()) / 60_000)) : null
    const next = minutes === null ? null : `${minutes}m`
    if (next === lastBadge) return
    lastBadge = next
    // Minutes left are a status, not a count, so the muted text badge. A host that
    // predates text badges refuses the object; a plain dot still says "running".
    try { app.setBadge(next === null ? null : { text: next }) }
    catch { app.setBadge(next === null ? null : 'dot') }
  }
  const unsubscribe = store.subscribe(updateBadge)
  // Minutes tick down between server events, so the badge re-reads the clock on its own.
  const timer = window.setInterval(updateBadge, BADGE_TICK_MS)
  walnut.signal.addEventListener('abort', () => {
    window.clearInterval(timer)
    unsubscribe()
  }, { once: true })

  void store.refresh()
  walnut.log.info('Rhythm web activated', { appPath: app.path })
}
