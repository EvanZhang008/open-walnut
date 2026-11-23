/**
 * How wide the rail is closed and open, read from the stylesheet before the layout changes.
 *
 * The page's slide starts at the click, ahead of the layout that moves it
 * (utils/layout-slide.ts), so it has to know how far the page will move. A hidden probe with
 * the rail's classes answers that once per state; a window resize asks again, because the
 * rail's width may follow a media query.
 */
const widths = new Map<boolean, number>();

export function railWidth(shell: HTMLElement, collapsed: boolean): number {
  const known = widths.get(collapsed);
  if (known !== undefined) return known;
  const probe = document.createElement('aside');
  probe.className = collapsed ? 'sidebar collapsed' : 'sidebar';
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:0;overflow:hidden;';
  shell.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  widths.set(collapsed, width);
  return width;
}

export function forgetRailWidths(): void {
  widths.clear();
}
