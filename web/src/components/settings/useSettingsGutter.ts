import { useLayoutEffect, type RefObject } from 'react';

/**
 * How wide Settings' kept scrollbar gutter is in this window, as `--settings-gutter` on the Settings
 * container, so its nav list and pane can take it out of their own right padding
 * (settings-nav.css). Both keep their gutter (`scrollbar-gutter: stable`), so a scrollbar that
 * comes with the notice stack's room never narrows their rows; paid for on top of the padding,
 * that gutter took 8px from every row at rest and wrapped six descriptions at 660px (2026-11-17).
 *
 * Measured, never assumed: it is the width of Settings' own styled scrollbar where the engine keeps
 * a gutter for it (8px in Chromium), and 0 where it keeps none (overlay scrollbars, WebKit 26 beside
 * `::-webkit-scrollbar` styles). The probe sits inside a hidden copy of the container, so the
 * same scrollbar rules reach it. Measured on mount and again after a resize (a display with
 * another scrollbar setting); set only on the container, so nothing outside Settings restyles.
 */
export function measureSettingsGutter(doc: Document = document): number {
  const host = doc.createElement('div');
  host.className = 'settings-container';
  host.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:120px;height:60px;visibility:hidden;pointer-events:none';
  const probe = doc.createElement('div');
  probe.className = 'settings-pane';
  probe.style.cssText = 'position:static;width:100px;height:40px;padding:0;border:0;overflow-y:auto;scrollbar-gutter:stable';
  host.appendChild(probe);
  doc.body.appendChild(host);
  const width = Math.max(0, probe.offsetWidth - probe.clientWidth);
  host.remove();
  return width;
}

export function useSettingsGutter(containerRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const write = () => {
      const value = `${measureSettingsGutter(el.ownerDocument)}px`;
      if (el.style.getPropertyValue('--settings-gutter') !== value) el.style.setProperty('--settings-gutter', value);
    };
    write();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => { clearTimeout(timer); timer = setTimeout(write, 250); };
    window.addEventListener('resize', onResize, { passive: true });
    return () => { clearTimeout(timer); window.removeEventListener('resize', onResize); };
  }, [containerRef]);
}
