/**
 * Task ids written in rendered output become task pills.
 *
 * Sessions are told to cite a task as `<task-ref id label/>`, but a model that
 * talks about another task mostly writes the id itself: "`mpwidref-7c2e`
 * confirmed it", "written into task mpwidrf2-9b10's report" (often inside CJK
 * prose), `walnut task show mpwidref-7c2e`, or only the id's first segment
 * ("Ask here is being changed by mvkghc5v", "the Chat order task (2ac88910)").
 * Each of those rendered as plain text, so the user could neither tell which
 * task it was nor open it (2026-09-29 and 2026-10-31 reports: "make all the
 * task ... all name so that user can click"). This pass fixes the output
 * instead of the prompt: whatever the model writes, a task it names is a pill
 * with the task's name.
 *
 * Runs on marked's OUTPUT (like linkifyPathsInCode), so it adds anchors and
 * never reinterprets markdown grammar. Rules:
 *  - The token shapes are task-id-shape.ts's (a full id, a UUID, or an id's
 *    first segment). A token links only when the renderer resolves it to a
 *    task (the client task store, else a batched server lookup that re-renders
 *    the message when it answers), so a UUID fragment, a hash, a word or a
 *    deleted task stays text; a guess is never linked.
 *  - Prose: the pill shows the task's CURRENT title, like a `<task-ref/>` pill,
 *    even when the model wrote the title beside the id: the name is what the
 *    user reads, the id is not.
 *  - A code span holding only the id is the same citation in backticks: it
 *    becomes the title pill too.
 *  - An id inside longer code (a command, a table dump) is linked in place with
 *    its text unchanged: code stays what the model wrote.
 *  - Never inside an anchor (no nested links: the HTML parser splits them), nor
 *    inside elements where a link is invalid or invisible (button, textarea,
 *    svg, style, ...).
 *
 * Dependency-free on purpose (task-id-shape.ts has no imports either):
 * markdown.ts imports it and the markdown test tier runs in a bare node env.
 */
import { isTaskTokenCandidate, TASK_TOKEN_SRC } from './task-id-shape';

/**
 * `pills`: conversation output, as described above. `links`: DATA (a tool's
 * input or result, injected context), where every id keeps its own text and
 * only becomes clickable: replacing an id in `"depends_on": ["<id>"]` with a
 * title would show the user data the tool never returned.
 */
export type BareTaskIdMode = 'pills' | 'links';

export interface BareTaskIdRenderer {
  /** The task a written token names (its full id and current title);
   *  undefined leaves the token as text. */
  resolve(token: string): { id: string; title: string } | undefined;
  /** Anchor HTML for one id. `label` is raw text (the renderer escapes it);
   *  `inCode` marks an in-place link inside code. */
  anchor(id: string, label: string, inCode: boolean): string;
}

const WHOLE_TOKEN_RE = new RegExp(`^\\s*(${TASK_TOKEN_SRC})\\s*$`);

/** Any token worth resolving in the text: the cheap test before the HTML is split. */
function hasCandidate(text: string): boolean {
  const re = new RegExp(TASK_TOKEN_SRC, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (isTaskTokenCandidate(m[0])) return true;
  return false;
}

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

export function linkBareTaskIds(html: string, r: BareTaskIdRenderer, mode: BareTaskIdMode = 'pills'): string {
  const pills = mode === 'pills';
  if (!hasCandidate(html)) return html;
  const parts = splitHtml(html);
  const anchors = anchorRanges(html);
  let nextAnchor = 0;
  const inAnchor = (at: number): boolean => {
    while (nextAnchor < anchors.length && anchors[nextAnchor]![1] <= at) nextAnchor++;
    const a = anchors[nextAnchor];
    return !!a && a[0] <= at && at < a[1];
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
            ? WHOLE_TOKEN_RE.exec(text.s) : null;
          const task = whole && isTaskTokenCandidate(whole[1]!) && !inAnchor(p.at) ? r.resolve(whole[1]!) : undefined;
          if (task) {
            out.push(r.anchor(task.id, task.title, false));
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
    const tokenRe = new RegExp(TASK_TOKEN_SRC, 'g');
    let m: RegExpExecArray | null;
    let last = 0;
    let piece = '';
    while ((m = tokenRe.exec(text)) !== null) {
      const token = m[0];
      if (!isTaskTokenCandidate(token)) continue;
      const task = r.resolve(token);
      if (!task) continue;
      // Code and data keep what was written; prose shows the name.
      const label = codeDepth > 0 || !pills ? token : task.title;
      piece += text.slice(last, m.index) + r.anchor(task.id, label, codeDepth > 0);
      last = m.index + token.length;
    }
    if (last === 0) { out.push(text); continue; }
    changed = true;
    out.push(piece + text.slice(last));
  }
  return changed ? out.join('') : html;
}
