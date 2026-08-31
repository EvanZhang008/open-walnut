/**
 * Confining model-written CSS to the block that wrote it.
 *
 * A reply's `<style>` block arrives as a page author's CSS: `body { background:
 * #111 }`, `input { appearance: none }`. Rendered as-is, ONE chat message restyles
 * the entire console. Rewriting it is a string transform over already-sanitized
 * HTML because that is the only place both halves are known — the sanitizer
 * decides what survives, and the scope id is what the renderer stamps on the
 * message wrapper (see rich-blocks.ts / RichBlocks.tsx).
 *
 * Three rules the parser follows, each learned from what a regex cannot do:
 *  · count braces, never pattern-match nesting. `@media` wraps rules, and rules
 *    can nest; a regex that "finds selectors" mangles the first `content: "}"` or
 *    `url(a{b.png)` it meets. Strings, comments and parens are opaque here.
 *  · fail SAFE, not smart. On any anomaly the block's content is DROPPED, because
 *    an unstyled block is a visible, local, recoverable disappointment while one
 *    mis-parsed rule that escapes the scope restyles the whole app.
 *  · a selector is not the only thing that leaks. `@keyframes NAME`, `@font-face
 *    { font-family: X }` and `@property --x` all bind a DOCUMENT-WIDE identifier,
 *    so scoping the selectors alone still let one reply overwrite another's (or
 *    the app's) animation or font. Keyframes are renamed; the other two are
 *    dropped.
 *
 * Dependency-free for the same reason as rich-blocks.ts: the tests that pin these
 * rules run in a tier that cannot resolve marked/dompurify.
 */


/**
 * At-rules whose body is not a rule list and cannot leak a selector, so the body
 * rides through untouched. `keyframes` is handled separately (its NAME leaks even
 * though its body cannot) and `font-face`/`property` are dropped outright.
 */
const VERBATIM_AT = new Set(['page', 'counter-style']);

/**
 * At-rules that register a GLOBAL identifier rather than styling anything: an
 * `@font-face { font-family: X }` rebinds the name `X` for the whole document, and
 * `@property --x` registers a custom property globally. There is no way to scope
 * either, a reply essentially never needs one, and a missing font degrades to the
 * fallback stack — so they are dropped, like `@import`.
 */
const DROP_AT = new Set(['import', 'font-face', 'property']);

/** `@keyframes spin` / `@-webkit-keyframes spin` — captures the prefix + the name. */
const KEYFRAMES_RE = /^\s*@((?:-[a-z]+-)?keyframes)\s+(-?[_a-zA-Z][\w-]*)\s*$/;

/** Names collected while scoping ONE style block, so the rewrite pass can find them. */
interface ScopeCtx { scopeId: string; keyframes: Set<string> }

/** Where the prelude before a `{` or `;` ends, or null on unparseable CSS. */
function readPrelude(css: string, from: number): { at: number; term: '{' | ';' | 'eof' } | null {
  let parens = 0;
  for (let i = from; i < css.length; i++) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const close = endOfString(css, i);
      if (close < 0) return null;
      i = close;
      continue;
    }
    if (ch === '(') { parens++; continue; }
    if (ch === ')') { parens = Math.max(0, parens - 1); continue; }
    if (parens > 0) continue;
    if (ch === '{') return { at: i, term: '{' };
    if (ch === ';') return { at: i, term: ';' };
    if (ch === '}') return null; // a closer with nothing open — garbage
  }
  return { at: css.length, term: 'eof' };
}

/** Index of the `}` closing the block that started at `from`, or -1. */
function readBlock(css: string, from: number): number {
  let depth = 1;
  for (let i = from; i < css.length; i++) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const close = endOfString(css, i);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    // A brace inside parens is not a brace: `url(a{b.png)` is a legal value, and
    // counting its `{` would report the whole stylesheet as unbalanced and drop it.
    if (ch === '(') {
      const close = endOfParen(css, i);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Index of the `)` closing the group opened at `from`, or -1. */
function endOfParen(css: string, from: number): number {
  let depth = 0;
  for (let i = from; i < css.length; i++) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const close = endOfString(css, i);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Index of the quote closing the string opened at `from`, or -1. */
function endOfString(css: string, from: number): number {
  const quote = css[from];
  for (let i = from + 1; i < css.length; i++) {
    if (css[i] === '\\') { i++; continue; }
    if (css[i] === quote) return i;
  }
  return -1;
}

/** Top-level comma split of a selector list (strings and parens are opaque). */
function splitSelectors(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' || ch === "'") {
      const close = endOfString(raw, i);
      i = close < 0 ? raw.length : close;
      continue;
    }
    if (ch === '(' || ch === '[') { depth++; continue; }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); continue; }
    if (ch === ',' && depth === 0) { parts.push(raw.slice(start, i)); start = i + 1; }
  }
  parts.push(raw.slice(start));
  return parts;
}

/**
 * Prefix every selector in a list so it can only match inside the chunk.
 * `:root` / `html` / `body` become the chunk element ITSELF — a model styling the
 * page background means "this block's background", and a descendant selector
 * there would simply never match. Returns '' when there is no selector to scope.
 */
function scopeSelectors(raw: string, scopeSel: string): string {
  const out: string[] = [];
  for (const part of splitSelectors(raw)) {
    const sel = part.trim();
    if (sel === '') continue;
    const low = sel.toLowerCase();
    out.push(low === ':root' || low === 'html' || low === 'body' ? scopeSel : `${scopeSel} ${sel}`);
  }
  return out.join(', ');
}

/** Rewrite a rule list. Returns null on any anomaly — the caller drops the CSS. */
function scopeRules(css: string, scopeSel: string, nesting: number, ctx: ScopeCtx): string | null {
  if (nesting > 8) return null; // pathological nesting: refuse rather than guess
  let out = '';
  let i = 0;
  while (i < css.length) {
    const tok = readPrelude(css, i);
    if (!tok) return null;
    const prelude = css.slice(i, tok.at);
    const at = /^\s*@([\w-]+)/.exec(prelude)?.[1].toLowerCase();

    if (tok.term === 'eof') {
      // Trailing junk with no `{` — a truncated rule mid-stream, or garbage.
      return prelude.trim() === '' ? out : null;
    }
    if (tok.term === ';') {
      // `@import` must never survive: it pulls a whole stylesheet in, unscoped,
      // and it is a network fetch we did not ask for.
      if (at && !DROP_AT.has(at)) out += `${prelude.trim()};\n`;
      i = tok.at + 1;
      continue;
    }

    const close = readBlock(css, tok.at + 1);
    if (close < 0) return null; // unbalanced braces
    const body = css.slice(tok.at + 1, close);
    i = close + 1;
    if (at && DROP_AT.has(at)) continue;
    if (at?.endsWith('keyframes')) {
      // The BODY is safe verbatim (`from` / `50%` are not selectors, and
      // prefixing them would break the animation) but the NAME is a document-wide
      // identifier: two replies both defining `spin` overwrite each other, and one
      // can hijack an animation the app itself defines. So the name is suffixed
      // with the scope id and every `animation`/`animation-name` reference to it
      // is rewritten to match (rewriteKeyframeRefs, after this pass).
      const named = KEYFRAMES_RE.exec(prelude);
      if (!named) continue; // unparseable name (or a quoted one) — drop, don't guess
      ctx.keyframes.add(named[2]);
      out += `@${named[1]} ${named[2]}-${ctx.scopeId} {${body}}\n`;
      continue;
    }
    if (at && VERBATIM_AT.has(at)) {
      out += `${prelude.trim()} {${body}}\n`;
      continue;
    }
    if (at) {
      // @media / @supports / @container / anything else that wraps rules: the
      // rules INSIDE are what could leak, so recurse.
      const inner = scopeRules(body, scopeSel, nesting + 1, ctx);
      if (inner === null) return null;
      out += `${prelude.trim()} {\n${inner}}\n`;
      continue;
    }
    const sel = scopeSelectors(prelude, scopeSel);
    if (sel !== '') out += `${sel} {${body}}\n`;
  }
  return out;
}

/** KEYFRAMES_RE already limits a name to `[\w-]`, so this is belt-and-braces. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Point every `animation` / `animation-name` value at the renamed keyframes.
 *
 * Runs over the already-scoped output because a rule may USE an animation that a
 * `@keyframes` block further down (or in another `<style>` of the same message)
 * defines — the set of renamed names is only complete once every block has been
 * walked. Only the value side of those two properties is touched, and only whole
 * comma/space-delimited tokens, so a `content: "spin"` or a class called `.spin`
 * is left alone.
 */
function rewriteKeyframeRefs(css: string, ctx: ScopeCtx): string {
  const alt = [...ctx.keyframes].map(escapeRe).join('|');
  const token = new RegExp(`(^|[\\s,])(${alt})(?=$|[\\s,])`, 'g');
  return css.replace(
    /(animation(?:-name)?\s*:)([^;{}]*)/gi,
    (_full, prop: string, value: string) =>
      prop + value.replace(token, (_m, pre: string, name: string) => `${pre}${name}-${ctx.scopeId}`),
  );
}

/**
 * Every `<style>` block in the string, closer OPTIONAL on purpose. A sanitizer
 * that serializes a parsed DOM always emits one, but if a `<style>` ever reached
 * here unclosed, the browser would close it on insert and run the CSS — unscoped.
 * Matching to end-of-text means there is no input shape where a rule escapes.
 */
const STYLE_BLOCK_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>|$)/gi;

/** Confine every rule in every `<style>` block to `[data-rblk="scopeId"]`. */
export function scopeStyleHtml(html: string, scopeId: string): string {
  if (!/<style/i.test(html)) return html;
  // The id lands inside an attribute selector AND is appended to CSS identifiers
  // (keyframe names), so it may only be ident-shaped.
  const safeId = scopeId.replace(/[^A-Za-z0-9_-]/g, '');
  const scopeSel = `[data-rblk="${safeId}"]`;
  const ctx: ScopeCtx = { scopeId: safeId, keyframes: new Set() };
  const scoped = html.replace(
    STYLE_BLOCK_RE,
    (_full, open: string, css: string, closeTag: string) =>
      `${open}${scopeRules(css, scopeSel, 0, ctx) ?? ''}${closeTag}`,
  );
  if (ctx.keyframes.size === 0) return scoped;
  // The rename pass runs over ALL blocks after ALL of them have been walked: one
  // chunk's `<style>` may define the animation another chunk's rule uses, and both
  // share this message's scope. Confined to style bodies, so an `animation:` in a
  // style ATTRIBUTE or in prose text is never touched.
  return scoped.replace(
    STYLE_BLOCK_RE,
    (_full, open: string, css: string, closeTag: string) =>
      `${open}${rewriteKeyframeRefs(css, ctx)}${closeTag}`,
  );
}
