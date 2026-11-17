/**
 * A browser spec never leaves an App it opened before the App is drawn.
 *
 * An App counts as opened when the shell draws it (useTrackOpenedApp, web/src/apps/hooks.ts),
 * and the router draws a route in a transition: the URL moves at once, the page a moment
 * later. A click away in between merges with that transition, so the App is never drawn and
 * never recorded. 2026-11-17: tests/e2e/browser/apps-page.spec.ts waited for an App's URL and
 * clicked Home at once; on a busy host the App's Open row was missing in 2 runs of 4 (the page
 * snapshot, taken after the test's finally turned the experiment off, made it look like the
 * experiment had read as off). A spec waits on the drawn App instead: `openApp` in
 * tests/e2e/browser/apps-store-helpers.ts, or any expectation on the page's content.
 *
 * The rule, read from every spec and helper: after `await expect(page).toHaveURL(/\/apps\/...)`,
 * the next awaited step that is not another wait on the page's URL must not be a click, a
 * goto, a reload or a back before some locator was waited for.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const BROWSER_DIR = path.resolve(import.meta.dirname, '../e2e/browser')

/** A wait for an App's page by its URL only (`/apps/<id>`, not the Apps page itself). */
const APP_URL_WAIT = /await expect\(page\)\.toHaveURL\(\/\\\/apps\\\/(?!\$)/
const LEAVES = /\.click\(|\.dblclick\(|\.goto\(|\.reload\(|\.goBack\(|\.goForward\(/

/** `file:line` of each step that leaves an App right after a wait on its URL alone. */
function leavesBeforeDrawn(text: string, name: string): string[] {
  const lines = text.split('\n')
  const found: string[] = []
  lines.forEach((line, i) => {
    if (!APP_URL_WAIT.test(line)) return
    for (let j = i + 1; j < lines.length; j++) {
      const step = lines[j]!.trim()
      if (step.startsWith('}')) break
      if (!step.startsWith('await ')) continue
      if (/^await expect\(page\)/.test(step)) continue
      if (LEAVES.test(step) && !/^await expect(\.poll)?\(/.test(step)) found.push(`${name}:${j + 1} ${step}`)
      break
    }
  })
  return found
}

describe('a browser spec waits for an App to be drawn before it leaves it', () => {
  it('finds the shape it guards against', () => {
    const urlOnly = [
      "  await page.getByTestId('plugin-card-open-rho').click()",
      '  await expect(page).toHaveURL(/\\/apps\\/[^/]+/)',
      '  const appPath = new URL(page.url()).pathname',
      "  await page.getByTestId('sidebar-core-app-home').click()",
    ].join('\n')
    expect(leavesBeforeDrawn(urlOnly, 'sample.spec.ts')).toEqual(["sample.spec.ts:4 await page.getByTestId('sidebar-core-app-home').click()"])
    const drawnFirst = [
      '  await expect(page).toHaveURL(/\\/apps\\/walnut-time~main/)',
      "  await expect(page.getByTestId('app-host-native')).toBeVisible()",
      "  await page.getByTestId('sidebar-core-app-home').click()",
    ].join('\n')
    expect(leavesBeforeDrawn(drawnFirst, 'sample.spec.ts')).toEqual([])
    // The Apps page's own URL is not an App: leaving it right away records nothing.
    expect(leavesBeforeDrawn("  await expect(page).toHaveURL(/\\/apps$/)\n  await page.reload()", 'sample.spec.ts')).toEqual([])
  })

  it('no spec or helper leaves an App right after a wait on its URL alone', () => {
    const names = fs.readdirSync(BROWSER_DIR).filter((f) => f.endsWith('.ts')).sort()
    expect(names.length).toBeGreaterThan(100)
    const found = names.flatMap((name) => leavesBeforeDrawn(fs.readFileSync(path.join(BROWSER_DIR, name), 'utf8'), name))
    expect(found, 'wait for the App to be drawn first: openApp(page, trigger) in apps-store-helpers.ts').toEqual([])
  })
})
