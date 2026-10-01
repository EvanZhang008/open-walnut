/**
 * The tag list behind the View panel's Tags section
 * (web/src/components/tasks/task-query-state.ts `deriveTagOptions`).
 *
 * Both surfaces (home panel and /tasks) build their list through this one
 * function, so its order and its filtering are the contract:
 *   - most used first, ties by text, each tag counted once per task;
 *   - a tag the display rules hide is not offered (Walnut's own `walnut:*`
 *     machine tags always, plus anything a user rule hides).
 */
import { describe, it, expect } from 'vitest';
import { deriveTagOptions } from '../../web/src/components/tasks/task-query-state';
import {
  BUILTIN_TAG_DISPLAY_RULES,
  compileTagDisplay,
} from '../../src/core/tag-display-rules';

const builtin = compileTagDisplay(BUILTIN_TAG_DISPLAY_RULES);

describe('deriveTagOptions', () => {
  it('orders by how many tasks carry a tag, then by text', () => {
    const tasks = [
      { tags: ['urgent', 'severity:2'] },
      { tags: ['severity:2', 'ticket:P123'] },
      { tags: ['severity:2', 'urgent'] },
      { tags: ['alpha'] },
      {},
    ];
    expect(deriveTagOptions(tasks, builtin.shown)).toEqual(['severity:2', 'urgent', 'alpha', 'ticket:P123']);
  });

  it('counts a tag once per task even when the task repeats it', () => {
    const tasks = [{ tags: ['b', 'b', 'b'] }, { tags: ['a'] }, { tags: ['a'] }];
    expect(deriveTagOptions(tasks, builtin.shown)).toEqual(['a', 'b']);
  });

  it('drops machine tags and tags a user rule hides, keeps the rest', () => {
    const rules = compileTagDisplay([
      ...BUILTIN_TAG_DISPLAY_RULES,
      { pattern: 'ticket:*', display: 'hidden', source: 'user' },
    ]);
    const tasks = [
      { tags: ['walnut:imported', 'ticket:P123', 'urgent', ''] },
      { tags: ['walnut:imported', 'ticket:P456'] },
    ];
    expect(deriveTagOptions(tasks, rules.shown)).toEqual(['urgent']);
  });

  it('keeps non-ASCII tags as typed', () => {
    // A two-character CJK tag (escaped); it must round-trip unchanged.
    const cjk = '\u7d27\u6025';
    const tasks = [{ tags: [cjk] }, { tags: [cjk, 'urgent'] }];
    expect(deriveTagOptions(tasks, builtin.shown)).toEqual([cjk, 'urgent']);
  });
});
