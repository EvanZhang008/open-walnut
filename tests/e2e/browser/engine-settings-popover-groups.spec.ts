/**
 * Composer "+" -> "Engine settings": the groups a running session does not
 * read (Updates, Terminal only) live INSIDE the popover since the Settings >
 * Engines pane was retired (2026-10-27). Each is a collapsed
 * `<details data-testid="engine-settings-popover-group-<id>">` after the
 * session rows, its summary "<Title> (<count>)"; it opens on a click and on
 * its own while the filter has text, and a row inside it saves like a session
 * row. There is no footer link to a Settings page any more.
 *
 * Disk assertions read the fixture HOME's user file, which every popover spec
 * shares, so this file takes the user-file lock like the others.
 */
import { test, expect } from '@playwright/test'
import { fixtureHome, readClaudeSettings } from './engine-settings-helpers'
import {
  allItems, captureView, claimUserFile, filterBox, fixtureRoot, groupOpen, groupSummaryText, makeGitProject, openPanels, openPopover,
  otherGroupsOf, popoverGroup, popoverGroups, popoverRow, popoverRowWrap, renderedKeys, restoreSeed, rowControl, savedLine,
  savedUserSentence, sessionsItems, settleToggle, shot, startSessionAt, visibleRowKeys, waitForRows, type View,
} from './engine-settings-popover-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let sid = ''
let captured: View

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000) // the hook may queue behind sibling spec files (claimUserFile)
  await claimUserFile(request)
  sid = await startSessionAt(request, await makeGitProject(await fixtureRoot()))
  captured = await captureView(request, sid)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

test.describe('engine settings popover: the other groups', () => {
  test('after the session rows, each other group is a collapsed "<Title> (N)" with its rows hidden', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)

    const others = otherGroupsOf(captured)
    expect(others.map((g) => g.id)).toEqual(['updates', 'terminal'])
    // Every row is rendered in response order, but only the session rows are visible.
    expect(await renderedKeys(dialog)).toEqual(allItems(captured).map((i) => i.key))
    expect(await visibleRowKeys(dialog)).toEqual(sessionsItems(captured).map((i) => i.key))
    await expect(popoverRow(dialog, 'autoUpdates')).toBeHidden()
    await expect(popoverRow(dialog, 'theme')).toBeHidden()
    await expect(popoverGroups(dialog)).toHaveCount(others.length)
    for (const [i, g] of others.entries()) {
      const groupBox = popoverGroups(dialog).nth(i)
      await expect(groupBox).toHaveAttribute('data-testid', `engine-settings-popover-group-${g.id}`)
      await expect(groupBox.locator('summary')).toHaveText(groupSummaryText(g))
      expect(await groupOpen(groupBox), `${g.id} starts collapsed`).toBe(false)
    }
    // The groups come after the last session row, inside the rows area.
    const lastSessionKey = sessionsItems(captured).at(-1)!.key
    expect(await popoverRowWrap(dialog, lastSessionKey).evaluate((row) => {
      const first = row.parentElement!.querySelector('details.engine-settings-popover-group')
      return !!first && first.parentElement === row.parentElement && !!(row.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)
    })).toBe(true)
    // No link out to Settings, in the footer or anywhere else.
    await expect(dialog.locator('a.engine-settings-more-link')).toHaveCount(0)
    await expect(dialog.locator('a[href^="/settings"]')).toHaveCount(0)
    await shot(page, 'groups-collapsed')
  })

  test('a summary click opens and closes a group; a filter hit opens it, and a row inside saves and resets', async ({ page, request }) => {
    const [panel] = await openPanels(page, [sid])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const terminalView = otherGroupsOf(captured).find((g) => g.id === 'terminal')!
    const terminal = popoverGroup(dialog, 'terminal')

    expect(await groupOpen(terminal)).toBe(false)
    await expect(popoverRow(dialog, 'timeFormat')).toBeHidden()
    await terminal.locator('summary').click()
    await expect.poll(() => groupOpen(terminal)).toBe(true)
    await expect(popoverRow(dialog, 'timeFormat')).toBeVisible()
    await expect(terminal.locator('.engine-settings-popover-group-help')).toHaveText(terminalView.help!)
    // The other group stays as it was.
    expect(await groupOpen(popoverGroup(dialog, 'updates'))).toBe(false)
    await shot(page, 'groups-terminal-open')
    await terminal.locator('summary').click()
    await expect.poll(() => groupOpen(terminal)).toBe(false)
    await expect(popoverRow(dialog, 'timeFormat')).toBeHidden()
    await settleToggle(page)

    // Typing a terminal-only key: its group opens with that one row; the
    // Updates group, with no hit, is not drawn; no session row matches.
    await filterBox(dialog).fill('time format')
    await expect.poll(() => visibleRowKeys(dialog)).toEqual(['timeFormat'])
    await expect.poll(() => groupOpen(terminal)).toBe(true)
    await expect(terminal.locator('summary')).toHaveText(groupSummaryText(terminalView, 1))
    await expect(popoverGroup(dialog, 'updates')).toHaveCount(0)
    await expect(popoverRow(dialog, 'alwaysThinkingEnabled')).toHaveCount(0)

    // A row inside a group saves like a session row: PATCH, disk, status line, footer, Reset.
    const home = await fixtureHome(request)
    expect('timeFormat' in (await readClaudeSettings(home))).toBe(false)
    const timeFormat = rowControl(dialog, 'claude', 'timeFormat')
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/api/engines/claude/settings'))
    await timeFormat.selectOption('24-hour')
    const req = await patch
    expect(new URL(req.url()).searchParams.get('sessionId')).toBe(sid)
    expect(req.postDataJSON()).toEqual({ set: { timeFormat: '24-hour' } })
    await expect.poll(async () => (await readClaudeSettings(home)).timeFormat).toBe('24-hour')
    await expect(popoverRow(dialog, 'timeFormat').locator('.engine-setting-status')).toHaveText('Set in user settings')
    await expect(savedLine(dialog)).toHaveText(savedUserSentence)
    // The group stays open with its one hit while the write lands.
    await expect(terminal.locator('summary')).toHaveText(groupSummaryText(terminalView, 1))
    expect(await groupOpen(terminal)).toBe(true)
    await dialog.getByTestId('engine-setting-reset-timeFormat').click()
    await expect.poll(async () => 'timeFormat' in (await readClaudeSettings(home))).toBe(false)
    await expect(timeFormat).toHaveValue('auto')

    // Clearing the filter folds the group back to how the user left it (closed).
    await filterBox(dialog).fill('')
    await expect.poll(() => groupOpen(terminal)).toBe(false)
    await expect(popoverRow(dialog, 'timeFormat')).toBeHidden()
    await expect(terminal.locator('summary')).toHaveText(groupSummaryText(terminalView))
  })

  test('a group the user opened stays open through a filter and after it is cleared', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const updates = popoverGroup(dialog, 'updates')
    await updates.locator('summary').click()
    await expect.poll(() => groupOpen(updates)).toBe(true)
    await settleToggle(page)
    await filterBox(dialog).fill('auto-update')
    await expect.poll(() => visibleRowKeys(dialog)).toEqual(['autoUpdates', 'autoUpdatesChannel'])
    await filterBox(dialog).fill('')
    await expect.poll(() => groupOpen(updates)).toBe(true)
    await expect(popoverRow(dialog, 'autoUpdates')).toBeVisible()
    await expect(popoverRow(dialog, 'theme')).toBeHidden()
  })
})
