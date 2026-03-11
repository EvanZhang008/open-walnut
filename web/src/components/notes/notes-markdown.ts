/**
 * Markdown renderer for global notes — preserves checkbox <input> elements
 * so users can click to toggle them. Separate from renderNoteMarkdown()
 * which strips inputs via DOMPurify defaults.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

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

  // Allow checkbox inputs and open links in new tab
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  try {
    const clean = DOMPurify.sanitize(html, {
      ADD_TAGS: ['input'],
      ADD_ATTR: ['checked', 'type', 'target'],
    });

    // Remove 'disabled' from checkboxes so click events fire.
    // marked adds disabled="" by default; we handle toggling in React.
    return clean.replace(/\s+disabled(?:="")?/g, '');
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
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
