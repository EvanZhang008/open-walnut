/**
 * Shared by the streamed-vs-finished parity specs: a snapshot of one reply
 * (every element's tag, class, computed style and box), a sampler of every frame
 * and DOM commit across the handover, and their diff.
 * See stream-final-render-parity.spec.ts for why.
 */
import type { Page } from '@playwright/test';

export async function disableTransitions(page: Page) {
  // No transitions: a headless WebKit page in the background barely advances
  // them, and a change at the handover must show as a change, not as a fade
  // the sampler happens to catch half-way.
  await page.addInitScript(() => {
    const style = () => {
      const el = document.createElement('style');
      el.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
      document.head.appendChild(el);
    };
    if (document.head) style(); else document.addEventListener('DOMContentLoaded', style);
  });
}

export const STYLE_PROPS = [
  'display', 'position', 'box-sizing',
  'color', 'background-color', 'background-image',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'white-space', 'word-break', 'overflow-wrap', 'text-decoration-line',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-top-style', 'border-top-color',
  'border-left-width', 'border-left-color', 'border-radius',
  'list-style-type', 'opacity', 'overflow-x',
] as const;

export type ElemSnap = { path: string; tag: string; cls: string; style: Record<string, string>; w: number; h: number; dx: number; dy: number };
export type ReplySnap = { left: number; width: number; top: number; height: number; html: string; elems: ElemSnap[] };

/**
 * Every element of the ONE visible reply holding `marker`: its tag, class,
 * computed style and box relative to the reply root, plus the root's box in the
 * scroll content's own coordinates (so scrolling does not count as a move).
 */
export async function snapReply(page: Page, marker: string): Promise<ReplySnap> {
  return page.evaluate(({ marker, props }) => {
    const scroller = document.querySelector('.main-page-session-column .session-history') as HTMLElement | null
      ?? document.querySelector('.session-history') as HTMLElement;
    // The whole message body: the rendered reply, its image previews and the
    // copy / pin / time strip under it.
    const roots = Array.from(scroller.querySelectorAll('.session-msg-content'))
      .filter((el) => !el.parentElement?.closest('.session-msg-content'))
      .filter((el) => (el.textContent ?? '').includes(`Findings ${marker}`))
      .filter((el) => (el as HTMLElement).getClientRects().length > 0);
    if (roots.length !== 1) throw new Error(`expected one visible reply for ${marker}, found ${roots.length}`);
    const root = roots[0] as HTMLElement;
    const sr = scroller.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const elems: ElemSnap[] = [];
    const walk = (el: Element, path: string) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const style: Record<string, string> = {};
      for (const p of props) style[p] = cs.getPropertyValue(p);
      elems.push({
        path, tag: el.tagName, cls: (el.getAttribute('class') ?? '').trim(), style,
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
        dx: Math.round((r.left - rr.left) * 10) / 10, dy: Math.round((r.top - rr.top) * 10) / 10,
      });
      Array.from(el.children).forEach((c, i) => walk(c, `${path}/${c.tagName.toLowerCase()}[${i}]`));
    };
    walk(root, 'root');
    // Ancestors up to the conversation: their font and color are what the
    // reply inherits, so a wrapper that drops a class changes them too.
    let anc: Element | null = root.parentElement;
    let depth = 0;
    while (anc && anc !== scroller && depth < 6) {
      const cs = getComputedStyle(anc);
      elems.push({
        path: `ancestor[${depth}]`, tag: 'ANCESTOR', cls: '',
        style: { 'font-size': cs.fontSize, 'line-height': cs.lineHeight, color: cs.color, 'font-family': cs.fontFamily },
        w: 0, h: 0, dx: 0, dy: 0,
      });
      anc = anc.parentElement; depth++;
    }
    return {
      left: Math.round((rr.left - sr.left) * 10) / 10,
      width: Math.round(rr.width * 10) / 10,
      top: Math.round((rr.top - sr.top) * 10) / 10,
      height: Math.round(rr.height * 10) / 10,
      html: root.querySelector('.rich-blocks, .markdown-body')?.innerHTML ?? '',
      elems,
    };
  }, { marker, props: STYLE_PROPS as unknown as string[] });
}

/** Record, on every animation frame, how many copies of the reply are on
 *  screen and where its code block is and what color it wears. */
export async function startFrameSampler(page: Page, marker: string) {
  await page.evaluate((marker) => {
    const w = window as any;
    w.__paritySamples = [];
    w.__paritySrc = [];
    w.__parityImgs = [];
    w.__paritySampling = true;
    const scroller = document.querySelector('.main-page-session-column .session-history') as HTMLElement | null
      ?? document.querySelector('.session-history') as HTMLElement;
    const tick = (src: 'frame' | 'commit') => {
      if (!w.__paritySampling) return;
      const pres = Array.from(scroller.querySelectorAll('pre'))
        .filter((p) => (p.textContent ?? '').includes(`const marker = '${marker}'`))
        .filter((p) => p.getClientRects().length > 0);
      const sr = scroller.getBoundingClientRect();
      const s = pres.map((p) => {
        const r = p.getBoundingClientRect();
        const cs = getComputedStyle(p);
        return {
          top: Math.round((r.top - sr.top) * 10) / 10,
          left: Math.round((r.left - sr.left) * 10) / 10,
          w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
          bg: cs.backgroundColor, color: cs.color, font: cs.fontSize,
        };
      });
      // An image that is not decoded at a commit paints as a blank box.
      const imgs = Array.from(scroller.querySelectorAll('img.inline-image'))
        .filter((img) => (img.getAttribute('src') ?? '').includes(marker))
        .filter((img) => img.getClientRects().length > 0) as HTMLImageElement[];
      // Read at the frame callback only: a commit's image still decodes before
      // the paint that follows it, and the frame callback is that paint's last
      // look.
      if (src === 'frame') w.__parityImgs.push(imgs.map((img) => img.complete && img.naturalWidth > 0));
      w.__paritySamples.push(s);
      w.__paritySrc.push(src);
    };
    // Every animation frame, and every DOM commit inside the conversation: a
    // MutationObserver callback runs after React's commit and before the paint,
    // so the handover's own commit is sampled even where frames are throttled
    // (headless WebKit runs rAF rarely in a background page).
    const frame = () => { if (!w.__paritySampling) return; tick('frame'); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    const mo = new MutationObserver(() => { if (w.__paritySampling) tick('commit'); else mo.disconnect(); });
    mo.observe(scroller, { subtree: true, childList: true, characterData: true, attributes: true });
  }, marker);
}

export async function stopFrameSampler(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    w.__paritySampling = false;
    return {
      samples: w.__paritySamples as Array<Array<{ top: number; left: number; w: number; h: number; bg: string; color: string; font: string }>>,
      imgs: w.__parityImgs as boolean[][],
      srcs: w.__paritySrc as string[],
    };
  });
}

export function diffSnaps(a: ReplySnap, b: ReplySnap): string[] {
  const out: string[] = [];
  if (a.left !== b.left) out.push(`reply left ${a.left} -> ${b.left}`);
  if (a.width !== b.width) out.push(`reply width ${a.width} -> ${b.width}`);
  if (a.height !== b.height) out.push(`reply height ${a.height} -> ${b.height}`);
  // Under a pixel: the column follows its bottom with a rounded scrollTop, so a
  // fold above whose height has a fraction moves nothing a person can see.
  if (Math.abs(a.top - b.top) >= 1) out.push(`reply top ${a.top} -> ${b.top}`);
  if (a.elems.length !== b.elems.length) out.push(`element count ${a.elems.length} -> ${b.elems.length}`);
  const n = Math.min(a.elems.length, b.elems.length);
  for (let i = 0; i < n; i++) {
    const x = a.elems[i]; const y = b.elems[i];
    if (x.path !== y.path || x.tag !== y.tag) { out.push(`element ${i}: ${x.path} ${x.tag} -> ${y.path} ${y.tag}`); continue; }
    if (x.cls !== y.cls) out.push(`${x.path} class "${x.cls}" -> "${y.cls}"`);
    for (const k of Object.keys(x.style)) {
      if (x.style[k] !== y.style[k]) out.push(`${x.path} <${x.tag.toLowerCase()}> ${k}: ${x.style[k]} -> ${y.style[k]}`);
    }
    for (const k of ['w', 'h', 'dx', 'dy'] as const) {
      if (x[k] !== y[k]) out.push(`${x.path} <${x.tag.toLowerCase()}> ${k}: ${x[k]} -> ${y[k]}`);
    }
  }
  return out;
}


export async function dumpRows(page: Page, label: string) {
  const rows = await page.evaluate(() => {
    const h = (document.querySelector('.main-page-session-column .session-history') ?? document.querySelector('.session-history')) as HTMLElement;
    const sr = h.getBoundingClientRect();
    const out: string[] = [];
    const walk = (el: Element, d: number) => {
      if (d > 5) return;
      for (const c of Array.from(el.children)) {
        const r = c.getBoundingClientRect();
        if (r.height === 0) continue;
        const cs = getComputedStyle(c);
        out.push(`${'  '.repeat(d)}${c.tagName.toLowerCase()}.${(c.getAttribute('class') ?? '').replace(/ /g, '.')} top=${Math.round(r.top - sr.top + h.scrollTop)} h=${Math.round(r.height)} m=${cs.marginTop}/${cs.marginBottom} p=${cs.paddingTop}/${cs.paddingBottom} "${(c.textContent ?? '').slice(0, 30).replace(/\n/g, ' ')}"`);
        if (!c.classList.contains('markdown-body')) walk(c, d + 1);
      }
    };
    walk(h, 0);
    return out;
  });
  console.log(`--- ${label}\n${rows.join('\n')}`);
}

