/**
 * Playwright browser tests for image lightbox.
 *
 * Verifies that clicking inline images in chat opens a lightbox modal
 * instead of navigating away from the page.
 *
 * Test data is seeded in test-server.ts — chat-history.json contains
 * assistant messages with image file paths that render as inline images.
 */
import { test, expect } from '@playwright/test'

const SCREENSHOT_DIR = 'test-results/lightbox-verify'

test.describe('image lightbox in chat', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test('inline images render with data-lightbox-src attribute', async ({ page }) => {
    // Wait for images to render (they come from the seeded assistant message)
    const images = page.locator('img[data-lightbox-src]')
    await expect(images.first()).toBeVisible({ timeout: 5000 })

    // Should have at least 2 images (blue + red from seeded data)
    const count = await images.count()
    expect(count).toBeGreaterThanOrEqual(2)

    // Each should have cursor:pointer style
    const cursor = await images.first().evaluate(el => getComputedStyle(el).cursor)
    expect(cursor).toBe('pointer')

    // Take screenshot of page with inline images
    await page.screenshot({ path: `${SCREENSHOT_DIR}/step1-inline-images.png` })
  })

  test('clicking inline image opens lightbox overlay', async ({ page }) => {
    const images = page.locator('img[data-lightbox-src]')
    await expect(images.first()).toBeVisible({ timeout: 5000 })

    // Record URL before click
    const urlBefore = page.url()

    // Click the first image (blue)
    await images.first().click()

    // Lightbox overlay should appear
    const overlay = page.locator('.lightbox-overlay')
    await expect(overlay).toBeVisible({ timeout: 2000 })

    // It should have role="dialog" for accessibility
    await expect(overlay).toHaveAttribute('role', 'dialog')
    await expect(overlay).toHaveAttribute('aria-modal', 'true')

    // The lightbox image should be visible
    const lightboxImg = page.locator('.lightbox-image')
    await expect(lightboxImg).toBeVisible()

    // The close button should be visible
    const closeBtn = page.locator('.lightbox-close')
    await expect(closeBtn).toBeVisible()

    // URL should NOT have changed (no navigation)
    expect(page.url()).toBe(urlBefore)

    // Take screenshot of lightbox
    await page.screenshot({ path: `${SCREENSHOT_DIR}/step2-lightbox-open.png` })
  })

  test('close button dismisses lightbox', async ({ page }) => {
    const images = page.locator('img[data-lightbox-src]')
    await expect(images.first()).toBeVisible({ timeout: 5000 })

    // Open lightbox
    await images.first().click()
    const overlay = page.locator('.lightbox-overlay')
    await expect(overlay).toBeVisible({ timeout: 2000 })

    // Click close button
    const closeBtn = page.locator('.lightbox-close')
    await closeBtn.click()

    // Overlay should be gone
    await expect(overlay).not.toBeVisible({ timeout: 2000 })

    // Take screenshot after close
    await page.screenshot({ path: `${SCREENSHOT_DIR}/step3-after-close-button.png` })
  })

  test('ESC key dismisses lightbox', async ({ page }) => {
    const images = page.locator('img[data-lightbox-src]')
    await expect(images.first()).toBeVisible({ timeout: 5000 })

    // Open lightbox
    await images.first().click()
    const overlay = page.locator('.lightbox-overlay')
    await expect(overlay).toBeVisible({ timeout: 2000 })

    // Press Escape
    await page.keyboard.press('Escape')

    // Overlay should be gone
    await expect(overlay).not.toBeVisible({ timeout: 2000 })

    // Take screenshot after ESC
    await page.screenshot({ path: `${SCREENSHOT_DIR}/step4-after-esc.png` })
  })

  test('clicking backdrop dismisses lightbox', async ({ page }) => {
    const images = page.locator('img[data-lightbox-src]')
    await expect(images.first()).toBeVisible({ timeout: 5000 })

    // Open lightbox
    await images.first().click()
    const overlay = page.locator('.lightbox-overlay')
    await expect(overlay).toBeVisible({ timeout: 2000 })

    // Click on the overlay backdrop (top-left corner, away from image and close btn)
    await overlay.click({ position: { x: 10, y: 50 } })

    // Overlay should be gone
    await expect(overlay).not.toBeVisible({ timeout: 2000 })

    // Take screenshot after backdrop click
    await page.screenshot({ path: `${SCREENSHOT_DIR}/step5-after-backdrop.png` })
  })

  test('clicking the lightbox image does NOT close it', async ({ page }) => {
    const images = page.locator('img[data-lightbox-src]')
    await expect(images.first()).toBeVisible({ timeout: 5000 })

    // Open lightbox
    await images.first().click()
    const overlay = page.locator('.lightbox-overlay')
    await expect(overlay).toBeVisible({ timeout: 2000 })

    // Click on the lightbox image itself (should NOT close — stopPropagation)
    const lightboxImg = page.locator('.lightbox-image')
    await lightboxImg.click()

    // Overlay should still be visible
    await expect(overlay).toBeVisible()
  })

  test('different images open independently in lightbox', async ({ page }) => {
    const images = page.locator('img[data-lightbox-src]')
    await expect(images.first()).toBeVisible({ timeout: 5000 })
    const count = await images.count()
    expect(count).toBeGreaterThanOrEqual(2)

    // Get the data-lightbox-src of first and second images
    const src1 = await images.nth(0).getAttribute('data-lightbox-src')
    const src2 = await images.nth(1).getAttribute('data-lightbox-src')
    expect(src1).not.toBe(src2)

    // Click first image — lightbox should show first image
    await images.nth(0).click()
    const lightboxImg = page.locator('.lightbox-image')
    await expect(lightboxImg).toBeVisible({ timeout: 2000 })
    const lightboxSrc1 = await lightboxImg.getAttribute('src')
    expect(lightboxSrc1).toBe(src1)

    // Take screenshot of first image in lightbox
    await page.screenshot({ path: `${SCREENSHOT_DIR}/step6-image1-lightbox.png` })

    // Close and open second image
    await page.keyboard.press('Escape')
    await expect(page.locator('.lightbox-overlay')).not.toBeVisible({ timeout: 2000 })

    await images.nth(1).click()
    await expect(lightboxImg).toBeVisible({ timeout: 2000 })
    const lightboxSrc2 = await lightboxImg.getAttribute('src')
    expect(lightboxSrc2).toBe(src2)

    // Take screenshot of second image in lightbox
    await page.screenshot({ path: `${SCREENSHOT_DIR}/step7-image2-lightbox.png` })
  })

  test('no page navigation occurs during lightbox interactions', async ({ page }) => {
    const images = page.locator('img[data-lightbox-src]')
    await expect(images.first()).toBeVisible({ timeout: 5000 })

    const urlBefore = page.url()

    // Open, close via button, open, close via ESC, open, close via backdrop
    for (const closeMethod of ['button', 'escape', 'backdrop'] as const) {
      await images.first().click()
      const overlay = page.locator('.lightbox-overlay')
      await expect(overlay).toBeVisible({ timeout: 2000 })

      switch (closeMethod) {
        case 'button':
          await page.locator('.lightbox-close').click()
          break
        case 'escape':
          await page.keyboard.press('Escape')
          break
        case 'backdrop':
          await overlay.click({ position: { x: 10, y: 50 } })
          break
      }

      await expect(overlay).not.toBeVisible({ timeout: 2000 })
      expect(page.url()).toBe(urlBefore)
    }
  })
})
