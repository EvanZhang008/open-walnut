/**
 * Folder names recover when the registry request dies at boot (2026-09-17).
 *
 * A folder's name is served by ONE request, `GET /api/tasks/groups`; the rows
 * themselves come from the task list. When that request was lost at boot the
 * panel drew every folder as a bare icon + count ("🗂 2") until a manual reload.
 * The scenario kills the first registry GETs before they leave the browser
 * (the incident's shape) and requires the name to arrive on its own.
 *
 *  1. the boot fetch is lost: the name lands with the connect-time re-pull (or
 *     the first retry, whichever is first);
 *  2. the connect-time re-pull dies too: the first retry of the schedule brings
 *     the name, with no reload;
 *  3. that retry dies as well: the schedule keeps going and the second retry
 *     brings it. Long enough a window that the nameless row the user reported
 *     is on screen for seconds first.
 *
 * "The boot fetch" is every registry GET in the first 500ms: the dev fixture
 * runs React StrictMode, which issues it twice, and a scenario must not pass
 * because a duplicate boot fetch slipped through on code that never retried.
 *
 * Scenario code lives in folder-registry-recovery-helpers.ts, shared with the
 * WebKit twin (a `test.use` browser pin only applies at a spec file's top level).
 */
import { test } from '@playwright/test'
import {
  expectFolderNameRecovers, newLitter, seedFolder, sweepLitter, type Litter,
} from './folder-registry-recovery-helpers'

test.setTimeout(120_000)

let litter: Litter = newLitter()
test.beforeEach(() => { litter = newLitter() })
test.afterEach(async () => { await sweepLitter(litter) })

test('the registry fetch lost at boot is retried and the folder gets its name without a reload', async ({ page }) => {
  const seeded = await seedFolder(litter, 'boot-loss')
  await expectFolderNameRecovers(page, seeded, 0)
})

test('the connect-time re-pull dies too: the first scheduled retry brings the name', async ({ page }) => {
  const seeded = await seedFolder(litter, 'one-extra')
  await expectFolderNameRecovers(page, seeded, 1)
})

test('that retry dies as well: the schedule keeps going until the name lands', async ({ page }) => {
  const seeded = await seedFolder(litter, 'two-extra')
  await expectFolderNameRecovers(page, seeded, 2)
})
