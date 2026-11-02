/**
 * The session header's folded labels (web/src/components/sessions/SessionHeaderLabels.tsx).
 *
 * The title row shows no pill beside the title: every label of the session's task (its
 * links and tags, the wait, Embedded, Cron, Trigger, Worker, Leader) sits in ONE control,
 * a tag icon plus a count. A click opens a flyout portalled to <body>; every panel keeps
 * its own flyout mounted (hidden while closed), so a spec reaches a panel's pills by
 * clicking THAT panel's button and reading the one visible flyout.
 *
 * The run status (Running, Idle) is not in the header at all any more. A panel still
 * says a turn runs the way the composer does: its primary button is Stop while a turn
 * streams and the composer is empty (`panelRunState`).
 */
import { expect, type Locator } from '@playwright/test'

export const HEADER_LABELS_BTN = '[data-testid="session-header-labels"]'
export const HEADER_LABELS_FLYOUT = '[data-testid="session-header-labels-flyout"]'

/** A panel's labels button (on its title row, or in a host's header). */
export function headerLabelsButton(panel: Locator): Locator {
  return panel.locator(HEADER_LABELS_BTN)
}

/** The one open labels flyout on the page. */
export function openLabelsFlyout(panel: Locator): Locator {
  return panel.page().locator(`${HEADER_LABELS_FLYOUT}:visible`)
}

/** Wait until the panel's labels name `text` (the button's title lists every label). */
export async function expectHeaderLabel(panel: Locator, text: string | RegExp, timeout = 20_000): Promise<void> {
  const re = typeof text === 'string' ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : text
  await expect(headerLabelsButton(panel)).toHaveAttribute('title', re, { timeout })
}

/** Open the panel's labels flyout (a no-op when it is open) and return it. */
export async function openHeaderLabels(panel: Locator, button: Locator = headerLabelsButton(panel)): Promise<Locator> {
  await expect(button).toBeVisible({ timeout: 20_000 })
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  const flyout = openLabelsFlyout(panel)
  await expect(flyout).toHaveCount(1)
  return flyout
}

/** Close the open labels flyout by clicking its button again (Escape would also reach
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

/** The title row carries no status badge and no pill: only the title, the labels button and the kebab. */
export async function expectBareTitleRow(panel: Locator): Promise<void> {
  const row = panel.locator('.session-panel-header-top')
  for (const sel of ['.session-panel-badge', '.tag-chip', '.task-trigger-pill', '.task-team-pill', '.session-cron-pill', '.task-waiting-chip']) {
    await expect(row.locator(sel), `${sel} beside the title`).toHaveCount(0)
  }
}
