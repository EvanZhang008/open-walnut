/**
 * Playwright test: STT Whisper one-button setup, REAL install (manual run only).
 *
 * Verifies that after picking "Whisper" and pressing "Set up", Homebrew installs
 * whisper-cpp, Large v3 Turbo downloads, and the pane ends on the model rows
 * with Large v3 Turbo active, without a page refresh.
 *
 * Prerequisites (this really installs and downloads, 1.6 GB):
 *   whisper-cpp must NOT be installed (brew uninstall whisper-cpp)
 *   cd web && npx vite build
 *   npx playwright test stt-install
 * The simplified flow without installs is covered by stt-setup-simplified.spec.ts.
 */
import { test, expect } from '@playwright/test'

test('Whisper Set up installs whisper-cpp and the model, then shows the model rows', async ({ page }) => {
  test.setTimeout(45 * 60_000)
  // Not `networkidle`: Settings keeps an SSE stream open (cloud-setup job), so
  // the network never goes idle; wait for the page.
  await page.goto('/settings')
  await page.locator('.settings-nav').waitFor({ state: 'visible', timeout: 20_000 })

  // Click the "Voice" nav item (the section id is still `stt`)
  await page.getByTestId('settings-nav-stt').click()

  const engine = page.locator('#stt-engine')
  await expect(engine).toBeVisible({ timeout: 5000 })
  await engine.selectOption('whisper-server')

  const setupRow = page.getByTestId('stt-setup-row')
  await expect(setupRow).toBeVisible({ timeout: 15_000 })
  await expect(setupRow).toContainText('whisper-cpp with Homebrew')
  await setupRow.getByRole('button', { name: 'Set up' }).click()

  const progressUI = page.getByTestId('stt-setup-progress')
  await expect(progressUI).toBeVisible({ timeout: 5000 })
  // Finishing applies the config on its own; the progress then goes away.
  await expect(progressUI).toHaveCount(0, { timeout: 40 * 60_000 })
  await expect(setupRow).toHaveCount(0)

  const modelManager = page.locator('.stt-model-manager')
  await expect(modelManager).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('stt-model-ggml-large-v3-turbo')).toContainText('Active')
})
