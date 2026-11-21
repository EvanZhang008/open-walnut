/**
 * The focus a view follows: null when focus spaces are off (experiment `focus_workspace`) or
 * the person is in none, so every view keeps today's behaviour then. A view that lists tasks
 * passes its list through `filter`; one that shows ONE task asks `inScope`. Lookups run on the
 * whole store (a subtask of a named task is inside), never on a filtered list.
 */
import { useMemo } from 'react'
import { taskInScope, type ScopeTask } from '@open-walnut/focus-scope'
import { useExperimental } from '@/hooks/useExperimental'
import { useTaskStoreActions } from '@/contexts/TasksContext'
import { useFocusSnapshot, type ActiveFocus } from './focus-store'

export interface FocusView {
  active: ActiveFocus
  /** Is the task inside the focus? A task the store does not hold is outside. */
  inScope(taskId: string | null | undefined): boolean
  /** The rows of `list` inside the focus. */
  filter<T extends ScopeTask>(list: readonly T[]): T[]
}

export function useFocusOn(): boolean {
  return useExperimental('focus_workspace')
}

/** The view of one focus over the store's lookup (module-level: the hook memoizes only data). */
function makeView(active: ActiveFocus, get: ((id: string) => ScopeTask | null) | undefined): FocusView {
  return {
    active,
    inScope: (taskId) => taskInScope(active.scope, taskId, (id) => get?.(id) ?? null),
    filter: <T extends ScopeTask>(list: readonly T[]) => {
      // The list itself first (it may hold rows the store does not yet), then the store.
      const byId = new Map<string, ScopeTask>(list.map((t) => [t.id, t]))
      const lookup = (id: string) => byId.get(id) ?? get?.(id) ?? null
      return list.filter((t) => taskInScope(active.scope, t.id, lookup))
    },
  }
}

export function useFocusView(): FocusView | null {
  const on = useFocusOn()
  const { active } = useFocusSnapshot()
  const get = useTaskStoreActions()?.get
  return useMemo(() => (on && active ? makeView(active, get) : null), [on, active, get])
}
