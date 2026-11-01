/**
 * A chat image drawn again looks the same from its first frame.
 *
 * A reply's DOM is built twice: as stream blocks while it arrives, then as its
 * persisted row, which replaces them (2026-11-01, the user: streaming and
 * finished must look exactly the same, "no flash"). Chat images are
 * `loading="lazy"`, and a lazy image waits for layout before it asks for its
 * pixels, so the redrawn one was an empty 0x0 box for a frame or two, and
 * everything around it moved, then moved back. Two answers, both before the
 * first paint of the new image:
 *  · an image whose src this page already loaded loses `loading="lazy"`: an
 *    eager image already in the page's "list of available images" is drawn at
 *    once (WebKit, so the Mac app, does so synchronously). A loaded image loses
 *    the attribute too, so the two copies' DOM is the same;
 *  · Chromium still decodes it a task later, so the image is held at the box it
 *    was last drawn at, in a container of the same width, until it loads.
 * Images never loaded here stay lazy: a long transcript does not fetch every
 * screenshot at once. Pinned by tests/web/image-size-hold.test.ts and
 * tests/e2e/browser/stream-final-render-parity.spec.ts.
 */

const SELECTOR = 'img.inline-image';

interface Box { w: number; h: number; cw: number }

/** Last drawn box per image place. Bounded: a session draws far fewer images. */
const boxes = new Map<string, Box>();
/** Srcs this page loaded. */
const loaded = new Set<string>();
const MAX_ENTRIES = 500;

function bounded<K, V>(m: Map<K, V> | Set<K>): void {
  if (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as K);
}

function containerWidth(img: HTMLImageElement): number {
  return img.parentElement?.clientWidth ?? 0;
}

/** One src can be drawn in two places of one message at two sizes (the inline
 *  image and the preview strip under the reply), so the box is per place. */
function keyOf(img: HTMLImageElement): string | null {
  const src = img.getAttribute('src');
  return src ? `${src}|${img.parentElement?.className ?? ''}` : null;
}

/** A chat image finished loading: remember its src and the box it is drawn at. */
export function rememberImageBox(img: HTMLImageElement): void {
  const src = img.getAttribute('src');
  const key = keyOf(img);
  if (!src || !key || !img.complete || img.naturalWidth === 0) return;
  loaded.add(src);
  bounded(loaded);
  if (img.getAttribute('loading') === 'lazy') img.removeAttribute('loading');
  if (img.dataset.wnHeld) return; // held at a remembered box: not its own size yet
  const r = img.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return; // hidden (a folded row)
  // The content box, which is what style width/height set (borders excluded).
  const cs = getComputedStyle(img);
  const w = parseFloat(cs.width);
  const h = parseFloat(cs.height);
  if (!(w > 0 && h > 0)) return;
  boxes.delete(key);
  boxes.set(key, { w, h, cw: containerWidth(img) });
  bounded(boxes);
}

/** Make a new chat image whose src this page already loaded look as it did. */
export function holdImageBox(img: HTMLImageElement): boolean {
  if (img.dataset.wnHeld) return false;
  const src = img.getAttribute('src');
  if (!src || !loaded.has(src)) return false;
  if (img.getAttribute('loading') === 'lazy') img.removeAttribute('loading');
  if (img.complete && img.naturalWidth > 0) return false;
  const key = keyOf(img);
  const box = key ? boxes.get(key) : undefined;
  if (!box || box.cw !== containerWidth(img)) return false;
  const prev = { width: img.style.width, height: img.style.height, attr: img.getAttribute('style') };
  img.style.width = `${box.w}px`;
  img.style.height = `${box.h}px`;
  img.dataset.wnHeld = '1';
  const release = () => {
    img.removeEventListener('load', release);
    img.removeEventListener('error', release);
    // Put the attribute back as it was, so the image's DOM ends exactly as an
    // image that was never held (an emptied style would leave `style=""`).
    if (prev.attr === null) img.removeAttribute('style');
    else { img.style.width = prev.width; img.style.height = prev.height; }
    delete img.dataset.wnHeld;
  };
  img.addEventListener('load', release);
  img.addEventListener('error', release);
  return true;
}

/**
 * Apply it to every chat image under `root`. Called from the layout effect of
 * what draws a message body (RichMarkdown, the image strip): a child's layout
 * effect runs before its parents', so the images have their box before the
 * conversation's own layout effect reads the height to keep its bottom pinned.
 * The MutationObserver below comes later (after the commit), too late for that
 * read: a column that measured the reply without its images had already
 * scrolled by their height.
 */
export function holdImageBoxesIn(root: Element | null): void {
  if (!root || loaded.size === 0) return;
  if (root.matches(SELECTOR)) holdImageBox(root as HTMLImageElement);
  else for (const img of root.querySelectorAll<HTMLImageElement>(SELECTOR)) holdImageBox(img);
}

let teardown: (() => void) | null = null;

export function installImageSizeHold(doc: Document = document): void {
  if (teardown || typeof MutationObserver === 'undefined') return;
  // `load` does not bubble; the capture phase still sees it. It runs before the
  // image's own listeners (a hold's release), so the box is read after them.
  const onLoad = (e: Event) => {
    const t = e.target;
    if (t instanceof HTMLImageElement && t.matches(SELECTOR)) queueMicrotask(() => rememberImageBox(t));
  };
  doc.addEventListener('load', onLoad, true);
  // The fallback for images drawn anywhere else (tool cards).
  const mo = new MutationObserver((records) => {
    for (const rec of records) for (const n of rec.addedNodes) if (n instanceof Element) holdImageBoxesIn(n);
  });
  mo.observe(doc.documentElement, { childList: true, subtree: true });
  teardown = () => { doc.removeEventListener('load', onLoad, true); mo.disconnect(); };
}

/** Test hook. */
export function _resetImageSizeHold(): void {
  teardown?.();
  teardown = null;
  boxes.clear();
  loaded.clear();
}
