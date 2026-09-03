/**
 * `window.__walnutDesktop`: the hook the Mac app shell calls before replacing
 * the page process. It must give the SAME unsaved-text answer as the page's own
 * stale-asset reload (one rule, two callers), and it must fail closed: a hook
 * that throws answers "unsaved", because a wrong "safe" loses typed text while
 * a wrong "unsaved" costs one more minute.
 */
import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { installDesktopBridge } from '../../web/src/utils/desktop-bridge';
import { hasUnsavedWork } from '../../web/src/utils/stale-assets';

function windowWith(html: string): Window {
  const { window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return window as unknown as Window;
}

describe('desktop bridge', () => {
  it('installs on the window and agrees with the stale-asset rule', () => {
    const clean = windowWith('<textarea></textarea><input type="text" value="filter">');
    const bridge = installDesktopBridge(clean);
    expect(clean.__walnutDesktop).toBe(bridge);
    expect(bridge.hasUnsavedWork()).toBe(hasUnsavedWork(clean.document));
    expect(bridge.hasUnsavedWork()).toBe(false);
  });

  it('reports a composer draft and a dirty editor as unsaved', () => {
    const draft = installDesktopBridge(windowWith('<textarea>half a message</textarea>'));
    expect(draft.hasUnsavedWork()).toBe(true);
    const dirty = installDesktopBridge(windowWith('<div class="fv-dirty-dot"></div>'));
    expect(dirty.hasUnsavedWork()).toBe(true);
  });

  it('fails closed when the DOM check throws', () => {
    const broken = { document: null } as unknown as Window;
    expect(installDesktopBridge(broken).hasUnsavedWork()).toBe(true);
  });
});
