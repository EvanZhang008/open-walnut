/**
 * The side panel after Disconnect (packages/browser-extension/src/sidepanel.ts, panel-data.ts):
 * an open panel closes its Walnut frames at once (none can still ask for the page or its text),
 * the words of last time kept for a fast reopen (panel-snap.ts) are removed with the connection,
 * and a panel opened afterwards draws neither a frame nor those words.
 */
import { expect, test, type Page } from '@playwright/test'
import { askView, openPanel, startPanelLab, sw, type PanelLab } from './extension-panel-harness'

let lab: PanelLab
test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'disconnect')
})
test.afterAll(async () => { await lab?.close() })

const kept = () => sw(lab).evaluate(async () => chrome.storage.local.get(['panelSnaps', 'panelServer']))

test('Disconnect closes the open panel\'s frames and removes what it kept; a reopen shows neither', async () => {
  test.setTimeout(150_000)
  // A conversation, so the panel keeps its words for the next open.
  let { panel } = await openPanel(lab, 'ask')
  const composer = askView(panel).locator('[data-testid="ask-object-compose"] textarea')
  await composer.fill('A private question about this page')
  await composer.press('Enter')
  await expect(askView(panel).getByText('Hello! I processed your message', { exact: false }).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => JSON.stringify((await kept()).panelSnaps ?? {}), { timeout: 15_000 }).toContain('A private question')
  await panel.close()

  // Opened again, it draws from what it kept and frames Walnut; then the person disconnects.
  ;({ panel } = await openPanel(lab, 'ask'))
  await expect(panel.locator('iframe.panel-frame')).toHaveCount(1, { timeout: 15_000 })
  const popup: Page = await lab.ctx.newPage()
  await popup.goto(`chrome-extension://${lab.extId}/popup.html`)
  const r = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'disconnect' }))
  expect(r).toMatchObject({ ok: true })
  await popup.close()

  // The open panel: no Walnut frame left, no drawing of last time, and it says to connect.
  await expect(panel.locator('iframe')).toHaveCount(0, { timeout: 10_000 })
  await expect(panel.getByTestId('panel-snap')).toHaveCount(0)
  await expect(panel.getByRole('heading', { name: 'Connect to Walnut' })).toBeVisible()
  const after = await kept()
  expect(after.panelSnaps).toBeUndefined()
  expect(after.panelServer).toBeUndefined()
  await panel.close()

  // Opened afterwards: nothing of that Walnut is drawn or framed (so no page of it to go to).
  ;({ panel } = await openPanel(lab, 'home'))
  await expect(panel.getByRole('heading', { name: 'Connect to Walnut' })).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('iframe')).toHaveCount(0)
  await expect(panel.getByTestId('panel-snap')).toHaveCount(0)
  await panel.close()
})
