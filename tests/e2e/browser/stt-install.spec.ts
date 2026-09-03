/**
 * Playwright test: STT whisper-server install flow.
 *
 * Verifies that after selecting "Whisper Server" engine and clicking
 * "Install via Homebrew", the "not installed" banner disappears once
 * the install completes — without requiring a page refresh.
 *
 * Prerequisites:
 *   whisper-cpp must NOT be installed (brew uninstall whisper-cpp)
 *   cd web && npx vite build
 *   npx playwright test stt-install
 */
import { test, expect } from '@playwright/test'

test('whisper-server install banner disappears after brew install', async ({ page }) => {
  // Navigate to settings page. Not `networkidle`: Settings keeps an SSE stream
  // open (cloud-setup job), so the network never goes idle; wait for the page.
  await page.goto('/settings')
  await page.locator('#providers').waitFor({ state: 'attached', timeout: 20_000 })

  // Click the "Voice" nav item (the section id is still `stt`)
  const sttNav = page.locator('.settings-nav-item', { hasText: /^Voice$/ })
  await sttNav.click()

  // Open the transcription service dropdown and select Whisper Server
  const dropdownTrigger = page.locator('.stt-dropdown-trigger')
  await expect(dropdownTrigger).toBeVisible({ timeout: 5000 })
  await dropdownTrigger.click()

  const whisperServerOption = page.locator('.stt-dropdown-option', { hasText: 'Whisper Server' })
  await whisperServerOption.click()

  // The "not installed" banner should appear
  const installBanner = page.locator('.stt-install-banner')
  await expect(installBanner).toBeVisible({ timeout: 5000 })
  await expect(installBanner).toContainText('whisper-server is not installed')

  // Click "Install via Homebrew"
  const installBtn = installBanner.locator('button', { hasText: 'Install via Homebrew' })
  await expect(installBtn).toBeVisible()
  await installBtn.click()

  // Wait for the setup progress UI to appear
  const progressUI = page.locator('.stt-setup-progress')
  await expect(progressUI).toBeVisible({ timeout: 5000 })

  // Wait for "Done — Apply Config" button (brew install can take a while)
  const doneBtn = page.locator('.stt-setup-actions button', { hasText: 'Done' })
  await expect(doneBtn).toBeVisible({ timeout: 120_000 })

  // Click "Done — Apply Config"
  await doneBtn.click()

  // The install banner should disappear (detection re-runs and finds whisper-server)
  await expect(installBanner).toBeHidden({ timeout: 15_000 })

  // The model manager should now be visible (binary is ready)
  const modelManager = page.locator('.stt-model-manager')
  await expect(modelManager).toBeVisible({ timeout: 5000 })
})
