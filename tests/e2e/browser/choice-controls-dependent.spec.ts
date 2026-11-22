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
async function offMasterProblems(page: Page): Promise<{ checked: number; problems: Array<{ master: string; problem: string }> }> {
  return page.evaluate(async () => {
    // Read what the user sees once the controls settle: a master just turned off starts the
    // grey fade of its group's controls (a 120 to 140 ms transition) on the next frame.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    // Transitions only: a spinner's endless animation never finishes.
    const fades = document.getAnimations().filter((a) => typeof CSSTransition !== 'undefined' && a instanceof CSSTransition)
    await Promise.all(fades.map((a) => a.finished.catch(() => undefined)))
    const out: Array<{ master: string; problem: string }> = []
    let checked = 0
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
      checked++
      let reason = false
      for (const group of groups) {
        if (!(group instanceof HTMLFieldSetElement) || !group.disabled) { out.push({ master: name, problem: `group #${group.id} is not a disabled fieldset` }); continue }
        if (group.querySelector('.wn-group-reason')?.textContent?.trim()) reason = true
        for (const c of group.querySelectorAll<HTMLElement>('input, button, select, textarea')) {
          if (!(c as HTMLInputElement).matches(':disabled')) out.push({ master: name, problem: `control not disabled: ${c.outerHTML.slice(0, 80)}` })
        }
        // Every kind's on state: a switch, a box or radio, a chip, a segment, a tab. None may carry the
        // accent in its fill, its text, its edge or its underline.
        const on = '[aria-checked="true"], [aria-selected="true"], [aria-pressed="true"], input:checked, input:indeterminate'
        for (const c of group.querySelectorAll<HTMLElement>(on)) {
          const st = getComputedStyle(c)
          const paints = [st.backgroundColor, st.color, st.borderTopColor, st.borderBottomColor, st.borderLeftColor]
          if (paints.includes(accent)) out.push({ master: name, problem: `drawn on in the accent colour: ${c.outerHTML.slice(0, 80)}` })
        }
      }
      if (!reason) out.push({ master: name, problem: 'no line says why the group is off' })
    }
    return { checked, problems: out }
  })
}

/** Every ControlGroup on the page keeps its rows laid out when the content around it changes:
 *  a box of its own (never display: contents), and each row has a height. 2026-11-22: in Chromium a
 *  display: contents fieldset lost its rows' boxes after a group was inserted above it (Calendar
 *  Accounts' Mail accounts read 0 px tall). The insert below is that change, made by hand. */
async function groupLayoutProblems(page: Page): Promise<{ groups: number; problems: Array<{ master: string; problem: string }> }> {
  return page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const out: Array<{ master: string; problem: string }> = []
    const groups = [...document.querySelectorAll<HTMLFieldSetElement>('.settings-pane fieldset.wn-group')]
    const marks: HTMLElement[] = []
    for (const g of groups) {
      const block = (g.closest('.settings-group-block, .settings-group') ?? g) as HTMLElement
      const mark = document.createElement('div')
      mark.style.height = '24px'
      block.parentElement?.insertBefore(mark, block)
      marks.push(mark)
    }
    await frame()
    for (const g of groups) {
      if (getComputedStyle(g).display === 'contents') out.push({ master: g.id, problem: 'the group fieldset is display: contents' })
      const rows = [...g.querySelectorAll<HTMLElement>('.settings-row, .wn-check-row')]
        .filter((r) => getComputedStyle(r).display !== 'none' && !r.closest('[hidden]'))
      for (const r of rows) {
        const h = r.getBoundingClientRect().height
        if (!r.getClientRects().length || h < 1) out.push({ master: g.id, problem: `a row has no height after content changed: ${r.outerHTML.slice(0, 80)}` })
      }
    }
    for (const m of marks) m.remove()
    return { groups: groups.length, problems: out }
  })
}

test('every master switch that is off leaves its controls disabled and grey', async ({ page }) => {
  await answerWritesLocally(page)
  await page.goto('/')
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  const ids = await page.$$eval('button.settings-nav-item[data-testid^="settings-nav-"]', (els) =>
    els.map((e) => (e.getAttribute('data-testid') ?? '').replace('settings-nav-', '')).filter(Boolean))
  expect(ids.length).toBeGreaterThan(15)
  const findings: Finding[] = []
  let checked = 0
  let laidOut = 0
  for (const id of ids) {
    const item = page.getByTestId(`settings-nav-${id}`)
    // A pane can leave the list once a master above turned off (Permissions goes when nothing
    // asks for one): it has no controls left to check.
    if (!(await item.count())) continue
    await item.scrollIntoViewIfNeeded()
    await item.click()
    await expect(item).toHaveAttribute('aria-current', 'page')
    await page.waitForTimeout(600)
    const here = page.locator('.settings-pane [role="switch"][aria-controls]')
    const n = await here.count()
    for (let i = 0; i < n; i++) {
      const m = here.nth(i)
      if ((await m.getAttribute('aria-checked')) === 'true' && await m.isEnabled()) {
        await m.click()
        // A master that does not turn off is a finding, never skipped.
        const off = await expect(m).toHaveAttribute('aria-checked', 'false', { timeout: 5_000 }).then(() => true, () => false)
        if (!off) findings.push({ pane: id, master: (await m.getAttribute('aria-label')) ?? (await m.getAttribute('id')) ?? '?', problem: 'clicked, but it did not turn off' })
      }
    }
    const res = await offMasterProblems(page)
    checked += res.checked
    for (const p of res.problems) findings.push({ pane: id, ...p })
    const lay = await groupLayoutProblems(page)
    laidOut += lay.groups
    for (const p of lay.problems) findings.push({ pane: id, ...p })
  }
  // Counts only masters that were really read off with their groups on screen.
  expect(checked, 'fewer than 3 masters were checked off with their groups: the check proves too little').toBeGreaterThanOrEqual(3)
  expect(laidOut, 'no ControlGroup was found to check its layout').toBeGreaterThanOrEqual(3)
  expect(findings, findings.map((f) => `${f.pane}: ${f.master}: ${f.problem}`).join('\n')).toEqual([])
})
