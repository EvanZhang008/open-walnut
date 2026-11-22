/**
 * A control under a master switch never looks on while the master is off (standard.md, "Choice
 * controls", ControlGroup). The master names its group with aria-controls; this walks every Settings
 * pane, finds each master, and checks, with the master off (flipped off for the check when the
 * fixture has it on; the write is answered locally so the fixture never changes):
 *   - the group it names is a disabled fieldset, and every control in it is disabled;
 *   - no switch, box or chip in it is drawn in the accent colour;
 *   - the group says why in a line of words.
 *
 * 2026-11-21 Settings review on the user's data: the Inbox Triage switch was off while its rule
 * switches stayed bright blue; a Sessions switch was off with live-looking boxes under it.
 */
import { devices, test, expect, type Page } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })
test.setTimeout(180_000)

async function answerWritesLocally(page: Page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    if (req.method() === 'GET') return route.fallback()
    return route.fulfill({ status: 200, json: { ok: true } })
  })
}

interface Finding { pane: string; master: string; problem: string }

/** Problems of every master on the page that is off now. */
async function offMasterProblems(page: Page): Promise<Array<{ master: string; problem: string }>> {
  return page.evaluate(() => {
    const out: Array<{ master: string; problem: string }> = []
    const accent = (() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--accent)'
      document.body.appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    })()
    for (const m of document.querySelectorAll<HTMLElement>('[role="switch"][aria-controls]')) {
      if (m.getAttribute('aria-checked') !== 'false') continue
      const name = m.getAttribute('aria-label') || m.id || m.getAttribute('aria-controls') || '?'
      // A master may name several groups (its controls sit in several boxes): each is checked, and
      // one of them says why.
      const groups = (m.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)).filter((g): g is HTMLElement => !!g)
      if (!groups.length) continue // no group is drawn while off: nothing can look on
      let reason = false
      for (const group of groups) {
        if (!(group instanceof HTMLFieldSetElement) || !group.disabled) { out.push({ master: name, problem: `group #${group.id} is not a disabled fieldset` }); continue }
        if (group.querySelector('.wn-group-reason')?.textContent?.trim()) reason = true
        for (const c of group.querySelectorAll<HTMLElement>('input, button, select, textarea')) {
          if (!(c as HTMLInputElement).matches(':disabled')) out.push({ master: name, problem: `control not disabled: ${c.outerHTML.slice(0, 80)}` })
        }
        for (const c of group.querySelectorAll<HTMLElement>('[role="switch"][aria-checked="true"], input:checked, [aria-pressed="true"]')) {
          const bg = getComputedStyle(c).backgroundColor
          if (bg === accent) out.push({ master: name, problem: `drawn on in the accent colour: ${c.outerHTML.slice(0, 80)}` })
        }
      }
      if (!reason) out.push({ master: name, problem: 'no line says why the group is off' })
    }
    return out
  })
}

test('every master switch that is off leaves its controls disabled and grey', async ({ page }) => {
  await answerWritesLocally(page)
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  const ids = await page.$$eval('button.settings-nav-item[data-testid^="settings-nav-"]', (els) =>
    els.map((e) => (e.getAttribute('data-testid') ?? '').replace('settings-nav-', '')).filter(Boolean))
  expect(ids.length).toBeGreaterThan(15)
  const findings: Finding[] = []
  let masters = 0
  for (const id of ids) {
    const item = page.getByTestId(`settings-nav-${id}`)
    await item.scrollIntoViewIfNeeded()
    await item.click()
    await expect(item).toHaveAttribute('aria-current', 'page')
    await page.waitForTimeout(600)
    const here = page.locator('.settings-pane [role="switch"][aria-controls]')
    const n = await here.count()
    masters += n
    for (let i = 0; i < n; i++) {
      const m = here.nth(i)
      if ((await m.getAttribute('aria-checked')) === 'true' && await m.isEnabled()) {
        await m.click()
        await expect(m).toHaveAttribute('aria-checked', 'false', { timeout: 5_000 }).catch(() => {})
      }
    }
    for (const p of await offMasterProblems(page)) findings.push({ pane: id, ...p })
  }
  expect(masters, 'no master switch names its controls with aria-controls: the check found nothing to check').toBeGreaterThanOrEqual(3)
  expect(findings, findings.map((f) => `${f.pane}: ${f.master}: ${f.problem}`).join('\n')).toEqual([])
})
