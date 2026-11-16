/**
 * The built-in apps: what each one is called, where it lives and where it sits on the rail.
 * Their screens are attached by the window that shows them:
 *  - the console (core-apps.tsx) imports every screen, as the sidebar can go to any of them;
 *  - a pop-out window of one app (core-apps-lazy.ts) loads only that app's screen, so a new
 *    window never fetches and runs the whole console before it draws its one app.
 *
 * Keep this file free of screen imports: both of those import it.
 *
 * Rail order (top → bottom): Home, Notes, Calendar, Tasks, Routines, Apps, Settings.
 * Home first because it is the landing surface; Notes/Calendar next because they
 * are read all day; Tasks after them (the Home Todo panel already covers the
 * common task reads, so /tasks is the deeper stop); Settings always last.
 *
 * These numbers are only the DEFAULT — a stored per-user order wins. A stored v1
 * order froze the previous default, so `parseAppPreferences` drops core keys when
 * migrating v1 → v2 (see preferences.ts) or this change would never reach an
 * existing client.
 */
import type { ComponentType } from 'react'
import { appRegistry, type AppComponentProps, type AppHandle, type CoreAppContribution } from './registry'
import { HomeIcon, TasksIcon, NotesIcon, CalendarIcon, MailIcon, ScheduleIcon, SettingsIcon, AppsIcon, PasswordsIcon } from './icons'

export const CORE_APPS = [
  {
    id: 'home', title: 'Home', path: '/', icon: HomeIcon,
    order: 10, fullBleed: true, persistent: true, lockVisibility: true,
  },
  { id: 'notes', title: 'Notes', path: '/notes', icon: NotesIcon, order: 20, fullBleed: true },
  { id: 'calendar', title: 'Calendar', path: '/calendar', icon: CalendarIcon, order: 30 },
  // The Mail console is core code (it needs host components a plugin bundle cannot import)
  // gated on the mail PLUGIN, which owns the model, the cache and every route it reads.
  // fullBleed: it is a three-pane console that owns its own scroll containers.
  {
    id: 'mail', title: 'Mail', path: '/mail', icon: MailIcon,
    order: 35, requiresPlugin: 'mail', fullBleed: true,
  },
  { id: 'tasks', title: 'Tasks', path: '/tasks', icon: TasksIcon, order: 40 },
  { id: 'routines', title: 'Routines', path: '/routines', icon: ScheduleIcon, order: 50 },
  // Passwords (components/passwords/): it owns its three panes and their scroll.
  { id: 'passwords', title: 'Passwords', path: '/passwords', icon: PasswordsIcon, order: 60, fullBleed: true },
  // Apps manages everything else on the rail (built-in apps, plugins and their Apps), so
  // it can never be hidden: it is the way back to whatever was hidden. `exactPath`:
  // every plugin App lives under /apps/<id>, which is not the Apps page.
  {
    id: 'apps', title: 'Apps', path: '/apps', icon: AppsIcon,
    order: 990, lockVisibility: true, exactPath: true, fullBleed: true,
  },
  {
    id: 'settings', title: 'Settings', path: '/settings', icon: SettingsIcon,
    order: 1000, lockVisibility: true,
  },
] as const satisfies readonly Omit<CoreAppContribution, 'component'>[]

export type CoreAppId = (typeof CORE_APPS)[number]['id']

/** Every built-in app with a screen for each: a new app without one does not type-check. */
export function registerCoreApps(
  screens: Record<CoreAppId, ComponentType<AppComponentProps>>,
  onRegistered?: (id: CoreAppId, handle: AppHandle) => void,
): void {
  for (const app of CORE_APPS) {
    if (appRegistry.findByKey(`core:${app.id}`)) continue
    const handle = appRegistry.registerCore({ ...app, component: screens[app.id] })
    onRegistered?.(app.id, handle)
  }
}
