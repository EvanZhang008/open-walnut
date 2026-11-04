/**
 * KaTeX, loaded only when a note actually holds math.
 *
 * `katex` and its stylesheet (with its fonts) are a few hundred KB, so they are
 * never part of the app's entry bundle: `loadMath()` pulls both through dynamic
 * imports the first time the math decorations find a formula, and Vite splits
 * them into their own chunks. Until then the formula shows as its source.
 *
 * Rendering never throws: `throwOnError: false` makes KaTeX paint a bad formula
 * as its own source in red (`span.katex-error`, the message in `title`), and any
 * other exception is caught here and painted the same way.
 */

type Katex = typeof import('katex').default;

export type MathStatus = 'idle' | 'loading' | 'ready' | 'failed';

let katex: Katex | null = null;
let status: MathStatus = 'idle';
let pending: Promise<boolean> | null = null;
let failedAt = 0;

/** After a failed load (a network blip, a chunk gone after an update), try again this much later. */
const RETRY_AFTER_MS = 30_000;

export function mathStatus(): MathStatus {
  return status;
}

/** True when a formula on screen should start (or retry) loading KaTeX. */
export function shouldLoadMath(now = Date.now()): boolean {
  if (status === 'idle') return true;
  return status === 'failed' && now - failedAt >= RETRY_AFTER_MS;
}

/** Load KaTeX and its CSS once; resolves true when rendering is available. */
export function loadMath(): Promise<boolean> {
  if (pending) return pending;
  status = 'loading';
  pending = Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([mod]) => {
      katex = (mod.default ?? mod) as Katex;
      status = 'ready';
      return true;
    })
    .catch(() => {
      status = 'failed';
      failedAt = Date.now();
      pending = null;
      return false;
    });
  return pending;
}

export interface RenderedMath {
  /** HTML to paint. A formula with an error is its own escaped source in a `katex-error` span. */
  html: string;
  /** The parse error message when the formula is invalid, otherwise null. */
  error: string | null;
}

const CACHE_LIMIT = 500;
const cache = new Map<string, RenderedMath>();

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const KATEX_ERROR_RE = /class="katex-error"[^>]*?title="([^"]*)"/;

/**
 * Render one formula. Requires `mathStatus() === 'ready'`; before that (or if the
 * load failed) it returns the escaped source flagged as an error.
 */
export function renderMath(latex: string, displayMode: boolean): RenderedMath {
  const key = `${displayMode ? 'd' : 'i'}:${latex}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!katex) return { html: escapeHtml(latex), error: 'Math renderer is not available' };
  let out: RenderedMath;
  try {
    const html = katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      trust: false,
      // Imported notes carry unicode and other non-strict LaTeX; render it without console noise.
      strict: 'ignore',
      output: 'htmlAndMathml',
      // `\rule{1e9em}{1e9em}` and the like must not blow up the editor's layout.
      maxSize: 100,
    });
    const m = KATEX_ERROR_RE.exec(html);
    out = { html, error: m ? unescapeHtml(m[1]) : null };
  } catch (err) {
    out = {
      html: `<span class="katex-error">${escapeHtml(latex)}</span>`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}
