/**
 * The shared task store's optimistic mutators (`useTasks`) for the three writes
 * that used to bypass it entirely.
 *
 * Why these are unit tests and not browser specs: each one is a PREDICTION of
 * what the server will do, and its fidelity to the server's own rules is the
 * whole point. A browser spec can only see that something changed, not that the
 * prediction matches `task-manager.applyUpdates` / `setPluginTaskField` case for
 * case (a `sprint:` convention tag intercepted out of the tag list, a cleared
 * plugin value DELETING its ext key rather than storing '').
 *
 *   . applyTagInstructions   — add / remove / set + the sprint: convention
 *   . applyPluginFieldPatch  — core column vs ext.<pluginId>.<key>, clears
 *   . the mutators themselves — that `update` now applies tag instructions
 *     locally, `setPluginField` patches before the PUT, and `deleteTask`
 *     forwards `force` and reports the outcome instead of swallowing it.
 *
 * HOW the hook runs without a DOM (root vitest is `environment: 'node'`, no
 * jsdom, no @testing-library/react): React's four hook primitives are replaced
 * with stand-ins and `useTasks` is invoked directly — the SAME technique as
 * tests/web/use-project-actions.test.ts, for the same reason. The code under
 * test is the real hook. `useState` slots are keyed by CALL ORDER, which is
 * stable for a hook; the seed assertion in `mount()` fails loudly if slot 0 ever
 * stops being the task list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../../src/core/types'

// The frontend's React lives in web/node_modules, so a mock keyed on the repo
// root's 'react' would silently miss (see use-project-actions.test.ts).
const stateSlots: unknown[] = []
let stateIdx = 0

vi.mock('../../web/node_modules/react', () => ({
  useState: <T,>(initial: T) => {
    const slot = stateIdx++
    if (!(slot in stateSlots)) {
      stateSlots[slot] = typeof initial === 'function' ? (initial as () => T)() : initial
    }
    const set = (next: unknown) => {
      stateSlots[slot] = typeof next === 'function'
        ? (next as (prev: unknown) => unknown)(stateSlots[slot])
        : next
    }
    return [stateSlots[slot], set] as const
  },
  useCallback: <T,>(fn: T) => fn,
  useEffect: () => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
  startTransition: (fn: () => void) => fn(),
}))

const eventHandlers = new Map<string, (data: unknown) => void>()
vi.mock('@/hooks/useWebSocket', () => ({
  useEvent: (name: string, handler: (data: unknown) => void) => eventHandlers.set(name, handler),
}))

const api = {
  fetchTasks: vi.fn(async () => [] as Task[]),
  fetchTaskGroups: vi.fn(async () => [] as unknown[]),
  createTask: vi.fn(),
  updateTask: vi.fn(async () => ({}) as Task),
  toggleCompleteTask: vi.fn(async () => ({}) as Task),
  reorderTasks: vi.fn(async () => {}),
  deleteTask: vi.fn(async (_id: string, _opts?: { force?: boolean }) => {}),
  setPluginFieldValue: vi.fn(async () => {}),
  batchSetPhase: vi.fn(),
  batchDeleteTasks: vi.fn(),
  createTaskGroup: vi.fn(),
  addTasksToGroup: vi.fn(),
  removeTasksFromGroup: vi.fn(),
  renameTaskGroup: vi.fn(),
  setTaskGroupHidden: vi.fn(),
  createEmptyFolder: vi.fn(),
  deleteTaskFolder: vi.fn(),
  setTaskFolderParent: vi.fn(),
  moveFolderToProject: vi.fn(),
}
vi.mock('@/api/tasks', () => api)

const { useTasks, applyTagInstructions, applyPluginFieldPatch } = await import('@/hooks/useTasks')

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Store fixture',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    project: 'Walnut',
    source: 'local',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  } as Task
}

/** Invoke the real hook over a seeded task list. Returns its mutators. */
function mount(tasks: Task[]) {
  eventHandlers.clear()
  stateSlots.length = 0
  stateSlots[0] = tasks
  stateIdx = 0
  const store = useTasks()
  // Slot 0 is the task list. If a new useState ever lands before it this fails
  // here rather than quietly testing an unrelated slot.
  expect(store.tasks).toBe(tasks)
  return store
}

/** The task list as the store holds it NOW (after the mutators' setTasks). */
function rows(): Task[] {
  return stateSlots[0] as Task[]
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchTasks.mockResolvedValue([])
  api.fetchTaskGroups.mockResolvedValue([])
  api.deleteTask.mockResolvedValue(undefined)
  api.setPluginFieldValue.mockResolvedValue(undefined)
  api.updateTask.mockResolvedValue(task())
})

describe('task phase event ownership', () => {
  it.each(['session_id', 'plan_session_id', 'exec_session_id'] as const)(
    'a session hint cannot replace the committed phase through %s', (slot) => {
      mount([task({ [slot]: 'session-1', phase: 'NEED_ACTION', status: 'in_progress', unread: true })])
      eventHandlers.get('session:status-changed')?.({
        sessionId: 'session-1', phase: 'IN_PROGRESS', process_status: 'running',
      })
      expect(rows()[0]).toMatchObject({ phase: 'NEED_ACTION', unread: true })
      eventHandlers.get('task:updated')?.({
        task: task({ [slot]: 'session-1', phase: 'IN_PROGRESS', status: 'in_progress', unread: false }),
      })
      expect(rows()[0]).toMatchObject({ phase: 'IN_PROGRESS', unread: false })
    },
  )

  it('marking a task read cannot swallow a concurrent committed phase change', () => {
    const store = mount([task({ phase: 'IN_PROGRESS', status: 'in_progress', unread: true })])
    store.update('task-1', { unread: false })
    eventHandlers.get('task:updated')?.({
      task: task({ phase: 'NEED_ACTION', status: 'in_progress', unread: true }),
    })
    expect(rows()[0]).toMatchObject({ phase: 'NEED_ACTION', unread: true })
  })

  it('a delayed phase hint cannot reopen a completed task', () => {
    mount([task({ session_id: 'session-1', phase: 'COMPLETE', status: 'done' })])
    eventHandlers.get('session:status-changed')?.({
      sessionId: 'session-1', phase: 'IN_PROGRESS',
      status: { sessionId: 'session-1', processStatus: 'running' },
    })
    expect(rows()[0]).toMatchObject({ phase: 'COMPLETE', status: 'done' })
  })
})

describe('applyTagInstructions', () => {
  it('unions add_tags onto the existing tags, keeping order and deduping', () => {
    expect(applyTagInstructions({ tags: ['a', 'b'] }, { add_tags: ['b', 'c'] }))
      .toEqual({ tags: ['a', 'b', 'c'] })
  })

  it('filters remove_tags out', () => {
    expect(applyTagInstructions({ tags: ['a', 'b', 'c'] }, { remove_tags: ['b'] }))
      .toEqual({ tags: ['a', 'c'] })
  })

  it('clears `tags` (not [] ) when the last tag is removed — mirrors the server delete', () => {
    expect(applyTagInstructions({ tags: ['a'] }, { remove_tags: ['a'] }))
      .toEqual({ tags: undefined })
  })

  it('set_tags replaces everything', () => {
    expect(applyTagInstructions({ tags: ['a', 'b'] }, { set_tags: ['z', 'z', 'y'] }))
      .toEqual({ tags: ['z', 'y'] })
  })

  it('touches nothing when the update carries no tag instruction', () => {
    expect(applyTagInstructions({ tags: ['a'] }, {})).toEqual({})
  })

  // The sprint: convention — the server redirects these into the sprint COLUMN,
  // so a client prediction that left them in the tag list would show a tag that
  // never exists on the server.
  it('intercepts a sprint: tag into the sprint column instead of the tag list', () => {
    expect(applyTagInstructions({ tags: ['a'] }, { add_tags: ['sprint:Feb 2 - Feb 13'] }))
      .toEqual({ sprint: 'Feb 2 - Feb 13' })
  })

  it('removing a sprint: tag clears the sprint column', () => {
    expect(applyTagInstructions({ tags: ['a'], sprint: 'Old' }, { remove_tags: ['sprint:Old'] }))
      .toEqual({ sprint: undefined })
  })

  it('keeps the plain tags of a mixed set_tags and drops the sprint one', () => {
    expect(applyTagInstructions({ tags: ['a'] }, { set_tags: ['keep', 'sprint:S1'] }))
      .toEqual({ tags: ['keep'], sprint: 'S1' })
  })
})

describe('applyPluginFieldPatch', () => {
  const extField = { pluginId: 'plugin-a', key: 'iteration' }
  const sprintField = { pluginId: 'plugin-a', key: 'sprint', coreField: 'sprint' as const }

  it('writes a core-column field onto the column', () => {
    expect(applyPluginFieldPatch({ sprint: 'Old' }, sprintField, 'New')).toEqual({ sprint: 'New' })
  })

  it('clears a core-column field', () => {
    expect(applyPluginFieldPatch({ sprint: 'Old' }, sprintField, null)).toEqual({ sprint: undefined })
  })

  it('writes anything else into ext.<pluginId>.<key>', () => {
    expect(applyPluginFieldPatch({}, extField, 'IT-7'))
      .toEqual({ ext: { 'plugin-a': { iteration: 'IT-7' } } })
  })

  it('keeps the plugin\'s other keys and the other plugins', () => {
    const base = { ext: { 'plugin-a': { id: 'PA-1', iteration: 'IT-6' }, 'plugin-b': { key: 'BE-2' } } }
    expect(applyPluginFieldPatch(base, extField, 'IT-7')).toEqual({
      ext: { 'plugin-a': { id: 'PA-1', iteration: 'IT-7' }, 'plugin-b': { key: 'BE-2' } },
    })
  })

  it('DELETES the ext key on a clear rather than storing an empty string', () => {
    const base = { ext: { 'plugin-a': { id: 'PA-1', iteration: 'IT-6' } } }
    expect(applyPluginFieldPatch(base, extField, null))
      .toEqual({ ext: { 'plugin-a': { id: 'PA-1' } } })
    expect(applyPluginFieldPatch(base, extField, ''))
      .toEqual({ ext: { 'plugin-a': { id: 'PA-1' } } })
  })
})

describe('update() with tag instructions', () => {
  it('applies the resulting tags locally and still sends the instruction', () => {
    const store = mount([task({ tags: ['a'] })])
    store.update('task-1', { add_tags: ['b'] })
    expect(rows()[0].tags).toEqual(['a', 'b'])
    expect(api.updateTask).toHaveBeenCalledWith('task-1', { add_tags: ['b'] })
  })

  it('bumps updated_at (a tag change is content, unlike the read marker)', () => {
    const store = mount([task({ tags: ['a'] })])
    store.update('task-1', { remove_tags: ['a'] })
    expect(rows()[0].updated_at).not.toBe('2026-09-01T00:00:00.000Z')
    expect(rows()[0].tags).toBeUndefined()
  })

  it('leaves a non-optimistic-only update to the echo', () => {
    const store = mount([task({ tags: ['a'] })])
    store.update('task-1', { add_depends_on: ['task-2'] } as Parameters<typeof store.update>[1])
    expect(rows()[0].updated_at).toBe('2026-09-01T00:00:00.000Z')
    expect(api.updateTask).toHaveBeenCalled()
  })
})

describe('setPluginField()', () => {
  it('patches the row BEFORE the PUT and sends the write', () => {
    const store = mount([task({ ext: { 'plugin-a': { id: 'PA-1' } } })])
    const field = { pluginId: 'plugin-a', key: 'iteration' }
    store.setPluginField('task-1', field, 'IT-7')
    expect(rows()[0].ext).toEqual({ 'plugin-a': { id: 'PA-1', iteration: 'IT-7' } })
    expect(api.setPluginFieldValue).toHaveBeenCalledWith('task-1', field, 'IT-7')
  })

  it('takes ext from the caller\'s copy — the list payload carries none', () => {
    // The home list row (`fields=list`) has no `ext` at all, so a patch derived
    // from the row alone would wipe the plugin's identity keys.
    const store = mount([task()])
    store.setPluginField(
      'task-1',
      { pluginId: 'plugin-a', key: 'iteration' },
      'IT-7',
      { ext: { 'plugin-a': { id: 'PA-1', short_id: 'A-1' } } },
    )
    expect(rows()[0].ext).toEqual({ 'plugin-a': { id: 'PA-1', short_id: 'A-1', iteration: 'IT-7' } })
  })

  it('writes a core-column field on the row', () => {
    const store = mount([task({ sprint: 'Old' })])
    store.setPluginField('task-1', { pluginId: 'plugin-a', key: 'sprint', coreField: 'sprint' }, 'New')
    expect(rows()[0].sprint).toBe('New')
  })

  it('ignores an id the list does not carry', () => {
    const store = mount([task()])
    store.setPluginField('other', { pluginId: 'plugin-a', key: 'iteration' }, 'IT-7')
    expect(rows()[0].ext).toBeUndefined()
  })
})

describe('deleteTask()', () => {
  it('removes the row before the DELETE and reports success', async () => {
    const store = mount([task(), task({ id: 'task-2' })])
    const done = store.deleteTask('task-1')
    expect(rows().map((t) => t.id)).toEqual(['task-2'])
    await expect(done).resolves.toBe(true)
    expect(api.deleteTask).toHaveBeenCalledWith('task-1', undefined)
  })

  it('forwards force — the toast Undo may have to delete past the session guard', async () => {
    const store = mount([task()])
    await store.deleteTask('task-1', { force: true })
    expect(api.deleteTask).toHaveBeenCalledWith('task-1', { force: true })
  })

  it('resolves FALSE instead of rejecting when the server refuses', async () => {
    api.deleteTask.mockRejectedValue(Object.assign(new Error('409 has active children'), { status: 409 }))
    const store = mount([task()])
    await expect(store.deleteTask('task-1')).resolves.toBe(false)
  })
})
