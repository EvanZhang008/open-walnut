/** TOC row budget. Long enough to name the moment, short enough that the
 *  collapsed rail stays a rail. */
const LABEL_MAX = 90;

/**
 * First non-empty line of a message (or passage), which is what a human
 * recognizes. Shared by the pin outline and the thread model, so a thread's label
 * and its pin's label can never disagree.
 */
export function pinLabelFor(text: string | undefined, fallback: string): string {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return fallback;
  // Strip the markdown that would render as literal punctuation in a one-line row.
  const plain = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/[*_`]/g, '')
    .trim();
  const label = plain || fallback;
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX)}…` : label;
}
