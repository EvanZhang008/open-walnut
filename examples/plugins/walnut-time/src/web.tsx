import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { createTimeApi } from './web/api'
import { TimeApp } from './web/app'
import { TIME_CSS } from './web/styles'

/**
 * Time — one native App with three tabs, and nothing else.
 *
 * The plugin contributes NO server entry on purpose: time collection, storage and
 * the /api/time endpoints are Walnut's, and this app is only a reader of them. That
 * is what makes it a safe first-party example: uninstall it and not one recorded
 * minute is affected.
 *
 * Everything is registered through `walnut.ui`, so disable / reload / uninstall
 * takes the route, the Sidebar row, the Command Palette entry and the injected CSS
 * away together.
 */

/** The documented default weight for a plugin App (core screens use 10 to 1000). */
const SIDEBAR_ORDER = 500

export async function activate(walnut: WalnutWebApi) {
  const api = createTimeApi(walnut)
  const log = walnut.log

  function TimeIcon({ size = 18 }: { size?: number }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M12 7.4V12l3.4 2.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  function TimeAppRoot(props: AppProps) {
    return (
      <TimeApp
        api={api}
        log={log}
        basePath={props.basePath}
        subpath={props.subpath}
        navigate={props.navigate}
      />
    )
  }

  const app = walnut.ui.app({
    id: 'main',
    title: 'Time',
    icon: TimeIcon,
    component: TimeAppRoot,
    badge: null,
    order: SIDEBAR_ORDER,
    // A day plot wants the whole canvas: the tape is 144px per hour and the
    // swimlanes want every pixel of width they can get.
    fullBleed: true,
  })

  walnut.ui.injectCss(TIME_CSS)
  log.info('Time app activated', { appPath: app.path })
}
