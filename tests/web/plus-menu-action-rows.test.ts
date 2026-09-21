/**
 * PlusMenuActionRows: the generic action rows ChatInput draws for its caller.
 *
 * SSR through renderToStaticMarkup (same pattern as setup-banner.test.ts): the
 * component has no hooks, so the markup contract (roles, ids, separator count,
 * disabled state, default icon) is pinned without a browser.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { PlusMenuActionRows } from '../../web/src/components/chat/PlusMenuActionRows'
import type { PlusMenuAction } from '../../web/src/components/chat/plus-menu-actions'

const noop = () => {}

const render = (actions: PlusMenuAction[]) => renderToStaticMarkup(
  createElement(PlusMenuActionRows, { actions, onSelect: noop }),
)

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length

describe('PlusMenuActionRows markup contract', () => {
  it('renders one separator then one menuitem per action, in order', () => {
    const html = render([
      { id: 'alpha', label: 'Alpha row', onSelect: noop },
      { id: 'beta', label: 'Beta row', onSelect: noop },
    ])
    expect(count(html, /role="separator"/g)).toBe(1)
    expect(html).toMatch(/^<div class="chat-plus-menu-divider" role="separator"><\/div><button/)
    expect(count(html, /<button[^>]*role="menuitem"/g)).toBe(2)
    const alpha = html.indexOf('data-action-id="alpha"')
    const beta = html.indexOf('data-action-id="beta"')
    expect(alpha).toBeGreaterThan(-1)
    expect(beta).toBeGreaterThan(alpha)
    expect(html).toContain('<span>Alpha row</span>')
    expect(html).toContain('<span>Beta row</span>')
    // Every row is a plain menu item with the shared row class and type=button.
    expect(count(html, /class="chat-plus-menu-item"/g)).toBe(2)
    expect(count(html, /type="button"/g)).toBe(2)
  })

  it('renders nothing for an empty list: no stray separator', () => {
    expect(render([])).toBe('')
  })

  it('marks a disabled action with aria-disabled and is-disabled, and still renders it', () => {
    const html = render([
      { id: 'on', label: 'Enabled', onSelect: noop },
      { id: 'off', label: 'Off for now', disabled: true, title: 'Checking what this engine supports', onSelect: noop },
    ])
    expect(count(html, /<button[^>]*role="menuitem"/g)).toBe(2)
    // Opening tags only (`<button...>`), one per row.
    const tags = html.match(/<button[^>]*>/g) ?? []
    expect(tags).toHaveLength(2)
    const offBtn = tags.find(t => t.includes('data-action-id="off"'))!
    const onBtn = tags.find(t => t.includes('data-action-id="on"'))!
    expect(offBtn).toContain('aria-disabled="true"')
    expect(offBtn).toContain('class="chat-plus-menu-item is-disabled"')
    expect(offBtn).toContain('title="Checking what this engine supports"')
    // Never the native `disabled` attribute: the row must stay hoverable for its title.
    expect(offBtn).not.toMatch(/\sdisabled(=|>|\s)/)
    // The enabled row carries neither marker.
    expect(onBtn).not.toContain('aria-disabled')
    expect(onBtn).not.toContain('is-disabled')
  })

  it('passes the title through verbatim and omits it when absent', () => {
    const html = render([
      { id: 'with', label: 'With title', title: 'Row tooltip text', onSelect: noop },
      { id: 'without', label: 'No title', onSelect: noop },
    ])
    expect(html).toContain('title="Row tooltip text"')
    expect(count(html, /title="/g)).toBe(1)
  })

  it('draws the default 16px gear when no icon is given, and the caller icon when it is', () => {
    const plain = render([{ id: 'a', label: 'A', onSelect: noop }])
    expect(plain).toMatch(/<svg width="16" height="16"[^>]*stroke="currentColor"[^>]*data-icon="gear"/)
    expect(plain).toContain('aria-hidden="true"')

    const custom = render([{
      id: 'b', label: 'B', onSelect: noop,
      icon: createElement('svg', { width: 16, height: 16, 'data-icon': 'custom' }),
    }])
    expect(custom).toContain('data-icon="custom"')
    expect(custom).not.toContain('data-icon="gear"')
  })
})
