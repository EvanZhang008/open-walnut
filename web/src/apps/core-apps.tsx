/**
 * The console's built-in apps with every screen loaded (the sidebar can go to any of them).
 * The list itself (names, paths, rail order) is core-app-list.ts; a pop-out window of one app
 * loads only that app's screen (core-apps-lazy.ts).
 */
import type { AppComponentProps } from './registry'
import { registerCoreApps } from './core-app-list'
import { MailApp } from './mail/MailApp'
import { attachMailBadge } from './mail/mail-live'
import { TasksApp } from './TasksApp'
import { NotesPage } from '@/pages/NotesPage'
import { CalendarPage } from '@/pages/CalendarPage'
import { RoutinesPage } from '@/pages/RoutinesPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { AppsPage } from '@/pages/AppsPage'
import { PasswordsApp as PasswordsView } from '@/components/passwords/PasswordsApp'

const EmptyApp = (_props: AppComponentProps) => null
const NotesApp = (_props: AppComponentProps) => <NotesPage />
const CalendarApp = (_props: AppComponentProps) => <CalendarPage />
const RoutinesApp = (_props: AppComponentProps) => <RoutinesPage />
const SettingsApp = (_props: AppComponentProps) => <SettingsPage />
const AppsApp = (_props: AppComponentProps) => <AppsPage />
const PasswordsApp = (_props: AppComponentProps) => <PasswordsView />

export function ensureCoreAppsRegistered(): void {
  registerCoreApps({
    home: EmptyApp,
    notes: NotesApp,
    calendar: CalendarApp,
    mail: MailApp,
    tasks: TasksApp,
    routines: RoutinesApp,
    passwords: PasswordsApp,
    apps: AppsApp,
    settings: SettingsApp,
  }, (id, handle) => {
    // The badge handle is only obtainable HERE, at registration. Mail keeps it and publishes the
    // unread total from the same mailbox rows the pane renders, so the sidebar number and the
    // mailbox badges are one arithmetic and cannot drift. This also installs mail's session-scoped
    // live wiring, which is what lets the badge move in a tab that never opened Mail.
    if (id === 'mail') attachMailBadge(handle)
  })
}
