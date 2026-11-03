/**
 * The Passwords app as a person uses it (web/src/components/passwords/): set up the vault
 * (a weak or mismatched master password is held back, the Secret Key is shown once and
 * the kit must be confirmed), add a login with the generator, reveal and copy, change the
 * password (history), the live verification code, search, favorites, trash and restore,
 * import a CSV with its dry run, the security check, lock, a wrong password, unlock, a
 * reload keeping the section and item, the Settings pane (what an agent gets, a new recovery
 * kit), and a forgotten master password reset with the recovery code.
 *
 * The fixture server is shared, so the first step sets the vault up when it is not, and
 * otherwise unlocks it (a retry). Fake data only.
 * Run on the Mac app's engine: PW_WEBKIT=1 bun x playwright test passwords --project webkit
 */
import { expect, test, type Page } from '@playwright/test'

test.use({ video: process.env.PW_DEMO_VIDEO ? 'on' : 'off' })
test.describe.configure({ mode: 'serial' })

const MASTER = 'Correct Horse Battery Staple 42'
const stamp = Date.now().toString(36)
const SITE = `Example Git ${stamp}`

async function openPasswords(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) await page.locator('.sidebar-collapse-btn').click()
  await page.locator('.sidebar-nav a[href="/passwords"]').first().click()
}

async function unlockIfLocked(page: Page) {
  const unlock = page.getByTestId('pw-unlock')
  const app = page.getByTestId('pw-app')
  await expect(unlock.or(app).or(page.getByRole('heading', { name: 'Set up Passwords' }))).toBeVisible()
  if (await unlock.isVisible()) {
    await page.getByLabel('Master password').fill(MASTER)
    await page.getByRole('button', { name: 'Unlock' }).click()
  }
  await expect(app).toBeVisible()
}

test('set up the vault, or unlock it when a retry finds it set up', async ({ page }) => {
  await openPasswords(page)
  const setup = page.getByRole('heading', { name: 'Set up Passwords' })
  await expect(setup.or(page.getByTestId('pw-unlock')).or(page.getByTestId('pw-app'))).toBeVisible()
  if (!(await setup.isVisible())) { await unlockIfLocked(page); return }

  const create = page.getByRole('button', { name: 'Create vault' })
  // Setup asks for the master password only: what agents may do lives in Settings.
  await expect(page.locator('#pw-setup-agents')).toHaveCount(0)
  await page.locator('#pw-setup-1').fill('password1')
  await expect(page.locator('.pw-meter-text')).toHaveText(/weak/i)
  await expect(create).toBeDisabled()
  await page.locator('#pw-setup-1').fill(MASTER)
  await page.locator('#pw-setup-2').fill(`${MASTER}x`)
  await expect(page.getByText('The two passwords differ.')).toBeVisible()
  await expect(create).toBeDisabled()
  await page.locator('#pw-setup-2').fill(MASTER)
  await expect(create).toBeEnabled()
  await create.click()

  await expect(page.getByRole('heading', { name: 'Save your recovery kit' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('pw-secret-key')).toHaveText(/^W1-[A-Z2-9]{6}(-[A-Z2-9]{5}){4}$/)
  await expect(page.getByTestId('pw-recovery-code')).toHaveText(/^R1-[A-Z2-9]{6}(-[A-Z2-9]{5}){4}$/)
  const open = page.getByRole('button', { name: 'Open Passwords' })
  await expect(open).toBeDisabled()
  await page.getByLabel(/I saved my recovery kit/).check()
  await open.click()
  await expect(page.getByTestId('pw-app')).toBeVisible()
})

test('add a login with the generator, reveal it, change it and see its history', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
  await openPasswords(page)
  await unlockIfLocked(page)

  await page.getByRole('button', { name: 'New item' }).click()
  await page.getByRole('menuitem', { name: 'New login' }).click()
  const editor = page.getByTestId('pw-editor')
  await editor.getByLabel('Name', { exact: true }).fill(SITE)
  await editor.getByPlaceholder('name@example.com').fill('alice@example.test')
  await editor.getByRole('button', { name: 'Generate a password' }).click()
  const generated = await page.getByTestId('pw-gen-value').innerText()
  expect(generated.length).toBeGreaterThanOrEqual(16)
  await page.getByRole('button', { name: 'Use this password' }).click()
  await expect(editor.getByLabel('Password', { exact: true })).toHaveValue(generated)
  await expect(editor.locator('.pw-meter-text')).toHaveText(/strong/i)
  await editor.getByLabel('Website 1').fill('git.example.test')
  await editor.getByPlaceholder('Setup key or otpauth:// link').fill('JBSWY3DPEHPK3PXP')
  await editor.getByRole('button', { name: 'Save' }).click()

  const detail = page.getByTestId('pw-detail')
  await expect(detail.getByRole('heading', { name: SITE })).toBeVisible()
  await expect(page.getByTestId('pw-row').filter({ hasText: SITE })).toHaveAttribute('aria-selected', 'true')
  await expect(detail.getByTestId('pw-field-password')).toHaveText('••••••••••••')
  await detail.getByRole('button', { name: 'Show Password' }).click()
  await expect(detail.getByTestId('pw-field-password')).toHaveText(generated)
  await expect(detail.getByTestId('pw-totp')).toHaveText(/^\d{3} \d{3}$/)
  await expect(detail.getByRole('link', { name: /git\.example\.test/ })).toHaveAttribute('href', 'https://git.example.test')

  await detail.getByRole('button', { name: 'Copy Username' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()).catch(() => 'no-clipboard')).toMatch(/alice@example\.test|no-clipboard/)

  await detail.getByRole('button', { name: 'Edit' }).click()
  await page.getByTestId('pw-editor').getByLabel('Password', { exact: true }).fill('a-new-Pass-2026!')
  await page.getByTestId('pw-editor').getByRole('button', { name: 'Save' }).click()
  await expect(detail.locator('.pw-history summary')).toHaveText('Password history (1)')
  await detail.locator('.pw-history summary').click()
  await detail.locator('.pw-history').getByRole('button', { name: /^Show / }).click()
  await expect(detail.locator('.pw-history')).toContainText(generated)
})

test('search, favorites, trash and restore', async ({ page }) => {
  await openPasswords(page)
  await unlockIfLocked(page)
  await page.getByTestId('pw-section-all').click()
  await page.getByLabel('Search passwords').fill(`git ${stamp}`)
  await expect(page.getByTestId('pw-row')).toHaveCount(1)
  await page.getByLabel('Search passwords').fill('no such thing anywhere')
  await expect(page.getByText('Nothing matches.')).toBeVisible()
  await page.getByLabel('Search passwords').fill(stamp)
  await page.getByTestId('pw-row').filter({ hasText: SITE }).click()

  const detail = page.getByTestId('pw-detail')
  await detail.getByRole('button', { name: 'Add to favorites' }).click()
  await expect(detail.getByRole('button', { name: 'Remove from favorites' })).toBeVisible()
  await page.getByTestId('pw-section-favorites').click()
  await expect(page.getByTestId('pw-row').filter({ hasText: SITE })).toBeVisible()

  await page.getByTestId('pw-row').filter({ hasText: SITE }).click()
  await detail.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('pw-row').filter({ hasText: SITE })).toHaveCount(0)
  await page.getByTestId('pw-section-trash').click()
  await page.getByTestId('pw-row').filter({ hasText: SITE }).click()
  await detail.getByRole('button', { name: 'Restore' }).click()
  await page.getByTestId('pw-section-all').click()
  await expect(page.getByTestId('pw-row').filter({ hasText: SITE })).toBeVisible()
})

test('import a CSV after its dry run, and the security check finds the weak one', async ({ page }) => {
  await openPasswords(page)
  await unlockIfLocked(page)
  await page.getByRole('button', { name: 'Import…' }).click()
  const dialog = page.getByTestId('pw-import')
  await dialog.getByTestId('pw-import-file').setInputFiles({
    name: 'chrome.csv', mimeType: 'text/csv',
    buffer: Buffer.from(`name,url,username,password,note\nmail ${stamp},https://mail-${stamp}.example.test/,bob,123456,\nshop ${stamp},https://shop-${stamp}.example.test/,bob,Xq7!vT2p-Lm9#rW4,\n`),
  })
  await expect(dialog.getByTestId('pw-import-report')).toContainText('2to add')
  await expect(dialog.getByRole('radio', { name: 'Chrome (.csv)' })).toHaveAttribute('aria-checked', 'true')
  await dialog.getByRole('button', { name: 'Import 2 items' }).click()
  await expect(dialog.getByText('Imported 2 items.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await page.getByLabel('Search passwords').fill(stamp)
  await expect(page.getByTestId('pw-row')).toHaveCount(3)

  await page.getByLabel('Search passwords').fill('')
  await page.getByTestId('pw-section-security').click()
  const sec = page.getByTestId('pw-security')
  await expect(sec).toContainText('Weak passwords')
  await sec.getByRole('button', { name: new RegExp(`mail ${stamp}`) }).click()
  await expect(page.getByTestId('pw-detail').getByRole('heading', { name: `mail ${stamp}` })).toBeVisible()
})

test('lock, a wrong password, unlock, and a reload keeps the section and the item', async ({ page }) => {
  await openPasswords(page)
  await unlockIfLocked(page)
  await page.getByTestId('pw-section-logins').click()
  await page.getByLabel('Search passwords').fill(stamp)
  await page.getByTestId('pw-row').filter({ hasText: SITE }).click()
  await page.getByTestId('pw-lock').click()

  const unlock = page.getByTestId('pw-unlock')
  await expect(unlock).toBeVisible()
  await expect(page.getByTestId('pw-app')).toHaveCount(0)
  await page.getByLabel('Master password').fill('not my password')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(unlock.getByRole('alert')).toContainText(/wrong master password/i)
  await page.getByLabel('Master password').fill(MASTER)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByTestId('pw-section-logins')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('pw-detail').getByRole('heading', { name: SITE })).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('pw-section-logins')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('pw-detail').getByRole('heading', { name: SITE })).toBeVisible()
})

test('the Settings pane shows the vault and locks every window', async ({ page }) => {
  await openPasswords(page)
  await unlockIfLocked(page)
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await page.getByTestId('settings-nav-passwords').click()
  const section = page.locator('#passwords')
  await expect(section).toContainText(/Unlocked in this window · \d+ items/)
  // What an agent gets, in one sentence.
  await expect(section.getByRole('radiogroup', { name: 'When an agent asks for a password' })).toBeVisible()
  await expect(section.getByText('You approve each use on your Mac or phone.')).toBeVisible()
  const away = section.locator('#pw-agents-away')
  await expect(away).toHaveAttribute('aria-checked', 'false')
  // The protected actions wait for the master password.
  const makeKit = section.getByRole('button', { name: 'Make a new recovery kit' })
  await expect(away).toBeDisabled()
  await expect(makeKit).toBeDisabled()
  await section.locator('#pw-confirm').fill(MASTER)
  const download = page.waitForEvent('download')
  await makeKit.click()
  expect((await download).suggestedFilename()).toMatch(/recovery/i)
  const card = section.getByTestId('pw-settings-kit')
  await expect(card.getByTestId('pw-recovery-code')).toHaveText(/^R1-/)
  await expect(section.locator('#pw-confirm')).toHaveValue('')
  // The kit stays until the person says it is saved.
  await card.getByLabel(/I saved my recovery kit/).check()
  await card.getByRole('button', { name: 'Done, I saved it' }).click()
  await expect(card).toHaveCount(0)
  await section.locator('#pw-confirm').fill('not my master password')
  await away.click()
  await expect(section.getByRole('alert')).toContainText(/wrong master password/i)
  await expect(away).toHaveAttribute('aria-checked', 'false')
  await section.locator('#pw-confirm').fill(MASTER)
  await away.click()
  await expect(away).toHaveAttribute('aria-checked', 'true')
  await expect(section).toContainText('Agents can ask while Passwords is locked.')
  await section.locator('#pw-confirm').fill(MASTER)
  await away.click()
  await expect(away).toHaveAttribute('aria-checked', 'false')
  await section.getByRole('button', { name: 'Lock all' }).click()
  await expect(section).toContainText('Every window is locked.')
  await expect(section).toContainText(/Locked · \d+ items/)
  await section.getByRole('button', { name: 'Open Passwords' }).click()
  await expect(page.getByTestId('pw-unlock')).toBeVisible()
})

test('a forgotten master password: the recovery code sets a new one and gives a new kit', async ({ page }) => {
  await openPasswords(page)
  await unlockIfLocked(page)
  // A fresh kit, so this test knows the code whatever ran before it.
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await page.getByTestId('settings-nav-passwords').click()
  const section = page.locator('#passwords')
  await section.locator('#pw-confirm').fill(MASTER)
  const download = page.waitForEvent('download')
  await section.getByRole('button', { name: 'Make a new recovery kit' }).click()
  await download
  const card = section.getByTestId('pw-settings-kit')
  const code = (await card.getByTestId('pw-recovery-code').textContent())!.trim()
  await card.getByLabel(/I saved my recovery kit/).check()
  await card.getByRole('button', { name: 'Done, I saved it' }).click()
  await section.getByRole('button', { name: 'Lock all' }).click()
  await expect(section).toContainText(/Locked · \d+ items/)
  await section.getByRole('button', { name: 'Open Passwords' }).click()

  const NEW = 'Forgotten Then Found Again 77'
  const reset = async (withCode: string, pw: string) => {
    await page.getByRole('button', { name: 'Forgot master password?' }).click()
    const form = page.getByTestId('pw-recover')
    await form.getByLabel('Recovery code').fill(withCode)
    await form.getByLabel('New master password', { exact: true }).fill(pw)
    await form.getByLabel('Confirm new master password').fill(pw)
    await form.getByRole('button', { name: 'Set new master password' }).click()
  }
  // A wrong code is refused and nothing changes.
  await reset('R1-AAAAAA-AAAAA-AAAAA-AAAAA-AAAAA', NEW)
  await expect(page.getByTestId('pw-recover').getByRole('alert')).toContainText(/does not open this vault/)
  await page.getByRole('button', { name: 'Back to unlock' }).click()
  await reset(code, NEW)
  const kit = page.getByTestId('pw-kit')
  await expect(kit.getByRole('heading', { name: 'Save your new recovery kit' })).toBeVisible({ timeout: 20_000 })
  const next = (await kit.getByTestId('pw-recovery-code').textContent())!.trim()
  expect(next).toMatch(/^R1-/)
  expect(next).not.toBe(code)
  await kit.getByLabel(/I saved my recovery kit/).check()
  await kit.getByRole('button', { name: 'Open Passwords' }).click()
  await expect(page.getByTestId('pw-app')).toBeVisible()

  // The old master password no longer opens it; the new one does.
  await page.getByTestId('pw-lock').click()
  await page.getByLabel('Master password').fill(MASTER)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByTestId('pw-unlock').getByRole('alert')).toContainText(/wrong master password/i)
  // The used code works no more; the new one sets the old password back for a rerun.
  await reset(code, MASTER)
  await expect(page.getByTestId('pw-recover').getByRole('alert')).toContainText(/does not open this vault/)
  await page.getByRole('button', { name: 'Back to unlock' }).click()
  await reset(next, MASTER)
  await expect(page.getByTestId('pw-kit')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('pw-kit').getByLabel(/I saved my recovery kit/).check()
  await page.getByTestId('pw-kit').getByRole('button', { name: 'Open Passwords' }).click()
  await expect(page.getByTestId('pw-app')).toBeVisible()
})
