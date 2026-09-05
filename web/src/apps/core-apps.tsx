import { appRegistry, type AppComponentProps, type CoreAppContribution } from './registry'
import { HomeIcon, TasksIcon, NotesIcon, CalendarIcon, MailIcon, ScheduleIcon, SettingsIcon } from './icons'
import { MailApp } from './mail/MailApp'
import { attachMailBadge } from './mail/mail-live'
import { DashboardPage } from '@/pages/DashboardPage'
import { NotesPage } from '@/pages/NotesPage'
import { CalendarPage } from '@/pages/CalendarPage'
import { RoutinesPage } from '@/pages/RoutinesPage'
import { SettingsPage } from '@/pages/SettingsPage'

const EmptyApp = (_props: AppComponentProps) => null
const TasksApp = (_props: AppComponentProps) => <DashboardPage />
const NotesApp = (_props: AppComponentProps) => <NotesPage />
const CalendarApp = (_props: AppComponentProps) => <CalendarPage />
const RoutinesApp = (_props: AppComponentProps) => <RoutinesPage />
const SettingsApp = (_props: AppComponentProps) => <SettingsPage />

/**
 * Rail order (top → bottom): Home, Notes, Calendar, Tasks, Routines, Settings.
 * Home first because it is the landing surface; Notes/Calendar next because they
 * are read all day; Tasks after them (the Home Todo panel already covers the
 * common task reads, so /tasks is the deeper stop); Settings always last.
 *
 * These numbers are only the DEFAULT — a stored per-user order wins. A stored v1
 * order froze the previous default, so `parseAppPreferences` drops core keys when
 * migrating v1 → v2 (see preferences.ts) or this change would never reach an
 * existing client.
 */
export const CORE_APPS: CoreAppContribution[] = [
  {
    id: 'home', title: 'Home', path: '/', icon: HomeIcon, component: EmptyApp,
    order: 10, fullBleed: true, persistent: true, lockVisibility: true,
  },
  { id: 'notes', title: 'Notes', path: '/notes', icon: NotesIcon, component: NotesApp, order: 20, fullBleed: true },
  { id: 'calendar', title: 'Calendar', path: '/calendar', icon: CalendarIcon, component: CalendarApp, order: 30 },
  // The Mail console is core code (it needs host components a plugin bundle cannot import)
  // gated on the mail PLUGIN, which owns the model, the cache and every route it reads.
  // fullBleed: it is a three-pane console that owns its own scroll containers.
  {
    id: 'mail', title: 'Mail', path: '/mail', icon: MailIcon, component: MailApp,
    order: 35, requiresPlugin: 'mail', fullBleed: true,
  },
  { id: 'tasks', title: 'Tasks', path: '/tasks', icon: TasksIcon, component: TasksApp, order: 40 },
  { id: 'routines', title: 'Routines', path: '/routines', icon: ScheduleIcon, component: RoutinesApp, order: 50 },
  {
    id: 'settings', title: 'Settings', path: '/settings', icon: SettingsIcon, component: SettingsApp,
    order: 1000, lockVisibility: true,
  },
]

export function ensureCoreAppsRegistered(): void {
  for (const app of CORE_APPS) {
    if (appRegistry.findByKey(`core:${app.id}`)) continue
    const handle = appRegistry.registerCore(app)
    // The badge handle is only obtainable HERE, at registration. Mail keeps it and publishes the
    // unread total from the same mailbox rows the pane renders, so the sidebar number and the
    // mailbox badges are one arithmetic and cannot drift. This also installs mail's session-scoped
    // live wiring, which is what lets the badge move in a tab that never opened Mail.
    if (app.id === 'mail') attachMailBadge(handle)
  }
}
