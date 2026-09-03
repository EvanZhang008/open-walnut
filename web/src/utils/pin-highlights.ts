/**
 * pin-highlights — the paint half of quote pins, on the CSS Custom Highlight API.
 *
 * Nothing here touches the message DOM. Wrapping a passage in `<mark>` would
 * fight React (the body is `dangerouslySetInnerHTML` from a DOMPurify'd string,
 * re-set on every streaming delta) and would be wiped on the next render anyway.
 * `CSS.highlights` paints ranges from the SIDE, so a re-render only invalidates
 * the Range objects — which the owning hook re-derives.
 *
 * ONE Highlight object per name, sliced per panel: `CSS.highlights` is a
 * document-global registry and the home page mounts up to three SessionPanels at
 * once, so a per-panel `CSS.highlights.set('walnut-pin', …)` would have each
 * panel delete its neighbours' paint (the exact bug `claimSearchOwner` exists to
 * arbitrate for file search — here the surfaces are peers and must coexist, so
 * they share the registry entry instead of taking turns).
 */
import { log } from './log';

/** Persistent paint on every pinned passage. */
export const HL_PIN = 'walnut-pin';
/** Short, brighter paint used by an outline jump to say "here". */
export const HL_PIN_FLASH = 'walnut-pin-flash';

export const PIN_FLASH_MS = 1500;

type HighlightCtor = new (...ranges: Range[]) => object;

interface HighlightCapableWindow {
  CSS?: { highlights?: Map<string, object> };
  Highlight?: HighlightCtor;
}

/** Per-panel slices of the shared registry entries. */
const panelRanges = new Map<string, Range[]>();
const flashRanges = new Set<Range>();
let warnedUnsupported = false;

function registry(): { highlights: Map<string, object>; Highlight: HighlightCtor } | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as HighlightCapableWindow;
  const highlights = w.CSS?.highlights;
  const Highlight = w.Highlight;
  if (!highlights || typeof Highlight !== 'function') {
    if (!warnedUnsupported) {
      warnedUnsupported = true;
      // Everything else about a quote pin still works (it persists, it lists in
      // the outline, it jumps) — only the yellow paint is missing.
      log.info('session', 'CSS Custom Highlight API unavailable — quote pins will not be painted');
    }
    return null;
  }
  return { highlights, Highlight };
}

export function highlightsSupported(): boolean {
  return registry() !== null;
}

function repaint(name: string, ranges: Range[]): void {
  const api = registry();
  if (!api) return;
  if (!ranges.length) { api.highlights.delete(name); return; }
  api.highlights.set(name, new api.Highlight(...ranges));
}

function repaintPins(): void {
  const all: Range[] = [];
  for (const ranges of panelRanges.values()) all.push(...ranges);
  repaint(HL_PIN, all);
}

/** Replace one panel's slice of the persistent pin paint. */
export function setPanelPinRanges(panelKey: string, ranges: Range[]): void {
  if (!ranges.length && !panelRanges.has(panelKey)) return;
  if (ranges.length) panelRanges.set(panelKey, ranges);
  else panelRanges.delete(panelKey);
  repaintPins();
}

/** Drop a panel's slice (unmount / session switch). */
export function clearPanelPinRanges(panelKey: string): void {
  if (!panelRanges.delete(panelKey)) return;
  repaintPins();
}

/** Flash a passage for {@link PIN_FLASH_MS} — the outline's "you landed here". */
export function flashRange(range: Range): void {
  flashRanges.add(range);
  repaint(HL_PIN_FLASH, [...flashRanges]);
  setTimeout(() => {
    flashRanges.delete(range);
    repaint(HL_PIN_FLASH, [...flashRanges]);
  }, PIN_FLASH_MS);
}

/** Test-only / diagnostics: how many passages are painted right now. */
export function paintedPinCount(): number {
  let n = 0;
  for (const ranges of panelRanges.values()) n += ranges.length;
  return n;
}
