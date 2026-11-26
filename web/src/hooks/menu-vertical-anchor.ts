/**
 * Which element gives an open menu its anchor's top and bottom (useMenuPlacement; left and right
 * always come from the trigger).
 *
 * - A caller that names its own vertical anchor (`verticalAnchorRef`) owns the choice: its
 *   element when it has one, else the trigger. The engine settings popover names the composer
 *   box only while that box is a line or two of draft, so a tall draft never squeezes its rows
 *   (engine-settings-popover-r2.spec "tall draft"). 2026-11-22 the composer default below took an
 *   empty ref as "not given" and lifted that popover over a tall draft again.
 * - On the phone (`bounds: 'visual'`) a menu from inside a composer clears the whole composer
 *   (spec 4.4), when its caller named none or named an empty one.
 * - On the desktop a menu opening upward from inside a composer clears the whole composer
 *   (2026-11-22 audit: the permission-mode and send menus covered the draft's first line), except
 *   a submenu, whose trigger sits in another menu and which opens beside its row.
 */

/** The part of an element this choice reads (an HTMLElement in the app, a stub in tests). */
export interface AnchorCandidate {
  closest(selector: string): AnchorCandidate | null
}

export interface VerticalAnchorInput<E extends AnchorCandidate> {
  /** The caller's own `verticalAnchorRef`: undefined when it passed none, its `current` otherwise. */
  given: { current: E | null } | undefined
  trigger: E | null
  bounds: 'layout' | 'visual'
  preferSide: 'up' | 'down'
  beside: boolean
}

export function verticalAnchorOf<E extends AnchorCandidate>({ given, trigger, bounds, preferSide, beside }: VerticalAnchorInput<E>): E | null {
  if (given?.current) return given.current
  if (bounds === 'visual') {
    return (trigger?.closest('.session-panel-input') ?? trigger?.closest('.chat-input-container') ?? null) as E | null
  }
  if (given) return null
  if (preferSide !== 'up' || beside || trigger?.closest('.wn-menu, [role="menu"]')) return null
  return (trigger?.closest('.chat-input-container') ?? null) as E | null
}
