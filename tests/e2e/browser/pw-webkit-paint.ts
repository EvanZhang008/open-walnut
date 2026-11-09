/**
 * Linux WebKit paints on the CPU in every test run (2026-11-09).
 *
 * Playwright's Linux WebKit (WPE headless, GTK headed) paints with Skia on GL by default. A machine with no GPU
 * gives it Mesa's software GL, and the GL painting threads (`SkiaGPUWorker`) then crash the
 * page process at random: the shared Linux test host logged 27 of their faults in one day
 * (2026-11-08), seven inside Mesa's swrast_dri.so, and each one fails whatever spec is
 * running with "Target crashed" or "Target page, context or browser has been closed", on any
 * pane. Skia's CPU painting runs none of those threads. macOS WebKit paints with Core
 * Graphics and reads no such variable, so this is Linux only, and an explicit value in the
 * environment wins.
 *
 * The browser inherits the environment of the worker that launches it, and every worker loads
 * its config, so every Playwright config imports this file (tests/setup/webkit-paint.test.ts).
 */
export const WEBKIT_LINUX_PAINT_ENV: Readonly<Record<string, string>> = { WEBKIT_SKIA_ENABLE_CPU_RENDERING: '1' }

export function applyWebkitPaintEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'linux') return
  for (const [k, v] of Object.entries(WEBKIT_LINUX_PAINT_ENV)) env[k] ??= v
}

applyWebkitPaintEnv()
