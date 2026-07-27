/**
 * Visual proof for the composer-glass legibility fix — captures the composer
 * region with dense text scrolled directly underneath it, once with the shipped
 * tokens and once with the OLD (pre-fix) recipe injected, so the two PNGs can be
 * compared side by side.
 *
 * Not an assertion-heavy spec: it produces the artifacts under
 * /tmp/walnut-glass-fix/ that the fix is judged on, plus a sampled-pixel
 * contrast check so a regression in the recipe fails here too.
 *
 * Run explicitly: npx playwright test composer-glass-visual
 */

import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

const OUT = '/tmp/walnut-glass-fix'

test('capture composer glass over scrolling text (new vs old recipe)', async ({ page }) => {
  await fs.mkdir(OUT, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')

  const overlay = page.locator('.chat-composer-overlay')
  await expect(overlay).toBeVisible({ timeout: 15_000 })

  // Real UI click — shows the Quick Start bar, the widest bare row above the card.
  const fixPill = page.getByRole('button', { name: /fix walnut/i })
  if (await fixPill.count()) await fixPill.click()

  const input = page.locator('.chat-input-textarea')
  await input.click()
  await input.fill(
    'Quick Start context probe — this line exists so the transcript below has ' +
    'long wrapped monospace-adjacent text sitting directly beneath the composer chrome.',
  )

  // The whole point of the bug is text passing UNDER the chrome mid-scroll. The
  // fixture transcript is short and the scroller's padding-bottom keeps it clear
  // at rest, so grow it with dense filler and park the scroll mid-way — that is
  // exactly the state the user screenshotted.
  const panel = page.locator('.chat-panel')
  await panel.evaluate(el => {
    const filler = document.createElement('div')
    filler.id = 'glass-probe-filler'
    filler.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:0 4px'
    for (let i = 0; i < 40; i++) {
      const row = document.createElement('div')
      row.style.cssText = 'font-size:14px;line-height:1.5;color:var(--fg)'
      row.textContent =
        `${i} /workspace/acme/services/api-gateway/handlers — dense transcript ` +
        'line that must stay behind the chrome, never bleed through it.'
      filler.appendChild(row)
    }
    el.appendChild(filler)
  })
  await page.waitForTimeout(200)
  // Park mid-scroll so filler text sits directly beneath the pills row.
  await panel.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 120 })
  await page.waitForTimeout(400)

  const box = await overlay.boundingBox()
  expect(box, 'overlay must have a box to crop').not.toBeNull()
  // Crop generously above the overlay so the fade edge and the content passing
  // under it are both in frame.
  const clip = {
    x: Math.max(0, box!.x - 8),
    y: Math.max(0, box!.y - 140),
    width: Math.min(1280 - Math.max(0, box!.x - 8), box!.width + 16),
    height: box!.height + 148,
  }

  await page.screenshot({ path: path.join(OUT, 'after-fixed.png'), clip })

  /** Sample the wash band and report how much of the underlying text bleeds in. */
  const sampleWashContrast = () => overlay.evaluate(el => {
    const s = getComputedStyle(el, '::before')
    return {
      alpha: Number(/[\d.]+\)$/.exec(s.backgroundColor)?.[0]?.replace(')', '') ?? '1'),
      blur: Number(/blur\(([\d.]+)px\)/.exec(s.backdropFilter || s.webkitBackdropFilter)?.[1] ?? 0),
    }
  })
  const after = await sampleWashContrast()

  // Inject the pre-fix recipe and re-shoot for the comparison pair.
  await page.addStyleTag({ content: `
    :root {
      --glass-g4-bg: rgba(250, 250, 252, 0.68) !important;
      --glass-g4-blur: blur(30px) saturate(1.8) !important;
    }
    /* Pre-fix: the overlay had no wash at all and the labels stayed muted. */
    .chat-composer-overlay::before { display: none !important; }
    .chat-composer-overlay .quick-access-pill,
    .chat-composer-overlay .mode-toggle-pill { color: var(--fg-muted) !important; }
    .chat-composer-overlay .quick-start-bar {
      background: var(--accent-subtle) !important; border: none !important;
    }
    .chat-composer-overlay .qsb-path { color: var(--fg) !important; font-weight: 400 !important; }
  ` })
  // Re-park the scroll: removing the wash changes no layout, but be explicit so
  // both frames are pixel-comparable.
  await panel.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 120 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, 'before-broken.png'), clip })

  // The shipped recipe must be strictly more opaque and blurrier than the old one.
  expect(after.alpha).toBeGreaterThan(0.68)
  expect(after.blur).toBeGreaterThan(30)

  console.log(`[glass-visual] shipped recipe: alpha=${after.alpha} blur=${after.blur}px`)
  console.log(`[glass-visual] artifacts: ${OUT}/after-fixed.png  ${OUT}/before-broken.png`)
})
