/**
 * corner-stack-room.spec.ts with classic scrollbars that take width (Linux, Windows, a Mac set to
 * always show them), where Playwright's headless Chromium hides them by default: a list that starts
 * to scroll when the notice stack's room comes keeps its width (scrollbar-gutter: stable), so
 * nothing moves. Chromium only: WebKit 26 reserves no gutter beside the app's ::-webkit-scrollbar
 * style, a known gap (docs/reference/notification-lifecycle.md).
 */
import { test } from '@playwright/test'
import { homeWithNotice, railWalk } from './corner-stack-room'
import { CHROMIUM_SILENT } from './pw-silence'

// The project's own launch options (silent), plus scrollbars shown.
test.use({ launchOptions: { args: CHROMIUM_SILENT, ignoreDefaultArgs: ['--hide-scrollbars'] } })
test.describe.configure({ timeout: 300_000 })
test.skip(({ browserName }) => browserName !== 'chromium', 'WebKit ignores scrollbar-gutter beside a ::-webkit-scrollbar style')

test('the task list with a notice, classic scrollbars (1280x800)', async ({ page }, info) => {
  await homeWithNotice(page, info, { width: 1280, height: 800 }, 'classic')
})

test('every page and side bar of the rail, classic scrollbars (1280x800)', async ({ page }) => {
  await railWalk(page, 800, 'classic')
})
