/**
 * Capture the app's WebSocket so a spec can inject a server event.
 *
 * The same init script used to be pasted into each spec that needed it. This
 * is the one copy to import; the semantics match those pastes: the FIRST `/ws`
 * socket the page opens is the one kept, so a reconnect does not silently
 * move injection to a socket the app may not be reading yet.
 *
 *   await captureWs(page);                    // before page.goto
 *   await injectEvent(page, 'session:x', {…}); // waits for the socket to be OPEN
 */
import type { Page } from '@playwright/test';

export async function captureWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
        }
      }
    } as typeof WebSocket;
  });
}

export async function waitForWs(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return !!ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout });
}

/** Dispatch one server event frame into the captured socket. */
export async function injectEvent(page: Page, name: string, data: unknown): Promise<void> {
  await waitForWs(page);
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket;
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
  }, { name, data });
}
