import fs from 'node:fs/promises'
import { expect, type Locator } from '@playwright/test'

/** A query exposes Clear as well as the mic. Neither may cover the other or typed words. */
export async function clearBesideMic(input: Locator, clear: Locator, query: string, shot: string): Promise<void> {
  const mic = input.locator('..').locator('.mic-btn')
  await input.fill(query)
  await expect(input).toHaveValue(query)
  await expect(clear).toBeVisible()
  await expect(mic).toHaveCount(1)
  await expect(mic).toBeVisible()
  const box = (await input.boundingBox())!
  const c = (await clear.boundingBox())!
  const m = (await mic.boundingBox())!
  for (const b of [c, m]) {
    expect(b.width).toBeGreaterThanOrEqual(44)
    expect(b.height).toBeGreaterThanOrEqual(44)
    expect(b.x).toBeGreaterThanOrEqual(box.x)
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1)
  }
  expect(c.x + c.width).toBeLessThanOrEqual(m.x)
  const padding = await input.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))
  expect(box.x + box.width - padding).toBeLessThanOrEqual(c.x)
  for (const control of [clear, mic]) {
    expect(await control.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return hit === el || el.contains(hit)
    })).toBe(true)
  }
  await fs.mkdir('/tmp/search-mic-layout', { recursive: true })
  await input.page().screenshot({ path: `/tmp/search-mic-layout/${shot}.png` })
  // Real input: an overlapped X would start recording or fail the click, not clear the query.
  await clear.click()
  await expect(input).toHaveValue('')
  await expect(clear).toHaveCount(0)
  await expect(mic).not.toHaveClass(/recording|transcribing/)
}
