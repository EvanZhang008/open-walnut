/**
 * Rhythm's web entry: one App and its CSS.
 *
 * The live countdown is NOT drawn here: the server publishes a status item and the host
 * draws it as a ring in the rail on every screen. The App entry carries no badge, since
 * a pinned App would repeat the ring's minutes right next to it.
 */
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { RhythmApp } from './web/app'
import { createRhythmStore } from './web/store'
import { RHYTHM_CSS } from './web/styles'

/** The documented default weight for a plugin App (core screens use 10 to 1000). */
const APP_ORDER = 500

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

  void store.refresh()
  walnut.log.info('Rhythm web activated', { appPath: app.path })
}
