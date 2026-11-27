/**
 * Words and counts the focus views show, kept apart from React so they are tested alone.
 */
import { isHiddenFromTaskLists } from '@open-walnut/org-tree'
import type { Task } from '@open-walnut/core'
import { taskUserState } from '@/utils/session-status'
import type { ActiveFocus } from './focus-store'
import { clockTime } from '@/utils/time'

/** "Walnut, Interview · 2 tasks": what a space or a focus holds, in a few words. */
export function scopeLine(scope: { projects?: readonly string[]; tasks?: readonly string[] }, titleOf?: (id: string) => string | undefined): string {
  const projects = (scope.projects ?? []).map((p) => p || 'Inbox')
  const tasks = scope.tasks ?? []
  const parts: string[] = []
  if (projects.length) parts.push(projects.join(', '))
  if (tasks.length === 1 && titleOf?.(tasks[0])) parts.push(titleOf(tasks[0])!)
  else if (tasks.length) parts.push(`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`)
  return parts.join(' · ')
}

/** Open tasks outside the focus, and those of them that need the person. */
export function outsideCounts(tasks: readonly Task[], inScope: (id: string) => boolean): { open: number; needs: number } {
  let open = 0
  let needs = 0
  for (const t of tasks) {
    if (isHiddenFromTaskLists(t) || inScope(t.id)) continue
    const state = taskUserState(t)
    if (state === 'done') continue
    open++
    if (state === 'needs') needs++
  }
  return { open, needs }
}

/** "14 waiting outside": the one way every view says it. */
export function outsideWords(open: number): string {
  return `${open} waiting outside`
}

/** What waited outside while the person focused: tasks that came to need them since it began. */
export interface FocusSummary {
  name: string
  minutes: number
  needs: Array<{ id: string; title: string }>
  /** Outside tasks that changed at all since the focus began. */
  changed: number
}

export function summarize(ended: ActiveFocus, tasks: readonly Task[], inScope: (id: string) => boolean, now = Date.now()): FocusSummary {
  const needs: Array<{ id: string; title: string }> = []
  let changed = 0
  for (const t of tasks) {
    if (isHiddenFromTaskLists(t) || inScope(t.id)) continue
    const at = Date.parse(t.updated_at ?? '')
    if (!Number.isFinite(at) || at < ended.since) continue
    changed++
    if (taskUserState(t) === 'needs') needs.push({ id: t.id, title: t.title })
  }
  return { name: ended.name, minutes: Math.max(0, Math.round((now - ended.since) / 60_000)), needs, changed }
}

export function durationWords(minutes: number): string {
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** "until 3:30 PM", or nothing for a focus with no end. */
export function untilWords(until: number | undefined): string {
  if (until === undefined) return ''
  return `until ${clockTime(until)}`
}

/** The lengths the person picks from when entering; null = until they leave. */
export const FOCUS_LENGTHS: ReadonlyArray<{ label: string; minutes: number | null }> = [
  { label: '1 h', minutes: 60 },
  { label: '2 h', minutes: 120 },
  { label: 'Until I leave', minutes: null },
]

/**
 * A new order of the rows a focus shows, merged back into the whole order: every row outside
 * the focus keeps its slot, and the slots of the shown rows take them in their new order. A
 * reorder written with only the shown ids would move every hidden row of the project to its end.
 */
export function mergeVisibleOrder(fullIds: readonly string[], newVisibleIds: readonly string[]): string[] {
  const shown = new Set(newVisibleIds)
  const out: string[] = []
  let next = 0
  for (const id of fullIds) out.push(shown.has(id) ? newVisibleIds[next++] : id)
  // A shown id the whole order lacks (a row just made) goes last, as a write of it alone would.
  while (next < newVisibleIds.length) out.push(newVisibleIds[next++])
  return out
}

/** The line under the people in a focus space (quick/people `focus`), none outside one. */
export function focusNoteOf(focus: { name: string; outside: number } | undefined): string | undefined {
  if (!focus) return undefined
  const left = focus.outside === 0 ? '' : ` · ${focus.outside} ${focus.outside === 1 ? 'task' : 'tasks'} outside it not listed`
  return `In focus: ${focus.name}${left}. A line to anyone outside is sent, and its reply waits there.`
}
