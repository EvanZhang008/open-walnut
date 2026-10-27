/**
 * The engine settings API, through the fixture server: the routes the session
 * popover calls refuse what they must, before any file is touched.
 *
 * The Settings > Engines pane this file once drove is gone (2026-10-27); the
 * popover specs (engine-settings-popover*.spec.ts) cover the UI, and
 * tests/core/engine-settings-service.test.ts pins the byte-for-byte file edits.
 */
import { test, expect } from '@playwright/test'

test.describe('engine settings API', () => {
  test('an unknown host is refused with a 400, an engine without settings with a 404', async ({ request }) => {
    const badHost = await request.get('/api/engines/claude/settings?host=no-such-host')
    expect(badHost.status()).toBe(400)
    expect((await badHost.json()).error).toContain('no-such-host')
    const noSurface = await request.get('/api/engines/gemini/settings')
    expect(noSurface.status()).toBe(404)
    const badValue = await request.patch('/api/engines/claude/settings', { data: { set: { 'permissions.defaultMode': 'yolo' } } })
    expect(badValue.status()).toBe(400)
    expect((await badValue.json()).error).toMatch(/must be one of/)
  })
})
