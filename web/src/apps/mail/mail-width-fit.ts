/**
 * A mail body's own pixel widths, fitted to the paper they render on (the string pass of
 * `mail-html.ts`; pure, so it runs in the node test tier like that file).
 *
 * One class of bug: a sender's fixed width holds the paper open wider than the reader pane, both
 * engines cut every line at the paper's edge, and the reader has to scroll sideways to read a
 * sentence. Each member is a declaration that does it:
 *
 *   - a table's `width` (`fitFixedTable` in mail-html.ts: `min(<width>, 100%)`);
 *   - any element's `min-width` (2026-11-24, a cloud provider's pricing notice: its 600px wrapper
 *     said `width:600px; min-width:600px`, the fitted width yielded and the minimum did not, and at
 *     a 520px paper the text was laid out at 624px);
 *   - a box's own `width`: a 400px block in a sign-in notice, and its 280px inline-block button
 *     with 60px of padding on each side, which kept its table cell 34px past a 520px paper.
 *
 * Where the paper is wider than the sender's width nothing changes: on fifteen real bodies at a
 * 900px paper every one drew pixel-identical before and after (`tests/e2e/browser/mail-body-fits.spec.ts`
 * holds one shape per member). Table cells, rows and columns keep their widths (a cell's width
 * re-spreads every column of a card), and so do images and media, which the frame reset's
 * `max-width: 100%` already holds.
 */

/** A pixel width as an attribute (`600`, `600px`) or as a CSS declaration value. */
export const PX_WIDTH = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i;

/** One declaration of an inline style: its property and its value, `!important` dropped. */
const DECL = /^\s*([a-zA-Z-]+)\s*:\s*([\s\S]*?)\s*(?:!important)?\s*$/;

/** Tags whose own `width` stays as the sender wrote it (see the file comment). */
const KEEPS_OWN_WIDTH = new Set([
  'table', 'td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'col', 'colgroup', 'caption',
  'img', 'svg', 'picture', 'video', 'audio', 'canvas', 'iframe', 'hr',
]);

/** A `12px` token as a number, anything else (`auto`, `1em`, a colour) as 0. */
function px(token: string | undefined): number {
  const m = token ? /^(\d+(?:\.\d+)?)px$/i.exec(token) : null;
  return m ? Number(m[1]) : 0;
}

/** Left and right of a one-to-four value side list (`12px 60px`). */
function leftRight(value: string): [number, number] {
  const parts = value.trim().split(/\s+/);
  const right = parts[1] ?? parts[0];
  return [px(parts[3] ?? right), px(right)];
}

/** The border width in a `border` shorthand (`1px solid #308bbf`). */
function borderWidth(value: string): number {
  return px(value.trim().split(/\s+/).find((t) => /px$/i.test(t)));
}

/**
 * The inline style with every pixel `min-width` fitted, and, outside table internals and media,
 * the box's own pixel `width` turned into a width that yields.
 *
 * The box becomes `width: auto`, capped at the sender's width (`max-width`) and held at it from
 * below while the paper allows (`min-width: min(<width>, 100% - <its side padding and border>)`).
 * Wherever the paper is wider that is exactly the sender's box, a block, an inline-block button or
 * a float alike. Where it is narrower the box yields, inside a table cell too: there `min()` with a
 * percentage in `width` still counts its pixels toward the cell's width, while a percentage in
 * `min-width` counts as zero, so the cell can narrow.
 */
export function fitInlineWidths(tag: string, style: string): string {
  const decls = style.split(';');
  let width: number | null = null;
  let cap: number | null = null;
  const side = { pl: 0, pr: 0, bl: 0, br: 0 };
  let borderBox = false;
  for (const decl of decls) {
    const m = DECL.exec(decl);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const value = m[2];
    if (name === 'width') {
      const found = PX_WIDTH.exec(value);
      width = found ? Number(found[1]) : null;
    } else if (name === 'max-width') {
      const found = PX_WIDTH.exec(value);
      cap = found ? Number(found[1]) : null;
    } else if (name === 'box-sizing') {
      borderBox = /border-box/i.test(value);
    } else if (name === 'padding') {
      [side.pl, side.pr] = leftRight(value);
    } else if (name === 'padding-left') {
      side.pl = px(value.trim());
    } else if (name === 'padding-right') {
      side.pr = px(value.trim());
    } else if (name === 'border') {
      side.bl = side.br = borderWidth(value);
    } else if (name === 'border-width') {
      [side.bl, side.br] = leftRight(value);
    } else if (name === 'border-left' || name === 'border-left-width') {
      side.bl = borderWidth(value);
    } else if (name === 'border-right' || name === 'border-right-width') {
      side.br = borderWidth(value);
    }
  }
  const sides = side.pl + side.pr + side.bl + side.br;
  const ownWidth = width !== null && width > 0 && !KEEPS_OWN_WIDTH.has(tag);
  const out: string[] = [];
  for (const decl of decls) {
    const m = DECL.exec(decl);
    const name = m?.[1].toLowerCase();
    if (m && name === 'min-width') {
      const found = PX_WIDTH.exec(m[2]);
      if (found) { out.push(`${leading(decl)}min-width:min(${found[1]}px,100%) !important`); continue; }
    }
    if (ownWidth && m && (name === 'width' || name === 'max-width')) continue;
    out.push(decl);
  }
  if (!ownWidth) return out.join(';');
  const max = cap !== null ? Math.min(cap, width!) : width!;
  const room = borderBox || sides <= 0 ? '100%' : `100% - ${round(sides)}px`;
  const fitted = `width:auto !important;max-width:${max}px !important;min-width:min(${max}px,${room}) !important`;
  const kept = out.join(';').replace(/^[\s;]+|[\s;]+$/g, '');
  return kept ? `${kept};${fitted}` : fitted;
}

function leading(decl: string): string {
  return /^\s*/.exec(decl)![0];
}

function round(n: number): string {
  return String(Math.round(n * 100) / 100);
}
