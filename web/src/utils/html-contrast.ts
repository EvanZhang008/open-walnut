/**
 * Readable text on a model-painted background.
 *
 * Rich replies often set a background on a box (`<pre style="background:#f6f8fa">`)
 * and leave the text colour to inheritance. What they inherit is Walnut's, not the
 * page the model imagined: assistant code blocks carry light text for their dark
 * fill, and the dark theme carries light text everywhere, so a light card read as
 * pale grey on white (2026-10-22). When an inline style names an opaque background
 * and no `color`, this picks the text colour that background needs.
 */

const DARK_TEXT = '#1f2328';
const LIGHT_TEXT = '#f0f3f6';

const NAMED: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  ivory: [255, 255, 240],
  beige: [245, 245, 220],
  lightyellow: [255, 255, 224],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  whitesmoke: [245, 245, 245],
  navy: [0, 0, 128],
};

type Rgba = [number, number, number, number];

function parseHex(hex: string): Rgba | null {
  const h = hex.slice(1);
  if (h.length === 3 || h.length === 4) {
    const v = [...h].map((c) => parseInt(c + c, 16));
    return [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1];
  }
  if (h.length === 6 || h.length === 8) {
    const v = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
    return [v[0], v[1], v[2], h.length === 8 ? v[3] / 255 : 1];
  }
  return null;
}

function parseRgbFn(args: string): Rgba | null {
  const parts = args.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p));
  const rgb = parts.slice(0, 3).map(channel);
  const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  if ([...rgb, a].some((n) => Number.isNaN(n))) return null;
  return [rgb[0], rgb[1], rgb[2], a];
}

/** The first colour a background value paints, or null when it names none we can read. */
function firstColor(value: string): Rgba | null {
  const m = value.match(/#[0-9a-f]{3,8}\b|rgba?\(([^)]*)\)|\b[a-z]+\b/gi);
  if (!m) return null;
  for (const token of m) {
    if (token.startsWith('#')) return parseHex(token.toLowerCase());
    const fn = token.match(/^rgba?\(([^)]*)\)$/i);
    if (fn) return parseRgbFn(fn[1]);
    const lower = token.toLowerCase();
    // A theme variable already fits its theme; a gradient or image is not one colour.
    if (lower === 'var' || lower.endsWith('gradient') || lower === 'url') return null;
    if (lower === 'transparent') return [0, 0, 0, 0];
    if (NAMED[lower]) return [...NAMED[lower], 1];
  }
  return null;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function declarations(style: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    out.push([decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim()]);
  }
  return out;
}

/**
 * The text colour an inline style needs, or null when it already names one, paints
 * no single colour we can read (a theme variable, an image, a gradient), or paints
 * a see-through one (the page shows through, so the inherited text still fits).
 */
export function readableTextColorFor(style: string): string | null {
  let bg: string | null = null;
  for (const [prop, value] of declarations(style)) {
    if (prop === 'color') return null;
    if (prop === 'background-image' && !/^none\b/i.test(value)) return null;
    // The later of `background` and `background-color` wins, as in CSS.
    if (prop === 'background' || prop === 'background-color') bg = value;
  }
  if (!bg || /url\(|gradient\(/i.test(bg)) return null;
  const rgba = firstColor(bg);
  if (!rgba || rgba[3] < 0.5) return null;
  // Contrast against black vs white: the darker text wins on a background brighter than ~0.18.
  return luminance(rgba) > 0.179 ? DARK_TEXT : LIGHT_TEXT;
}

let armed = 0;

/**
 * Run a sanitize with the hook on. Only a model reply opts in: mail, Office
 * previews and copied rich text keep their author's colours exactly.
 */
export function withReadableInk<T>(run: () => T): T {
  armed++;
  try {
    return run();
  } finally {
    armed--;
  }
}

/**
 * DOMPurify `afterSanitizeAttributes` hook: add the colour, keep the rest of the
 * style. `data-ink` lets the stylesheet give themed chips inside the box (inline
 * code, table headers, which paint their own theme background) the theme's text
 * colour back, instead of the box's.
 */
export function ensureReadableText(node: Element): void {
  if (!armed) return;
  const style = node.getAttribute?.('style');
  if (!style) return;
  const color = readableTextColorFor(style);
  if (!color) return;
  const trimmed = style.trim();
  node.setAttribute('style', `${trimmed}${trimmed.endsWith(';') ? '' : ';'}color:${color}`);
  node.setAttribute('data-ink', color === DARK_TEXT ? 'dark' : 'light');
}
