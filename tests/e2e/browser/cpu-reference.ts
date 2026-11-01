/**
 * A main-thread CPU budget that travels between machines.
 *
 * A budget in ms of the page's main-thread CPU holds only on the machine it was measured on: the
 * same React render costs about twice as much in an 8 CPU dev container as on the Mac, and more
 * again on a 4 core CI runner at load 11 (2026-11-01: the kanban's 500 ms open budget, measured
 * 290 to 360 ms on the Mac, read 700 here and 697 to 1,058 on CI, for a product that had not got
 * slower: the build of 2026-10-23 read 900 to 986 here). So the budget is counted in a
 * fixed reference draw measured in the same page, on the same clock: a slower machine gets it in
 * proportion, a machine as fast as the one it was set on keeps it as written, and a real regression
 * (the work itself grown) still fails anywhere.
 */
import type { Page } from '@playwright/test'

/**
 * Main-thread CPU of a fixed draw in this page: 3,000 two-line rows built, laid out and taken
 * away, five times; the median, in ms. It does the kind of work a first render does (markup,
 * style, layout), so it scales with the machine the way that render does. `cpuMs` reads the
 * page's main-thread CPU so far, in ms (CDP Performance TaskDuration).
 */
export async function referenceDrawMs(page: Page, cpuMs: () => Promise<number>): Promise<number> {
  const runs: number[] = []
  for (let i = 0; i < 5; i++) {
    const before = await cpuMs()
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;left:0;top:0;width:600px;visibility:hidden;pointer-events:none'
      host.innerHTML = Array.from({ length: 3_000 }, (_, n) =>
        `<div class="ref-row"><b>Sender ${n}</b> <span>Subject line number ${n} of the reference draw</span><p>A preview of the message body, ${n}</p></div>`).join('')
      document.body.append(host)
      void host.getBoundingClientRect().height
      host.remove()
    })
    runs.push((await cpuMs()) - before)
  }
  return Math.round(runs.sort((a, b) => a - b)[2]!)
}

/**
 * A budget as it holds on this machine: `refs` reference draws, and never less than the budget as
 * written (`asWrittenMs`, for the machine it was measured on, which is faster than any runner).
 * Pick `refs` from the work's own cost in references, measured where both are read on one clock,
 * with headroom for the spread under load, and no more: work that grew by half should fail.
 */
export function cpuBudget(asWrittenMs: number, refs: number, referenceMs: number): number {
  return Math.max(asWrittenMs, Math.round(refs * referenceMs))
}
