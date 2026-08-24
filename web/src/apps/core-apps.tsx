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

export const CORE_APPS: CoreAppContribution[] = [
  {
    id: 'home', title: 'Home', path: '/', icon: HomeIcon, component: EmptyApp,
    order: 10, fullBleed: true, persistent: true, lockVisibility: true,
  },
  { id: 'tasks', title: 'Tasks', path: '/tasks', icon: TasksIcon, component: TasksApp, order: 20 },
  { id: 'notes', title: 'Notes', path: '/notes', icon: NotesIcon, component: NotesApp, order: 30, fullBleed: true },
  { id: 'calendar', title: 'Calendar', path: '/calendar', icon: CalendarIcon, component: CalendarApp, order: 40 },
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
