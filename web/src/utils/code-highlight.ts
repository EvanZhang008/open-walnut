/**
 * Syntax highlighting for the file viewer, via refractor (Prism grammars —
 * same open-source stack the Changed-tab diff uses, see diffHighlight.ts).
 *
 * Highlights the WHOLE file in one pass (so multi-line tokens — block
 * comments, template literals — keep their color across lines), then splits
 * the hast tree back into per-line HTML strings, re-opening any spans that
 * were open at each newline. Output plugs into the existing line-numbered
 * renderer; token colors come from the shared Prism palette in globals.css.
 */
import { refractor } from 'refractor';
import { languageForPath } from '@/components/sessions/diffHighlight';

// Skip highlighting for very large files — tokenizing megabytes blocks the
// main thread. (The content fetch already truncates at 512KB.)
const MAX_HIGHLIGHT_CHARS = 400_000;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESC[c]!);
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

/**
 * Highlight `content` as the language inferred from `path`.
 * Returns one HTML string per line (already escaped, wrapped in Prism token
 * spans), or null when the language is unknown / file too big / grammar threw
 * — callers fall back to plain escaped text.
 */
export function highlightLines(content: string, path: string): string[] | null {
  if (content.length > MAX_HIGHLIGHT_CHARS) return null;
  const lang = languageForPath(path);
  if (!lang) return null;
  let root: { children: HastNode[] };
  try {
    root = refractor.highlight(content, lang) as unknown as { children: HastNode[] };
  } catch {
    return null;
  }

  const lines: string[] = [];
  let cur = '';
  // Stack of class lists for spans currently open — replayed after each newline.
  const stack: string[] = [];
  const walk = (nodes: HastNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text') {
        const parts = (n.value ?? '').split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) {
            cur += '</span>'.repeat(stack.length);
            lines.push(cur);
            cur = stack.map((c) => `<span class="${c}">`).join('');
          }
          cur += esc(parts[i]!);
        }
      } else if (n.type === 'element') {
        const cls = (n.properties?.className ?? []).join(' ');
        stack.push(cls);
        cur += `<span class="${cls}">`;
        walk(n.children ?? []);
        stack.pop();
        cur += '</span>';
      }
    }
  };
  walk(root.children);
  lines.push(cur);

  // Safety: a line-count mismatch means the splitter mis-tracked something —
  // fall back to plain rendering rather than desync line numbers.
  const expected = content.split('\n').length;
  if (lines.length !== expected) return null;
  return lines;
}
