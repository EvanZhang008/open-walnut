/**
 * Engine settings popover, the unhappy paths: a host whose environment was not
 * visible, an unparsable settings file, an empty group, a first load that
 * fails, saves that fail two different ways, a rescope that fails, a global-only
 * row under project scope, an engine catalog that is slow or down, and a Codex
 * shaped view. Server answers are stubbed at the network edge by mutating the
 * real response, so every stub keeps the real shape.
 */
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fixtureHome } from './engine-settings-helpers'
import { seedColumns } from './draft-helpers'
import {
  HOST_LABEL, banner, claimUserFile, dialogOf, engineSettingsRow, fixtureRoot, makeGitProject, openPanels, openPlusMenu,
  openPopover, panelFor, plusButton, popoverRow, popoverRowWrap, readLocal, restoreSeed, rowControl, rowsArea,
  scopeOption, startSessionAt, stubGet, stubPatch, waitForRows, watchSettingsRequests, type View,
} from './engine-settings-popover-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let repo = ''
let sid = ''

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000) // the hook may queue behind sibling spec files (claimUserFile)
  await claimUserFile(request)
  repo = await makeGitProject(await fixtureRoot())
  sid = await startSessionAt(request, repo)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

const HOST_DOWN = 'The host devbox could not be reached in time.'

/** Resolve a CSS custom property to the colour the browser would paint. */
const resolveVar = (page: Page, name: string) => page.evaluate((v) => {
  const probe = document.createElement('span')
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(v).trim()
  document.body.appendChild(probe)
  const out = getComputedStyle(probe).color
  probe.remove()
  return out
}, name)

test.describe('engine settings popover: failures and edge shapes', () => {
  test('unchecked environment, an empty sessions group, and a first load that fails then retries', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])

    // The environment on the host was not visible.
    const env = await stubGet(page, (real) => ({ ...real, envChecked: false }), { scope: 'default', times: 1 })
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const note = dialog.getByTestId('engine-settings-env-unchecked')
    await expect(note).toHaveText(`Environment variables on ${HOST_LABEL} were not checked: one set for the engine's processes there can take precedence over these files.`)
    expect(await note.evaluate((el) => getComputedStyle(el).color)).toBe(await resolveVar(page, '--warning'))
    await env.unroute()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Nothing a running session reads.
    const empty = await stubGet(page, (real) => ({
      ...real, groups: real.groups.map((g) => (g.id === 'sessions' ? { ...g, items: [] } : g)),
    }), { scope: 'default', times: 1 })
    dialog = await openPopover(page, panel)
    await expect(dialog).toHaveAttribute('data-state', 'empty')
    const emptyBox = dialog.locator('.engine-settings-popover-empty')
    await expect(emptyBox).toContainText('Claude Code reports no settings that a running session reads. Its other settings are in Settings › Engines.')
    await expect(emptyBox.locator('a[href="/settings#engines"]')).toBeVisible()
    await empty.unroute()
    await page.keyboard.press('Escape')

    // The first GET fails: the sentence, Retry, a disabled switch; Retry re-fetches and recovers.
    const seen = watchSettingsRequests(page)
    const down = await stubGet(page, { status: 502, body: { error: HOST_DOWN } }, { scope: 'default', times: 1 })
    dialog = await openPopover(page, panel)
    await expect(dialog).toHaveAttribute('data-state', 'error')
    await expect(dialog.locator('.engine-settings-popover-error')).toHaveText(HOST_DOWN)
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-disabled', 'true')
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-disabled', 'true')
    expect(seen.filter((r) => r.startsWith('GET'))).toHaveLength(1)
    await dialog.locator('button.engine-settings-retry').click()
    await waitForRows(dialog)
    expect(seen.filter((r) => r.startsWith('GET'))).toHaveLength(2)
    await expect(scopeOption(dialog, 'default')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(scopeOption(dialog, 'project')).not.toHaveAttribute('aria-disabled', 'true')
    await down.unroute()
    await page.keyboard.press('Escape')
  })

  test('a refused save reverts, an unknown save re-reads, a pending save locks the switch', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])
    const seen = watchSettingsRequests(page)
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const thinking = () => rowControl(dialog, 'claude', 'alwaysThinkingEnabled')
    await expect(thinking()).toHaveAttribute('aria-checked', 'true')

    // Not-written -> the control goes back, the sentence shows, no re-read.
    const refused = await stubPatch(page, { status: 400, body: { error: 'The value is not one this key accepts.', outcome: 'not-written' } }, { times: 1 })
    const getsBefore = seen.filter((r) => r.startsWith('GET')).length
    await thinking().click()
    await expect(banner(dialog)).toHaveText('The value is not one this key accepts.')
    await expect(banner(dialog)).toHaveAttribute('role', 'alert')
    await expect(thinking()).toHaveAttribute('aria-checked', 'true')
    await page.waitForTimeout(400)
    expect(seen.filter((r) => r.startsWith('GET')).length).toBe(getsBefore)
    await banner(dialog).locator('button[aria-label="Dismiss"]').click()
    await expect(banner(dialog)).toHaveCount(0)
    await refused.unroute()

    // A 500 with no outcome -> the sentence (or the generic one), no revert, one GET with the current scope.
    const unknown = await stubPatch(page, { status: 500, body: { error: 'Something failed on the way to the file.' } }, { times: 1 })
    const mark = seen.length
    await thinking().click()
    await expect(banner(dialog)).toBeVisible()
    await expect(banner(dialog)).toContainText(/Could not reach the server\.|Something failed on the way to the file\./)
    await expect.poll(() => seen.slice(mark).filter((r) => r.startsWith('GET')).length).toBe(1)
    const reread = new URL(seen.slice(mark).find((r) => r.startsWith('GET'))!.slice(4))
    expect(reread.searchParams.has('scope')).toBe(false)
    expect(reread.searchParams.get('sessionId')).toBe(sid)
    // The re-read shows the disk truth: nothing was written.
    await expect(thinking()).toHaveAttribute('aria-checked', 'true')
    await unknown.unroute()
    await page.keyboard.press('Escape')

    // A save in flight under project scope disables the switch and already reads as the project layer.
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await expect(rowsArea(dialog)).not.toHaveAttribute('aria-busy', 'true')
    const slow = await stubPatch(page, 'real', { scope: 'project', delayMs: 1500, times: 1 })
    const fast = () => rowControl(dialog, 'claude', 'fastMode')
    await fast().scrollIntoViewIfNeeded()
    const statuses: string[] = []
    const status = popoverRow(dialog, 'fastMode').locator('.engine-setting-status')
    await fast().click()
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-disabled', 'true')
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('title', 'Wait for the current save to finish')
    statuses.push((await status.textContent()) ?? '')
    await expect(status).toHaveText('Set in this project (local)')
    await expect.poll(() => readLocal(repo), { timeout: 10_000 }).toEqual({ fastMode: true })
    await expect(scopeOption(dialog, 'default')).not.toHaveAttribute('aria-disabled', 'true')
    statuses.push((await status.textContent()) ?? '')
    expect(statuses).not.toContain('Set in user settings')
    await slow.unroute()
    await dialog.getByTestId('engine-setting-reset-fastMode').click()
    await expect.poll(() => readLocal(repo)).toEqual({})
    await scopeOption(dialog, 'default').click()
    await page.keyboard.press('Escape')
  })

  test('an unparsable user file disables its rows and shows the error until the file is repaired', async ({ page, request }) => {
    const home = await fixtureHome(request)
    const file = path.join(home, '.claude', 'settings.json')
    const original = await fs.readFile(file, 'utf-8')
    try {
      await fs.writeFile(file, '{ "alwaysThinkingEnabled": true, ')
      const [panel] = await openPanels(page, [sid])
      const dialog = await openPopover(page, panel)
      await expect(dialog).toHaveAttribute('data-state', 'ready')
      const userRows = dialog.locator('.engine-setting-row[data-write-target="user"]')
      await expect(userRows.first()).toBeVisible()
      const count = await userRows.count()
      expect(count).toBeGreaterThan(5)
      await expect(userRows.locator('fieldset.engine-setting-control[disabled]')).toHaveCount(count)
      const files = dialog.getByTestId('engine-settings-files')
      expect(await files.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)
      const err = files.locator('p.engine-settings-file[data-file-id="user"] .engine-settings-file-error')
      await expect(err).toBeVisible()
      expect(await err.evaluate((el) => getComputedStyle(el).color)).toBe(await resolveVar(page, '--error'))
      // Repair, then reopen: the rows come back to life.
      await fs.writeFile(file, original)
      await page.keyboard.press('Escape')
      const again = await openPopover(page, panel)
      await waitForRows(again)
      await expect(again.locator('.engine-setting-row[data-write-target="user"] fieldset.engine-setting-control[disabled]')).toHaveCount(0)
      await expect(again.getByTestId('engine-settings-files').locator('.engine-settings-file-error')).toHaveCount(0)
      await page.keyboard.press('Escape')
    } finally {
      await fs.writeFile(file, original)
    }
  })

  test('a failed rescope keeps the switch alive; a global-only row is locked under project scope', async ({ page, request }) => {
    const [panel] = await openPanels(page, [sid])
    const seen = watchSettingsRequests(page)
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)

    // The project GET fails after a good default load.
    const down = await stubGet(page, { status: 502, body: { error: HOST_DOWN } }, { scope: 'project', times: 1 })
    await scopeOption(dialog, 'project').click()
    await expect(dialog.locator('.engine-settings-popover-error')).toHaveText(HOST_DOWN)
    await expect(dialog.locator('button.engine-settings-retry')).toBeVisible()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await expect(scopeOption(dialog, 'default')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(scopeOption(dialog, 'project')).not.toHaveAttribute('aria-disabled', 'true')
    const mark = seen.length
    await scopeOption(dialog, 'default').click()
    await waitForRows(dialog)
    const back = seen.slice(mark).filter((r) => r.startsWith('GET')).map((r) => new URL(r.slice(4)).searchParams.get('scope'))
    expect(back).toEqual([null])
    await down.unroute()
    await page.keyboard.press('Escape')

    // A row stored in the global config has no project layer, so project scope
    // locks it. No stub: the server marks the row itself (projectLayer:false),
    // which is the contract the lock is allowed to depend on.
    const real = await request.get(`/api/engines/claude/settings?sessionId=${sid}&scope=project`)
    const realView = (await real.json()) as View
    const globalLabel = realView.files.find((f) => f.id === 'global')!.label
    const marked = realView.groups.flatMap((g) => g.items).filter((i) => i.projectLayer === false).map((i) => i.key)
    expect(marked).toContain('workflowSizeGuideline')
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const control = () => rowControl(dialog, 'claude', 'workflowSizeGuideline')
    await control().scrollIntoViewIfNeeded()
    await expect(control()).toBeEnabled()
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    const wrap = popoverRowWrap(dialog, 'workflowSizeGuideline')
    const lock = wrap.locator('fieldset.engine-settings-row-lock')
    await expect(lock).toHaveAttribute('disabled', '')
    await expect(lock).toHaveClass(/is-global-only/)
    await expect(lock).toHaveAttribute('title', `Stored in ${globalLabel}, which has no per-project layer`)
    await expect(control()).toBeDisabled()
    expect(await wrap.evaluate((el) => (el as HTMLElement).innerText)).not.toContain('Saves to this project (local)')
    await scopeOption(dialog, 'default').click()
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    await expect(control()).toBeEnabled()
    await page.keyboard.press('Escape')
  })

  test('a Codex-shaped view drives the link, the file count, the sentences; the row extras', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])
    const codex = await stubGet(page, (real) => {
      const sessions = real.groups.find((g) => g.id === 'sessions')!
      const other = real.groups.find((g) => g.id !== 'sessions')!
      return {
        ...real, engine: 'codex', displayName: 'Codex', appliesOn: 'new-session', files: [real.files[0]],
        groups: [sessions, { ...other, id: 'updates', title: 'Updates', items: other.items.slice(0, 1) }],
      }
    }, { scope: 'default', times: 1 })
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    // The engine's name comes from the catalog (the session really is a Claude one here), the rest from the view.
    await expect(dialog.locator('h2.engine-settings-popover-title')).toHaveText(/^(Codex|Claude Code) settings$/)
    await expect(dialog.locator('a.engine-settings-more-link')).toHaveText('Updates settings (1) are in Settings › Engines')
    await expect(dialog.getByTestId('engine-settings-files').locator('summary')).toHaveText('Files (1)')
    await expect(dialog.getByTestId('engine-settings-applies-on')).toHaveText(/^Applies to new (Codex|Claude Code) sessions; this session keeps its current settings\.$/)
    expect(await dialog.getAttribute('aria-label')).toMatch(/^(Codex|Claude Code) settings for new sessions in /)
    await codex.unroute()
    await page.keyboard.press('Escape')

    // No other group with rows -> a plain link.
    const only = await stubGet(page, (real) => ({ ...real, groups: real.groups.filter((g) => g.id === 'sessions') }), { scope: 'default', times: 1 })
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await expect(dialog.locator('a.engine-settings-more-link')).toHaveText('Open Settings › Engines')
    await only.unroute()
    await page.keyboard.press('Escape')

    // An environment override is worded as Walnut's own environment. a row not honoured here says so.
    const extras = await stubGet(page, (real) => ({
      ...real,
      groups: real.groups.map((g) => ({
        ...g,
        items: g.items.map((i) => {
          if (i.key === 'model') return { ...i, envOverride: { name: 'ANTHROPIC_MODEL', value: 'opus' } }
          if (i.key === 'permissions.defaultMode') return { ...i, honoredHere: false }
          return i
        }),
      })),
    }), { scope: 'default', times: 1 })
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const modelWrap = popoverRowWrap(dialog, 'model')
    await modelWrap.scrollIntoViewIfNeeded()
    await expect(modelWrap.locator('span.engine-setting-env-walnut')).toHaveText("Overridden by ANTHROPIC_MODEL=opus in Walnut's own environment")
    await expect(modelWrap.locator('.engine-setting-env')).toBeHidden()
    await expect(popoverRowWrap(dialog, 'permissions.defaultMode').locator('span.engine-setting-not-honored')).toHaveText('Does not change this session.')
    // The Reset tooltip on a row whose value comes from the older location. Recorded, not required:
    // the row component is finished code and this slice only lists the wording as a follow-up.
    const resetTitle = await dialog.getByTestId('engine-setting-reset-permissions.defaultMode').getAttribute('title')
    test.info().annotations.push({ type: 'follow-up', description: `R27 Reset title today: ${resetTitle ?? '(none)'}` })
    await extras.unroute()
    await page.keyboard.press('Escape')
  })

  test('before the engine catalog answers the row is there but off; a failed catalog names the way out', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.removeItem('walnut.engineCatalog.v1') } catch { /* storage off */ } })
    // First load: the catalog hangs 3s, then fails. A 4xx: a 5xx is retried on a
    // 2/4/8/16s schedule by design, so 'failed' would take most of a minute to show.
    let mode: 'fail' | 'real' = 'fail'
    await page.route('**/api/engines', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await new Promise((r) => setTimeout(r, 3000))
      if (mode === 'fail') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'catalog down' }) })
      return route.fulfill({ response: await route.fetch() })
    })
    // Not loadHome: its networkidle wait would outlast the hanging catalog request.
    await seedColumns(page, [sid])
    await page.goto('/')
    const panel = panelFor(page, sid)
    await expect(plusButton(panel)).toBeVisible({ timeout: 30_000 })
    let menu = await openPlusMenu(panel)
    let row = engineSettingsRow(menu)
    await expect(row).toHaveAttribute('aria-disabled', 'true')
    await expect(row).toHaveAttribute('title', 'Checking what this engine supports')
    await row.click({ force: true })
    await expect(dialogOf(page)).toHaveCount(0)
    await expect(menu).toBeVisible()
    await expect(row).toHaveAttribute('title', 'Could not read the engine list; open Settings › Engines', { timeout: 6000 })
    await expect(row).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')

    // Second load: slow but successful; the row turns live once the catalog lands.
    mode = 'real'
    await page.reload()
    await expect(plusButton(panel)).toBeVisible({ timeout: 30_000 })
    menu = await openPlusMenu(panel)
    row = engineSettingsRow(menu)
    await expect(row).toHaveAttribute('aria-disabled', 'true')
    await expect(row).not.toHaveAttribute('aria-disabled', 'true', { timeout: 6000 })
    await row.click()
    await expect(dialogOf(page)).toBeVisible()
    await page.keyboard.press('Escape')
  })
})
