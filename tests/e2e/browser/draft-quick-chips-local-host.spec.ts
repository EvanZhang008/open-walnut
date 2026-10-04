/**
 * One local folder is ONE quick chip, whichever way the store spelled "this machine".
 *
 * Reported 2026-10-04: the draft showed two identical "walnut · Local" chips. The
 * working-dirs reply held the same cwd twice, once with host null and once with host ''
 * (a launch that passed an empty host). The chip key only folded null, so both rendered.
 * The server now folds the spellings on read; this pins the client guard, so a stale
 * store or an older server can never draw the pair again.
 */
import { test, expect } from '@playwright/test'
import { discoverFixtureRoot, draftChipPaths, draftPanel, loadHome, openDraft, type WorkingDir } from './draft-helpers'

const SHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-chips'

test.setTimeout(120_000)

test("a folder stored under host '' and under null shows as one chip", async ({ page }) => {
  const root = await discoverFixtureRoot()
  const cwd = `${root}/projects/walnut`
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**/api/sessions/working-dirs*', async (route) => {
    const res = await route.fetch()
    const json = (await res.json()) as { dirs: Array<WorkingDir & { host: string | null }> }
    // The same folder again under the empty-string host, the newest row of all.
    json.dirs.unshift({ cwd, host: '', count: 1, lastUsed: new Date().toISOString() })
    await route.fulfill({ response: res, json })
  })
  await loadHome(page)
  const panel = await openDraft(page)
  await expect(panel).toBeVisible()
  const paths = await draftChipPaths(panel)
  expect(paths.filter((p) => p === cwd), 'the folder appears once').toHaveLength(1)
  expect(new Set(paths).size, 'no chip title repeats').toBe(paths.length)
  await expect(draftPanel(page)).toBeVisible()
  await panel.screenshot({ path: `${SHOT_DIR}/local-host-one-chip.png` })
})
