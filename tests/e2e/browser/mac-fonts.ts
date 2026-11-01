import { expect } from '@playwright/test'

/**
 * Whether the page is drawn in the fonts the product's widths were chosen for.
 *
 * The system font stack (`-apple-system, BlinkMacSystemFont, ...`) resolves to Apple's font only on a
 * Mac. A Linux runner draws the same text in a narrower fallback, so a sentence that is too wide for
 * its slot in the Mac app fits there (2026-11-01: `12px needs 163px of a 165px slot` in Chromium and
 * `11px needs 149px of a 159px slot` in WebKit, on every CI run).
 */
export const ON_MAC_FONTS = process.platform === 'darwin'

/**
 * A recorded design reason, "one size up would not fit": graded where the Mac's fonts are, logged
 * elsewhere. That a text DOES fit is font independent enough to grade everywhere, so only the
 * "too wide" half goes through here.
 */
export function expectTooWideOnMac(need: number, slot: number, message: string): void {
  if (!ON_MAC_FONTS) {
    console.log(`${message}: not graded, ${process.platform} has no Apple system font`)
    return
  }
  expect(need, message).toBeGreaterThan(slot)
}
