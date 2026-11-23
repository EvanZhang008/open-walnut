/**
 * The team pills say their word, never a task's title (2026-11-23, the user: "if it's a worker,
 * don't show its name, it's too long; just show Worker, and when I click it show who it is").
 * The Worker pill (SubtaskPill.tsx) reads "Worker" and the Leader pill (LeaderPill.tsx) reads
 * "Leader · N"; the leader's or a worker's title lives only in the hover text (an attribute of the
 * trigger, allowed) and in the team flyout a click opens.
 *
 * Read from the source: the children of each pill's trigger button (`<button ref={triggerRef}`
 * up to its `</button>`). Every `{...}` expression drawn there must be one this file names, so a
 * title added in any form (`parentTitle`, `orgDisplayTitle(t)`, `task.title`, a new helper)
 * fails here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TASKS = path.resolve(__dirname, '../../web/src/components/tasks');

/** What each pill may draw: its literal words and the expressions that make up its word or count. */
const PILLS: Record<string, { words: string; expressions: string[] }> = {
  'SubtaskPill.tsx': { words: 'Worker', expressions: [] },
  'LeaderPill.tsx': { words: '·', expressions: ['leaderWord(task)', 'subtasks.length'] },
};

const TITLE_LIKE = /\btitle\b|Title\b|orgDisplayTitle|label\b/;

/** The JSX between the trigger button's opening tag and its `</button>`, comments dropped. */
function triggerChildren(source: string, file: string): string {
  const start = source.indexOf('ref={triggerRef}');
  expect(start, `${file}: a trigger button with ref={triggerRef}`).toBeGreaterThan(0);
  expect(source.indexOf('ref={triggerRef}', start + 1), `${file}: one trigger button`).toBe(-1);
  // The opening tag ends at a line holding only ">" (the repo's JSX layout for long tags).
  const tagEnd = source.slice(start).search(/\n\s*>\s*\n/);
  expect(tagEnd, `${file}: the trigger's opening tag ends on a line of its own`).toBeGreaterThan(0);
  const from = start + tagEnd + source.slice(start + tagEnd).indexOf('>') + 1;
  const to = source.indexOf('</button>', from);
  expect(to, `${file}: the trigger's </button>`).toBeGreaterThan(from);
  return source.slice(from, to).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

describe('a team pill draws its word, never a task title', () => {
  for (const [file, allowed] of Object.entries(PILLS)) {
    it(file, () => {
      const children = triggerChildren(fs.readFileSync(path.join(TASKS, file), 'utf8'), file);
      const expressions = [...children.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1].trim());
      expect(expressions, `${file}: only the word and count are drawn in the pill; a title goes in its hover or its flyout`).toEqual(allowed.expressions);
      const text = children.replace(/\{[^{}]*\}/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      expect(text, `${file}: the pill's literal words`).toBe(allowed.words);
      // Class names and test ids inside the trigger are part of the markup, so check them too.
      const markup = [...children.matchAll(/<[^>]*>/g)].map((m) => m[0]).join(' ');
      expect(markup, `${file}: no title element inside the pill`).not.toMatch(TITLE_LIKE);
    });
  }

  it('the Worker pill still names its leader in its hover text', () => {
    const source = fs.readFileSync(path.join(TASKS, 'SubtaskPill.tsx'), 'utf8');
    expect(source).toContain('title={subtaskPillTitle(parentTitle)}');
    expect(source).toContain('Worker of "${parentTitle}". Click to see its team.');
  });
});
