/**
 * Engine settings popover, the write-scope half: "This project only" creates
 * <cwd>/.claude/settings.local.json in the session's own checkout and keeps it
 * out of git, a plain directory says it is not a checkout, a shared project
 * file is read but never written, text drafts commit or revert, two columns
 * never show two dialogs, and the last scope is remembered per host + cwd.
 *
 * Every directory here is created by the spec under the fixture's projects dir.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fixtureHome, readClaudeSettings } from './engine-settings-helpers'
import {
  HOST_LABEL, banner, captureView, claimUserFile, clickComposerOutside, dialogOf, exists, fixtureRoot,
  makeGitProject, makePlainProject, openPanels, openPlusMenu, engineSettingsRow, openPopover, plusButton,
  popoverRow, projectScopeNote, readExclude, readLocal, restoreSeed, rowControl, savedLine,
  removedProjectSentence, savedProjectBase, scopeOption, expectNoSaved, shortCwd, shot, startSessionAt, stubGet, waitForRows, watchSettingsRequests,
} from './engine-settings-popover-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let repo = ''
let sid = ''
let plain = ''
let plainSid = ''

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000) // the hook may queue behind sibling spec files (claimUserFile)
  await claimUserFile(request)
  const root = await fixtureRoot()
  repo = await makeGitProject(root)
  sid = await startSessionAt(request, repo)
  plain = await makePlainProject(root)
  plainSid = await startSessionAt(request, plain)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

const isPatch = (scope: 'default' | 'project') => (r: { method(): string; url(): string }) =>
  r.method() === 'PATCH' && r.url().includes('/api/engines/claude/settings')
  && (new URL(r.url()).searchParams.get('scope') ?? 'default') === scope

test.describe('engine settings popover: write scope', () => {
  test('this project only writes the local file, says so, and is remembered', async ({ page, request }) => {
    const home = await fixtureHome(request)
    const short = shortCwd(repo)
    const [panel] = await openPanels(page, [sid])
    const seen = watchSettingsRequests(page)
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)

    // The switch fetches the project view; every row now saves to the local file.
    const projectGet = page.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).searchParams.get('scope') === 'project')
    await scopeOption(dialog, 'project').click()
    expect(new URL((await projectGet).url()).searchParams.get('sessionId')).toBe(sid)
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await expect(dialog).toHaveAttribute('data-scope', 'project')
    await expect(dialog.getByTestId('engine-settings-scope-note')).toHaveText(projectScopeNote(repo))
    expect(await dialog.getAttribute('aria-label')).toContain(`for sessions in ${short}`)
    const rows = dialog.locator('[data-testid^="engine-setting-row-"]')
    await expect(rows.first()).toBeVisible()
    const targets = await rows.locator('.engine-setting-target').allTextContents()
    expect(new Set(targets)).toEqual(new Set(['Saves to this project (local)']))
    // Every row saves to the local file EXCEPT the ones whose key is kept in a
    // file with no per-project layer: those are locked, and say why instead.
    const locked = dialog.locator('.engine-settings-popover-row.is-global-only')
    expect(targets.length + await locked.count()).toBe(await rows.count())
    for (const row of await locked.all()) {
      // A <fieldset> is not one of the form controls Playwright's toBeDisabled
      // understands, so the attribute is the assertion (the control inside it is
      // really disabled, which the failures spec checks on the row's own select).
      const lock = row.locator('fieldset.engine-settings-row-lock')
      await expect(lock).toHaveAttribute('disabled', '')
      expect(await lock.getAttribute('title')).toContain('no per-project layer')
    }
    await shot(page, 'scope-project')

    // Pick a style that differs from the seeded user value.
    expect((await readClaudeSettings(home)).outputStyle).toBe('Explanatory')
    expect(await readLocal(repo)).toBeNull()
    const patch = page.waitForRequest(isPatch('project'))
    await rowControl(dialog, 'claude', 'outputStyle').selectOption('Learning')
    expect((await patch).postDataJSON()).toEqual({ set: { outputStyle: 'Learning' } })
    await expect.poll(() => readLocal(repo)).toEqual({ outputStyle: 'Learning' })
    // The exclude hand-off runs after the file write, so wait for it rather than read once.
    await expect.poll(() => readExclude(repo)).toContain('/.claude/settings.local.json\n')
    expect((await readClaudeSettings(home)).outputStyle).toBe('Explanatory')

    // Status, Reset, the footer sentence, the Files line.
    await expect(popoverRow(dialog, 'outputStyle').locator('.engine-setting-status')).toHaveText('Set in this project (local)')
    await expect(dialog.getByTestId('engine-setting-reset-outputStyle')).toBeVisible()
    const sentence = `${savedProjectBase(repo)} Created ${short}/.claude/settings.local.json and kept it out of git (this repo's exclude list).`
    await expect(savedLine(dialog)).toHaveText(sentence)
    await expect(savedLine(dialog)).toHaveAttribute('aria-live', 'polite')
    expect(await savedLine(dialog).textContent()).not.toContain('Applies on')
    expect(await savedLine(dialog).textContent()).not.toContain('.git/info/exclude')
    const files = dialog.getByTestId('engine-settings-files')
    await files.locator('summary').click()
    const localLine = files.locator('p.engine-settings-file[data-file-id="project-local"]')
    await expect(localLine.locator('.engine-settings-file-created')).toHaveText('created just now')
    await expect(localLine).not.toContainText('(not created yet)')
    await shot(page, 'saved-project')

    // The sentence stays for 6s, survives the mouse, is replaced by the next save, cleared by a scope switch.
    await page.waitForTimeout(6000)
    await expect(savedLine(dialog)).toHaveText(sentence)
    await page.mouse.move(2, 2)
    await savedLine(dialog).hover()
    await expect(savedLine(dialog)).toHaveText(sentence)
    const second = page.waitForRequest(isPatch('project'))
    await rowControl(dialog, 'claude', 'verbose').click()
    expect((await second).postDataJSON()).toEqual({ set: { verbose: true } })
    await expect.poll(() => readLocal(repo)).toEqual({ outputStyle: 'Learning', verbose: true })
    await expect(savedLine(dialog)).toHaveText(savedProjectBase(repo))

    // Reset under project scope takes the key out of the local file only.
    const unset = page.waitForRequest(isPatch('project'))
    await dialog.getByTestId('engine-setting-reset-outputStyle').click()
    expect((await unset).postDataJSON()).toEqual({ unset: ['outputStyle'] })
    await expect.poll(() => readLocal(repo)).toEqual({ verbose: true })
    await expect(popoverRow(dialog, 'outputStyle').locator('.engine-setting-status')).toHaveText('Set in user settings')
    // A Reset is not a save; the footer says what left which file and whose value applies now.
    await expect(savedLine(dialog)).toHaveText(removedProjectSentence('Output style'))
    expect(await savedLine(dialog).textContent()).not.toContain('Saved to')
    await shot(page, 'after-reset')
    await dialog.getByTestId('engine-setting-reset-verbose').click()
    await expect.poll(() => readLocal(repo)).toEqual({})
    await expect(savedLine(dialog)).toHaveText(removedProjectSentence('Verbose output'))

    // back to default: the user-file rows lose the line, outputStyle keeps it (the CLI writes it per project).
    await scopeOption(dialog, 'default').click()
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    await expectNoSaved(dialog)
    await expect(popoverRow(dialog, 'alwaysThinkingEnabled').locator('.engine-setting-target')).toHaveCount(0)
    await expect(popoverRow(dialog, 'outputStyle').locator('.engine-setting-target')).toHaveText('Saves to this project (local)')

    // A reopen starts with an empty footer. the last scope is remembered per host + cwd.
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await dialog.locator('button.engine-settings-popover-close').click()
    await expect(dialog).toHaveCount(0)
    const before = seen.length
    dialog = await openPopover(page, panel)
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 })
    await waitForRows(dialog)
    await expectNoSaved(dialog)
    // The remembered scope rides on the FIRST request (one round trip), never a default read first.
    const gets = seen.slice(before).filter((r) => r.startsWith('GET'))
    expect(gets.map((r) => new URL(r.slice(4)).searchParams.get('scope'))).toEqual(['project'])
    await dialog.locator('button.engine-settings-popover-close').click()

    // remembered 'project' but the project layer is unavailable this time (the server refuses the
    // scope): one retry with the default, stay default, no red bar, and the memory is dropped.
    const refused = await stubGet(page, {
      status: 400, body: { error: "engine 'claude' has no project-scoped settings file", outcome: 'not-written' },
    }, { scope: 'project', times: 1 })
    const stub = await stubGet(page, (real) => ({ ...real, projectScopeAvailable: false }), { scope: 'default', times: 1 })
    const mark = seen.length
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-disabled', 'true')
    await page.waitForTimeout(500)
    expect(seen.slice(mark).filter((r) => r.startsWith('GET')).map((r) => new URL(r.slice(4)).searchParams.get('scope'))).toEqual(['project', null])
    await expect(banner(dialog)).toHaveCount(0)
    await expect(dialog.locator('.engine-settings-popover-error')).toHaveCount(0)
    await refused.unroute()
    await stub.unroute()
    await dialog.locator('button.engine-settings-popover-close').click()
    // The refused memory is gone: the next open asks for the default straight away.
    const mark2 = seen.length
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    expect(seen.slice(mark2).filter((r) => r.startsWith('GET')).map((r) => new URL(r.slice(4)).searchParams.get('scope'))).toEqual([null])
    await dialog.locator('button.engine-settings-popover-close').click()
    // Leave the memory on default for the specs after this one.
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await scopeOption(dialog, 'default').click()
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
  })

  test('a directory that is not a git checkout gets the file and an honest sentence, no.git', async ({ page }) => {
    const [panel] = await openPanels(page, [plainSid])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await rowControl(dialog, 'claude', 'outputStyle').selectOption('Learning')
    await expect.poll(() => readLocal(plain)).toEqual({ outputStyle: 'Learning' })
    const short = shortCwd(plain)
    await expect(savedLine(dialog)).toHaveText(`${savedProjectBase(plain)} Created ${short}/.claude/settings.local.json; this directory is not a git checkout.`)
    expect(await exists(path.join(plain, '.git'))).toBe(false)
    await dialog.getByTestId('engine-setting-reset-outputStyle').click()
    await expect.poll(() => readLocal(plain)).toEqual({})
    await page.keyboard.press('Escape')
  })

  test('a session without a working directory keeps the project side reachable but inert', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])
    const seen = watchSettingsRequests(page)
    const stub = await stubGet(page, (real) => {
      const { cwd: _cwd, ...rest } = real
      return { ...rest, projectScopeAvailable: false }
    }, { scope: 'default' })
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const project = scopeOption(dialog, 'project')
    await expect(project).toHaveAttribute('aria-disabled', 'true')
    expect(await project.evaluate((el) => el.hasAttribute('disabled'))).toBe(false)
    // The unchecked side is not a Tab stop; an arrow reaches it (and its reason), Tab goes on to the filter.
    await expect(project).toHaveAttribute('tabindex', '-1')
    await scopeOption(dialog, 'default').focus()
    await page.keyboard.press('ArrowRight')
    await expect(project).toBeFocused()
    await expect(project).toHaveAttribute('aria-checked', 'false')
    await scopeOption(dialog, 'default').focus()
    await page.keyboard.press('Tab')
    await expect(dialog.locator('input.engine-settings-filter')).toBeFocused()
    // force: Playwright treats aria-disabled as not actionable; the user can still click it.
    await project.click({ force: true })
    await expect(project).toHaveAttribute('aria-checked', 'false')
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    const reason = dialog.locator('.engine-settings-scope-reason')
    await expect(reason).toHaveText('This session has no working directory, so there is no project file to write.')
    const reasonId = await reason.getAttribute('id')
    expect(reasonId).toBeTruthy()
    expect(await project.getAttribute('aria-describedby')).toBe(reasonId)
    await page.waitForTimeout(300)
    expect(seen.filter((r) => r.includes('scope=project'))).toEqual([])
    await stub.unroute()
    await page.keyboard.press('Escape')
  })

  test('a key the shared project file holds is shown as such, and the change lands in the local file', async ({ page, request }) => {
    const root = await fixtureRoot()
    const sharedRepo = await makeGitProject(root)
    const shared = path.join(sharedRepo, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(shared), { recursive: true })
    const sharedBytes = JSON.stringify({ verbose: true, permissions: { allow: ['Read'] } }, null, 2) + '\n'
    await fs.writeFile(shared, sharedBytes)
    const sharedSid = await startSessionAt(request, sharedRepo)

    const [panel] = await openPanels(page, [sharedSid])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const row = popoverRow(dialog, 'verbose')
    await row.scrollIntoViewIfNeeded()
    await expect(row.locator('.engine-setting-status')).toHaveText('Set in this project (shared), committed with the repo')
    await expect(row.locator('.engine-setting-target')).toHaveText('Saves to this project (local)')
    expect(await row.textContent()).not.toContain('Overridden by')
    await expect(rowControl(dialog, 'claude', 'verbose')).toHaveAttribute('aria-checked', 'true')
    await rowControl(dialog, 'claude', 'verbose').click()
    await expect.poll(() => readLocal(sharedRepo)).toEqual({ verbose: false })
    await expect(row.locator('.engine-setting-status')).toHaveText('Set in this project (local)')
    expect(await fs.readFile(shared, 'utf-8')).toBe(sharedBytes)
    await page.keyboard.press('Escape')
  })

  test('a text draft reverts on Escape, commits on an outside click, and guards the scope switch', async ({ page, request }) => {
    const home = await fixtureHome(request)
    expect((await readClaudeSettings(home)).language).toBe('Chinese')
    const [panel] = await openPanels(page, [sid])
    let patches = 0
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/settings')) patches += 1 })
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const language = () => rowControl(dialog, 'claude', 'language')
    await language().scrollIntoViewIfNeeded()

    // Escape discards the draft, the dialog stays, nothing is written.
    await language().fill('zh')
    await language().press('Escape')
    await expect(dialog).toBeVisible()
    await expect(language()).toHaveValue('Chinese')
    expect(patches).toBe(0)
    // A click on the composer commits the draft (blur) and closes the dialog.
    await language().fill('zh')
    const commit = page.waitForRequest(isPatch('default'))
    await clickComposerOutside(panel, dialog)
    expect((await commit).postDataJSON()).toEqual({ set: { language: 'zh' } })
    await expect.poll(async () => (await readClaudeSettings(home)).language).toBe('zh')
    await expect(dialog).toHaveCount(0)

    // An uncommitted draft blocks the scope switch with one sentence; Enter commits, then it switches.
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await language().scrollIntoViewIfNeeded()
    await language().fill('ja')
    const before = patches
    await scopeOption(dialog, 'project').click()
    await expect(dialog.locator('.engine-settings-draft-guard')).toHaveText('Press Enter to save the value first, or Escape to discard.')
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    expect(patches).toBe(before)
    await language().press('Enter')
    await expect.poll(async () => (await readClaudeSettings(home)).language).toBe('ja')
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await scopeOption(dialog, 'default').click()
    await page.keyboard.press('Escape')
  })

  test('two columns, one dialog at a time; long cwds stay distinct; a closed column takes its dialog along', async ({ page, request }) => {
    const root = await fixtureRoot()
    const cwdA = await makePlainProject(root, path.join('work', 'repo-a', 'services', 'api'))
    const cwdB = await makePlainProject(root, path.join('work', 'repo-b', 'services', 'api'))
    expect(cwdA.length).toBeGreaterThan(48)
    const sidA = await startSessionAt(request, cwdA)
    const sidB = await startSessionAt(request, cwdB)
    const [panelA, panelB] = await openPanels(page, [sidA, sidB])

    // Opening the second column's menu closes the first column's dialog.
    const dialogA = await openPopover(page, panelA)
    await waitForRows(dialogA)
    const viewA = await captureView(request, sidA)
    expect(viewA.cwd).toBe(cwdA)
    await plusButton(panelB).click()
    await expect(dialogOf(page)).toHaveCount(0)
    const menuB = panelB.locator('.chat-plus-menu[role=menu]')
    await expect(menuB).toBeVisible()
    await engineSettingsRow(menuB).click()
    const dialogB = dialogOf(page)
    await expect(dialogB).toHaveCount(1)
    await waitForRows(dialogB)

    // The full path is the title; the short form follows the rule, never
    // exceeds the budget, and still carries the segment that tells the repos apart.
    const subtitleB = dialogB.locator('.engine-settings-popover-subtitle')
    await expect(subtitleB).toHaveAttribute('title', cwdB)
    await expect(subtitleB).toHaveText(`${HOST_LABEL} · ${shortCwd(cwdB)}`)
    expect(shortCwd(cwdB).length).toBeLessThanOrEqual(48)
    await expect(subtitleB).toContainText('repo-b')
    const textB = await subtitleB.textContent()
    await page.keyboard.press('Escape')
    const dialogA2 = await openPopover(page, panelA)
    const subtitleA = dialogA2.locator('.engine-settings-popover-subtitle')
    await expect(subtitleA).toHaveAttribute('title', cwdA)
    await expect(subtitleA).toHaveText(`${HOST_LABEL} · ${shortCwd(cwdA)}`)
    await expect(subtitleA).toContainText('repo-a')
    expect(await subtitleA.textContent()).not.toBe(textB)
    await shot(page, 'two-columns')

    // Closing the column that owns the dialog removes the dialog. Keyboard, so no
    // outside pointerdown closes it first: the unmount has to do it.
    await waitForRows(dialogA2)
    await panelA.locator('.session-panel-close').focus()
    await expect(dialogA2).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(panelA).toHaveCount(0)
    expect(await page.locator('.engine-settings-popover').count()).toBe(0)
    await openPlusMenu(panelB)
    await page.keyboard.press('Escape')
  })
})
