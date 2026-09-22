import { test as base, type BrowserContext, type Page } from '@playwright/test'

export const APP_SHORTCUTS_KEY = 'open-walnut-app-shortcuts-visible'
export const TASK_SHORTCUTS_KEY = 'walnut-todo-quick-views-visible'

// These specs exercise optional bars; absent-only seeds preserve explicit preferences.
export async function seedShortcutBars(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript(
    ([appKey, taskKey]) => {
      try {
        if (localStorage.getItem(appKey) === null) localStorage.setItem(appKey, 'true')
        if (localStorage.getItem(taskKey) === null) localStorage.setItem(taskKey, 'true')
      } catch {}
    },
    [APP_SHORTCUTS_KEY, TASK_SHORTCUTS_KEY],
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
