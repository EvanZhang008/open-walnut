/**
 * Fenced code blocks in rendered markdown: a header (language label, Wrap,
 * Copy) around the `<pre>`, and Prism syntax colors inside it.
 *
 * Two string passes, because the in-app renderer works on HTML strings (one
 * cached string per message, written with innerHTML):
 *
 *  1. `renderCodeBlockFrame` is marked's `code` renderer for the in-app render.
 *     It writes the frame and the PLAIN escaped code, marking the `<code>` with
 *     the grammar to use (`data-hl`). The passes that link paths, task ids and
 *     letters inside code (markdown.ts) then run on that plain text exactly as
 *     they always have.
 *  2. `highlightCodeBlocks` runs after them. It reads the text back out of each
 *     marked `<code>`, highlights the whole block in one pass (so a block
 *     comment or a template string keeps its color across lines), and puts the
 *     links back where they were. Inside a link the text stays uncolored: it
 *     reads as a link, not a token.
 *
 * The buttons do nothing on their own: code-block-actions.ts owns one document
 * listener for every block on every surface.
 *
 * Relative imports only: the markdown test tier runs this in a bare node env.
 */
import { refractor } from 'refractor';
import tsx from 'refractor/lang/tsx.js';
import jsx from 'refractor/lang/jsx.js';
import docker from 'refractor/lang/docker.js';
import toml from 'refractor/lang/toml.js';
import graphql from 'refractor/lang/graphql.js';
import powershell from 'refractor/lang/powershell.js';
import hcl from 'refractor/lang/hcl.js';

for (const grammar of [tsx, jsx, docker, toml, graphql, powershell, hcl]) {
  if (!refractor.registered(grammar.displayName)) refractor.register(grammar);
}

/** A block longer than this has only its head (this much) colored. Its colored markup is what
 *  every later render of the message re-parses (a streaming reply re-renders
 *  the whole message on each delta), so the cap bounds that cost. */
export const MAX_HIGHLIGHT_CHARS = 30_000;
/** A block whose closing fence has not arrived is the one still streaming: it
 *  changes on every delta, so only its first lines (up to this many chars, cut
 *  at a line end) are colored, a prefix that stops changing and is cached; the
 *  rest is colored the moment the fence closes (a block over
 *  MAX_HIGHLIGHT_CHARS keeps the colored head). Colors never disappear. */
export const MAX_OPEN_HIGHLIGHT_CHARS = 4_000;

/** Fence words Prism does not know by that name. */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript', js: 'javascript', py: 'python', sh: 'bash', shell: 'bash', yml: 'yaml',
  md: 'markdown', rb: 'ruby', cs: 'csharp', dotnet: 'csharp', kt: 'kotlin', kts: 'kotlin',
  objc: 'objectivec', ino: 'arduino',
  zsh: 'bash', console: 'bash', 'shell-session': 'bash', shellsession: 'bash', terminal: 'bash',
  jsonc: 'json', json5: 'json', jsonl: 'json', ndjson: 'json',
  dockerfile: 'docker', containerfile: 'docker',
  rs: 'rust', golang: 'go', 'c++': 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'c',
  mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript',
  ps1: 'powershell', pwsh: 'powershell', ps: 'powershell',
  tf: 'hcl', terraform: 'hcl', gql: 'graphql', htm: 'html', vue: 'markup',
  patch: 'diff', make: 'makefile', mk: 'makefile', cfg: 'ini', conf: 'ini',
  pyi: 'python', python3: 'python', rake: 'ruby', gemspec: 'ruby',
};

/** File extensions a fence word written as a file name maps to (`app.py`). */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  mts: 'typescript', cts: 'typescript', py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', lua: 'lua', pl: 'perl', r: 'r', sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', css: 'css',
  scss: 'scss', sass: 'sass', less: 'less', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  vue: 'markup', md: 'markdown', mdx: 'markdown', sql: 'sql', diff: 'diff', patch: 'diff',
  graphql: 'graphql', gql: 'graphql', tf: 'hcl', ps1: 'powershell', m: 'objectivec',
};

/** What the header calls each grammar. Unknown fence words show as written. */
const LANG_LABELS: Record<string, string> = {
  typescript: 'TypeScript', tsx: 'TSX', javascript: 'JavaScript', jsx: 'JSX', python: 'Python',
  bash: 'Shell', json: 'JSON', yaml: 'YAML', toml: 'TOML', ini: 'INI', css: 'CSS', scss: 'SCSS',
  sass: 'Sass', less: 'Less', go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', swift: 'Swift',
  c: 'C', cpp: 'C++', csharp: 'C#', ruby: 'Ruby', php: 'PHP', lua: 'Lua', perl: 'Perl', r: 'R',
  sql: 'SQL', diff: 'Diff', markdown: 'Markdown', makefile: 'Makefile', objectivec: 'Objective-C',
  docker: 'Dockerfile', graphql: 'GraphQL', powershell: 'PowerShell', hcl: 'HCL', regex: 'Regex',
  basic: 'BASIC', vbnet: 'VB.NET', arduino: 'Arduino',
};

/** The markup grammar covers several languages; name the one the fence named. */
const MARKUP_LABELS: Record<string, string> = { html: 'HTML', htm: 'HTML', xml: 'XML', svg: 'SVG', vue: 'Vue', markup: 'HTML', mathml: 'MathML', rss: 'RSS', atom: 'Atom' };

const PLAIN_WORDS = new Set(['text', 'txt', 'plain', 'plaintext', 'output', 'log', 'none']);

export interface FenceInfo {
  /** Prism grammar to highlight with, or null (plain). */
  grammar: string | null;
  /** Header label; '' when the fence named nothing. */
  label: string;
  /** The language word for `class="language-…"`, as marked writes it. */
  classLang: string;
  /** A file name the fence named (```` ```src/app.ts ````, ```` ```ts title="app.ts" ````). */
  title: string | null;
}

function grammarFor(word: string): string | null {
  const w = word.toLowerCase();
  if (!w || PLAIN_WORDS.has(w)) return null;
  const aliased = LANG_ALIASES[w] ?? w;
  return refractor.registered(aliased) ? aliased : null;
}

function labelFor(word: string, grammar: string | null): string {
  const w = word.toLowerCase();
  if (!w) return '';
  // A word no language is called (stray punctuation, markup) names nothing.
  if (!/^[\w+#.\-]{1,32}$/.test(word)) return 'Text';
  if (PLAIN_WORDS.has(w)) return 'Text';
  if (grammar === 'markup') return MARKUP_LABELS[w] ?? word;
  // `markup` is a sibling of html/xml in Prism's alias list, so html and friends
  // resolve to their own names there; fold them back.
  if (MARKUP_LABELS[w]) return MARKUP_LABELS[w]!;
  return (grammar && LANG_LABELS[grammar]) || word;
}

function looksLikeFileName(word: string): boolean {
  return /[./]/.test(word) && /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(word) && !/^\.+$/.test(word);
}

/**
 * Read a fence's info string. Accepts what models write: `ts`, `TypeScript`,
 * `ts title="src/app.ts"`, `ts:src/app.ts`, `src/app.ts`, `{.python}`.
 */
export function parseFenceInfo(info: string | undefined): FenceInfo {
  const raw = (info ?? '').trim();
  let first = (raw.match(/^\S*/)?.[0] ?? '').replace(/^\{\.?|\}$/g, '');
  let title: string | null = raw.match(/\btitle=(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean) ?? null;
  const colon = first.indexOf(':');
  if (colon > 0 && looksLikeFileName(first.slice(colon + 1))) {
    title = first.slice(colon + 1);
    first = first.slice(0, colon);
  }
  if (looksLikeFileName(first) && !grammarFor(first)) {
    title = first;
    const ext = first.split('.').pop()!.toLowerCase();
    const grammar = EXT_LANG[ext] && refractor.registered(EXT_LANG[ext]!) ? EXT_LANG[ext]! : null;
    return { grammar, label: grammar ? labelFor(ext, grammar) : ext.toUpperCase(), classLang: ext, title };
  }
  const grammar = grammarFor(first);
  return { grammar, label: labelFor(first, grammar), classLang: first, title };
}

const ESC_FULL: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** The same escape marked applies to code text (quotes too). */
function escapeCode(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_FULL[c]!);
}

// Lucide's "wrap-text" and "copy" glyphs (ISC license), inline so the frame is
// one string with no component behind it.
const ICON_ATTRS = 'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const WRAP_ICON = `<svg class="md-code-icon" ${ICON_ATTRS}><path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/></svg>`;
const COPY_ICON = `<svg class="md-code-icon md-code-icon-copy" ${ICON_ATTRS}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const FOLD_ICON = `<svg class="md-code-icon" ${ICON_ATTRS}><path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/></svg>`;
const CHECK_ICON = `<svg class="md-code-icon md-code-icon-done" ${ICON_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>`;

/** The Wrap button's name (per block; `aria-pressed` says whether it is on). */
export const WRAP_LABEL = 'Wrap long lines';

/** A finished block longer than this many lines opens folded. */
export const COLLAPSE_LINES = 50;

/** Blocks drawn so far in the current message render (`beginCodeBlockRender`). */
let blockOrdinal = 0;

/** Called before each message's markdown is parsed: a block's key counts from
 *  the first block of its message. */
export function beginCodeBlockRender(): void {
  blockOrdinal = 0;
}

/** FNV-1a, base 36: short, and only [0-9a-z] (safe in an attribute selector). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Which block this is, stable while it streams and across re-renders: its
 * place in the message, its fence word and its first line. A streaming reply
 * rebuilds every block on each delta, so this is what a block's own Wrap
 * state hangs on (code-block-actions.ts).
 */
export function codeBlockKey(ordinal: number, info: string, code: string): string {
  const nl = code.indexOf('\n');
  return `${ordinal}-${hash(info + '\n' + (nl < 0 ? code : code.slice(0, nl)))}`;
}

/** True when a fenced block's source has no closing fence yet (still streaming). */
export function isFenceOpen(raw: string): boolean {
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
  if (!open) return false; // an indented block has no fence to close
  const lines = raw.replace(/\n+$/, '').split('\n');
  if (lines.length < 2) return true;
  const last = lines[lines.length - 1]!.trim();
  const ch = open[1]![0]!;
  return !(last.length >= open[1]!.length && [...last].every((c) => c === ch));
}

/**
 * marked `code` renderer output for the in-app render: header + `<pre>`.
 * `escaped` is marked's flag for text a tokenizer already escaped.
 */
export function renderCodeBlockFrame(text: string, info: string | undefined, escaped?: boolean, raw?: string): string {
  const fence = parseFenceInfo(info);
  // Trailing blank lines are not drawn (an empty last row) or copied.
  const code = text.replace(/(?:\n[ \t]*)+$/, '') + '\n';
  const key = codeBlockKey(blockOrdinal++, (info ?? '').trim(), code);
  const body = escaped ? code : escapeCode(code);
  const cls = fence.classLang ? ` class="language-${escapeCode(fence.classLang)}"` : '';
  const partial = !!fence.grammar && code.length > MAX_OPEN_HIGHLIGHT_CHARS && raw !== undefined && isFenceOpen(raw);
  // Every block is marked for the final pass (code-block's highlightCodeBlocks):
  // a grammar colors it, '' leaves it plain.
  const hl = ` data-hl="${fence.grammar ?? ''}"${partial ? ' data-hl-open=""' : ''}`;
  // Finished and over the coloring cap: its head is colored, the rest plain
  // (highlightCodeBlocks); the header says so, or the plain part reads broken.
  const colorNote = !!fence.grammar && !partial && body.length > MAX_HIGHLIGHT_CHARS
    ? '<span class="md-code-note" title="Too long to color whole: the first lines are colored.">Colored in part</span>'
    : '';
  const empty = code.trim() === '';
  // A long finished block opens folded (code-block-actions.ts decides, and
  // keeps one the reader watched stream in open); one still streaming never is.
  const lines = code.split('\n').length - 1;
  const open = raw !== undefined && isFenceOpen(raw);
  const long = !open && lines > COLLAPSE_LINES;
  const more = long
    ? `<button type="button" class="md-code-more" data-md-code-action="expand" data-find-skip="">Show all ${lines.toLocaleString('en-US')} lines</button>`
    : '';
  // A fence with no language still names what it is, so no header reads empty.
  // A file name gives way from its folders first: the file itself stays.
  let label: string;
  if (fence.title) {
    // `src/very/deep` + `/app.tsx`: cut short, it reads `src/ve…/app.tsx`.
    const slash = fence.title.lastIndexOf('/');
    const split = slash > 0 && slash < fence.title.length - 1;
    const dir = split ? `<span class="md-code-lang-dir">${escapeCode(fence.title.slice(0, slash))}</span>` : '';
    const base = escapeCode(split ? fence.title.slice(slash) : fence.title);
    const tip = escapeCode(fence.label ? `${fence.title} (${fence.label})` : fence.title);
    label = `<span class="md-code-lang md-code-lang-file" title="${tip}">${dir}<span class="md-code-lang-base">${base}</span></span>`;
  } else {
    label = `<span class="md-code-lang">${escapeCode(fence.label || 'Text')}</span>`;
  }
  // Drawn unwrapped: the message's HTML is cached and reused, so a block's
  // own Wrap state is applied to the element (code-block-actions.ts).
  const wrapLabel = WRAP_LABEL;
  // Each Copy says which block it copies (a screen reader's list of buttons
  // shows ten of them otherwise, all alike).
  const copyName = escapeCode(fence.title ? `Copy ${fence.title}` : fence.label ? `Copy ${fence.label} code` : 'Copy code');
  return `<div class="md-code" data-md-code-key="${key}"${empty ? ' data-empty=""' : ''}${open ? ' data-open=""' : ''}${long ? ' data-long=""' : ''}>`
    + '<div class="md-code-head" data-find-skip="">'
    + label
    + colorNote
    // Copy's outcome, read out by screen readers; shown when a copy failed.
    + '<span class="md-code-status" role="status" aria-live="polite"></span>'
    + '<span class="md-code-actions">'
    // A long block, unfolded: fold it again from wherever the reader is (the
    // header is stuck to the top of the screen through the whole block).
    + (long ? `<button type="button" class="md-code-btn md-code-fold" data-md-code-action="fold" title="Show fewer lines">${FOLD_ICON}<span class="md-code-btn-label">Fold</span></button>` : '')
    + `<button type="button" class="md-code-btn md-code-wrap" data-md-code-action="wrap" aria-pressed="false" aria-label="${wrapLabel}" title="${wrapLabel}">${WRAP_ICON}<span class="md-code-btn-label">Wrap</span></button>`
    + `<button type="button" class="md-code-btn md-code-copy" data-md-code-action="copy" aria-label="${copyName}" title="Copy code">${COPY_ICON}${CHECK_ICON}<span class="md-code-copy-label md-code-btn-label">Copy</span></button>`
    + '</span></div>'
    // Focusable, so a keyboard reaches a block's sideways scroll.
    + `<pre tabindex="0"><code${cls}${hl}>${body}</code></pre>${more}</div>\n`;
}

// ── Highlighting ────────────────────────────────────────────────────────────

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

// The browser's serializer writes U+00A0 as &nbsp; (code pasted from a web
// page or a chat app is full of them); the rest are what it and marked emit.
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function unescapeHtml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}

const VOID_TAGS = /^<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i;

/** One tag, quotes respected: an older engine's serializer leaves `>` raw in
 *  an attribute value, and a tag cut there would turn the rest of the
 *  attribute into "text". A `<` that starts no whole tag is text. */
const TAG_OR_TEXT_RE = /<(?:[^>"']|"[^"]*"|'[^']*')*>|<|[^<]+/g;

/** Prism token types code-block.css gives a color (or weight). Keep in step. */
const STYLED_TOKENS = new Set([
  'comment', 'prolog', 'doctype', 'cdata', 'keyword', 'atrule', 'important', 'rule',
  'string', 'char', 'attr-value', 'template-string', 'regex', 'inserted',
  'number', 'boolean', 'constant', 'symbol', 'property', 'entity', 'url', 'selector', 'attr-name', 'deleted',
  'function', 'class-name', 'builtin', 'variable', 'parameter', 'tag', 'bold', 'italic',
  'coord',
]);

/**
 * Highlight one block's inner HTML (escaped code text plus the anchors earlier
 * passes put in it). Returns null when the grammar throws.
 */
export function highlightCodeInner(inner: string, grammar: string): string | null {
  // Text runs (escaped) and tags, with each tag's offset in the decoded text.
  const tags: { at: number; html: string; open: boolean; close: boolean }[] = [];
  let raw = '';
  for (const m of inner.matchAll(TAG_OR_TEXT_RE)) {
    const part = m[0];
    if (part[0] === '<' && part.length > 1) {
      const close = part.startsWith('</');
      const open = !close && !part.endsWith('/>') && !VOID_TAGS.test(part);
      tags.push({ at: raw.length, html: part, open, close });
    } else {
      raw += unescapeHtml(part);
    }
  }
  let root: { children: HastNode[] };
  try {
    root = refractor.highlight(raw, grammar) as unknown as { children: HastNode[] };
  } catch {
    return null;
  }

  // Only token types the stylesheet colors become spans (punctuation and
  // operators keep the block's own ink), adjacent runs of one type share a span,
  // and spans nest as the grammar nests them. A 25KB block was 10,800 spans and
  // 466KB of markup when every text run carried its full span chain; the DOM
  // size, not the grammar, was what a streaming reply paid for on every delta.
  let out = '';
  let pos = 0;
  let nextTag = 0;
  let linkDepth = 0;
  let emitted: string[] = [];
  const sync = (target: string[]) => {
    let k = 0;
    while (k < emitted.length && k < target.length && emitted[k] === target[k]) k++;
    if (emitted.length > k) out += '</span>'.repeat(emitted.length - k);
    for (let j = k; j < target.length; j++) out += `<span class="token ${target[j]}">`;
    emitted = target.slice();
  };
  const emitTagsAt = (at: number) => {
    while (nextTag < tags.length && tags[nextTag]!.at === at) {
      const t = tags[nextTag++]!;
      // A tag never sits inside a token span: close them, reopen after.
      sync([]);
      if (t.close) linkDepth = Math.max(0, linkDepth - 1);
      out += t.html;
      if (t.open) linkDepth++;
    }
  };
  const stack: string[] = [];
  const emitText = (text: string) => {
    let i = 0;
    while (i < text.length) {
      emitTagsAt(pos);
      const limit = nextTag < tags.length ? Math.min(text.length, i + tags[nextTag]!.at - pos) : text.length;
      const piece = text.slice(i, limit);
      // Inside an anchor the text keeps the link's color, not a token's.
      // Whitespace keeps whatever is open, so `a b` of one type stays one span.
      if (linkDepth > 0) sync([]);
      else if (/\S/.test(piece)) sync(stack);
      // Quotes too: text never closes an attribute, whatever came before it.
      out += escapeCode(piece);
      pos += piece.length;
      i = limit;
    }
  };
  const walk = (nodes: HastNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text') emitText(n.value ?? '');
      else if (n.type === 'element') {
        const type = (n.properties?.className ?? []).find((c) => STYLED_TOKENS.has(c));
        if (type) stack.push(type);
        walk(n.children ?? []);
        if (type) stack.pop();
      }
    }
  };
  walk(root.children);
  sync([]);
  emitTagsAt(pos);
  // A tag past the decoded end cannot exist, but never drop markup silently.
  while (nextTag < tags.length) out += tags[nextTag++]!.html;
  return out;
}

const HL_CACHE_MAX = 400;
/** Characters held across keys and values; a few huge blocks must not pin
 *  tens of megabytes. */
const HL_CACHE_MAX_CHARS = 3_000_000;
/** Finished blocks are highlighted once: a streaming reply re-renders the whole
 *  message on every delta, and only its last block is still changing. */
const hlCache = new Map<string, string>();
let hlCacheChars = 0;

function cacheGet(key: string): string | undefined {
  const hit = hlCache.get(key);
  if (hit !== undefined) {
    hlCache.delete(key);
    hlCache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, value: string): void {
  hlCache.set(key, value);
  hlCacheChars += key.length + value.length;
  while (hlCache.size > HL_CACHE_MAX || hlCacheChars > HL_CACHE_MAX_CHARS) {
    const oldest = hlCache.keys().next().value;
    if (oldest === undefined) break;
    hlCacheChars -= oldest.length + hlCache.get(oldest)!.length;
    hlCache.delete(oldest);
  }
}

const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const MARKED_CODE_RE = new RegExp(`(<code\\b${ATTRS}?\\sdata-hl="([\\w-]*)"${ATTRS}>)([\\s\\S]*?)(<\\/code>)`, 'g');

/** A hyphen and the character after it, in text (never inside a tag). */
const HYPHEN_RE = /-([^\s&<>-])/gu;
/** A slash between two parts of a path or URL (`a/b`, not `// x` or `/abs`). */
const SLASH_RE = /(?<=[^\s/<>]\/)(?=[^\s/&<>])/g;

/**
 * Keep each hyphen with what follows it, so a wrapped line never breaks after
 * one: `-benchtime` split as `-` / `benchtime` reads as two arguments, as a
 * path split at `marina-` reads as two. The pair is one unbreakable span
 * (code-block.css `.md-code-nb`); the text is unchanged.
 * And a long path or URL may break after a slash, as an editor's word wrap
 * does, so it fills the line it starts on instead of leaving `//` alone on
 * one line (a <wbr>: nothing in the text, nothing copied).
 */
export function keepHyphens(inner: string): string {
  if (!inner.includes('-') && !inner.includes('/')) return inner;
  return nameBrokenLinks(keepHyphensIn(inner));
}

/** A link whose text now holds break points keeps its plain text as its name:
 *  a screen reader reads a <wbr> as a pause. */
function nameBrokenLinks(html: string): string {
  if (!html.includes('<wbr>')) return html;
  return html.replace(/<a\b([^>]*)>((?:(?!<\/a>)[\s\S])*<wbr>(?:(?!<\/a>)[\s\S])*)<\/a>/g, (all, attrs: string, text: string) => {
    if (/\saria-label=/.test(attrs)) return all;
    const name = text.replace(/<[^>]*>/g, '').replace(/"/g, '&quot;');
    return `<a${attrs} aria-label="${name}">${text}</a>`;
  });
}

function keepHyphensIn(inner: string): string {
  let out = '';
  // A path or URL link wraps like the code around it; a pill (a task, a
  // letter) is left as its pass wrote it.
  const pills: boolean[] = [];
  for (const m of inner.matchAll(TAG_OR_TEXT_RE)) {
    const part = m[0];
    if (part[0] === '<' && part.length > 1) {
      if (/^<a[\s>]/i.test(part)) pills.push(/\bclass="[^"]*\b(?:task|letter)/i.test(part));
      else if (/^<\/a>/i.test(part)) pills.pop();
      out += part;
    } else {
      out += pills.includes(true)
        ? part
        : part.replace(SLASH_RE, '<wbr>').replace(HYPHEN_RE, '<span class="md-code-nb">-$1</span>');
    }
  }
  return out;
}

/** Each line's leading indent in columns (a tab to the next stop of 4). */
function lineIndents(text: string, diff = false): number[] {
  return text.split('\n').map((l) => {
    let n = 0;
    // A diff line's own code starts after its +, - or space.
    if (diff && /^[+\- ]/.test(l)) {
      n = 1;
      l = l.slice(1);
    }
    for (const c of l) {
      if (c === ' ') n++;
      else if (c === '\t') n += 4 - (n % 4);
      else break;
    }
    return Math.min(n, 40);
  });
}

/**
 * Wrap each line in a span that knows its own indent (`--in`, columns), so a
 * wrapped line's continuation starts deeper than the line itself
 * (code-block.css `.md-code-ln`). Unwrapped, the spans are plain inline boxes
 * and change nothing. Spans open across a newline (a block comment, a string)
 * are closed at the line's end and reopened on the next; the newline itself
 * stays outside every span, so the text is unchanged.
 */
export function markLines(inner: string, grammar = ''): string {
  const parts = [...inner.matchAll(TAG_OR_TEXT_RE)].map((m) => m[0]);
  const isTag = (p: string) => p[0] === '<' && p.length > 1;
  const text = parts.filter((p) => !isTag(p)).map(unescapeHtml).join('');
  const indents = lineIndents(text, grammar === 'diff');
  // A diff's added and removed lines are tinted across the block (not just
  // behind their text), as a diff view shows them.
  const kinds = grammar === 'diff'
    ? text.split('\n').map((l) => (/^\+(?!\+\+ )/.test(l) ? ' md-code-ln-add' : /^-(?!-- )/.test(l) ? ' md-code-ln-del' : ''))
    : null;
  let out = '';
  let line = 0;
  let inLine = false;
  const stack: { open: string; name: string }[] = [];
  const openLine = () => {
    out += `<span class="md-code-ln${kinds?.[line] ?? ''}" style="--in:${indents[line] ?? 0}">`;
    for (const t of stack) out += t.open;
    inLine = true;
  };
  const closeLine = () => {
    for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]!.name}>`;
    out += '</span>';
    inLine = false;
  };
  for (const part of parts) {
    if (isTag(part)) {
      if (part.startsWith('</')) {
        stack.pop();
        // Closed right at a line's end: closeLine already wrote it.
        if (inLine) out += part;
      } else {
        if (!inLine) openLine();
        out += part;
        if (!part.endsWith('/>') && !VOID_TAGS.test(part)) {
          stack.push({ open: part, name: /^<([a-zA-Z][\w-]*)/.exec(part)?.[1] ?? 'span' });
        }
      }
      continue;
    }
    const segs = part.split('\n');
    segs.forEach((seg, i) => {
      if (i > 0) {
        if (inLine) closeLine();
        out += '\n';
        line++;
      }
      if (seg) {
        if (!inLine) openLine();
        out += seg;
      }
    });
  }
  if (inLine) closeLine();
  return out;
}

/** Above this many lines a block gets no per-line spans: thousands of line
 *  boxes made Wrap on a 5,000-line block take a second. Its wrapped lines
 *  just start at the left edge. */
const MAX_MARKED_LINES = 1500;

/** Everything the final pass does to a block's (colored or plain) markup. */
function shapeLines(inner: string, grammar = ''): string {
  let lines = 0;
  for (let i = inner.indexOf('\n'); i >= 0 && lines <= MAX_MARKED_LINES; i = inner.indexOf('\n', i + 1)) lines++;
  return keepHyphens(lines > MAX_MARKED_LINES ? inner : markLines(inner, grammar));
}

/** Color every block `renderCodeBlockFrame` marked, mark its lines and keep
 *  its hyphens joined. Leaves the rest alone. */
export function highlightCodeBlocks(html: string): string {
  if (!html.includes('data-hl="')) return html;
  return html.replace(MARKED_CODE_RE, (full, open: string, grammar: string, inner: string, close: string) => {
    if (!grammar) return open + shapeLines(inner) + close;
    const streaming = open.includes('data-hl-open');
    if (streaming || inner.length > MAX_HIGHLIGHT_CHARS) {
      // Still streaming: color the stable head (cached as the block grows).
      // Too big to color whole: color as much as the cap allows, which is
      // never less than the block showed while streaming. The rest is plain;
      // the cut is at a newline outside any tag.
      const cut = inner.lastIndexOf('\n', streaming ? MAX_OPEN_HIGHLIGHT_CHARS : MAX_HIGHLIGHT_CHARS);
      if (cut <= 0 || inner.lastIndexOf('<', cut) > inner.lastIndexOf('>', cut)) return open + shapeLines(inner) + close;
      return open + colorInner(inner.slice(0, cut + 1), grammar) + shapeLines(inner.slice(cut + 1)) + close;
    }
    return open + colorInner(inner, grammar) + close;
  });
}

function colorInner(inner: string, grammar: string): string {
  const key = `${grammar}\0${inner}`;
  let colored = cacheGet(key);
  if (colored === undefined) {
    colored = shapeLines(highlightCodeInner(inner, grammar) ?? inner, grammar);
    cachePut(key, colored);
  }
  return colored;
}
