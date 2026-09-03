/**
 * Rich clipboard → markdown for plain <textarea> composers.
 *
 * A textarea only ever sees `text/plain`, and the plain flavour a rich editor
 * (an internal wiki, Google Docs, Confluence, a rendered README) puts on the
 * clipboard is lossy: list markers, nesting and headings are gone, and every
 * block is padded with blank lines. The `text/html` flavour beside it still
 * has the structure, so we walk that DOM and write it back out as markdown.
 *
 * Deliberately conservative: only kicks in when the HTML carries structure a
 * textarea would lose (lists, headings, tables, code blocks, quotes). Prose-only
 * HTML (and syntax-coloured `<div><span>` code from editors) returns null so the
 * browser's native paste, with its undo stack, handles it.
 */

/** Block structure that text/plain cannot carry. */
const STRUCTURAL_SELECTOR = 'ul, ol, table, h1, h2, h3, h4, h5, h6, pre, blockquote';

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'figure', 'figcaption', 'address', 'dl', 'dt', 'dd', 'details', 'summary', 'form', 'fieldset',
]);

const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'template', 'noscript', 'svg', 'button', 'select', 'textarea']);

/**
 * Private-use sentinels. Whitespace normalisation trims spaces and tabs from
 * line edges, so list indentation is written as INDENT and fenced code blocks
 * are parked in `verbatim` behind a SLOT token; both are resolved last.
 */
const SLOT = '\uE000';
const INDENT = '\uE001';

type Render = { verbatim: string[] };

function slot(r: Render, text: string): string {
  r.verbatim.push(text);
  return `${SLOT}${r.verbatim.length - 1}${SLOT}`;
}

function tagOf(node: Node): string {
  return (node as Element).tagName?.toLowerCase() ?? '';
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function styleOf(el: Element): string {
  return (el.getAttribute('style') ?? '').toLowerCase();
}

/** Google Docs wraps the whole selection in `<b style="font-weight:normal">`. */
function isFakeBold(el: Element): boolean {
  return /font-weight:\s*(normal|400)\b/.test(styleOf(el));
}

function isHidden(el: Element): boolean {
  return /display:\s*none/.test(styleOf(el)) || el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true';
}

function codeLanguage(el: Element): string {
  const cls = `${el.getAttribute('class') ?? ''} ${el.firstElementChild?.getAttribute('class') ?? ''}`;
  return /(?:^|\s)(?:language|lang)-([\w#+-]+)/.exec(cls)?.[1] ?? '';
}

/** Wrap inline content in a mark, keeping the surrounding spaces outside it. */
function mark(inner: string, token: string): string {
  if (inner.includes('\n')) return inner;
  const lead = /^\s/.test(inner) ? ' ' : '';
  const tail = /\s$/.test(inner) ? ' ' : '';
  const core = inner.trim();
  if (!core) return inner;
  return `${lead}${token}${core}${token}${tail}`;
}

function inlineCode(text: string): string {
  const fence = text.includes('`') ? '``' : '`';
  const pad = /^`|`$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function fencedCode(text: string, lang: string): string {
  const body = text.replace(/\r/g, '').replace(/^\n+|\n+$/g, '');
  const ticks = /```/.test(body) ? '````' : '```';
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function renderChildren(node: Node, r: Render): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) out += renderNode(child, r);
  return out;
}

function renderNode(node: Node, r: Render): string {
  if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ');
  if (!isElement(node)) return '';
  const tag = tagOf(node);
  if (SKIP_TAGS.has(tag) || isHidden(node)) return '';

  switch (tag) {
    case 'br': return '\n';
    case 'hr': return '\n\n---\n\n';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const text = renderChildren(node, r).replace(/\n+/g, ' ').trim();
      return text ? `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n` : '';
    }
    case 'ul': case 'ol': return `\n\n${renderList(node, r)}\n\n`;
    case 'li': return `\n\n${renderList(node.parentNode as Element, r, [node])}\n\n`;
    case 'pre': return `\n\n${slot(r, fencedCode(node.textContent ?? '', codeLanguage(node)))}\n\n`;
    case 'code': case 'kbd': case 'samp': {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      return text ? inlineCode(text) : '';
    }
    case 'strong': case 'b': {
      const inner = renderChildren(node, r);
      return isFakeBold(node) ? inner : mark(inner, '**');
    }
    case 'em': case 'i': case 'cite': case 'dfn': case 'var': return mark(renderChildren(node, r), '*');
    case 's': case 'del': case 'strike': return mark(renderChildren(node, r), '~~');
    case 'a': {
      const text = renderChildren(node, r).replace(/\s+/g, ' ').trim();
      const href = (node.getAttribute('href') ?? '').trim();
      if (!/^(https?:|mailto:)/i.test(href)) return text;
      if (!text || text === href || text === href.replace(/^mailto:/i, '')) return href;
      return `[${text}](${href})`;
    }
    case 'img': {
      const src = node.getAttribute('src') ?? '';
      const alt = (node.getAttribute('alt') ?? '').trim();
      // data: URIs are megabytes of base64; the alt text is all a textarea wants.
      return /^https?:/i.test(src) ? `![${alt}](${src})` : alt;
    }
    case 'input': {
      if ((node.getAttribute('type') ?? '').toLowerCase() !== 'checkbox') return '';
      return node.getAttribute('checked') !== null ? '[x] ' : '[ ] ';
    }
    case 'blockquote': {
      const inner = normalise(renderChildren(node, r), 'block');
      return inner ? `\n\n${inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n` : '';
    }
    case 'table': return `\n\n${renderTable(node, r)}\n\n`;
    case 'tr': case 'td': case 'th': case 'thead': case 'tbody': case 'tfoot': case 'caption':
      return `${renderChildren(node, r)} `;
    default:
      return BLOCK_TAGS.has(tag) ? `\n\n${renderChildren(node, r)}\n\n` : renderChildren(node, r);
  }
}

/** Render a list. `only` renders a stray <li> whose parent isn't a list. */
function renderList(list: Element, r: Render, only?: Element[]): string {
  const ordered = tagOf(list) === 'ol';
  let n = Number.parseInt(list.getAttribute('start') ?? '1', 10) || 1;
  const items = only ?? Array.from(list.children).filter((c) => tagOf(c) === 'li');
  const lines: string[] = [];
  for (const li of items) {
    if (isHidden(li)) continue;
    const marker = ordered ? `${n++}. ` : '- ';
    const body = normalise(renderChildren(li, r), 'list-item');
    if (!body) continue;
    const indent = INDENT.repeat(marker.length);
    lines.push(body.split('\n').map((l, i) => (i === 0 ? marker + l : l ? indent + l : l)).join('\n'));
  }
  return lines.join('\n');
}

function renderTable(table: Element, r: Render): string {
  const rows = Array.from(table.querySelectorAll('tr'))
    .filter((tr) => tr.closest('table') === table)
    .map((tr) => Array.from(tr.children)
      .filter((c) => tagOf(c) === 'td' || tagOf(c) === 'th')
      .map((c) => normalise(renderChildren(c, r), 'block').replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((cells) => cells.length));
  const pad = (cells: string[]) => [...cells, ...Array<string>(width - cells.length).fill('')];
  const line = (cells: string[]) => `| ${pad(cells).join(' | ')} |`;
  const [head, ...body] = rows;
  return [line(head), `| ${Array<string>(width).fill('---').join(' | ')} |`, ...body.map(line)].join('\n');
}

/**
 * Collapse the `\n\n` block padding the walker emits into markdown spacing.
 * List items are tight (a paragraph followed by its nested list sits on the
 * next line); blocks keep one blank line between them.
 */
function normalise(text: string, mode: 'block' | 'list-item'): string {
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+$/, '').replace(/^[ \t]+/, '').replace(/ {2,}/g, ' '));
  const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return (mode === 'list-item' ? joined.replace(/\n{2,}/g, '\n') : joined).trim();
}

/** Resolve sentinels: parked verbatim blocks (indented to their list depth), then indentation. */
function restore(text: string, r: Render): string {
  return text
    .replace(new RegExp(`^(${INDENT}*)${SLOT}(\\d+)${SLOT}$`, 'gm'), (_, indent: string, i: string) =>
      (r.verbatim[Number(i)] ?? '').split('\n').map((l) => indent + l).join('\n'))
    .replace(new RegExp(INDENT, 'g'), ' ');
}

/** Whether this HTML carries structure that a plain-text paste would lose. */
export function hasBlockStructure(root: ParentNode): boolean {
  return root.querySelector(STRUCTURAL_SELECTOR) !== null;
}

/** Markdown for an already-parsed fragment. Always converts; use pastedHtmlToMarkdown for the paste gate. */
export function domToMarkdown(root: Node): string {
  const r: Render = { verbatim: [] };
  return restore(normalise(renderChildren(root, r), 'block'), r);
}

function parseHtml(html: string): ParentNode {
  return new DOMParser().parseFromString(html, 'text/html').body;
}

/**
 * The clipboard's `text/html` as markdown, or null when the native plain-text
 * paste is the better result (no structure to preserve, or nothing left after
 * conversion). `parse` is injectable so the walker can run without a browser.
 */
export function pastedHtmlToMarkdown(html: string, parse: (html: string) => ParentNode = parseHtml): string | null {
  if (!html || !/<[a-z][\s\S]*>/i.test(html)) return null;
  let root: ParentNode;
  try { root = parse(html); } catch { return null; }
  if (!hasBlockStructure(root)) return null;
  const md = domToMarkdown(root);
  return md || null;
}

/**
 * Textarea paste handler body: returns true when the paste was taken over.
 * Inserts through execCommand so the native undo stack still covers it and
 * React's onChange fires from the resulting input event; falls back to
 * setRangeText + a synthetic input event where execCommand is unsupported.
 */
export function pasteRichTextAsMarkdown(
  e: { clipboardData: DataTransfer | null; preventDefault: () => void },
  el: HTMLTextAreaElement | HTMLInputElement | null,
): boolean {
  const html = e.clipboardData?.getData('text/html');
  if (!html || !el) return false;
  const md = pastedHtmlToMarkdown(html);
  if (!md) return false;
  e.preventDefault();
  el.focus();
  let inserted = false;
  try { inserted = document.execCommand('insertText', false, md); } catch { inserted = false; }
  if (!inserted) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(md, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}
