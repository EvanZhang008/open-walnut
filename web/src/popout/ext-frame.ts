/**
 * A Walnut view framed by the extension's side panel (the Ask, Tasks views): it hears only the
 * extension page that framed it, at that page's origin, from the first message on, and tells
 * only it (ext-panel-model.ts has the messages).
 */
import { EXT_PANEL, readInbound, type PanelInbound } from './ext-panel-model';

let parentOrigin = '';
const onKnown = new Set<() => void>();

/** Run `cb` each time the extension page becomes known (its first word); returns the unsubscribe. */
export function onParentKnown(cb: () => void): () => void {
  onKnown.add(cb);
  return () => { onKnown.delete(cb); };
}

export function parentKnown(): boolean {
  return parentOrigin !== '';
}

export function toParent(msg: Record<string, unknown>): void {
  // Before the extension's first word only `ready` goes out, and it carries nothing.
  if (!parentOrigin && msg.type !== 'ready') return;
  window.parent?.postMessage({ walnut: EXT_PANEL, ...msg }, parentOrigin || '*');
}

/** The extension's message in this event, or null; the first one pins the origin heard from. */
export function fromParent(e: MessageEvent): PanelInbound | null {
  const isParent = e.source === window.parent && window.parent !== window;
  if (parentOrigin && e.origin !== parentOrigin) return null;
  const m = readInbound(e.data, e.origin, isParent);
  if (m && !parentOrigin) {
    parentOrigin = e.origin;
    for (const cb of [...onKnown]) cb();
  }
  return m;
}
