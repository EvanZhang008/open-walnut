/**
 * The master password hint in the Passwords app (web/src/components/passwords/HintField.tsx,
 * HintSettings.tsx): setup refuses a hint that gives the password away, Settings changes it,
 * the unlock screen shows it behind "Show hint" and at once after a wrong password, and
 * Settings removes it again.
 *
 * The fixture server is shared with passwords.spec.ts, so this uses the same master password
 * and sets the vault up only when nothing did yet. Fake data only.
 */
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { holdVaultLock } from './vault-lock'

test.describe.configure({ mode: 'serial' })
// It sets the vault up through the UI, changes the vault's one hint and locks every window: alone on the vault.
holdVaultLock('exclusive', 'file')

let setUpHere = false

const MASTER = 'Correct Horse Battery Staple 42'
const HINT = 'the stable by the river'
/** Set in Settings: differs from the setup's hint, so Save always has a change to save. */
const HINT2 = 'the barn behind the mill'
const SHOTS = process.env.HINT_SHOTS_DIR
const shot = async (page: Page, name: string, el = page.locator('.pw-gate-card')) => {
  if (SHOTS) await el.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

async function openPasswords(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) await page.locator('.sidebar-collapse-btn').click()
  await page.locator('.sidebar-nav a[href="/passwords"]').first().click()
}

async function openSettings(page: Page) {
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await page.getByTestId('settings-nav-passwords').click()
  return page.locator('#passwords')
}

test('setup refuses a hint that gives the password away, then takes a good one', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 })
  await openPasswords(page)
  const setup = page.getByRole('heading', { name: 'Set up Passwords' })
  const unlock = page.getByTestId('pw-unlock')
  await expect(setup.or(unlock).or(page.getByTestId('pw-app'))).toBeVisible()
  if (!(await setup.isVisible())) {
    if (await unlock.isVisible()) {
      await page.getByLabel('Master password').fill(MASTER)
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    }
    await expect(page.getByTestId('pw-app')).toBeVisible()
    test.info().annotations.push({ type: 'note', description: 'vault already set up: setup step skipped' })
    return
  }
  await page.locator('#pw-setup-1').fill(MASTER)
  await page.locator('#pw-setup-2').fill(MASTER)
  const create = page.getByRole('button', { name: 'Create vault' })
  const hint = page.getByTestId('pw-setup-hint')
  await hint.fill('horse battery')
  await expect(page.getByTestId('pw-setup-hint-error')).toContainText('part of your master password')
  await expect(create).toBeDisabled()
  await hint.fill(`my password is ${MASTER.toUpperCase()}`)
  await expect(page.getByTestId('pw-setup-hint-error')).toContainText('contains your master password')
  await shot(page, 'web-setup-hint-refused')
  await hint.fill(HINT)
  await expect(page.getByTestId('pw-setup-hint-error')).toHaveCount(0)
  await expect(page.getByText(/Anyone who opens the unlock screen can read it/)).toBeVisible()
  await shot(page, 'web-setup-hint-ok')
  await expect(create).toBeEnabled()
  await create.click()
  await expect(page.getByRole('heading', { name: 'Save your recovery kit' })).toBeVisible({ timeout: 20_000 })
  await page.getByLabel(/I saved my recovery kit/).check()
  await page.getByRole('button', { name: 'Open Passwords' }).click()
  await expect(page.getByTestId('pw-app')).toBeVisible()
  setUpHere = true
})

test('Settings sets the hint with the master password; the unlock screen shows it', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 })
  await openPasswords(page)
  const unlock = page.getByTestId('pw-unlock')
  await expect(unlock.or(page.getByTestId('pw-app'))).toBeVisible()
  if (await unlock.isVisible()) {
    await page.getByLabel('Master password').fill(MASTER)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  }
  await expect(page.getByTestId('pw-app')).toBeVisible()

  const section = await openSettings(page)
  const group = section.getByTestId('pw-hint-settings')
  await expect(group).toBeVisible()
  // A vault this spec set up carries the setup's hint.
  if (setUpHere) await expect(group).toContainText(`Now: ${HINT}`)
  const save = group.getByTestId('pw-hint-save')
  await group.locator('#pw-hint-edit').fill('a new one')
  await group.locator('#pw-hint-pw').fill(MASTER)
  await group.locator('#pw-hint-edit').fill('staple 42')
  await expect(group).toContainText('part of your master password')
  await expect(save).toBeDisabled()
  await group.locator('#pw-hint-edit').fill(HINT2)
  await expect(save).toBeEnabled()
  await save.click()
  await expect(group).toContainText('Hint saved.')
  await expect(group).toContainText(`Now: ${HINT2}`)
  await shot(page, 'web-settings-hint', group)

  // A new master password's hint is checked as it is typed (nothing is sent here).
  await section.locator('#pw-new').fill('Seven Blue Lanterns Glow')
  await section.locator('#pw-new2').fill('Seven Blue Lanterns Glow')
  await section.locator('#pw-new-hint').fill('blue lanterns')
  await expect(section.getByText(/The hint is part of your master password/)).toBeVisible()
  await expect(section.getByRole('button', { name: 'Change master password' })).toBeDisabled()
  await section.locator('#pw-new-hint').fill('')
  await section.locator('#pw-new').fill('')
  await section.locator('#pw-new2').fill('')

  await section.getByRole('button', { name: 'Lock all' }).click()
  await expect(section).toContainText(/Locked · \d+ items/)
  await section.getByRole('button', { name: 'Open Passwords' }).click()
  await expect(unlock).toBeVisible()
  await expect(page.getByTestId('pw-hint-shown')).toHaveCount(0)
  await shot(page, 'web-unlock-show-hint-link')
  await page.getByTestId('pw-show-hint').click()
  await expect(page.getByTestId('pw-hint-shown')).toHaveText(`Hint: ${HINT2}`)
  await shot(page, 'web-unlock-hint-shown')

  // A fresh page: a wrong password shows the hint at once.
  await page.reload()
  await expect(unlock).toBeVisible()
  await expect(page.getByTestId('pw-show-hint')).toBeVisible()
  await page.getByLabel('Master password').fill('not my password')
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(unlock.getByRole('alert')).toContainText(/wrong master password/i)
  await expect(page.getByTestId('pw-hint-shown')).toHaveText(`Hint: ${HINT2}`)
  await shot(page, 'web-unlock-wrong-password')
  await page.getByLabel('Master password').fill(MASTER)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByTestId('pw-app')).toBeVisible()
})

test('Settings removes the hint, and the unlock screen has no link then', async ({ page }) => {
  await openPasswords(page)
  const unlock = page.getByTestId('pw-unlock')
  await expect(unlock.or(page.getByTestId('pw-app'))).toBeVisible()
  if (await unlock.isVisible()) {
    await page.getByLabel('Master password').fill(MASTER)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  }
  const section = await openSettings(page)
  const group = section.getByTestId('pw-hint-settings')
  await group.getByTestId('pw-hint-remove').click()
  await expect(group).toContainText('Hint removed.')
  await expect(group).toContainText('No hint yet.')
  await section.getByRole('button', { name: 'Lock all' }).click()
  await expect(section).toContainText(/Locked · \d+ items/)
  await section.getByRole('button', { name: 'Open Passwords' }).click()
  await expect(unlock).toBeVisible()
  await expect(page.getByTestId('pw-show-hint')).toHaveCount(0)
})
