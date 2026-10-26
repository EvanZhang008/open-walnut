/**
 * The Home panels' ACTUAL open state in this window, as MainPage broadcasts it
 * (`main:<panel>-visible`, sent on mount and on every change). localStorage holds
 * the user's preference instead, which can differ (a draft borrowing the chat spot,
 * another window writing the shared key), so anything that toggles a panel to close
 * it must read this, or the toggle opens it.
 *
 * Listens from import time: the Apps page imports it eagerly with the core apps, so
 * the first broadcast at MainPage's mount is never missed. Null until one arrives.
 */
export type HomePanelId = 'todo' | 'calendar' | 'scratchpad' | 'chat'

const latest: Partial<Record<HomePanelId, boolean>> = {}

if (typeof window !== 'undefined') {
  for (const id of ['todo', 'calendar', 'scratchpad', 'chat'] as const) {
    window.addEventListener(`main:${id}-visible`, (event) => {
      const visible = (event as CustomEvent<{ visible?: unknown }>).detail?.visible
      if (typeof visible === 'boolean') latest[id] = visible
    })
  }
}

export function homePanelOpen(id: HomePanelId): boolean | null {
  return latest[id] ?? null
}
