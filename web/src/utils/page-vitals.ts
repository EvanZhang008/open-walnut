/**
 * Page vitals: every few minutes the page logs how much it holds, so a page that grows in the
 * window someone really uses can be read from the server log next to the Mac app's own memory
 * lines (`[webcontent] page process footprint`, subsystem desktop).
 *
 * 2026-11-10: the Mac app's page process grew from about 0.9 GB to 2.3 GB in half an hour of
 * active use, in both WebKit malloc and graphics, while a headless probe of the same layout
 * stayed flat. Nothing in a test browser shows what grows in that window, so the page says it.
 *
 * Cheap reads only (a few DOM counts, the running animations, image and canvas sizes, the
 * scroll heights of the chat columns), one line every SAMPLE_MS while the page is visible.
 */
import { log } from './log';

const SAMPLE_MS = 5 * 60_000;

type Probe = () => number;
const probes = new Map<string, Probe>();

/** A store adds what it holds (entries, rows), read at each sample. */
export function registerPageVital(name: string, read: Probe): () => void {
  probes.set(name, read);
  return () => { if (probes.get(name) === read) probes.delete(name); };
}

const mpx = (w: number, h: number) => ((w || 0) * (h || 0)) / 1e6;
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface PageVitals {
  nodes: number;
  panels: number;
  msgRows: number;
  anims: number;
  topAnims: string;
  imgs: number;
  imgMpx: number;
  canvases: number;
  canvasMpx: number;
  iframes: number;
  svgs: number;
  scrollMpx: number;
  tallestScrollPx: number;
  viewport: string;
  ageMin: number;
  [probe: string]: number | string;
}

/** One reading of the page (exported for tests). */
export function readPageVitals(doc: Document = document, win: Window = window): PageVitals {
  const imgs = Array.from(doc.getElementsByTagName('img'));
  const canvases = Array.from(doc.getElementsByTagName('canvas'));
  const animNames = new Map<string, number>();
  let anims = 0;
  try {
    for (const a of doc.getAnimations?.() ?? []) {
      anims++;
      const name = (a as Animation & { animationName?: string }).animationName || a.constructor.name;
      animNames.set(name, (animNames.get(name) ?? 0) + 1);
    }
  } catch { /* no Web Animations */ }
  let scrollMpx = 0;
  let tallest = 0;
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('.session-history, .org-rail-body'))) {
    scrollMpx += mpx(el.clientWidth, el.scrollHeight);
    tallest = Math.max(tallest, el.scrollHeight || 0);
  }
  const out: PageVitals = {
    nodes: doc.querySelectorAll('*').length,
    panels: doc.querySelectorAll('.session-panel').length,
    msgRows: doc.querySelectorAll('.session-msg').length,
    anims,
    topAnims: [...animNames].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}=${c}`).join(','),
    imgs: imgs.length,
    imgMpx: round1(imgs.reduce((s, i) => s + mpx(i.naturalWidth, i.naturalHeight), 0)),
    canvases: canvases.length,
    canvasMpx: round1(canvases.reduce((s, c) => s + mpx(c.width, c.height), 0)),
    iframes: doc.getElementsByTagName('iframe').length,
    svgs: doc.getElementsByTagName('svg').length,
    scrollMpx: round1(scrollMpx),
    tallestScrollPx: tallest,
    viewport: `${win.innerWidth}x${win.innerHeight}@${win.devicePixelRatio}`,
    ageMin: Math.round(win.performance.now() / 60_000),
  };
  for (const [name, read] of probes) {
    try { out[name] = read(); } catch { /* a probe never breaks the sample */ }
  }
  return out;
}

let started = false;

/** Start the periodic sample (idempotent). */
export function initPageVitals(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  const sample = () => {
    if (document.visibilityState !== 'visible') return;
    log.info('page-vitals', 'sample', readPageVitals() as unknown as Record<string, unknown>);
  };
  setInterval(sample, SAMPLE_MS);
}
