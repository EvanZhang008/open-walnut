/**
 * "Show me that control": open the task panel's view menu (the sliders button beside
 * New task) on one of its options and pulse it, from anywhere in the app.
 *
 * The strip's lock grant uses it: when every panel is pinned and a new session grows the
 * strip by one, the hint toast's "Adjust panels" has to land the user on the panel-count
 * picker they already have, two centimetres from the strip, not on a Settings page
 * (2026-10-02: "that's ridiculous, it's too far away"). Same window-event bridge as
 * `main:locate-task`: the ViewDropdown that owns the option answers; one on a surface
 * without it (the /tasks page) ignores the event.
 */

export const VIEW_DROPDOWN_REVEAL_EVENT = 'view-dropdown:reveal';

export interface ViewDropdownRevealDetail {
  /** `ViewOptionGroup.options[].key` of the control to show, e.g. `session-panels`. */
  option: string;
}

export function revealViewOption(option: string): void {
  window.dispatchEvent(new CustomEvent<ViewDropdownRevealDetail>(VIEW_DROPDOWN_REVEAL_EVENT, { detail: { option } }));
}

/** How long the revealed row pulses; matches the `vd-field-flash` keyframes. */
export const VIEW_OPTION_FLASH_MS = 3100;

/**
 * Run `cb` once `el` has a visible, stationary box. The task panel reopens with a 250ms width
 * transition and a hidden MainPage shows up on the next route commit, and a menu placed from
 * the trigger's rect mid-move would be drawn in the wrong place. Frames are compared, not
 * class names, so any animation on any ancestor is waited out. Gives up after ~1s.
 */
export function whenSettled(el: Element, cb: () => void): () => void {
  let last: string | null = null;
  let frames = 0;
  let raf = 0;
  const tick = () => {
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0;
    // All four edges: a toolbar that wraps while its panel is still narrow holds the
    // trigger's left and width steady and moves only its top.
    const box = `${r.left},${r.top},${r.width},${r.height}`;
    if ((visible && last === box) || frames++ > 60) { cb(); return; }
    last = box;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
