/**
 * The one look of a card's answer (.claude/skills/walnut-ui-requirements/standard.md, "The button
 * family"), measured on the page: at most one solid blue key (the main action), every key and the
 * box one height (34 px), every option a row of its own, and the keys above the box.
 *
 * 2026-11-21, the user, after cards shipped with different buttons from the design he had seen:
 * "the UI is so ugly ... can we have 10 design ... and actually implement it that way" (he picked
 * "2 is good"). Specs call this on every card kind they draw, so a card that drifts fails.
 */
import { expect, type Locator } from '@playwright/test'

export interface FamilyLook { keys: number; blue: number; heights: number[]; box: number | null; optionRows: boolean; keysAboveBox: boolean }

/** Measures the card's answer row; the parts a prompt's own card or the composer draw are not its keys. */
export async function familyLook(card: Locator): Promise<FamilyLook> {
  return card.evaluate((el) => {
    const row = el.querySelector('.ask-card-answer')
    if (!row) return { keys: 0, blue: 0, heights: [], box: null, optionRows: true, keysAboveBox: true }
    const probe = document.createElement('span')
    probe.style.color = 'var(--accent)'
    row.appendChild(probe)
    const accent = getComputedStyle(probe).color
    probe.remove()
    const own = (b: Element) => !b.closest('.org-answer-words, .kanban-prompt, .permission-request-card, .ask-card-tools')
    const keys = [...row.querySelectorAll('button, .org-answer-check')].filter(own).filter((b) => (b as HTMLElement).offsetParent !== null)
    const box = row.querySelector('.org-answer-words .chat-input-box')
    const boxRect = box?.getBoundingClientRect()
    const rowWidth = row.getBoundingClientRect().width
    const options = [...row.querySelectorAll('.org-answer-options .btn, .org-answer-check')].filter(own)
    return {
      keys: keys.length,
      blue: keys.filter((b) => getComputedStyle(b).backgroundColor === accent).length,
      heights: keys.map((b) => Math.round(b.getBoundingClientRect().height)),
      box: boxRect ? Math.round(boxRect.height) : null,
      optionRows: options.every((o) => o.getBoundingClientRect().width >= rowWidth - 2),
      keysAboveBox: !boxRect || keys.every((b) => b.getBoundingClientRect().bottom <= boxRect.top + 1),
    }
  })
}

export async function expectFamily(card: Locator, what: string): Promise<FamilyLook> {
  await expect(card.locator('.ask-card-answer').first(), what).toBeVisible({ timeout: 30_000 })
  const look = await familyLook(card)
  expect(look.blue, `${what}: at most one blue key`).toBeLessThanOrEqual(1)
  for (const h of look.heights) expect(Math.abs(h - 34), `${what}: a key is ${h} px, not 34`).toBeLessThanOrEqual(1)
  if (look.box !== null) expect(Math.abs(look.box - 34), `${what}: the box is ${look.box} px, not 34`).toBeLessThanOrEqual(1)
  expect(look.optionRows, `${what}: every option is a row of its own`).toBe(true)
  expect(look.keysAboveBox, `${what}: the keys come before the box`).toBe(true)
  return look
}
