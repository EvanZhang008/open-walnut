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

export interface FamilyLook { keys: number; blue: number; heights: number[]; box: number | null; optionRows: boolean; keysAboveBox: boolean; narrow: boolean; boxOwnLine: boolean; toolsUnderBox: boolean | null }

/** Measures the card's answer row; the parts a prompt's own card or the composer draw are not its keys. */
export async function familyLook(card: Locator): Promise<FamilyLook> {
  return card.evaluate((el) => {
    const row = el.querySelector('.ask-card-answer')
    if (!row) return { keys: 0, blue: 0, heights: [], box: null, optionRows: true, keysAboveBox: true, narrow: false, boxOwnLine: true, toolsUnderBox: null }
    // The main action's blue: the button family's primary fill, set on .btn (styles/buttons.css), or
    // the accent where that is not set (an approval's key outside the family).
    const blues = new Set(['var(--btn-primary-fill, var(--accent))', 'var(--accent)'].map((color) => {
      const probe = document.createElement('span')
      probe.className = 'btn'
      probe.style.cssText = `position:absolute;visibility:hidden;color:${color}`
      row.appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    }))
    const own = (b: Element) => !b.closest('.org-answer-words, .kanban-prompt, .permission-request-card, .ask-card-tools')
    const keys = [...row.querySelectorAll('button, .org-answer-check')].filter(own).filter((b) => (b as HTMLElement).offsetParent !== null)
    const box = row.querySelector('.org-answer-words .chat-input-box')
    const boxRect = box?.getBoundingClientRect()
    const rowWidth = row.getBoundingClientRect().width
    const card = (el.closest('.ask-card') ?? el) as HTMLElement
    const pad = getComputedStyle(card)
    const inner = card.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
    const words = row.querySelector('.org-answer-words')?.getBoundingClientRect()
    const tools = row.querySelector('.ask-card-tools')?.getBoundingClientRect()
    const options = [...row.querySelectorAll('.org-answer-options .btn, .org-answer-check')].filter(own)
    return {
      keys: keys.length,
      blue: keys.filter((b) => blues.has(getComputedStyle(b).backgroundColor)).length,
      heights: keys.map((b) => Math.round(b.getBoundingClientRect().height)),
      box: boxRect ? Math.round(boxRect.height) : null,
      optionRows: options.every((o) => o.getBoundingClientRect().width >= rowWidth - 2),
      keysAboveBox: !boxRect || keys.every((b) => b.getBoundingClientRect().bottom <= boxRect.top + 1),
      narrow: inner <= 460,
      boxOwnLine: !words || words.width >= rowWidth - 2,
      toolsUnderBox: words && tools && tools.width > 0 ? tools.top >= words.bottom - 1 : null,
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
  // A narrow card (content under 460 px, the container query's width) gives the box its own line and puts Snooze under it.
  if (look.narrow) {
    expect(look.boxOwnLine, `${what}: a narrow card's box takes a line of its own`).toBe(true)
    if (look.toolsUnderBox !== null) expect(look.toolsUnderBox, `${what}: a narrow card's Snooze sits under its box`).toBe(true)
  }
  return look
}
