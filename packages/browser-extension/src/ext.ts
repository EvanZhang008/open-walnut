/**
 * The browser's extension API, the same in Chrome and Firefox: Firefox has `browser` with
 * promises, Chrome (MV3) has `chrome`, whose calls return promises too. Only the calls this
 * extension makes are typed, loosely.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Tab { id?: number; url?: string; title?: string; windowId?: number; active?: boolean; status?: string }
export interface Win { id?: number; tabs?: Tab[] }
export interface Sender { tab?: Tab; frameId?: number; url?: string; origin?: string; id?: string }

interface Event<F> { addListener(f: F): void; removeListener(f: F): void }

export interface ExtApi {
  runtime: {
    id: string
    getURL(path: string): string
    sendMessage(msg: unknown): Promise<any>
    onMessage: Event<(msg: any, sender: Sender, sendResponse: (r: unknown) => void) => boolean | void | Promise<unknown>>
    onInstalled: Event<(d: { reason: string }) => void>
    onStartup?: Event<() => void>
    getPlatformInfo(): Promise<unknown>
    openOptionsPage?(): Promise<void>
    getManifest(): { version: string; name: string; version_name?: string }
    reload?(): void
  }
  storage: {
    local: StorageArea
    session: StorageArea & { setAccessLevel?(o: { accessLevel: string }): Promise<void> }
    onChanged: Event<(changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void>
  }
  tabs: {
    query(q: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean; windowId?: number }): Promise<Tab[]>
    get(tabId: number): Promise<Tab>
    sendMessage(tabId: number, msg: unknown, opts?: { frameId?: number }): Promise<any>
    create(o: { url: string; active?: boolean; windowId?: number }): Promise<Tab>
    update(tabId: number, o: { active?: boolean; url?: string }): Promise<Tab>
    remove(tabId: number): Promise<void>
    goBack(tabId: number): Promise<void>
    captureVisibleTab(windowId: number, o: { format: 'jpeg' | 'png'; quality?: number }): Promise<string>
    onRemoved: Event<(tabId: number) => void>
    onUpdated: Event<(tabId: number, change: { status?: string; url?: string; title?: string }, tab: Tab) => void>
    onActivated: Event<(info: { tabId: number; windowId: number }) => void>
  }
  windows: {
    create(o: { url: string; type?: string; width?: number; height?: number; focused?: boolean }): Promise<Win>
    get(id: number, o?: { populate?: boolean }): Promise<Win>
    getCurrent(): Promise<Win>
    onRemoved: Event<(windowId: number) => void>
  }
  permissions: {
    request(p: { origins?: string[]; permissions?: string[] }): Promise<boolean>
    contains(p: { origins?: string[]; permissions?: string[] }): Promise<boolean>
  }
  /** getSelf needs no permission. */
  management?: { getSelf?(): Promise<{ installType?: string }> }
  alarms: { create(name: string, o: { periodInMinutes: number }): Promise<void> | void; onAlarm: Event<(a: { name: string }) => void> }
  action: { openPopup?(): Promise<void>; setBadgeText(o: { text: string; tabId?: number }): Promise<void>; setBadgeBackgroundColor(o: { color: string }): Promise<void> }
  commands?: { onCommand: Event<(name: string, tab?: Tab) => void> }
  contextMenus?: {
    create(o: { id: string; title: string; contexts: string[] }, cb?: () => void): void
    removeAll(): Promise<void> | void
    onClicked: Event<(info: { menuItemId: string | number; selectionText?: string; pageUrl?: string }, tab?: Tab) => void>
  }
  /** Chrome's side panel. */
  sidePanel?: { open(o: { windowId?: number; tabId?: number }): Promise<void> }
  /** Firefox's sidebar. */
  sidebarAction?: { open(): Promise<void> }
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
