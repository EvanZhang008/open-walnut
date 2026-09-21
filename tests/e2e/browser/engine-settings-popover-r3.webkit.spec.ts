/**
 * Review round three of the engine settings popover in WEBKIT (the Mac app is a
 * WKWebView): the filter and the rows keep their top through skeleton, dense,
 * filter and scope switch; the default sentence names both
 * exceptions; the footer link reads the response's groups; the
 * guard dims the note; the Files chevron turns; the not-honoured
 * sentence sits in the card; the switch is one Tab stop and About sits
 * with Close; the dark surface is raised.
 *
 * Run: PW_WEBKIT=1 npx playwright test tests/e2e/browser/engine-settings-popover-r3.webkit.spec.ts --project=webkit
 */
import { test, expect, type Locator } from '@playwright/test'
import {
  LOCAL_SCOPE_NOTE, captureView, claimUserFile, filterBox, fixtureRoot, makeGitProject, openPanels, openPopover, otherGroupsLinkText,
  popoverRow, popoverRowWrap, rect, restoreSeed, rowControl, rowsArea, scopeOption, shot, startSessionAt, stubGet, waitForRows,
} from './engine-settings-popover-helpers'

test.use({ browserName: 'webkit' })
test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let repo = ''
let sid = ''

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  await claimUserFile(request)
  repo = await makeGitProject(await fixtureRoot(), `r3wk-repo-${Date.now().toString(36)}`)
  sid = await startSessionAt(request, repo)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

const opacity = (loc: Locator) => loc.evaluate((el) => Number(getComputedStyle(el).opacity))

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('webkit: stable filter top through every state; both sentences from the response', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const captured = await captureView(request, sid)
  const [panel] = await openPanels(page, [sid])
  const slow = await stubGet(page, 'real', { scope: 'default', delayMs: 1200, times: 1 })
  const dialog = await openPopover(page, panel)
  await expect(dialog).toHaveAttribute('data-state', 'loading')
  const geometry = async () => ({ root: await rect(dialog), filter: await rect(filterBox(dialog)), rows: await rect(rowsArea(dialog)) })
  const g0 = await geometry()
  await waitForRows(dialog)
  const g1 = await geometry()
  await expect(dialog.getByTestId('engine-settings-scope-note')).toHaveText(LOCAL_SCOPE_NOTE)
  await expect(dialog.locator('a.engine-settings-more-link')).toHaveText(otherGroupsLinkText(captured))
  await expect(dialog.locator('a.engine-settings-more-link')).toHaveText(/ settings \(\d+\) are in Settings › Engines$/)
  await filterBox(dialog).fill('zzzz')
  await expect(dialog.locator('.engine-settings-popover-nomatch')).toBeVisible()
  const g2 = await geometry()
  await filterBox(dialog).fill('')
  await expect(popoverRow(dialog, 'alwaysThinkingEnabled')).toBeVisible()
  const g3 = await geometry()
  await scopeOption(dialog, 'project').click()
  await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
  await expect(popoverRow(dialog, 'alwaysThinkingEnabled').locator('.engine-setting-target')).toHaveText('Saves to this project (local)')
  const g4 = await geometry()
  await shot(page, 'r4/wk-height-stable-project')
  const all = [g0, g1, g2, g3, g4]
  test.info().annotations.push({ type: 'geometry', description: JSON.stringify(all.map((g) => ({ h: g.root.height, top: g.root.top, filterTop: g.filter.top, rowsTop: g.rows.top }))) })
  for (const g of all) {
    expect(Math.abs(g.root.height - g1.root.height), 'root height').toBeLessThanOrEqual(1)
    expect(Math.abs(g.root.top - g1.root.top), 'root top').toBeLessThanOrEqual(1)
    expect(Math.abs(g.filter.top - g1.filter.top), 'filter top').toBeLessThanOrEqual(1)
    expect(Math.abs(g.rows.top - g1.rows.top), 'rows top').toBeLessThanOrEqual(1)
  }
  const maxH = await dialog.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--menu-max-height')))
  expect(Math.abs(g1.root.height - Math.min(720, maxH))).toBeLessThanOrEqual(1)
  await scopeOption(dialog, 'default').click()
  await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
  await slow.unroute()
  await page.keyboard.press('Escape')
})

test('webkit: the guard dims the note, the chevron turns, the not-honoured sentence is in the card', async ({ page }) => {
  const [panel] = await openPanels(page, [sid])
  const marked = await stubGet(page, (real) => ({
    ...real,
    groups: real.groups.map((g) => ({ ...g, items: g.items.map((i) => (i.key === 'permissions.defaultMode' ? { ...i, honoredHere: false } : i)) })),
  }), { scope: 'default', times: 1 })
  const dialog = await openPopover(page, panel)
  await waitForRows(dialog)
  //
  const card = popoverRow(dialog, 'permissions.defaultMode')
  await card.scrollIntoViewIfNeeded()
  const sentence = card.locator('.engine-setting-not-honored')
  await expect(sentence).toHaveText('Does not change this session.')
  const cardBox = await rect(card)
  const sentenceBox = await rect(sentence)
  expect(sentenceBox.bottom).toBeLessThanOrEqual(cardBox.bottom + 0.5)
  expect(await sentence.evaluate((el) => el.previousElementSibling?.className)).toBe('engine-setting-status')
  await expect(popoverRowWrap(dialog, 'permissions.defaultMode').locator(':scope > .engine-setting-not-honored')).toHaveCount(0)
  await shot(page, 'r4/wk-not-honored-in-card')
  //
  const note = dialog.getByTestId('engine-settings-scope-note')
  const applies = dialog.getByTestId('engine-settings-applies-on')
  const noteBefore = await rect(note)
  const appliesBefore = await rect(applies)
  const language = rowControl(dialog, 'claude', 'language')
  await language.scrollIntoViewIfNeeded()
  await language.fill('zz-draft')
  await scopeOption(dialog, 'project').click()
  await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
  const guard = dialog.locator('.engine-settings-draft-guard')
  await expect(guard).toHaveText('Press Enter to save the value first, or Escape to discard.')
  const guardBox = await rect(guard)
  expect(Math.abs(guardBox.top - noteBefore.top)).toBeLessThanOrEqual(1)
  expect(await opacity(note)).toBeLessThan(0.5)
  expect(Math.abs((await rect(applies)).top - appliesBefore.top)).toBeLessThanOrEqual(0.5)
  expect((await rect(note)).bottom).toBeGreaterThan(guardBox.bottom + 10)
  await shot(page, 'r4/wk-draft-guard-dimmed')
  await language.press('Escape')
  await expect(language).toHaveValue('Chinese')
  await expect(guard).toHaveCount(0, { timeout: 5000 })
  expect(await opacity(note)).toBe(1)
  //
  const files = dialog.getByTestId('engine-settings-files')
  const chevron = files.locator('summary .engine-settings-files-chevron')
  await expect(chevron).toBeVisible()
  const closedTransform = await chevron.evaluate((el) => getComputedStyle(el).transform)
  await files.locator('summary').click()
  await expect.poll(() => files.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)
  await expect.poll(() => chevron.evaluate((el) => getComputedStyle(el).transform)).not.toBe(closedTransform)
  await expect(files.locator('summary')).toHaveText(/^Files \(\d+\)$/)
  await shot(page, 'r4/wk-files-open-chevron')
  await marked.unroute()
  await page.keyboard.press('Escape')
})

test('webkit: one Tab stop for the switch, About last with Close; the dark surface is raised', async ({ page }) => {
  const [panel] = await openPanels(page, [sid])
  let dialog = await openPopover(page, panel)
  await waitForRows(dialog)
  const def = scopeOption(dialog, 'default')
  const project = scopeOption(dialog, 'project')
  await expect(project).toHaveAttribute('tabindex', '-1')
  await def.focus()
  await page.keyboard.press('Tab')
  await expect(filterBox(dialog)).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(def).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(project).toBeFocused()
  await expect(project).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(def).toHaveAttribute('aria-checked', 'true')
  await def.focus()
  await page.keyboard.press('Shift+Tab')
  expect(await page.evaluate(() => document.activeElement?.className)).toBe('engine-settings-popover-close')
  // WebKit's Tab skips buttons unless the system preference is on, so the About position is checked in the DOM:
  // after the footer, right before Close, never between the switch and the filter.
  const aboutPlace = await dialog.evaluate((el) => {
    const about = el.querySelector('.engine-settings-about')!
    const close = el.querySelector('.engine-settings-popover-close')!
    const filter = el.querySelector('.engine-settings-filter')!
    const footer = el.querySelector('.engine-settings-popover-footer')!
    const after = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    return { afterFilter: after(filter, about), afterFooter: after(footer, about), beforeClose: after(about, close), nextIsClose: about.nextElementSibling === close }
  })
  expect(aboutPlace).toEqual({ afterFilter: true, afterFooter: true, beforeClose: true, nextIsClose: true })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  //
  await page.evaluate(() => { localStorage.setItem('open-walnut-theme', 'dark'); document.documentElement.setAttribute('data-theme', 'dark') })
  dialog = await openPopover(page, panel)
  await waitForRows(dialog)
  const colours = await dialog.evaluate((el) => {
    const lum = (rgb: string) => { const m = rgb.match(/\d+(\.\d+)?/g)!.map(Number); return (m[0] + m[1] + m[2]) / 3 }
    const pop = getComputedStyle(el)
    return { popover: pop.backgroundColor, page: getComputedStyle(document.body).backgroundColor, shadow: pop.boxShadow, lighter: lum(pop.backgroundColor) - lum(getComputedStyle(document.body).backgroundColor) }
  })
  test.info().annotations.push({ type: 'dark-surface', description: JSON.stringify(colours) })
  expect(colours.lighter).toBeGreaterThanOrEqual(20)
  expect(colours.shadow).not.toBe('none')
  await shot(page, 'r4/wk-dark-raised')
  await page.keyboard.press('Escape')
  await page.evaluate(() => { localStorage.setItem('open-walnut-theme', 'light'); document.documentElement.setAttribute('data-theme', 'light') })
})
