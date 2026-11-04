/**
 * The browser calls only agents make (ext.ts types the rest): new tabs and who opened them,
 * every normal tab, frames, downloads, and the optional debugger. Loosely typed, like ext.ts.
 */
import { ext, type Tab } from './ext'

interface Ev<F> { addListener(f: F): void; removeListener(f: F): void }

export interface NewTab extends Tab { openerTabId?: number; pendingUrl?: string; incognito?: boolean }

export interface DownloadItem {
  id: number; url: string; finalUrl?: string; referrer?: string; filename: string; mime?: string
  state: 'in_progress' | 'interrupted' | 'complete'; bytesReceived: number; totalBytes: number
  startTime: string; endTime?: string; error?: string; exists?: boolean
}

export interface Debuggee { tabId: number }
export interface DebuggerApi {
  attach(target: Debuggee, version: string): Promise<void>
  detach(target: Debuggee): Promise<void>
  sendCommand(target: Debuggee, method: string, params?: Record<string, unknown>): Promise<unknown>
}

interface MoreApi {
  tabs: {
    onCreated: Ev<(tab: NewTab) => void>
    query(q: { windowType?: string }): Promise<NewTab[]>
    get(tabId: number): Promise<NewTab>
    create(o: { url: string; active?: boolean; windowId?: number; openerTabId?: number }): Promise<Tab>
  }
  windows: { get(id: number): Promise<{ id?: number; type?: string; incognito?: boolean }> }
  scripting?: {
    executeScript(o: { target: { tabId: number; allFrames?: boolean }; func: () => unknown }): Promise<Array<{ frameId: number; result?: unknown }>>
  }
  downloads?: {
    onCreated: Ev<(item: DownloadItem) => void>
    search(q: { id?: number }): Promise<DownloadItem[]>
  }
  debugger?: DebuggerApi
  permissions: {
    contains(p: { permissions?: string[] }): Promise<boolean>
    request(p: { permissions?: string[] }): Promise<boolean>
    remove(p: { permissions?: string[] }): Promise<boolean>
  }
}

export const more = ext as unknown as MoreApi
