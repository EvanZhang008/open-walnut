/**
 * Every setting's help line, as the page draws it, is one short line (standard.md, "Words", rule 8).
 *
 * The source ratchet (tests/web/ui-words-ratchet.test.ts, longHelp) reads `help="..."` literals; a
 * help built by a function, a constant from another file or a registry (the Experimental page's
 * forty descriptions, 2026-11-22 audit) only shows its length once drawn. So this walks every
 * Settings pane by its nav and measures each `.settings-row-help` the fixture shows. A longer text
 * goes on the row's hover (its `title`) or the docs.
 */
import { test, expect, type Page } from '@playwright/test'

test.setTimeout(240_000)

/** The help line's cap, the source ratchet's own (tests/web/ui-words-scan.ts HELP_MAX). */
const HELP_MAX = 120

/**
 * Rows whose line is their content, not an explanation, by label: the extension's numbered install
 * steps. An error message (a line with "Error:") is also shown whole: it says what went wrong.
 */
const SHOWN_WHOLE = new Set(['Chrome, Edge, Brave or Arc'])

/** The panes of Settings: its nav entries, minus the ones that are links to another page (Agents). */
async function navIds(page: Page): Promise<string[]> {
  return page.$$eval('.settings-nav [data-testid^="settings-nav-"]', (els) => els
    .filter((e) => !(e instanceof HTMLAnchorElement && !new URL(e.href).pathname.startsWith('/settings')))
    .map((e) => e.getAttribute('data-testid')!.slice('settings-nav-'.length)))
}

test('every help line in Settings is 120 characters or less', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  const ids = await navIds(page)
  expect(ids.length).toBeGreaterThan(10)
  const long: string[] = []
  for (const id of ids) {
    const item = page.getByTestId(`settings-nav-${id}`)
    if (!(await item.isVisible())) continue
    await item.click()
    await expect(item).toHaveAttribute('aria-current', 'page')
    await page.waitForTimeout(800)
    const rows = await page.$$eval('.settings-pane p.settings-row-help', (els) => els.map((el) => ({
      label: el.closest('.settings-row')?.querySelector('.settings-row-label')?.textContent?.trim() ?? '',
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })))
    for (const r of rows) if (r.text.length > HELP_MAX && !SHOWN_WHOLE.has(r.label) && !/\bError:/.test(r.text)) long.push(`${id} > ${r.label}: ${r.text.length} chars: ${r.text.slice(0, 90)}...`)
  }
  expect(long, 'help lines over 120 characters: shorten each, the rest goes on the row\'s hover').toEqual([])
})
