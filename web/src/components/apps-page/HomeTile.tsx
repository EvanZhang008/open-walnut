/**
 * One item of the Apps home screen, in either view: a tile (icon view, like Launchpad) or a row
 * (list view). Both have the same two things: the item itself is the ONE main action (Open, or
 * Set up / Settings when there is nothing to open now), and one More menu holds the rest (Open,
 * Show on the sidebar, Pin, Details and settings, Remove). The menu opens from its ⋯ button (a
 * press, or Enter, Space or ArrowDown on it), from a right-click anywhere on the item, and on a
 * touch screen from a long press on a tile (as a phone's home screen; its ⋯ is not drawn there).
 *
 * Marks, each with one meaning (UI rules 16, 17): a small grey dot under the icon says it is on
 * the Sidebar, as the Dock marks a running app; a small red dot on the icon says it needs the
 * person (setup, a failure) on a tile, where a row says it in words instead; an App's own badge
 * sits there otherwise. The ⋯ of a tile is at its top left, clear of both. No switches on an item.
 */
import { useRef, useState, type ReactNode } from 'react'
import { useLeanCallback } from '@/hooks/useLeanCallback'
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu'
import { useMenuButton } from '@/components/settings/sections/useMenuButton'
import { PluginIcon } from '@/components/settings/PluginIcon'
import { AppBadge } from './app-bits'
import { EntryIcon } from './BuiltinAppsGrid'
import { PRIMARY_LABEL, needsAttention, primaryOf } from './apps-home-model'
import type { HomeEntry } from './home-items'

export interface HomeItemActions {
  /** The item's main action (Open, or its details page). */
  run: (entry: HomeEntry) => void
  /** Its menu's rows. */
  menuFor: (entry: HomeEntry) => ContextMenuItem[]
}

function MoreGlyph() {
  return (
    <svg viewBox="0 0 14 4" width="14" height="4" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="2" r="1.5" /><circle cx="7" cy="2" r="1.5" /><circle cx="12" cy="2" r="1.5" />
    </svg>
  )
}

function ItemIcon({ entry, tint, big }: { entry: HomeEntry; tint: string; big: boolean }) {
  const { item, row } = entry
  if (entry.entry) return <EntryIcon entry={entry.entry} size={big ? 72 : 40} />
  return <PluginIcon name={item.title} iconUrl={row?.iconUrl} tint={tint} size={big ? 'xl' : 'lg'} />
}

/** The icon with its marks: the red dot of attention, else an App's badge; the Sidebar dot under it. */
function MarkedIcon({ entry, tint, big }: { entry: HomeEntry; tint: string; big: boolean }) {
  const { item } = entry
  const app = entry.apps[0]
  return (
    <span className="apps-home-icon">
      <ItemIcon entry={entry} tint={tint} big={big} />
      {big && needsAttention(item)
        ? <span className="apps-home-alert" role="img" aria-label={item.status.text} title={item.status.text} data-testid={`apps-home-alert-${item.id}`} />
        : app ? <AppBadge app={app} /> : null}
      {item.onSidebar && <span className="apps-home-docked" role="img" aria-label="On the sidebar" title="On the sidebar" data-testid={`apps-home-docked-${item.id}`} />}
    </span>
  )
}

const LONG_PRESS_MS = 500
/** A finger that moves this far is scrolling, not pressing. */
const PRESS_SLOP_PX = 10

/** The menu of one item: its ⋯ button, a right-click and a long touch on the item open the same rows. */
function useItemMenu(entry: HomeEntry, actions: HomeItemActions) {
  const moreRef = useRef<HTMLButtonElement>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const button = useMenuButton(useLeanCallback(() => moreRef.current, []))
  const context = useContextMenu({ ignorePressSelection: true })
  const [pressedAt, setPressedAt] = useState<{ x: number; y: number } | null>(null)
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number; fired: boolean }>({ timer: null, x: 0, y: 0, fired: false })
  const cancelPress = () => { if (press.current.timer) { clearTimeout(press.current.timer); press.current.timer = null } }
  const touch = {
    onPointerDown: (e: React.PointerEvent) => {
      press.current.fired = false
      if (e.pointerType !== 'touch') return
      const point = { x: e.clientX, y: e.clientY }
      cancelPress()
      press.current = { ...press.current, ...point, timer: setTimeout(() => { press.current.fired = true; setPressedAt(point) }, LONG_PRESS_MS) }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (press.current.timer && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > PRESS_SLOP_PX) cancelPress()
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    /** The click a long press ends in is not the item's main action. */
    swallowClick: () => { cancelPress(); if (!press.current.fired) return false; press.current.fired = false; return true },
  }
  const name = entry.item.title
  const more = (
    <span ref={anchorRef} className="apps-home-more-anchor">
      <button
        ref={moreRef}
        type="button"
        className="btn btn-icon btn-sm apps-home-more"
        aria-label={`More for ${name}`}
        title="More"
        data-testid={`apps-home-more-${entry.item.id}`}
        {...button.buttonProps}
        onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.focus({ preventScroll: true }); button.buttonProps.onPointerDown(e) }}
      >
        <MoreGlyph />
      </button>
    </span>
  )
  const open = button.menu ?? context.state?.point ?? pressedAt
  const menu = open ? (
    <ContextMenu
      point={open}
      anchorRef={button.menu ? anchorRef : undefined}
      ariaLabel={`${name} actions`}
      testId="apps-home-menu"
      returnFocus={moreRef.current}
      highlightFirst={button.menu?.keys}
      onClose={(why) => { if (button.menu) button.close(why); else { context.close(); setPressedAt(null) } }}
      items={actions.menuFor(entry)}
    />
  ) : null
  const onContextMenu = (e: React.MouseEvent) => {
    if (button.menu) button.close()
    // A long press already opened the menu (some engines also send a contextmenu for it).
    if (press.current.fired || pressedAt) { e.preventDefault(); return }
    context.open(e, undefined)
  }
  return { more, menu, onContextMenu, touch }
}

export function HomeTile({ entry, tint, actions }: { entry: HomeEntry; tint: string; actions: HomeItemActions }) {
  const { item } = entry
  const { more, menu, onContextMenu, touch } = useItemMenu(entry, actions)
  const primary = primaryOf(item)
  return (
    <>
    <div
      className={`apps-home-tile${item.dim ? ' is-dim' : ''}`}
      data-testid={`apps-home-item-${item.id}`}
      data-kind={item.kind}
      data-primary={primary}
      data-on-sidebar={item.onSidebar}
      onContextMenu={onContextMenu}
    >
      {/* A launcher tile, not a key of the button family: the whole tile is what you press. */}
      <div
        role="button"
        tabIndex={0}
        className="apps-home-tile-main"
        onClick={() => { if (!touch.swallowClick()) actions.run(entry) }}
        onPointerDown={touch.onPointerDown}
        onPointerMove={touch.onPointerMove}
        onPointerUp={touch.onPointerUp}
        onPointerCancel={touch.onPointerCancel}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actions.run(entry) } }}
        aria-label={primary === 'open' ? `Open ${item.title}` : `${PRIMARY_LABEL[primary]}: ${item.title}`}
        title={item.line || item.title}
        data-testid={`apps-home-open-${item.id}`}
      >
        <MarkedIcon entry={entry} tint={tint} big />
        {/* A hyphenated name keeps its word together under a narrow tile ("To-Do", not "To-" / "Do"). */}
        <span className="apps-home-name wn-title">{item.title.replace(/-/g, '\u2011')}</span>
      </div>
      {more}
    </div>
    {/* Beside the item, not in it: a right-click on the menu's backdrop must not reach the item's own handler. */}
    {menu}
    </>
  )
}

export function HomeRow({ entry, tint, actions, status }: { entry: HomeEntry; tint: string; actions: HomeItemActions; status?: ReactNode }) {
  const { item } = entry
  const { more, menu, onContextMenu } = useItemMenu(entry, actions)
  const primary = primaryOf(item)
  return (
    <>
    <div
      className={`apps-home-row${item.dim ? ' is-dim' : ''}`}
      data-testid={`apps-home-item-${item.id}`}
      data-kind={item.kind}
      data-primary={primary}
      data-on-sidebar={item.onSidebar}
      onContextMenu={onContextMenu}
    >
      <MarkedIcon entry={entry} tint={tint} big={false} />
      <div className="apps-home-row-text">
        <span className="apps-home-row-name wn-title">{item.title}</span>
        {item.line && <span className="apps-home-row-line wn-title">{item.line}</span>}
      </div>
      {status}
      <button
        type="button"
        className="btn btn-sm apps-home-row-primary"
        onClick={() => actions.run(entry)}
        aria-label={`${PRIMARY_LABEL[primary]} ${item.title}`}
        data-testid={`apps-home-open-${item.id}`}
      >
        {PRIMARY_LABEL[primary]}
      </button>
      {more}
    </div>
    {/* Beside the item, not in it: a right-click on the menu's backdrop must not reach the item's own handler. */}
    {menu}
    </>
  )
}
