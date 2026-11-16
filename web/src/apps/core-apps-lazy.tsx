/**
 * The built-in apps for a pop-out window of one app (popout/PopoutAppView.tsx): each screen is
 * its own import, run only when it is drawn. The console's registration (core-apps.tsx) imports
 * every screen, which in a pop-out cost about 1 MB of the whole console (Tasks, Mail, Settings,
 * the session panel...) fetched and run before the window drew its one app.
 *
 * `preloadCoreScreen` starts the window's own screen the moment this module runs, alongside the
 * shell, instead of after the first render asks for it.
 */
import { lazy, type ComponentType } from 'react'
import type { AppComponentProps, AppHandle } from './registry'
import { registerCoreApps, type CoreAppId } from './core-app-list'

type Screen = ComponentType<AppComponentProps>

let mailHandle: AppHandle | null = null

const LOADERS: Record<CoreAppId, () => Promise<Screen>> = {
  home: async () => () => null,
  notes: () => import('@/pages/NotesPage').then((m) => m.NotesPage),
  calendar: () => import('@/pages/CalendarPage').then((m) => m.CalendarPage),
  // Mail's badge and live wiring come with its screen, as the console's registration installs them.
  mail: () => Promise.all([import('./mail/MailApp'), import('./mail/mail-live')]).then(([app, live]) => {
    if (mailHandle) live.attachMailBadge(mailHandle)
    return app.MailApp
  }),
  tasks: () => import('./TasksApp').then((m) => m.TasksApp),
  routines: () => import('@/pages/RoutinesPage').then((m) => m.RoutinesPage),
  passwords: () => import('@/components/passwords/PasswordsApp').then((m) => m.PasswordsApp),
  apps: () => import('@/pages/AppsPage').then((m) => m.AppsPage),
  settings: () => import('@/pages/SettingsPage').then((m) => m.SettingsPage),
}

const started = new Map<CoreAppId, Promise<Screen>>()

function load(id: CoreAppId): Promise<Screen> {
  let p = started.get(id)
  if (!p) {
    p = LOADERS[id]()
    // A failed import is tried again by the next draw (the stale-asset recovery reloads first).
    p.catch(() => { started.delete(id) })
    started.set(id, p)
  }
  return p
}

function isCoreAppId(id: string): id is CoreAppId {
  return Object.prototype.hasOwnProperty.call(LOADERS, id)
}

/** Start loading the screen of `core:<id>` now; anything else (a plugin App) is left alone. */
export function preloadCoreScreen(appKey: string): void {
  const id = appKey.startsWith('core:') ? appKey.slice('core:'.length) : ''
  if (isCoreAppId(id)) void load(id).catch(() => undefined)
}

export function ensureCoreAppsRegisteredLazily(): void {
  const screens = {} as Record<CoreAppId, Screen>
  for (const id of Object.keys(LOADERS) as CoreAppId[]) {
    screens[id] = lazy(() => load(id).then((screen) => ({ default: screen })))
  }
  registerCoreApps(screens, (id, handle) => { if (id === 'mail') mailHandle = handle })
}
