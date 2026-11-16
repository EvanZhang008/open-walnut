/**
 * The reading split keeps its top line through every change of size (2026-11-15, the
 * user, of the split jumping between fullscreen and normal: take the first line as
 * the anchor, and let no zoom in or out move it).
 *
 * On a transcript of long, dense replies that rewrap at every width (test-server.ts
 * denseTranscript), with the reading pane above and the chat below both mid-reply:
 *  · the panel's fullscreen on and off, several rounds;
 *  · the window narrower and back;
 *  · the divider dragged;
 *  · side by side and back;
 * after each, in both panes, the character that started the top line before the change
 * is on the top line again, at the same height (a probe picked by caretRangeFromPoint,
 * independent of the app's own anchor). A sampler in every painted frame checks
 * that no frame in between showed the text moved. Then the chat at its end stays at
 * its end through the same fullscreen rounds, and a line near the end, which the wider
 * fullscreen rows cannot keep at the top (the box stops at its end), comes back when
 * fullscreen goes off. The divider is the grip band (design 1):
 * an 8px band with its grip, darker on hover, accent while dragging.
 * The rule: web/src/components/sessions/line-anchor.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { sessionPanel } from './threads-helpers'

const SESSION_ID = 'pw-dense-split-session'
const TASK_ID = 'pw-task-dense-split'
const LAST_REPLY = 'Dense reply 12'

type Pane = 'reader' | 'chat'
const SCOPE: Record<Pane, string> = { reader: '.session-reader-body', chat: '.session-panel-body' }

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.WALNUT_TASK_DIR ? `${process.env.WALNUT_TASK_DIR}/shots` : `/tmp/reader-anchor/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/anchor-${name}-${test.info().project.name}.png` })
}

async function openSession(page: Page): Promise<Locator> {
  const panel = sessionPanel(page, SESSION_ID)
  if (await panel.count() === 0) {
    const search = page.locator('.todo-search-input')
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(async () => {
      if (await search.inputValue() !== SESSION_ID) await search.fill(SESSION_ID)
      await expect(task).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 30_000 })
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.session-panel-body .session-history')).toContainText(LAST_REPLY, { timeout: 30_000 })
  return panel
}

/**
 * Pick, in each pane, the character at the start of its top visible line (the box's top,
 * or the panel header's bottom where the glass header floats over it), and keep it on
 * window.__probes. Returns each probe's line top below that edge and a few characters.
 */
async function pickProbes(page: Page): Promise<Record<Pane, { dy: number; text: string }>> {
  return page.evaluate((scopes) => {
    const w = window as unknown as { __probes: Record<string, { node: Text; offset: number }> }
    w.__probes = {}
    const out: Record<string, { dy: number; text: string }> = {}
    for (const [name, sel] of Object.entries(scopes)) {
      const el = document.querySelector<HTMLElement>(`${sel} .session-history`)!
      const box = el.getBoundingClientRect()
      const header = el.closest('.session-panel')?.querySelector<HTMLElement>(':scope > .session-panel-header')?.getBoundingClientRect()
      const edge = header && header.bottom > box.top && header.top < box.bottom ? header.bottom : box.top
      const top = (node: Text, i: number) => {
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        return range.getBoundingClientRect().top
      }
      let hit: { node: Text; offset: number } | null = null
      for (let y = edge + 4; y < edge + 80 && !hit; y += 6) {
        const r = (document as unknown as { caretRangeFromPoint: (x: number, y: number) => Range | null }).caretRangeFromPoint(box.left + box.width * 0.35, y)
        if (r && r.startContainer.nodeType === Node.TEXT_NODE && (r.startContainer as Text).data.trim()) hit = { node: r.startContainer as Text, offset: Math.min(r.startOffset, (r.startContainer as Text).data.length - 1) }
      }
      if (!hit) throw new Error(`no text at the top of ${name}`)
      // Back, in text order within its block, to the first character of that line: the
      // character that started the line the reader saw on top.
      const lineTop = top(hit.node, hit.offset)
      const block = hit.node.parentElement!.closest('p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote') ?? hit.node.parentElement!
      const texts: Text[] = []
      const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      for (let n = tw.nextNode(); n; n = tw.nextNode()) texts.push(n as Text)
      let ti = texts.indexOf(hit.node)
      let at = { node: hit.node, offset: hit.offset }
      for (;;) {
        const prev = at.offset > 0 ? { node: at.node, offset: at.offset - 1 } : (ti > 0 && texts[ti - 1].data.length ? { node: texts[ti - 1], offset: texts[ti - 1].data.length - 1 } : null)
        if (!prev || Math.abs(top(prev.node, prev.offset) - lineTop) >= 2) break
        if (prev.node !== at.node) ti--
        at = prev
      }
      hit = at
      w.__probes[name] = hit
      const range = document.createRange()
      range.setStart(hit.node, hit.offset)
      range.setEnd(hit.node, hit.offset + 1)
      out[name] = { dy: Math.round(range.getBoundingClientRect().top - edge), text: hit.node.data.slice(hit.offset, hit.offset + 12) }
    }
    return out
  }, SCOPE) as Promise<Record<Pane, { dy: number; text: string }>>
}

/** Each probe's line top below its pane's visible edge now (null: the probe is not drawn). */
async function probeTops(page: Page): Promise<Record<Pane, number | null>> {
  return page.evaluate((scopes) => {
    const w = window as unknown as { __probes: Record<string, { node: Text; offset: number }> }
    const out: Record<string, number | null> = {}
    for (const [name, sel] of Object.entries(scopes)) {
      const el = document.querySelector<HTMLElement>(`${sel} .session-history`)
      const p = w.__probes[name]
      if (!el || !p || !p.node.isConnected) { out[name] = null; continue }
      const box = el.getBoundingClientRect()
      const header = el.closest('.session-panel')?.querySelector<HTMLElement>(':scope > .session-panel-header')?.getBoundingClientRect()
      const edge = header && header.bottom > box.top && header.top < box.bottom ? header.bottom : box.top
      const range = document.createRange()
      range.setStart(p.node, p.offset)
      range.setEnd(p.node, p.offset + 1)
      out[name] = Math.round(range.getBoundingClientRect().top - edge)
    }
    return out
  }, SCOPE) as Promise<Record<Pane, number | null>>
}

/**
 * Sample the probes in every frame as it is painted: in a ResizeObserver callback (after
 * layout, after the app's own observers, before paint) on a probe box resized every frame.
 * A read from a task or a rAF would force a layout the frame never paints (a React commit
 * between frames, before the app's ResizeObserver put the line back).
 */
async function startSampler(page: Page): Promise<void> {
  await page.evaluate((scopes) => {
    const w = window as unknown as { __probes: Record<string, { node: Text; offset: number }>; __samples: Array<Record<string, number>>; __sampling: boolean; __sampleBox?: HTMLElement }
    w.__samples = []
    w.__sampling = true
    const tick = document.createElement('div')
    tick.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0'
    document.body.appendChild(tick)
    w.__sampleBox = tick
    let n = 0
    const ro = new ResizeObserver(() => {
      if (!w.__sampling) { ro.disconnect(); tick.remove(); return }
      const s: Record<string, number> = {}
      for (const [name, sel] of Object.entries(scopes)) {
        const el = document.querySelector<HTMLElement>(`${sel} .session-history`)
        const p = w.__probes[name]
        if (!el || !p?.node.isConnected) continue
        const box = el.getBoundingClientRect()
        const header = el.closest('.session-panel')?.querySelector<HTMLElement>(':scope > .session-panel-header')?.getBoundingClientRect()
        const edge = header && header.bottom > box.top && header.top < box.bottom ? header.bottom : box.top
        const range = document.createRange()
        range.setStart(p.node, p.offset)
        range.setEnd(p.node, p.offset + 1)
        s[name] = Math.round(range.getBoundingClientRect().top - edge)
      }
      w.__samples.push(s)
    })
    ro.observe(tick)
    const frame = () => { if (!w.__sampling) return; tick.style.width = `${1 + (++n % 2)}px`; requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
  }, SCOPE)
}

async function stopSampler(page: Page): Promise<Array<Record<string, number>>> {
  return page.evaluate(() => {
    const w = window as unknown as { __samples: Array<Record<string, number>>; __sampling: boolean }
    w.__sampling = false
    return w.__samples
  })
}

/**
 * A change of size keeps both panes' top lines: settled, and in every painted frame.
 * `before` is what the reader left on top (picked after his own scroll, not after the
 * last change: the first character of a line in one width is mid-line in another).
 */
async function expectHeld(page: Page, label: string, before: Record<Pane, { dy: number; text: string }>, change: () => Promise<void>): Promise<void> {
  await startSampler(page)
  await change()
  await page.waitForTimeout(700)
  const samples = await stopSampler(page)
  const after = await probeTops(page)
  for (const pane of ['reader', 'chat'] as const) {
    expect(after[pane], `${label}: the ${pane} pane's top line is still drawn ("${before[pane].text}")`).not.toBeNull()
    expect(Math.abs(after[pane]! - before[pane].dy), `${label}: the ${pane} pane's top line ("${before[pane].text}") stays at ${before[pane].dy}px, now ${after[pane]}px`).toBeLessThanOrEqual(3)
    const worst = samples.reduce((m, s) => (s[pane] === undefined ? m : Math.max(m, Math.abs(s[pane] - before[pane].dy))), 0)
    expect(worst, `${label}: no painted frame showed the ${pane} pane's top line moved`).toBeLessThanOrEqual(3)
  }
}

async function wheel(page: Page, panel: Locator, pane: Pane, dy: number): Promise<void> {
  const box = (await panel.locator(`${SCOPE[pane]} .session-history`).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(400)
}

const fromBottom = (panel: Locator, pane: Pane) => panel.locator(`${SCOPE[pane]} .session-history`).evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop))

test.describe('Reading split top-line anchor', () => {
  test.setTimeout(240_000)
  const flag = (on: boolean) => ({ data: { experimental: { chat_reading_split: on } } })
  test.afterEach(async ({ request }) => { await request.put('/api/config', flag(false)) })

  test('fullscreen, window, divider and turn keep both panes on their top line; the end stays the end', async ({ page, request }) => {
    await request.put('/api/config', flag(true))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
    const panel = await openSession(page)
    const fullscreen = async () => {
      const on = /open-walnut-fullscreen/.test(await panel.getAttribute('class') ?? '')
      await panel.getByRole('button', { name: on ? 'Collapse session' : 'Expand session to full screen' }).first().click()
      if (on) await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
      else await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    }

    // The split opens mid-history; both panes go mid-reply.
    // Up into the history with a real wheel (the load's bottom pin lets go on it), then
    // a reply's menu from the middle of the box: the pane opens on that reply.
    const chatBox = (await panel.locator('.session-panel-body .session-history').boundingBox())!
    await page.mouse.move(chatBox.x + chatBox.width / 2, chatBox.y + chatBox.height / 2)
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -700); await page.waitForTimeout(150) }
    await page.waitForTimeout(500)
    // A paragraph wholly on screen, its menu from its first word.
    const at = await panel.locator('.session-panel-body .session-history').evaluate((el) => {
      const box = el.getBoundingClientRect()
      for (const p of Array.from(el.querySelectorAll<HTMLElement>('[data-message-id] .session-msg-content p'))) {
        const r = p.getBoundingClientRect()
        if (r.top > box.top + box.height * 0.3 && r.bottom < box.bottom - 20) return { x: r.left + 12, y: r.top + 8 }
      }
      return null
    })
    expect(at, 'a paragraph is on screen').not.toBeNull()
    await page.mouse.click(at!.x, at!.y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Read in split' }).click()
    const reader = panel.getByTestId('session-reader-pane')
    await expect(reader).toBeVisible()
    await page.waitForTimeout(1200)
    await wheel(page, panel, 'reader', 260)
    // Far enough up that the wider fullscreen rows still fill the box below the line.
    for (let i = 0; i < 4; i++) await wheel(page, panel, 'chat', -800)
    expect(await fromBottom(panel, 'chat'), 'the chat is mid-history').toBeGreaterThan(2000)

    // The grip band: 8px, its grip drawn; darker on hover, accent while dragging.
    const divider = panel.getByTestId('session-reader-divider')
    const band = await divider.evaluate((el) => {
      const cs = getComputedStyle(el)
      const grip = getComputedStyle(el, '::after')
      return { h: Math.round(el.getBoundingClientRect().height), bg: cs.backgroundColor, gripW: grip.width, gripH: grip.height, grip: grip.backgroundColor }
    })
    expect(band.h, 'the band is 8px').toBe(8)
    expect([band.gripW, band.gripH], 'the grip bar is drawn').toEqual(['36px', '4px'])
    const box0 = (await divider.boundingBox())!
    await page.mouse.move(box0.x + box0.width / 2, box0.y + 4)
    await expect.poll(() => divider.evaluate((el) => getComputedStyle(el).backgroundColor), { message: 'hover darkens the band' }).not.toBe(band.bg)
    await shot(page, '0-divider-hover')

    // What the reader left on top of each pane: it stays there through every change below.
    const base = await pickProbes(page)
    // 1. Fullscreen on and off, four rounds.
    for (let i = 0; i < 4; i++) {
      await expectHeld(page, `fullscreen round ${i + 1}`, base, fullscreen)
      if (i === 0) await shot(page, '1-fullscreen-on')
    }
    // 2. The window narrower and back.
    await expectHeld(page, 'window narrower', base, () => page.setViewportSize({ width: 1100, height: 860 }))
    await expectHeld(page, 'window back', base, () => page.setViewportSize({ width: 1440, height: 900 }))
    // 3. The divider dragged down 120px (the grip turns accent meanwhile).
    await expectHeld(page, 'divider drag', base, async () => {
      const d = (await divider.boundingBox())!
      await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2)
      await page.mouse.down()
      await page.mouse.move(d.x + d.width / 2, d.y + 60, { steps: 4 })
      const dragging = await divider.evaluate((el) => getComputedStyle(el, '::after').backgroundColor)
      expect(dragging, 'the grip changes colour while dragging').not.toBe(band.grip)
      await shot(page, '2-divider-dragging')
      await page.mouse.move(d.x + d.width / 2, d.y + 120, { steps: 4 })
      await page.mouse.up()
    })
    // 4. Side by side and back (the panel is fullscreen-wide now or not: make it wide).
    if (!/open-walnut-fullscreen/.test(await panel.getAttribute('class') ?? '')) await fullscreen()
    await expectHeld(page, 'side by side', base, async () => {
      await panel.getByTestId('session-reader-orient').click()
      await expect(reader).toHaveClass(/is-side/)
    })
    await shot(page, '3-side-by-side')
    await expectHeld(page, 'stacked again', base, async () => {
      await panel.getByTestId('session-reader-orient').click()
      await expect(reader).toHaveClass(/is-stack/)
    })

    // 5. Near the end: in fullscreen the wider rows below the line are shorter than the
    // box, so the box stops at its end; fullscreen off again puts the same line back.
    await fullscreen() // off
    await panel.locator('.session-panel-body .session-history').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await wheel(page, panel, 'chat', 400)
    await wheel(page, panel, 'chat', -450)
    const near = await pickProbes(page)
    await fullscreen() // on: clamped at the end
    await page.waitForTimeout(700)
    await fullscreen() // off: the line comes back
    await page.waitForTimeout(700)
    const back = await probeTops(page)
    for (const pane of ['reader', 'chat'] as const) {
      expect(Math.abs(back[pane]! - near[pane].dy), `near the end, fullscreen on and off: the ${pane} pane's top line ("${near[pane].text}") is back at ${near[pane].dy}px, now ${back[pane]}px`).toBeLessThanOrEqual(3)
    }

    // 6. The chat at its end stays at its end through fullscreen rounds; the reader holds its line.
    await panel.locator('.session-panel-body .session-history').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await wheel(page, panel, 'chat', 400)
    expect(await fromBottom(panel, 'chat')).toBeLessThanOrEqual(4)
    const before = await pickProbes(page)
    for (let i = 0; i < 3; i++) {
      await fullscreen()
      await page.waitForTimeout(700)
      expect(await fromBottom(panel, 'chat'), `fullscreen round ${i + 1}: the chat stays at its end`).toBeLessThanOrEqual(4)
      const after = await probeTops(page)
      expect(Math.abs(after.reader! - before.reader.dy), `fullscreen round ${i + 1}: the reading pane holds its line`).toBeLessThanOrEqual(3)
    }
    await panel.getByTestId('session-reader-close').click()
  })
})
