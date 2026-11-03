/**
 * The session header's title row (web/src/components/sessions/SessionPanel.tsx).
 *
 * Beside the title: the state pills (the wait, Embedded, Cron, Trigger, Worker, Leader),
 * the link tags folded into ONE control (SessionHeaderLabels.tsx, a tag icon plus a
 * count, there only when the task has a tag), and the kebab. The tags control opens a
 * flyout portalled to <body>; every panel keeps its own flyout mounted (hidden while
 * closed), so a spec reaches a panel's tags by clicking THAT panel's button and reading
 * the one visible flyout. An Org node draws the same parts in its own header
 * (`org-detail-chat-tools`).
 *
 * The run status (Running, Idle) is not in the header at all. A panel still says a turn
 * runs the way the composer does: its primary button is Stop while a turn streams and the
 * composer is empty (`panelRunState`).
 */
import { expect, type Locator } from '@playwright/test'

export const HEADER_LABELS_BTN = '[data-testid="session-header-labels"]'
export const HEADER_LABELS_FLYOUT = '[data-testid="session-header-labels-flyout"]'

/** A panel's tags button (on its title row, or in a host's header). */
export function headerLabelsButton(panel: Locator): Locator {
  return panel.locator(HEADER_LABELS_BTN).or(panel.page().locator(`[data-testid="org-detail-chat-tools"] ${HEADER_LABELS_BTN}`))
}

/** The one open tags flyout on the page. */
export function openLabelsFlyout(panel: Locator): Locator {
  return panel.page().locator(`${HEADER_LABELS_FLYOUT}:visible`)
}

/** The panel's header parts: its state pills on the row, and the open tags flyout. */
export function headerParts(panel: Locator): Locator {
  return panel.locator('.session-panel-title-meta')
    .or(panel.page().locator('[data-testid="org-detail-chat-tools"]'))
    .or(openLabelsFlyout(panel))
}

/** A state pill beside the panel's title (the wait chip, Cron, Trigger, Worker, Leader,
 *  Embedded), on its title row or in a host's header. Its text content is the whole label
 *  even on a tight row, where CSS draws one letter in its place. */
export function headerPill(panel: Locator, selector: string): Locator {
  return panel.locator(`.session-panel-title-meta ${selector}`)
    .or(panel.page().locator(`[data-testid="org-detail-chat-tools"] ${selector}`))
}

/** Wait until the panel's header names `text`: a pill on the row, or a tag (the tags
 *  button's title lists every tag). */
export async function expectHeaderLabel(panel: Locator, text: string | RegExp, timeout = 20_000): Promise<void> {
  const re = typeof text === 'string' ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : text
  const read = async () => {
    const row = await panel.locator('.session-panel-title-meta').allInnerTexts().catch(() => [] as string[])
    const btn = headerLabelsButton(panel)
    const title = (await btn.count()) ? (await btn.first().getAttribute('title')) ?? '' : ''
    return `${row.join(' ')} ${title}`
  }
  await expect.poll(read, { timeout }).toMatch(re)
}

/** Open the panel's tags flyout when it has tags (a no-op when open or absent) and return
 *  what holds the header's labels: the row's pills and that flyout. */
export async function openHeaderLabels(panel: Locator, button: Locator = headerLabelsButton(panel)): Promise<Locator> {
  if ((await button.count()) > 0) {
    await expect(button).toBeVisible({ timeout: 20_000 })
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(openLabelsFlyout(panel)).toHaveCount(1)
  }
  return headerParts(panel)
}

/** Close the open tags flyout by clicking its button again (Escape would also reach
 *  whatever else listens for it, a full screen panel say). */
export async function closeHeaderLabels(panel: Locator, button: Locator = headerLabelsButton(panel)): Promise<void> {
  if ((await button.count()) === 0 || (await button.getAttribute('aria-expanded')) !== 'true') return
  await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await expect(openLabelsFlyout(panel)).toHaveCount(0)
}

/** The panel's Stop button: on screen exactly while a turn streams (and the composer is empty). */
export function panelStopButton(panel: Locator): Locator {
  return panel.getByRole('button', { name: 'Stop the running turn', exact: true })
}

/** The run state a panel shows now that the header has no status badge. */
export async function expectPanelRunning(panel: Locator, running: boolean, timeout = 20_000): Promise<void> {
  if (running) await expect(panelStopButton(panel)).toBeVisible({ timeout })
  else await expect(panelStopButton(panel)).toHaveCount(0, { timeout })
}

/** The title row carries no run status and no loose tag: tags live in the tags control. */
export async function expectBareTitleRow(panel: Locator): Promise<void> {
  const row = panel.locator('.session-panel-header-top')
  await expect(row.locator('.tag-chip'), 'a tag beside the title').toHaveCount(0)
  expect(await row.innerText()).not.toMatch(/\b(Running|Idle|Stopped)\b/)
}
