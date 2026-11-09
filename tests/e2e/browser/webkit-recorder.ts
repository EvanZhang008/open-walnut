/**
 * Playwright's Linux WebKit build has no MediaRecorder, so a spec that records the mic
 * cannot start a recording there: every scenario waited out its 90 s and failed on each
 * CI run (2026-11-01, mic-stall and stt-failure-recovery). macOS WebKit, the Mac app's
 * engine, has it: `walnut-dev webkit <spec>` runs them on the Mac.
 */
import { devices, type Page } from '@playwright/test'

export const NO_RECORDER = 'this WebKit build has no MediaRecorder (Linux): run it on the Mac, walnut-dev webkit'

export async function hasMediaRecorder(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof MediaRecorder !== 'undefined')
}

/** The engine check every recording spec keeps, so it runs wherever the engine can record. */
export const ENGINE_CHECK = 'really runs in WebKit'

/**
 * Desktop Safari's user agent, marked as a voice test. Under automation the Mac's
 * silencer refuses a page's AudioContext in WebKit (it cannot send one to no output
 * device, and one on the speakers woke them at a person's Mac, 2026-11-08); a page
 * whose user agent ends with this mark keeps it, its output still sent through a gain
 * of zero. The synthetic microphone is an AudioContext, so every spec that records
 * uses this agent.
 */
export const VOICE_TEST_USER_AGENT = `${devices['Desktop Safari'].userAgent} WalnutVoiceTest`
