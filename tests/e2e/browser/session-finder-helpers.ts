/**
 * Open a session on Home the way a person does from the keyboard: the session finder
 * (Cmd/Ctrl+Shift+O), its query, and a click on the one matching result. Works for a
 * session with no task too, which has no task row to click.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export async function openSessionFromFinder(page: Page, query: string, sid: string): Promise<Locator> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+Shift+O')
  const finder = page.locator('.session-search-panel')
  await expect(finder).toBeVisible()
  // The finder keeps the last query while closed and clears it in an effect once it is shown;
  // text typed before that effect is wiped with it. The same effect focuses the box a frame
  // later, so a focused, empty box has been cleared.
  const input = finder.locator('.session-search-input')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('')
  // It lists recent sessions at once and swaps in the query's answer 250 ms after the last
  // keystroke: a click during that swap can press one row and release on another (WebKit).
  const answered = page.waitForResponse((res) => {
    const u = new URL(res.url())
    return u.pathname === '/api/sessions/recent' && u.searchParams.get('q') === query
  })
  await input.fill(query)
  await expect(input).toHaveValue(query)
  await answered
  await expect(finder.locator('.todo-search-spinner')).toHaveCount(0)
  const result = finder.locator('.session-search-result').filter({ has: page.locator('.session-search-title', { hasText: query }) })
  await expect(result).toHaveCount(1, { timeout: 10_000 })
  await result.click()
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}
