/**
 * One spec at a time drives the app-wide panel count (`ui.session_panels`) on a fixture server.
 *
 * The count is one config value the whole server shares, and `fullyParallel` runs other files
 * against the same server at once: a spec that set 3 and counted columns read 4, or its saved
 * count read 2, because another file's `setPanelMode` landed in between (2026-11-03, CI shard 11:
 * session-panel-lock-grant failed twice while session-panel-count ran on the next worker).
 * Serial within a file never covered that. Every spec that writes the count calls
 * `holdPanelCountLock()` once at its top level; tests/web/panel-count-lock-guard.test.ts fails on
 * one that writes it without. The lock itself is spec-lock.ts.
 */
import { specLock } from './spec-lock'

const lock = specLock('panel-count')

/** Hold the fixture's panel count for this file (serial) or for each test (any other file). */
export function holdPanelCountLock(scope: 'file' | 'test'): void {
  lock.hold(scope)
}
