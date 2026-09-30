/**
 * Bare task ids in rendered output become task pills.
 *
 * Sessions are told to cite a task as `<task-ref id label/>`, but a model that
 * talks about another task mostly writes the id itself: "`mpwidref-7c2e`
 * confirmed it", "written into task mpwidrf2-9b10's report" (often inside CJK
 * prose), `walnut task show mpwidref-7c2e`.
 * Each of those rendered as plain text or plain code, so the user could neither
 * tell which task it was nor open it (2026-09-29 report). This pass fixes the
 * output instead of the prompt: whatever the model writes, a known id is
 * clickable.
 *
 * Runs on marked's OUTPUT (like linkifyPathsInCode), so it adds anchors and
 * never reinterprets markdown grammar. Rules:
 *  - Only an id the client task store knows becomes a link. The store holds the
 *    whole board, completed tasks included, so an unknown id-shaped token (a
 *    UUID fragment, a hash, a deleted task) stays text; a guess is never linked.
 *  - Prose: the pill shows the task's CURRENT title, like a `<task-ref/>` pill.
 *    When that title is already written right beside the id (`id (Title)`,
 *    `Title (id)`), the pill keeps the id text so the title is not printed twice.
 *  - A code span holding only the id is the same citation in backticks: it
 *    becomes the title pill too.
 *  - An id inside longer code (a command, a table dump) is linked in place with
 *    its text unchanged: code stays what the model wrote.
 *  - Never inside an anchor (no nested links: the HTML parser splits them), nor
 *    inside elements where a link is invalid or invisible (button, textarea,
 *    svg, style, ...).
 *
 * Dependency-free on purpose: markdown.ts imports it and the markdown test tier
 * runs in a bare node env.
 */

/**
 * `pills`: conversation output, as described above. `links`: DATA (a tool's
 * input or result, injected context), where every id keeps its own text and
 * only becomes clickable: replacing an id in `"depends_on": ["<id>"]` with a
 * title would show the user data the tool never returned.
 */
export type BareTaskIdMode = 'pills' | 'links';

export interface BareTaskIdRenderer {
  /** Current title of a known task; undefined leaves the id as text. */
  title(id: string): string | undefined;
  /** Anchor HTML for one id. `label` is raw text (the renderer escapes it);
   *  `inCode` marks an in-place link inside code. */
  anchor(id: string, label: string, inCode: boolean): string;
}

/** Task id shape (`<base36 time>-<4 hex>`), standing alone: not glued to a
 *  word, a longer dashed token (UUIDs), a path segment, a file name or an
 *  address. */
const ID_SRC = '(?<![\\w\\-./@#])[a-z0-9]{7,10}-[a-f0-9]{4}(?![\\w\\-/@]|\\.\\w)';
const ID_HINT_RE = new RegExp(ID_SRC);
const WHOLE_ID_RE = /^\s*([a-z0-9]{7,10}-[a-f0-9]{4})\s*$/;

/** Elements whose text must not grow an anchor: interactive controls (an
 *  anchor inside is invalid), raw-text elements, and foreign content. */
const NO_LINK_ELEMENTS = new Set([
  'button', 'textarea', 'select', 'option', 'script', 'style', 'svg', 'math',
  'title', 'noscript', 'template', 'iframe', 'object', 'label',
]);

/** A tag, quote-aware: a `>` inside an attribute value (`title="a > b"`) does
 *  not end it, or the rest of the value would be read as text and linked. */
const TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const TAG_NAME_RE = /^<\/?([a-zA-Z][\w-]*)/;
/** Open `<a …>` that is not self-closing. */
const A_OPEN_RE = /<a(?:>|\s[^>]*[^/>]>)/gi;

/** How far beside the id to look for its title (beyond the title's length). */
const BESIDE_SLACK = 6;
/** Title prefix that has to appear beside the id to count as "already written". */
const BESIDE_PREFIX = 24;

type Part = { tag: boolean; s: string; at: number };

function splitHtml(html: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html)) !== null) {
    if (m.index > last) parts.push({ tag: false, s: html.slice(last, m.index), at: last });
    parts.push({ tag: true, s: m[0], at: m.index });
    last = m.index + m[0].length;
  }
  if (last < html.length) parts.push({ tag: false, s: html.slice(last), at: last });
  return parts;
}

/**
 * Byte ranges covered by anchors: every complete `<a …>…</a>` pair, plus an
 * unclosed open `<a …>` (a raw anchor still streaming in) to the end of the text.
 * Pairs, not a running open/close count, so a stray `</a>` or a self-closing
 * `<a/>` in model HTML cannot switch linking off for the rest of the message.
 */
function anchorRanges(html: string): [number, number][] {
  const ranges: [number, number][] = [];
  const lower = html.toLowerCase();
  A_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = A_OPEN_RE.exec(html)) !== null) {
    const close = lower.indexOf('</a>', m.index + m[0].length);
    const end = close === -1 ? html.length : close + 4;
    ranges.push([m.index, end]);
    A_OPEN_RE.lastIndex = end;
  }
  return ranges;
}

function decodeText(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
}

function norm(s: string): string {
  return decodeText(s).toLowerCase().replace(/\s+/g, ' ');
}

/** Is the task's title already written right before or right after the id? */
function titleIsBeside(title: string, before: string, after: string): boolean {
  const t = norm(title).trim();
  const head = t.slice(0, BESIDE_PREFIX);
  if (head.length < 4) return false;
  const a = norm(after).slice(0, head.length + BESIDE_SLACK);
  const b = norm(before).slice(-(t.length + BESIDE_SLACK));
  return a.includes(head) || b.includes(head);
}

export function linkBareTaskIds(html: string, r: BareTaskIdRenderer, mode: BareTaskIdMode = 'pills'): string {
  const pills = mode === 'pills';
  if (!ID_HINT_RE.test(html)) return html;
  const parts = splitHtml(html);
  const anchors = anchorRanges(html);
  let nextAnchor = 0;
  const inAnchor = (at: number): boolean => {
    while (nextAnchor < anchors.length && anchors[nextAnchor]![1] <= at) nextAnchor++;
    const a = anchors[nextAnchor];
    return !!a && a[0] <= at && at < a[1];
  };

  /**
   * The pill's label: the title, or the id when the title is already written
   * beside it. `first`/`last` are the parts the id occupies; `before`/`after`
   * are the rest of its own text part. The walk over neighbouring text parts is
   * bounded: it stops once it has enough characters to compare.
   */
  const pillLabel = (id: string, title: string, first: number, last: number, before: string, after: string): string => {
    const need = title.length + BESIDE_SLACK + 8;
    let b = before;
    for (let j = first - 1; j >= 0 && b.length < need; j--) if (!parts[j]!.tag) b = parts[j]!.s + b;
    let a = after;
    for (let j = last + 1; j < parts.length && a.length < need; j++) if (!parts[j]!.tag) a += parts[j]!.s;
    return titleIsBeside(title, b, a) ? id : title;
  };

  let codeDepth = 0;
  let noLinkDepth = 0;
  let changed = false;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.tag) {
      const name = TAG_NAME_RE.exec(p.s)?.[1]?.toLowerCase();
      const closing = p.s.startsWith('</');
      const selfClosing = p.s.endsWith('/>');
      if (name === 'code' || name === 'pre') {
        if (closing) codeDepth = Math.max(0, codeDepth - 1);
        else if (!selfClosing) {
          // `<code>id</code>` outside a <pre>: the id cited in backticks. The
          // pill replaces the whole span.
          const text = parts[i + 1];
          const close = parts[i + 2];
          const whole = pills && name === 'code' && codeDepth === 0 && noLinkDepth === 0
            && text && !text.tag && close?.tag && /^<\/code>$/i.test(close.s)
            ? WHOLE_ID_RE.exec(text.s) : null;
          const title = whole && !inAnchor(p.at) ? r.title(whole[1]!) : undefined;
          if (whole && title !== undefined) {
            const id = whole[1]!;
            out.push(r.anchor(id, pillLabel(id, title, i, i + 2, '', ''), false));
            changed = true;
            i += 2;
            continue;
          }
          codeDepth++;
        }
      } else if (name && NO_LINK_ELEMENTS.has(name)) {
        if (closing) noLinkDepth = Math.max(0, noLinkDepth - 1);
        else if (!selfClosing) noLinkDepth++;
      }
      out.push(p.s);
      continue;
    }
    if (noLinkDepth > 0 || inAnchor(p.at)) { out.push(p.s); continue; }
    const text = p.s;
    const idRe = new RegExp(ID_SRC, 'g');
    let m: RegExpExecArray | null;
    let last = 0;
    let piece = '';
    while ((m = idRe.exec(text)) !== null) {
      const id = m[0];
      const title = r.title(id);
      if (title === undefined) continue;
      const end = m.index + id.length;
      const label = codeDepth > 0 || !pills
        ? id
        : pillLabel(id, title, i, i, text.slice(0, m.index), text.slice(end));
      piece += text.slice(last, m.index) + r.anchor(id, label, codeDepth > 0);
      last = end;
    }
    if (last === 0) { out.push(text); continue; }
    changed = true;
    out.push(piece + text.slice(last));
  }
  return changed ? out.join('') : html;
}
