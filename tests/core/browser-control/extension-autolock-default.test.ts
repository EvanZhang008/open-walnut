/**
 * The extension follows Walnut's own unlock length unless the person picked a lock of its own
 * (packages/browser-extension/src/settings.ts). An older extension defaulted to "After 15 minutes"
 * and wrote that default with every setting it saved, so after an update its idle alarm still
 * locked 15 minutes after the unlock: 2026-11-07, the person unlocked at night and was asked
 * again (an extension `POST /vault/lock` 16 minutes after the unlock). Only a pick made here keeps 15.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

let stored: Record<string, unknown> = {}
vi.mock('../../../packages/browser-extension/src/ext', () => ({
  ext: {
    storage: {
      local: {
        get: async (k: string) => (k in stored ? { [k]: stored[k] } : {}),
        set: async (o: Record<string, unknown>) => { Object.assign(stored, o) },
      },
    },
  },
}))

describe('the extension auto-lock after an update', () => {
  beforeEach(() => { stored = {} })

  it('a fresh install follows Walnut', async () => {
    const { getSettings } = await import('../../../packages/browser-extension/src/settings')
    expect((await getSettings()).autoLock).toBe('walnut')
  })

  it("an older extension's saved default of 15 minutes reads Walnut's setting", async () => {
    stored = { settings: { autoLock: '15', pageFill: false } }
    const { getSettings } = await import('../../../packages/browser-extension/src/settings')
    const s = await getSettings()
    expect(s.autoLock).toBe('walnut')
    expect(s.pageFill).toBe(false)
  })

  it('15 minutes the person picked here stays, and saving another setting keeps it', async () => {
    const { getSettings, setSettings } = await import('../../../packages/browser-extension/src/settings')
    await setSettings({ autoLock: '15', autoLockChosen: true })
    await setSettings({ pageFill: false })
    expect((await getSettings()).autoLock).toBe('15')
  })

  it('saving another setting with the default never turns it into a timed lock', async () => {
    const { getSettings, setSettings } = await import('../../../packages/browser-extension/src/settings')
    await setSettings({ pageFill: false })
    expect((stored.settings as { autoLock: string }).autoLock).toBe('walnut')
    expect((await getSettings()).autoLock).toBe('walnut')
  })
})
