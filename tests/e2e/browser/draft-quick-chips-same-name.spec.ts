/**
 * Sibling checkouts that share a folder name are ONE quick chip.
 *
 * Reported 2026-10-06: the draft showed "review · devbox" three times. The store
 * held three real paths (three worktrees of one repo, each ending in the same
 * folder), the chip label is the folder name, and the row deduped by full path, so
 * three different folders drew three identical buttons. The row now keeps one chip
 * per visible name on a host: it opens the checkout the folder picker ranks first,
 * and the draft's own folder takes that slot when it shares the name.
 */
import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  discoverFixtureRoot, draftChipPaths, draftCwdPill, draftQuickChips, loadHome, openDraft, pickDraftFolder,
  type WorkingDir,
} from './draft-helpers'

const SHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-chips'

test.setTimeout(120_000)

test('three checkouts ending in one folder name draw one chip, and the picked one owns it', async ({ page }) => {
  const root = await discoverFixtureRoot()
  const paths = ['alpha', 'beta', 'gamma'].map((tree) => `${root}/worktrees/${tree}/review`)
  for (const p of paths) fs.mkdirSync(p, { recursive: true })
  const now = Date.now()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**/api/sessions/working-dirs*', async (route) => {
    const res = await route.fetch()
    const json = (await res.json()) as { dirs: WorkingDir[] }
    // alpha: most used but stale; gamma: newest but a one-off; beta: what the
    // folder picker ranks first (count decayed by age), so beta owns the chip.
    const shape = [[5000, 10 * 86_400_000], [3000, 86_400_000], [5, 60_000]]
    json.dirs.unshift(...paths.map((cwd, i) => ({
      cwd, host: null, count: shape[i][0], lastUsed: new Date(now - shape[i][1]).toISOString(),
    })))
    await route.fulfill({ response: res, json })
  })
  await loadHome(page)
  const panel = await openDraft(page)
  const reviewChips = () => draftQuickChips(panel).filter({ hasText: /^review$/ })

  const labels = (await draftQuickChips(panel).allInnerTexts()).map((l) => l.trim())
  expect(labels.filter((l) => l === 'review'), 'the shared name is one chip').toHaveLength(1)
  expect(new Set(labels).size, 'no two chips read the same').toBe(labels.length)
  const titles = await draftChipPaths(panel)
  expect(titles.filter((t) => paths.includes(t)), 'the chip opens the checkout the picker ranks first').toEqual([paths[1]])
  const slot = titles.indexOf(paths[1])

  // One click on it: the draft runs there, the chip lights, nothing moves.
  await reviewChips().click()
  await expect(draftCwdPill(panel)).toContainText('review')
  await expect(reviewChips()).toHaveClass(/draft-quick-chip-active/)
  expect(await draftChipPaths(panel)).toEqual(titles)

  // A sibling checkout picked through the full picker takes the same slot, lit.
  for (const target of [paths[0], paths[2]]) {
    await pickDraftFolder(page, panel, target)
    await expect(reviewChips()).toHaveCount(1)
    await expect(reviewChips()).toHaveAttribute('title', target)
    await expect(reviewChips()).toHaveClass(/draft-quick-chip-active/)
    expect((await draftChipPaths(panel)).indexOf(target), 'the chip did not move').toBe(slot)
  }
  await panel.locator('.draft-quick-block').screenshot({ path: `${SHOT_DIR}/same-name-one-chip-${test.info().project.name}.png` })
  // A late cache re-warm must not land in the handler after the page closes.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})
