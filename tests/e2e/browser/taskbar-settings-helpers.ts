/**
 * This page's taskbar switches (Settings > General, hooks/useTaskbarSettings.ts), answered in the
 * browser: its config reads carry them, and its writes of them are kept here, never sent, so the
 * shared fixture server's settings never change under another spec (any other config write goes
 * on, without them). `writes` holds every `ui`
 * the page wrote, to check what a Settings click saves; a reload reads back what it wrote.
 */
import type { Page } from '@playwright/test'

export interface TaskbarConfig {
  taskbar_hide_recent_only?: boolean
  taskbar_leaving?: 'recent' | 'chips'
}

export async function pinTaskbarConfig(page: Page, initial: TaskbarConfig = {}): Promise<{ writes: TaskbarConfig[]; now: () => TaskbarConfig }> {
  const overlay: TaskbarConfig = { ...initial }
  const writes: TaskbarConfig[] = []
  // The last value this browser read, so the first render already matches.
  await page.addInitScript((v) => {
    try {
      localStorage.setItem('walnut:taskbar-settings', JSON.stringify({ hideRecentOnly: v.taskbar_hide_recent_only, leaving: v.taskbar_leaving }))
    } catch { /* none */ }
  }, overlay)
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') {
      const body = (route.request().postDataJSON() ?? {}) as { ui?: Record<string, unknown> }
      const ui = body.ui ?? {}
      const got: TaskbarConfig = {}
      if ('taskbar_hide_recent_only' in ui) got.taskbar_hide_recent_only = ui.taskbar_hide_recent_only as boolean
      if ('taskbar_leaving' in ui) got.taskbar_leaving = ui.taskbar_leaving as TaskbarConfig['taskbar_leaving']
      const changed = (Object.keys(got) as Array<keyof TaskbarConfig>).some((k) => got[k] !== overlay[k])
      if (changed) {
        // A taskbar switch's own write: kept here, never sent.
        Object.assign(overlay, got)
        writes.push(got)
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
        return
      }
      // Any other write (the panel count, say) goes on, without the switches this page read.
      if (body.ui) {
        const { taskbar_hide_recent_only: _h, taskbar_leaving: _l, ...rest } = ui
        body.ui = rest
      }
      await route.continue({ postData: JSON.stringify(body) })
      return
    }
    const res = await route.fetch()
    const body = await res.json() as { config: { ui?: Record<string, unknown> } }
    body.config.ui = { ...(body.config.ui ?? {}), ...overlay }
    await route.fulfill({ response: res, json: body })
  })
  return { writes, now: () => ({ ...overlay }) }
}
