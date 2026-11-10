/**
 * Settings, Agents: which look the agent's cursor has in a page (cursor-looks.ts), with a small
 * live picture of it. Stored as `settings.cursorStyle`; open pages follow at once (page-cursor.ts).
 */
import { h } from './dom'
import { CURSOR_STYLES, CURSOR_STYLE_LABELS, cursorCss, cursorParts, isCursorStyle, type CursorStyle } from './cursor-looks'
import { setSettings } from './settings'

/** The picture: the cursor alone (no tag), its tip near the top left, a little smaller, its click played when `click`. */
function drawPreview(el: HTMLElement, style: CursorStyle, click: boolean): void {
  const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' })
  const css = document.createElement('style')
  css.textContent = `${cursorCss(style)}\n.c{position:absolute}.c .tag{display:none}`
  const { box } = cursorParts(document, style)
  // A little smaller than in a page, so the whole look fits the picture.
  box.style.transform = 'translate(6px, 5px) scale(0.84)'
  root.replaceChildren(css, box)
  if (click) requestAnimationFrame(() => box.classList.add('on'))
}

export function cursorPickRow(current: CursorStyle): { row: HTMLElement; sync: (s: CursorStyle) => void } {
  const select = h('select', { class: 'select', id: 'cursor-style', 'aria-label': 'Agent cursor', 'data-testid': 'popup-cursor-style' },
    ...CURSOR_STYLES.map((s) => h('option', { value: s }, CURSOR_STYLE_LABELS[s]))) as HTMLSelectElement
  select.value = current
  const preview = h('span', { class: 'cursor-preview', 'aria-hidden': 'true', 'data-testid': 'popup-cursor-preview' })
  drawPreview(preview, current, false)
  select.onchange = () => {
    if (!isCursorStyle(select.value)) return
    drawPreview(preview, select.value, true)
    void setSettings({ cursorStyle: select.value })
  }
  const row = h('div', { class: 'setting setting-stack', 'data-testid': 'popup-cursor-row' },
    preview, h('label', { class: 'row-title', for: 'cursor-style' }, 'Agent cursor'), select,
    h('span', { class: 'row-sub' }, "How an agent's pointer looks in the tabs it uses. Your own mouse never moves."))
  return {
    row,
    sync: (s) => {
      if (document.activeElement === select || select.value === s) return
      select.value = s
      drawPreview(preview, s, false)
    },
  }
}
