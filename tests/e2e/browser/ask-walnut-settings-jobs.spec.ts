/**
 * Playwright test: Settings → Ask Walnut, the "what it does on its own" list.
 *
 * The list's whole value is that the runner column is TRUE. The first version
 * called all ten rows "model" jobs, which was wrong twice over: session titles
 * and diff summaries are answered by the coding session's own model over its
 * control pipe (no Walnut provider involved), and AI task search spawns a slim
 * Claude Code child under this machine's own login. This pins each row's
 * runner as rendered, so a future edit can't quietly mislabel them again.
 */
import { test, expect } from '@playwright/test'

test.describe('Ask Walnut settings — agent job inventory', () => {
  test('every job row names who actually answers it', async ({ page }) => {
    // Initial load only (a fresh profile starts with the sidebar fully
    // collapsed and its expand control hidden, so there is no clickable path
    // to Settings from `/`); the section itself is then reached by a real click.
    await page.goto('/settings')
    // Not networkidle: the app holds a live stream open, so it never settles.
    const nav = page.getByTestId('settings-nav-ask-walnut')
    await expect(nav).toBeVisible({ timeout: 30_000 })
    await nav.click()

    const section = page.locator('#ask-walnut')
    await expect(section).toBeVisible({ timeout: 10_000 })

    const jobs = section.getByTestId('ask-walnut-jobs')
    await expect(jobs).toBeVisible()

    // Row-by-row: the runner cell is the FIRST span of the row, so read it
    // per row — a section-wide text match would happily pass on a page that
    // labels every row "model" (that is how the wrong list looked green).
    const expected: Array<[string, string]> = [
      ['Quick-add task parsing', 'model'],
      ['Session auto-filing', 'model'],
      ['Session titles', 'session'],
      ['Diff summaries', 'session'],
      ['AI task search', 'Claude Code'],
      ['Conversation and fork titles', 'model'],
      ['Project summaries', 'model'],
      ['Task ledger notes', 'model'],
      ['Memory upkeep', 'model'],
      ['Routine drafts', 'model'],
    ]
    const rows = jobs.locator('li')
    await expect(rows).toHaveCount(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const [name, runner] = expected[i]
      const row = rows.nth(i)
      await expect(row).toContainText(name)
      // Jev is off in the fixture (no credential), so the two classification
      // rows read "model" here; the label flips to Jev once a key is present.
      await expect(row.locator('span').first()).toHaveText(runner)
    }

    // The two credential-free runners are explained, not just labelled.
    await expect(section).toContainText('need no provider of their own')

    await section.screenshot({ path: '/tmp/ask-walnut-jobs/section.png' })
  })
})
