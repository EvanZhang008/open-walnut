/**
 * Playwright: the iCloud Passwords completion list never covers the composer.
 *
 * The extension treats every <textarea> as a fillable text field (its
 * `_isTextField()` returns true for textareas outright) and forwards our
 * `autocomplete="off"` only as a flag Apple's AutoFill ignores, so it popped an
 * "Enable Password AutoFill" panel over the session message box (2026-09-04).
 * Walnut hides the panel instead, matched on the shape the extension always
 * builds: a <div> on <body> with an open shadow root holding an <iframe> at its
 * own completion_list.html.
 *
 * The panel is built here by hand: a browser extension cannot be loaded into
 * the Playwright run, and this is the exact DOM its content script appends.
 */
import { test, expect, type Page } from '@playwright/test';

const EXT = 'moz-extension://11111111-2222-3333-4444-555555555555';

/** Reproduces CompletionListDriver.showCompletionList()'s DOM, then reports whether it is visible. */
async function injectPanel(page: Page, iframeSrc: string) {
  return page.evaluate((src) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('src', src);
    iframe.style.setProperty('width', '9001px', 'important');
    iframe.style.setProperty('height', '100%', 'important');
    const host = document.createElement('div');
    host.setAttribute('data-test-panel', '1');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('top', '400px', 'important');
    host.style.setProperty('left', '400px', 'important');
    host.attachShadow({ mode: 'open' }).appendChild(iframe);
    host.setAttribute('popover', 'manual');
    document.body.appendChild(host);
    if (typeof (host as HTMLElement & { showPopover?: () => void }).showPopover === 'function') {
      try { (host as HTMLElement & { showPopover: () => void }).showPopover(); } catch { /* ignore */ }
    }
    // The MutationObserver runs on a microtask; read back on the next frame.
    return new Promise<string>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(getComputedStyle(host).display);
      }));
    });
  }, iframeSrc);
}

test.describe('iCloud Passwords panel over the composer', () => {
  test('the extension panel is hidden as soon as it is injected', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const textarea = page.locator('.chat-input-textarea').first();
    await expect(textarea).toBeVisible();
    await textarea.click();

    const display = await injectPanel(page, `${EXT}/completion_list.html?username=&colorScheme=&isDark=false`);
    expect(display).toBe('none');
    // The composer is still the thing you see and can type into.
    await page.keyboard.type('still typing');
    await expect(textarea).toHaveValue('still typing');
    await page.screenshot({ path: '/tmp/icloud-password-overlay/composer-clear.png', clip: { x: 0, y: 0, width: 1280, height: 900 } });
  });

  test('an ordinary shadow-root div with an iframe is left alone', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Same shape, but not the extension's panel: must not be touched, or the
    // matcher is broad enough to break real embedded content.
    expect(await injectPanel(page, 'https://example.com/embed.html')).not.toBe('none');
    expect(await injectPanel(page, `${EXT}/settings.html`)).not.toBe('none');
  });
});
