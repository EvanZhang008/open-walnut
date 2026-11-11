/**
 * Markdown renderer for global notes — preserves checkbox <input> elements
 * so users can click to toggle them. Separate from renderNoteMarkdown()
 * which strips inputs via DOMPurify defaults.
 *
 * Viewer parity (§5 of editor-architecture): the read-only `marked` view must
 * match the editor for the custom constructs. Two post-passes run BEFORE
 * DOMPurify:
 *   - `#tag` literal text → <span class="notes-tag"> chip
 *   - a `> [!kind]` blockquote → <div class="notes-callout" data-kind>
 * Search snippets may also carry <mark> spans (BE highlight contract §1.2 #8),
 * so the DOMPurify allowlist is widened for `mark` + `class`/`data-*`.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Isolated DOMPurify instance for notes rendering.
 * Hooks are added once at module init — no global mutations, no race conditions.
 */
const notesPurify = DOMPurify();
if (notesPurify.isSupported) notesPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const CALLOUT_KINDS = new Set(['note', 'tip', 'warning', 'danger', 'info']);

// `#tag` in plain text: letter-led, not preceded by a word char (excludes C#),
// not a heading (post-pass runs on rendered HTML, headings are already <h*>).
const TAG_TEXT_RE = /(^|[\s(])#([A-Za-z][\w/-]*)/g;

/** Wrap `#tag` runs in styled chips inside text nodes (skips code/pre/a/headings). */
function wrapTags(root: HTMLElement) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let n = walker.nextNode();
  while (n) {
    const parent = (n as Text).parentElement;
    if (
      parent &&
      !parent.closest('code, pre, a, h1, h2, h3, h4, h5, h6, .notes-tag') &&
      /(^|[\s(])#[A-Za-z]/.test((n as Text).data)
    ) {
      targets.push(n as Text);
    }
    n = walker.nextNode();
  }
  for (const textNode of targets) {
    const frag = doc.createDocumentFragment();
    const data = textNode.data;
    let last = 0;
    TAG_TEXT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_TEXT_RE.exec(data)) !== null) {
      const [full, lead, name] = m;
      const start = m.index + lead.length;
      if (start > last) frag.appendChild(doc.createTextNode(data.slice(last, start)));
      const span = doc.createElement('span');
      span.className = 'notes-tag';
      span.textContent = `#${name}`;
      frag.appendChild(span);
      last = m.index + full.length;
    }
    if (last < data.length) frag.appendChild(doc.createTextNode(data.slice(last)));
    if (last > 0) textNode.replaceWith(frag);
  }
}

/** Re-tag `> [!kind]` blockquotes as styled callout divs (matches the editor). */
function wrapCallouts(root: HTMLElement) {
  const doc = root.ownerDocument;
  root.querySelectorAll('blockquote').forEach(bq => {
    const firstP = bq.querySelector('p');
    if (!firstP) return;
    // Marker is the first line; keep all body lines (see callout-node.ts — a
    // bare `.*` drops 2nd+ lines and fails to match 3+ line callouts entirely).
    const m = /^\s*\[!([A-Za-z]+)\][ \t]*\n?([\s\S]*)$/.exec(firstP.textContent ?? '');
    if (!m) return;
    const kind = m[1].toLowerCase();
    if (!CALLOUT_KINDS.has(kind)) return;

    const div = doc.createElement('div');
    div.className = `notes-callout notes-callout-${kind}`;
    div.setAttribute('data-kind', kind);
    const trailing = m[2];
    if (trailing) firstP.textContent = trailing; else firstP.remove();
    while (bq.firstChild) div.appendChild(bq.firstChild);
    if (!div.querySelector('p')) div.appendChild(doc.createElement('p'));
    bq.replaceWith(div);
  });
}

export function renderNotesMarkdown(text: string): string {
  if (!text.trim()) return '';
  let html: string;
  try {
    const raw = marked.parse(text, { breaks: true, gfm: true });
    html = typeof raw === 'string' ? raw : '';
  } catch {
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<p>${escaped}</p>`;
  }

  // Run the editor-parity post-passes on a detached element before sanitizing.
  try {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const container = tpl.content as unknown as HTMLElement;
    wrapCallouts(container as HTMLElement);
    wrapTags(container as HTMLElement);
    html = tpl.innerHTML;
  } catch {
    // If DOM post-passes fail, fall through with the raw marked HTML.
  }

  const clean = notesPurify.sanitize(html, {
    ADD_TAGS: ['input', 'mark'],
    ADD_ATTR: ['checked', 'type', 'target', 'class', 'data-kind', 'data-tag'],
  });

  // Remove 'disabled' from checkboxes so click events fire.
  // marked adds disabled="" by default; we handle toggling in React.
  return clean.replace(/\s+disabled(?:="")?/g, '');
}

/**
 * Render a single-line search snippet, preserving the BE's `<mark>…</mark>`
 * matched-span highlight (§1.2 #8) while sanitizing everything else. Used by the
 * Cmd+K hybrid-search list. Unlike `renderNotesMarkdown`, this does NOT run the
 * tag/callout block post-passes (a snippet is an inline excerpt, not a document)
 * and forbids block/structural tags so a snippet can never inject a heading,
 * list, or image into the palette row — only inline emphasis + the `<mark>` span
 * survive. DOMPurify remains the single trust boundary; `<mark>` is BE-emitted,
 * never raw user HTML.
 */
export function renderNoteSnippet(snippet: string): string {
  if (!snippet) return '';
  return notesPurify.sanitize(snippet, {
    ALLOWED_TAGS: ['mark', 'em', 'strong', 'code', 'b', 'i'],
    ALLOWED_ATTR: ['class'],
  });
}

/**
 * Toggle the Nth checkbox in markdown source (0-indexed).
 * Matches `- [ ]` and `- [x]` / `- [X]` patterns.
 */
export function toggleCheckboxAtIndex(md: string, idx: number): string {
  let i = 0;
  return md.replace(/- \[([ xX])\]/g, (match, check) => {
    if (i++ === idx) return check.trim() ? '- [ ]' : '- [x]';
    return match;
  });
}
