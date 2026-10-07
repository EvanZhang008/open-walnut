import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { createTimeApi } from './web/api'
import { TimeApp } from './web/app'
import { TIME_CSS } from './web/styles'
import { TaskTimePage } from './web/task-page'
import { rawSubpath, timePageFromRoute, timePaths } from './web/task-routes'
import { createTimeSlots } from './web/task-slots'
import { createTaskTimeStore } from './web/task-time-store'

/**
 * Time: one native App, plus two slots inside the console.
 *
 * The plugin contributes NO server entry on purpose: time collection, storage and
 * the /api/time endpoints are Walnut's, and this app is only a reader of them. That
 * is what makes it a safe first-party example: uninstall it and not one recorded
 * minute is affected.
 *
 * Everything is registered through `walnut.ui`, so disable / reload / uninstall
 * takes the route, the entry row, the Command Palette entry and the injected CSS
 * away together.
 *
 * The App declares `placement: 'settings'`, so its row is in the Settings Plugins
 * group rather than in the Sidebar. A day report is something you open now and then; the
 * Sidebar is for the surfaces you live in.
 *
 * The slots (`walnut.ui.slot`) are where a task's own time shows: one "Time" fact with
 * the task's other facts in its details, and one at the top of each session's menu (a
 * chip on the session header too, when the user pins it there from that row). All
 * lead to the App's task page (`/task/<id>`), which is not a tab: it is a page about
 * one task.
 */

/** The documented default weight for a plugin App (core screens use 10 to 1000). */
const APP_ORDER = 500

export async function activate(walnut: WalnutWebApi) {
  const api = createTimeApi(walnut)
  const log = walnut.log
  const store = createTaskTimeStore(walnut, api, log)

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
    const page = timePageFromRoute(rawSubpath(props), props.search)
    if (page) {
      return (
        <TaskTimePage page={page} store={store} paths={timePaths(props.basePath)} basePath={props.basePath} navigate={props.navigate} />
      )
    }
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
    order: APP_ORDER,
    // A day plot wants the whole canvas: the tape is 144px per hour and the
    // swimlanes want every pixel of width they can get.
    fullBleed: true,
    // A report you read now and then, not a daily surface: its row belongs in
    // the Settings Plugins group, and the Sidebar stays short.
    // The route, the deep links and the Command Palette entry are unaffected.
    placement: 'settings',
  })

  // A host older than slots has no `slot`: the App still works, the two facts just are not drawn.
  const { TaskTime, SessionTime } = createTimeSlots(store, timePaths(app.path))
  walnut.ui.slot?.({ id: 'task-time', target: 'task.meta', title: 'Time', component: TaskTime })
  walnut.ui.slot?.({ id: 'session-time', target: 'session.meta', title: 'Time', component: SessionTime })

  walnut.ui.injectCss(TIME_CSS)
  log.info('Time app activated', { appPath: app.path, slots: typeof walnut.ui.slot === 'function' })
}
