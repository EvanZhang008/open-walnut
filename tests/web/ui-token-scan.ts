/**
 * Per declaration: which of the UI standard's token rules it breaks
 * (.claude/skills/walnut-ui-requirements/standard.md, "Tokens"). Counted per file by
 * ui-standard-scan.ts `countAll()`, held by ui-standard-ratchet.test.ts.
 *
 * 2026-11-21, the UI audit: 71 corner radii, 61 font sizes (495 of them half pixels), 106 shadow
 * geometries and 541 raw colours, because the stylesheets wrote values instead of tokens.
 *   - rawColour: a literal colour in a colour property (or a custom property outside the theme's
 *     :root blocks), outside a var() fallback. Shadows are shadowLiteral's.
 *   - radiusNotToken: a corner written as a length (8px), not var(--radius-*); 0 and % are fine.
 *   - pillRadius: a corner of 99px or more (a pill). The standard draws controls at 8 px.
 *   - fontSizeOffScale: a font size not from var(--font-size-*) (also in the `font` shorthand).
 *   - shadowLiteral: a blurred box-shadow written literally (rings and inset hairlines are fine).
 *   - zIndexLiteral: a z-index number other than -1, 0 or 1 (a layer belongs to --z-*).
 *   - spacingOffGrid: a padding, margin or gap off the 2 px grid (odd pixels other than 1 px).
 */
import type { Decl } from './css-scan';
import { splitTopLevel } from './css-scan';

export const TOKEN_KINDS = ['rawColour', 'radiusNotToken', 'pillRadius', 'fontSizeOffScale', 'shadowLiteral', 'zIndexLiteral', 'spacingOffGrid'] as const;
export type TokenKind = typeof TOKEN_KINDS[number];

/** The value with every `var(...)` (fallbacks included) and `url(...)` removed: what is written literally. */
export function literalPart(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const at = value.slice(i, i + 4).toLowerCase();
    if (at === 'var(' || at === 'url(') {
      let depth = 0;
      for (; i < value.length; i++) {
        if (value[i] === '(') depth++;
        else if (value[i] === ')' && --depth === 0) break;
      }
      out += ' ';
      continue;
    }
    out += value[i];
  }
  return out;
}

const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?<![\w-])(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|gold|brown|darkgr[ae]y|lightgr[ae]y|whitesmoke)(?![\w-])/i;
const COLOUR_PROP = /^(color|background|background-color|background-image|border|border-(top|right|bottom|left|block|inline)(-start|-end)?|border(-(top|right|bottom|left|block|inline)(-start|-end)?)?-color|outline|outline-color|fill|stroke|text-decoration|text-decoration-color|caret-color|accent-color|column-rule|column-rule-color|text-emphasis-color)$/;
/** The theme's own blocks: `:root`, `:root[data-theme="dark"]`, `:root:not([data-theme])`, `html`. */
const THEME_BLOCK = /^(:root|html)(\[[^\]]*\]|:not\([^)]*\))*$/;
const LENGTH = /(-?\d*\.?\d+)(px|r?em|pt|vh|vw)\b/g;

/** A shadow part with a blur above 0, its colour (var(), rgb(), color-mix() ...) left out. */
function blurred(part: string): boolean {
  if (/\binset\b/.test(part)) return false;
  let geometry = literalPart(part);
  while (/[a-z-]+\([^()]*\)/i.test(geometry)) geometry = geometry.replace(/[a-z-]+\([^()]*\)/gi, ' ');
  geometry = geometry.replace(/#[0-9a-f]{3,8}\b/gi, ' ');
  const nums = [...geometry.matchAll(/(^|\s)(-?\d*\.?\d+)(px)?(?=\s|$)/g)].map((m) => Number(m[2]));
  return nums.length >= 3 && nums[2] > 0;
}

export function tokenBreaks(d: Decl): TokenKind[] {
  const out: TokenKind[] = [];
  const { prop, value } = d;
  const lit = literalPart(value);
  if (prop.startsWith('--')) {
    if (!d.selectors.every((s) => THEME_BLOCK.test(s)) && COLOUR.test(lit)) out.push('rawColour');
    return out;
  }
  if (COLOUR_PROP.test(prop) && COLOUR.test(lit)) out.push('rawColour');
  if (/^border(-[a-z]+)*-radius$/.test(prop)) {
    const lengths = [...lit.matchAll(LENGTH)].map((m) => Number(m[1]));
    if (lengths.some((n) => n >= 99)) out.push('pillRadius');
    else if (lengths.some((n) => n !== 0)) out.push('radiusNotToken');
  }
  if (prop === 'font-size' && /\d|\b(x*-small|small|medium|large|x*-large|smaller|larger)\b/.test(lit)) out.push('fontSizeOffScale');
  if (prop === 'font' && /(^|\s)\d*\.?\d+(px|r?em|pt|%)(?=\s|\/|$)/.test(lit)) out.push('fontSizeOffScale');
  if (prop === 'box-shadow' && splitTopLevel(value).some((p) => blurred(p))) out.push('shadowLiteral');
  if (prop === 'z-index' && /^-?\d+$/.test(value.replace(/\s*!important$/, '').trim()) && Math.abs(Number(value.replace(/\s*!important$/, ''))) > 1) out.push('zIndexLiteral');
  if (/^(padding|margin)(-(top|right|bottom|left|block|inline)(-start|-end)?)?$|^(gap|row-gap|column-gap)$/.test(prop)) {
    const px = [...lit.matchAll(/(-?\d*\.?\d+)px\b/g)].map((m) => Math.abs(Number(m[1])));
    if (px.some((n) => n !== 1 && n % 2 !== 0)) out.push('spacingOffGrid');
  }
  return out;
}
