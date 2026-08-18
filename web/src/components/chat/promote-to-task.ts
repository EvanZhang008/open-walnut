/**
 * "Turn this into task" — the pure part: how a chat message becomes a task's
 * title + description. Split out of PromoteToTaskMenu.tsx so these rules are
 * testable without a DOM (the menu itself pulls React, portals and the shared
 * project flyout).
 */

export interface PromoteToTaskInput {
  title: string;
  /** Full message text, when it carries more than the title already does. */
  description?: string;
  /** '' = Inbox. */
  project?: string;
}

const TITLE_MAX = 90;

/**
 * First meaningful line of a message, stripped of markdown scaffolding, capped
 * to a title-sized string. Falls back to a generic title for text that carries
 * no words at all (a lone code fence, an empty bullet).
 */
export function deriveTaskTitle(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s{0,3}#{1,6}(\s+|$)/, '')             // heading
      .replace(/^\s{0,3}[-*+]\s+\[[ xX]\]\s*/, '')      // task list item
      .replace(/^\s{0,3}[-*+](\s+|$)/, '')              // bullet
      .replace(/^\s{0,3}\d+[.)](\s+|$)/, '')            // ordered item
      .replace(/^\s{0,3}>\s?/, '')                      // quote
      .replace(/^\s*```.*$/, '')                        // fence line
      .replace(/[*_`~]/g, '')                           // inline emphasis marks
      .trim();
    // A line with no letters or digits left is scaffolding, not a title: a lone
    // bullet ("-"), a horizontal rule ("---"), a fence. Keep walking — otherwise
    // the task is literally named "-".
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
  }
  return 'Chat note';
}

/**
 * The body to store: the whole message, EXCEPT when the title already is the
 * whole message (a short one-liner) — duplicating it there just makes the task
 * detail pane repeat itself.
 */
export function deriveTaskDescription(text: string, title: string): string | undefined {
  const body = text.trim();
  if (!body) return undefined;
  if (!body.includes('\n') && body === title) return undefined;
  return body;
}
