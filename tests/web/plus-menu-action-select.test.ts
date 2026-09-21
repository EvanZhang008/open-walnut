/**
 * A click on a caller-defined "+" menu row calls THAT action's onSelect, and
 * the anchor handed over is the "+" button element. Two layers, both without a
 * DOM: PlusMenuActionRows is hook-free, so its element tree is walked for the
 * button props and the onClick is invoked directly; the close-then-select glue
 * ChatInput runs is the pure `selectPlusMenuAction`, fed a stand-in anchor.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from '../../web/node_modules/react/index.js'
import { PlusMenuActionRows } from '../../web/src/components/chat/PlusMenuActionRows'
import { selectPlusMenuAction, type PlusMenuAction } from '../../web/src/components/chat/plus-menu-actions'

type Props = { role?: string; 'data-action-id'?: string; onClick?: () => void; children?: unknown }

/** Every element with role=menuitem in a hook-free element tree. */
function menuItems(node: unknown, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => menuItems(n, out)); return out }
  const el = node as ReactElement<Props>
  if (el.props?.role === 'menuitem') out.push(el)
  const kids = el.props?.children
  if (kids) menuItems(kids, out)
  return out
}

describe('PlusMenuActionRows click wiring', () => {
  it('two actions render two rows; clicking a row calls onSelect with THAT action', () => {
    const onSelect = vi.fn()
    const alpha: PlusMenuAction = { id: 'alpha', label: 'Alpha', onSelect: vi.fn() }
    const beta: PlusMenuAction = { id: 'beta', label: 'Beta', onSelect: vi.fn() }
    const tree = PlusMenuActionRows({ actions: [alpha, beta], onSelect })
    const rows = menuItems(tree)
    expect(rows.map((r) => r.props['data-action-id'])).toEqual(['alpha', 'beta'])
    rows[1].props.onClick!()
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(beta)
    rows[0].props.onClick!()
    expect(onSelect).toHaveBeenLastCalledWith(alpha)
  })

  it('a disabled row has no click handler at all', () => {
    const tree = PlusMenuActionRows({ actions: [{ id: 'off', label: 'Off', disabled: true, onSelect: vi.fn() }], onSelect: vi.fn() })
    expect(menuItems(tree)[0].props.onClick).toBeUndefined()
  })
})

describe('selectPlusMenuAction (ChatInput glue)', () => {
  it('closes the menu FIRST, then hands the "+" button to the action as its anchor', () => {
    const order: string[] = []
    const anchor = { tagName: 'BUTTON', className: 'chat-plus-btn' } as unknown as HTMLElement
    const action: PlusMenuAction = { id: 'a', label: 'A', onSelect: vi.fn((ctx) => order.push(`select:${ctx.anchor === anchor}`)) }
    selectPlusMenuAction(action, anchor, () => order.push('close'))
    expect(order).toEqual(['close', 'select:true'])
    expect(action.onSelect).toHaveBeenCalledWith({ anchor, composer: null })
  })

  it('passes the composer box along when ChatInput knows it', () => {
    const anchor = { tagName: 'BUTTON' } as unknown as HTMLElement
    const composer = { className: 'chat-input-box' } as unknown as HTMLElement
    const action: PlusMenuAction = { id: 'a', label: 'A', onSelect: vi.fn() }
    selectPlusMenuAction(action, anchor, () => {}, composer)
    expect(action.onSelect).toHaveBeenCalledWith({ anchor, composer })
  })

  it('no anchor (the "+" button is gone): the menu still closes, the action is not called', () => {
    const close = vi.fn()
    const action: PlusMenuAction = { id: 'a', label: 'A', onSelect: vi.fn() }
    selectPlusMenuAction(action, null, close)
    expect(close).toHaveBeenCalledTimes(1)
    expect(action.onSelect).not.toHaveBeenCalled()
  })
})
