/**
 * The nightly comparison: at 03:00 local time, when the experiment and
 * `stt.compare.nightly` are both on, the takes of the last 24 hours. Both are
 * read when the clock fires, so turning either off needs no restart. Never on a
 * test server (backgroundAiDisabled).
 */
import { log } from '../../../logging/index.js'

const NIGHT_HOUR = 3
const DAY_MS = 24 * 60 * 60_000

let timer: ReturnType<typeof setTimeout> | null = null

/** Milliseconds from `now` to the next 03:00 local. */
export function msUntilNight(now = new Date()): number {
  const next = new Date(now)
  next.setHours(NIGHT_HOUR, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

async function fire(): Promise<void> {
  const [{ compareFlag, compareSection }, { getConfig }, { runComparison }] = await Promise.all([
    import('./settings.js'), import('../../config-manager.js'), import('./runner.js'),
  ])
  if (!(await compareFlag.on())) return
  if (compareSection(await getConfig()).nightly !== true) return
  log.stt.info('voice accuracy: nightly comparison of the last day\'s takes')
  runComparison({ sinceMs: Date.now() - DAY_MS, last: 500 })
}

export async function startCompareNightly(): Promise<void> {
  const { backgroundAiDisabled } = await import('../../cheap-model.js')
  if (timer || backgroundAiDisabled()) return
  const arm = () => {
    timer = setTimeout(() => {
      void fire().catch((err) => log.stt.warn(`voice accuracy nightly failed: ${err instanceof Error ? err.message : String(err)}`))
      arm()
    }, msUntilNight())
    timer.unref?.()
  }
  arm()
}

/** Test hook. */
export function _stopCompareNightlyForTest(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
