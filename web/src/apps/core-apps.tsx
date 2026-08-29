import { appRegistry, type AppComponentProps, type CoreAppContribution } from './registry'
import { HomeIcon, TasksIcon, NotesIcon, CalendarIcon, ScheduleIcon, SettingsIcon } from './icons'
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
  { id: 'tasks', title: 'Tasks', path: '/tasks', icon: TasksIcon, component: TasksApp, order: 40 },
  { id: 'routines', title: 'Routines', path: '/routines', icon: ScheduleIcon, component: RoutinesApp, order: 50 },
  {
    id: 'settings', title: 'Settings', path: '/settings', icon: SettingsIcon, component: SettingsApp,
    order: 1000, lockVisibility: true,
  },
]

export function ensureCoreAppsRegistered(): void {
  for (const app of CORE_APPS) {
    if (!appRegistry.findByKey(`core:${app.id}`)) appRegistry.registerCore(app)
  }
}
