import type { Page, WebSocketRoute } from '@playwright/test'

/**
 * A page whose task list a spec answers itself, and nothing else's tasks on it.
 *
 * The browser fixture server is shared by every parallel worker, and the web task
 * store takes a task from a live `task:created` / `task:updated` frame too (an unknown
 * id is upserted). Answering `/api/tasks` alone therefore leaves the board open to
 * whatever the other workers' specs create, pin or edit while this one measures it
 * (CI 2026-11-04: a pinned row of kebab-menu-viewport-fit.spec.ts arrived mid-test as an
 * Inbox run in Satellite, and every row under it moved 69px).
 *
 * `answerTaskList` answers the list with `tasks()` (read on every request, so a spec
 * may change what it returns) and drops every event frame about a task none of its
 * answers held. Frames about the spec's own ids and every other frame pass untouched.
 * `tests/web/task-list-stub-ratchet.test.ts` holds every spec that answers the list
 * to this.
 */
export async function answerTaskList(page: Page, tasks: () => Array<{ id: string }>): Promise<void> {
  const ours = new Set<string>()
  await page.route('**/api/tasks?*', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.continue()
    const list = tasks()
    for (const task of list) ours.add(task.id)
    await route.fulfill({ json: { tasks: list } })
  })
  await page.routeWebSocket(/\/ws(\?|$)/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      if (foreignTaskFrame(typeof message === 'string' ? message : message.toString('utf8'), ours)) return
      ws.send(message)
    })
  })
}

/** Whether a server frame is an event about one task outside `ours`. */
export function foreignTaskFrame(text: string, ours: ReadonlySet<string>): boolean {
  let frame: { type?: string; data?: { task?: { id?: unknown } } }
  try { frame = JSON.parse(text) } catch { return false }
  if (frame?.type !== 'event') return false
  const id = frame.data?.task?.id
  return typeof id === 'string' && !ours.has(id)
}
