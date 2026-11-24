/**
 * A page's own search-param pick is on screen before the next click, and Back ends it
 * (hooks/useSearchParamsNow.ts).
 *
 * 2026-11-24: the router renders a navigation as a transition, so on a busy machine the node just
 * left stayed on screen, and took clicks, for more than half a second after another was picked: a
 * section opened in that moment was opened on the old node, and the picked one showed it folded
 * (truncation-peek-surfaces failed in the full browser run every time). Here the CPU is slowed so
 * the transition is that late on any machine, and the page is read the moment the click returns:
 * the picked node's own title must already be the detail's heading. Chromium only (CDP).
 */
import { expect, test } from '@playwright/test'
import { home } from './inbox-items-helpers'
import { openApps, openBuiltinDetail, openPluginDetail } from './apps-store-helpers'

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(120_000)

test('a picked Org node shows at once, even while the page renders slowly', async ({ page, request, browserName }) => {
  test.skip(browserName !== 'chromium', 'CPU throttling is a Chromium DevTools call')
  const stamp = Date.now().toString(36)
  const projects = [`Pick first ${stamp}`, `Pick second ${stamp}`]
  const made: string[] = []
  try {
    for (const project of projects) {
      const res = await request.post('/api/tasks', { data: { title: `Lead task of ${project}`, project, source: 'local' } })
      expect(res.status()).toBe(201)
      made.push((await res.json()).task.id)
    }
    await home(page)
    await page.getByTestId('sidebar-org').click()
    const channel = (project: string) => page.locator(`[data-testid="org-channel"][data-key="project:${project.toLowerCase()}"]`)
    const heading = page.getByTestId('org-page').locator('h2').first()
    await channel(projects[0]).click()
    await expect(heading).toContainText(projects[0], { timeout: 20_000 })

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 })
    try {
      for (const project of [projects[1], projects[0], projects[1]]) {
        await channel(project).click()
        // Read at once, no waiting: whatever the next click lands on is what shows now.
        expect(await heading.evaluate((el) => el.textContent), `${project}: the picked node is shown before the next click`).toContain(project)
      }
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    }
  } finally {
    for (const id of made) await request.delete(`/api/tasks/${id}?force=true`)
  }
})

// The pick's other edges: Back may land on the very entry the pick was made on before the router
// rendered the pick, so the router renders nothing new; or it may come while the router's render of
// the pick still waits to commit, which already ended the pick. Both left an Apps detail open after
// Back (a built-in's in apps-page.spec.ts, a plugin's in plugin-update-layout.spec.ts, the full run
// of 2026-11-24); here the CPU is slowed so a fast open and close is that fast on any machine, and
// both kinds of detail are opened in turn.
test('an Apps detail opened and closed fast closes, even while the page renders slowly', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CPU throttling is a Chromium DevTools call')
  test.setTimeout(300_000)
  await home(page)
  await openApps(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  try {
    for (let round = 0; round < 4; round++) {
      for (const id of ['home', 'walnut-time', 'apps', 'walnut-time', 'tasks', 'walnut-time', 'org']) {
        const plugin = id === 'walnut-time'
        if (plugin) await openPluginDetail(page, id)
        else await openBuiltinDetail(page, id)
        await page.getByTestId('plugin-detail-back').click()
        await expect(page.getByTestId(plugin ? 'plugin-detail' : 'builtin-detail'), `${id}, round ${round + 1}: Back closed the detail`).toHaveCount(0, { timeout: 8_000 })
      }
    }
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  }
})
