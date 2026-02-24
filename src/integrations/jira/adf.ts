/**
 * Atlassian Document Format (ADF) helpers.
 *
 * Jira Cloud REST API v3 requires ADF for description and comment bodies.
 * These helpers provide minimal conversions for Phase 1 — plain text and
 * basic markdown (headings, paragraphs, code blocks) only.
 */

// ── ADF types (subset) ──

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
}

export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

// ── Conversion: plain text → ADF ──

/** Wrap plain text in a minimal ADF document with one paragraph per line group. */
export function plainTextToAdf(text: string): AdfDocument {
  if (!text.trim()) {
    return { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [] }] };
  }
  const paragraphs = text.split(/\n{2,}/);
  return {
    version: 1,
    type: 'doc',
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: p.trim() }],
    })),
  };
}

// ── Conversion: markdown → ADF ──

/** Convert basic markdown to ADF. Supports headings (# ## ###), code blocks (```), and paragraphs. */
export function markdownToAdf(md: string): AdfDocument {
  if (!md.trim()) {
    return { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [] }] };
  }

  const content: AdfNode[] = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      content.push({
        type: 'codeBlock',
        ...(lang ? { attrs: { language: lang } } : {}),
        content: [{ type: 'text', text: codeLines.join('\n') }],
      });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      content.push({
        type: 'heading',
        attrs: { level },
        content: [{ type: 'text', text: headingMatch[2] }],
      });
      i++;
      continue;
    }

    // Empty line — skip
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-empty, non-special lines
    const paragraphLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !lines[i].match(/^#{1,6}\s/)) {
      paragraphLines.push(lines[i]);
      i++;
    }
    if (paragraphLines.length > 0) {
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: paragraphLines.join('\n') }],
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [] });
  }

  return { version: 1, type: 'doc', content };
}

// ── Conversion: ADF → plain text ──

/** Recursively extract plain text from an ADF document. */
export function adfToPlainText(adf: AdfDocument | null | undefined): string {
  if (!adf?.content) return '';
  return adf.content.map(nodeToText).filter(Boolean).join('\n\n');
}

function nodeToText(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'paragraph':
      return childrenToText(node);
    case 'heading': {
      const level = (node.attrs?.level as number) ?? 1;
      const prefix = '#'.repeat(level);
      return `${prefix} ${childrenToText(node)}`;
    }
    case 'codeBlock': {
      const lang = (node.attrs?.language as string) ?? '';
      return `\`\`\`${lang}\n${childrenToText(node)}\n\`\`\``;
    }
    case 'hardBreak':
      return '\n';
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? []).map((li, idx) => {
        const prefix = node.type === 'orderedList' ? `${idx + 1}. ` : '- ';
        return `${prefix}${childrenToText(li)}`;
      }).join('\n');
    default:
      return childrenToText(node);
  }
}

function childrenToText(node: AdfNode): string {
  if (!node.content) return node.text ?? '';
  return node.content.map(nodeToText).join('');
}
