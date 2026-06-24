import { marked } from 'marked';
import { renderMarkdownWithRefs } from '@/utils/markdown';

/** One rendered top-level markdown block, tagged with the 1-based SOURCE line it
 *  starts on. Rendered HTML doesn't map 1:1 to source lines, but every block
 *  (heading, paragraph, list, code fence, table, blockquote) has a well-defined
 *  start line — which is what a reviewer needs to locate it in the file. */
export interface MarkdownBlock {
  /** 1-based source line where this block begins. */
  line: number;
  /** Sanitized HTML for just this block (via the shared renderer). */
  html: string;
}

/**
 * Split markdown into top-level blocks, each tagged with its source start-line,
 * so the rendered preview can show a line-number gutter aligned to the source.
 *
 * Uses marked's lexer: each top-level token carries `.raw` (its exact source
 * slice including trailing newlines), so accumulating newline counts gives the
 * start line of the next block — no guessing. Each block is rendered through the
 * SAME `renderMarkdownWithRefs` the app uses everywhere (file/task/session ref
 * linking, image proxying, sanitization), so the preview reads identically; we
 * only add the gutter. Blank-line (`space`) tokens advance the counter but emit
 * nothing. Falls back to a single block on any lexer error.
 */
export function markdownBlocksWithLines(text: string, sessionCwd?: string, host?: string): MarkdownBlock[] {
  let tokens: ReturnType<typeof marked.lexer>;
  try {
    tokens = marked.lexer(text);
  } catch {
    return [{ line: 1, html: renderMarkdownWithRefs(text, sessionCwd, host) }];
  }
  const blocks: MarkdownBlock[] = [];
  let line = 1;
  for (const tok of tokens) {
    const raw = (tok as { raw?: string }).raw ?? '';
    if (tok.type !== 'space') {
      const html = renderMarkdownWithRefs(raw, sessionCwd, host);
      if (html.trim()) blocks.push({ line, html });
    }
    // Advance by the newlines this token's raw consumed (trailing blanks included).
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) line++;
  }
  return blocks.length ? blocks : [{ line: 1, html: renderMarkdownWithRefs(text, sessionCwd, host) }];
}
