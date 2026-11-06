import type { BrowserContext } from '@playwright/test'

/**
 * The window's one notice corner (corner-stack.tsx) shows every live notice of the shared
 * fixture server, a permission prompt of ANOTHER worker's team included (each team seeds two
 * Bash prompts). Over the board it covers a card and gives the lanes extra room at their end
 * (syncRoom), which moves what these specs measure and drag. They test the board, so the corner
 * keeps only the board's own toasts (its move toasts, which C8 and others read).
 */
export async function keepCornerToBoard(target: Pick<BrowserContext, 'addInitScript'>): Promise<void> {
  await target.addInitScript(() => {
    const css = '.corner-stack > .corner-slot:not(.corner-slot-board) { display: none !important; }'
    const add = () => { const s = document.createElement('style'); s.dataset.test = 'corner-board-only'; s.textContent = css; document.head.appendChild(s) }
    if (document.head) add(); else document.addEventListener('DOMContentLoaded', add, { once: true })
  })
}
