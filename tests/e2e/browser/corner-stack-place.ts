import type { Page } from '@playwright/test'
import { STACK_WIDTH_PX } from '../../../web/src/components/common/corner-stack-width'

/** What stackPlace() says when the stack is where it belongs. */
export const BOTTOM_LEFT = 'bottom left'

/**
 * How far Home's session taskbar lifts the stack now, 0 while it does not show: the stack stands on
 * it (corner-stack.tsx). The one place the tests compute it.
 */
export async function taskbarLift(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bar = document.querySelector('.session-taskbar')?.getBoundingClientRect()
    return bar && bar.height > 0 ? Math.max(0, Math.round(window.innerHeight - bar.top)) : 0
  })
}

/**
 * Where the notice stack sits on a computer (web/src/styles/corner-stack.css), as one string: its
 * bottom 16px above the window's (above the session taskbar's top while that shows), its left 16px right of the sidebar's icon rail (or of the
 * notification center while that is open), and its one width, min(440px, window - 32px), whatever
 * else the page has open. BOTTOM_LEFT when it is there, else the numbers a failure can read.
 * The phone has its own place (the top, across the screen), which this does not describe.
 */
export async function stackPlace(page: Page): Promise<string> {
  const lift = await taskbarLift(page)
  return page.evaluate(({ stackWidth, ok, lift }) => {
    const r = document.querySelector('[data-testid="corner-stack"]')!.getBoundingClientRect()
    // The rail counts while it takes its own room in the page's row (an overlay sidebar does not).
    const side = document.querySelector('.app-shell > .sidebar')
    const rail = side && getComputedStyle(side).position !== 'fixed' ? Math.max(0, Math.round(side.getBoundingClientRect().right)) : 0
    const center = document.querySelector('.notification-panel')?.getBoundingClientRect()
    const from = center && center.width > 0 ? Math.max(rail, Math.round(center.right)) : rail
    const want = { left: from + 16, bottom: 16 + lift, width: Math.min(stackWidth, window.innerWidth - 32) }
    const got = { left: Math.round(r.left), bottom: Math.round(window.innerHeight - r.bottom), width: Math.round(r.width) }
    return Math.abs(got.left - want.left) <= 1 && got.bottom === want.bottom && got.width === want.width
      ? ok
      : `stack left ${got.left} (want ${want.left}), bottom gap ${got.bottom} (want ${want.bottom}), width ${got.width} (want ${want.width}) in ${window.innerWidth}x${window.innerHeight}`
  }, { stackWidth: STACK_WIDTH_PX, ok: BOTTOM_LEFT, lift })
}
