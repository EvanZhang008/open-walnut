/** A per-frame sampler of the kanban pane, for the first-paint checks in board-kanban-round4.spec.ts. */
import type { Page } from '@playwright/test'

/** Every animation frame from now: the cards drawn, their summaries, one card's height, the skeletons, the pane text. */
export async function startSampler(page: Page, watchId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as { __kb: Array<Record<string, unknown>>; __kbStop?: boolean }
    w.__kb = []
    w.__kbStop = false
    const t0 = performance.now()
    const tick = () => {
      if (w.__kbStop) return
      const pane = document.querySelector('[data-testid="task-board-pane"]')
      if (pane) {
        const cards = pane.querySelectorAll('[data-testid="kanban-card"]:not(.kanban-skeleton)').length
        const sums = pane.querySelectorAll('[data-testid="kanban-card-summary"]').length
        const one = pane.querySelector<HTMLElement>(`[data-testid="kanban-card"][data-task-id="${id}"]`)
        const chip = pane.querySelector('[data-testid="kanban-chip-changed"]')
        w.__kb.push({
          ms: Math.round(performance.now() - t0), cards, sums, h: one ? Math.round(one.getBoundingClientRect().height) : -1,
          sk: pane.querySelectorAll('[data-testid="kanban-skeleton"]').length, text: /Loading the board/.test(pane.textContent ?? ''),
          changed: chip ? Number(chip.getAttribute('data-count')) : -1,
          session: /a session/.test(Array.from(pane.querySelectorAll('[data-testid="kanban-card-changed"]')).map((e) => e.getAttribute('title') ?? '').join(' ')),
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, watchId)
}

export async function stopSampler(page: Page): Promise<Array<{ ms: number; cards: number; sums: number; h: number; sk: number; text: boolean; changed: number; session: boolean }>> {
  return page.evaluate(() => {
    const w = window as unknown as { __kb: Array<Record<string, unknown>>; __kbStop?: boolean }
    w.__kbStop = true
    return w.__kb as never
  })
}
