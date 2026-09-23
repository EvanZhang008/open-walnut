import { test as base, type BrowserContext, type Page } from '@playwright/test'

export const APP_SHORTCUTS_KEY = 'open-walnut-app-shortcuts-visible'
export const TASK_SHORTCUTS_KEY = 'walnut-todo-quick-views-visible'
/** Every tab stays on the bar: these specs click tier tabs the shared fixture may hold no task for. */
export const TAB_BAR_HIDE_EMPTY_KEY = 'walnut-todo-tab-bar-hide-empty'

// These specs exercise optional bars; absent-only seeds preserve explicit preferences.
export async function seedShortcutBars(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript(
    ([appKey, taskKey, emptyKey]) => {
      try {
        if (localStorage.getItem(appKey) === null) localStorage.setItem(appKey, 'true')
        if (localStorage.getItem(taskKey) === null) localStorage.setItem(taskKey, 'true')
        if (localStorage.getItem(emptyKey) === null) localStorage.setItem(emptyKey, 'false')
      } catch {}
    },
    [APP_SHORTCUTS_KEY, TASK_SHORTCUTS_KEY, TAB_BAR_HIDE_EMPTY_KEY],
  )
}

export const test = base.extend<{ shortcutBarsVisible: void }>({
  shortcutBarsVisible: [
    async ({ context }, use) => {
      await seedShortcutBars(context)
      await use()
    },
    { auto: true },
  ],
})

export { expect } from '@playwright/test'
