/**
 * The browser's extension API, the same in Chrome and Firefox: Firefox has `browser` with
 * promises, Chrome (MV3) has `chrome`, whose calls return promises too. Only the calls this
 * extension makes are typed, loosely.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Tab { id?: number; url?: string; title?: string; windowId?: number; active?: boolean }
export interface Sender { tab?: Tab; frameId?: number; url?: string; origin?: string; id?: string }

interface Event<F> { addListener(f: F): void; removeListener(f: F): void }

export interface ExtApi {
  runtime: {
    id: string
    getURL(path: string): string
    sendMessage(msg: unknown): Promise<any>
    onMessage: Event<(msg: any, sender: Sender, sendResponse: (r: unknown) => void) => boolean | void | Promise<unknown>>
    onInstalled: Event<(d: { reason: string }) => void>
    openOptionsPage?(): Promise<void>
    getManifest(): { version: string; name: string }
  }
  storage: {
    local: StorageArea
    session: StorageArea & { setAccessLevel?(o: { accessLevel: string }): Promise<void> }
    onChanged: Event<(changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void>
  }
  tabs: {
    query(q: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>
    get(tabId: number): Promise<Tab>
    sendMessage(tabId: number, msg: unknown, opts?: { frameId?: number }): Promise<any>
    create(o: { url: string; active?: boolean }): Promise<Tab>
    update(tabId: number, o: { active?: boolean }): Promise<Tab>
    remove(tabId: number): Promise<void>
    onRemoved: Event<(tabId: number) => void>
  }
  windows: { create(o: { url: string; type: string; width: number; height: number; focused?: boolean }): Promise<unknown> }
  action: { openPopup?(): Promise<void>; setBadgeText(o: { text: string; tabId?: number }): Promise<void>; setBadgeBackgroundColor(o: { color: string }): Promise<void> }
  commands?: { onCommand: Event<(name: string, tab?: Tab) => void> }
}

interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, any>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

const g = globalThis as any
export const ext: ExtApi = (g.browser ?? g.chrome) as ExtApi
export const isFirefox = typeof g.browser !== 'undefined' && typeof g.browser.runtime?.getBrowserInfo === 'function'

/** Messages the background answers. Every reply is `{ ok: true, ... }` or `{ ok: false, error, code? }`. */
export async function ask<T = Record<string, unknown>>(msg: { type: string; [k: string]: unknown }): Promise<T & { ok: boolean; error?: string; code?: string }> {
  try {
    const r = await ext.runtime.sendMessage(msg)
    return (r ?? { ok: false, error: 'No answer from the Walnut extension.' }) as T & { ok: boolean; error?: string; code?: string }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as T & { ok: boolean; error?: string }
  }
}
