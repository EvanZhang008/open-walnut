/**
 * Filling the page with one item, for every view that fills (the popup's rows and detail, the key
 * popover). Its own file, light on imports: the side panel's script carries it through the key
 * popover, and the item views' imports (the public suffix list among them) stay out (review R3-7).
 */
import { ask } from './ext'
import { copySecret, toast } from './popup-ui'
import { currentView, isCurrent } from './popup-view'

export interface Item { id: string; title: string; username?: string; site?: string; hasTotp: boolean; exact?: boolean; type?: string; sub?: string }

/** Where the popup runs: the toolbar, the side panel's Passwords tab, or a window of its own. */
export interface PopupCtx {
  root: HTMLElement; embedded: boolean; inWindow: boolean; panelWindow?: number; back: () => void
  /** Where this view says a fill's error (the key popover's own line); else a toast. A success says nothing then. */
  say?: (text: string) => void
}

/** Walnut ended this browser's unlock: the popup shows its lock screen (the background forgot the token). */
const LOCKED = new Set(['vault_session_needed', 'vault_locked'])
export const lockedReply = (r: { ok: boolean; code?: string }) => !r.ok && !!r.code && LOCKED.has(r.code)

/** Fill the page with `it`; true when it was filled. */
export async function fillTab(it: { id: string }, ctx: PopupCtx): Promise<boolean> {
  const g = currentView()
  const r = await ask<{ code?: string }>({ type: 'fill-tab', id: it.id, ...(ctx.panelWindow ? { windowId: ctx.panelWindow } : {}) })
  if (!isCurrent(g)) return false
  if (lockedReply(r)) { ctx.back(); return false }
  if (!r.ok) { (ctx.say ?? toast)(r.error ?? 'Could not fill.'); return false }
  // Its one-time code goes on the clipboard (the background had no clipboard of its own here).
  if (r.code) await copySecret(r.code, 'Code')
  if (ctx.embedded) { if (!r.code && !ctx.say) toast('Filled') } else if (!ctx.inWindow) setTimeout(() => window.close(), r.code ? 700 : 0)
  return true
}
