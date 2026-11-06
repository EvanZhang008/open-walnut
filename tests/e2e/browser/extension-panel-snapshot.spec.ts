/**
 * The words the side panel draws while its Walnut frame loads (web/src/popout/useAskSnapshots.ts,
 * ext-snapshot.ts; kept by packages/browser-extension/src/panel-snap.ts), through the real
 * extension in Chromium:
 *
 * - the conversation is sent again as it moves: a follow-up and its reply reach the kept words
 *   without closing the panel (the drawing of the next open is the conversation as it was left);
 * - the toolbar popup on the same page keeps only the shell (its Continue rows), never its empty
 *   composer over the side panel's conversation of that page (review 2026-11-06, F3);
 * - so the next panel open draws the follow-up at once.
 */
import { expect, test, type Page } from '@playwright/test'
import { askView, openPanel, startPanelLab, sw, type PanelLab } from './extension-panel-harness'

test.describe.configure({ mode: 'serial' })

let lab: PanelLab
test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'snapshot')
})
test.afterAll(async () => { await lab?.close() })

type Kept = { ask?: Record<string, { messages: Array<{ role: string; text: string }>; cont?: unknown[] }>; shell?: { at: number; cont?: unknown[] } }
const kept = async (): Promise<Kept> => (await sw(lab).evaluate(async () => chrome.storage.local.get('panelSnaps'))).panelSnaps ?? {}
/** The kept words of the docs page's conversation (the only page this spec talks on). */
const pageWords = async (): Promise<string> => {
  const k = await kept()
  const page = Object.entries(k.ask ?? {}).find(([key]) => key.startsWith('web:http://docs.example.test'))
  return page ? page[1].messages.map((m) => `${m.role}: ${m.text}`).join('\n') : ''
}

const FIRST = 'What changed for uploads?'
const SECOND = 'And does dark mode follow the system?'

test('a follow-up reaches the kept words while the panel stays open; the popup keeps the panel\'s conversation', async () => {
  test.setTimeout(240_000)
  const { panel } = await openPanel(lab, 'ask')
  const v = askView(panel)
  const composer = v.locator('[data-testid="ask-object-compose"] textarea')
  await composer.fill(FIRST)
  await composer.press('Enter')
  await expect(v.getByTestId('ask-object-session')).toBeVisible({ timeout: 60_000 })
  await expect(v.getByText('Hello! I processed your message', { exact: false }).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(pageWords, { timeout: 15_000 }).toContain(FIRST)

  // The same conversation goes on: its follow-up and reply are sent again, with the panel open.
  const followUp = v.locator('.session-panel.is-plain-chat textarea').first()
  await followUp.fill(SECOND)
  await followUp.press('Enter')
  await expect(v.locator('.session-msg-user', { hasText: SECOND }).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(pageWords, { timeout: 15_000 }).toContain(SECOND)
  await panel.waitForTimeout(800)
  await panel.close()
  const before = await pageWords()
  const shellAt = (await kept()).shell?.at ?? 0

  // The toolbar popup on that page: its composer and Continue rows, held open past its send.
  const opened = lab.ctx.waitForEvent('page')
  await sw(lab).evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`popup-ask.html?window=${w}`), type: 'popup', width: 380, height: 560 }), lab.docWindow)
  const pop: Page = await opened
  await expect(pop.frameLocator('iframe.panel-frame').locator('.ext-popup-composer textarea')).toBeVisible({ timeout: 60_000 })
  // Its words are kept (the shell, for every placeholder)...
  await expect.poll(async () => (await kept()).shell?.at ?? 0, { timeout: 15_000 }).toBeGreaterThan(shellAt)
  await pop.waitForTimeout(800)
  await pop.close()
  // ...and the panel's conversation of the page is as the panel left it.
  expect(await pageWords()).toBe(before)

  // The next panel open draws the follow-up at once, before its frame is up.
  const again = await openPanel(lab, 'ask')
  // (waitForSelector watches every frame of the page, so the brief drawing is not missed.)
  await again.panel.waitForSelector(`[data-testid="panel-snap"] .panel-snap-msg:has-text("${SECOND}")`, { state: 'visible', timeout: 10_000 })
  await again.panel.close()
})
