import { Navigate } from 'react-router-dom'
import type { AppComponentProps } from './registry'
import { DashboardPage } from '@/pages/DashboardPage'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'

/**
 * N2-16: on a phone the home screen IS the task list. The dashboard (a project
 * rail beside a wide table) stays off the drawer, and a link that still lands
 * on /tasks (a project mention in chat, a deleted task, a command) goes home.
 */
export function TasksApp(_props: AppComponentProps) {
  const phone = usePhoneLayout()
  return phone ? <Navigate to="/" replace /> : <DashboardPage />
}
