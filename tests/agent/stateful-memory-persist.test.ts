/**
 * Regression tests for stateful-agent self-persistence.
 *
 * Background: a stateful console agent's carry-forward state lives in the YAML
 * `description` of `memory/projects/<path>/MEMORY.md`. No tool can write there
 * (`memory_manage` is hardwired to the two global stores; `file_write` on
 * `memory/project/*` reroutes appends to skill history). The `<memory_update>`
 * tag protocol that buildStatefulMemorySection advertises is therefore the ONLY
 * write path — and it was silently unwired at both dispatch sites, so stateful
 * agents lost every update. These tests pin the whole contract:
 * prompt advertises → agent emits tag → persist writes → next run reads it back
 * → the timeline route can still parse it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  buildStatefulMemorySection,
  extractMemoryUpdate,
  persistMemoryUpdate,
} from '../../src/agent/stateful-memory.js';
import { getProjectMemory } from '../../src/core/project-memory.js';
import { __parseTimelineFromMemoryForTest } from '../../src/web/routes/timeline.js';
import { WALNUT_HOME } from '../../src/constants.js';
import type { AgentStatefulConfig } from '../../src/core/types.js';

const CONFIG: AgentStatefulConfig = {
  memory_project: 'life/tracker',
  memory_budget_tokens: 5000,
  memory_source: 'life-tracker',
};

/** A day record in the shape the timeline view parses. */
const DAY_RECORD = `## Day Record: 2026-07-30

### Activity Timeline
- 09:00-09:30 | Editor | coding | Editing the agent registry
- 09:30-10:15 | Browser | reading | Reading API docs

### Summary
- coding: 0h30m
- reading: 0h45m

### Status
Last Updated: 2026-07-30 10:15:00`;

/** Extract the YAML `description` the way the timeline route does. */
function descriptionOf(raw: string): string {
  const m = raw.match(/^---\n[\s\S]*?description:\s*([\s\S]*?)\n---/);
  return m ? m[1] : raw;
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('buildStatefulMemorySection', () => {
  it('tells the agent the tag is the only write path, and not to use a tool', () => {
    const section = buildStatefulMemorySection(null, CONFIG);
    expect(section).toContain('<memory_update>');
    expect(section).toContain('ONLY way to persist state');
    expect(section).toContain('no tool can write');
  });

  it('does NOT advertise any tool-based memory write', () => {
    const section = buildStatefulMemorySection(null, CONFIG);
    // These were the stale instructions that made persistence a silent no-op.
    expect(section).not.toContain('update_summary');
    expect(section).not.toContain('memory_manage');
  });
});

describe('persistMemoryUpdate', () => {
  it('writes the <memory_update> block to the project summary', async () => {
    const written = await persistMemoryUpdate(
      `Created a new entry.\n\n<memory_update>\n${DAY_RECORD}\n</memory_update>`,
      CONFIG,
      'Life Tracker',
    );
    expect(written).toBe(true);

    const stored = getProjectMemory('life/tracker');
    expect(stored).not.toBeNull();
    expect(stored!.content).toContain('name: Life Tracker');
    expect(descriptionOf(stored!.content)).toContain('09:30-10:15 | Browser | reading');
  });

  it('is a no-op when the response has no tag (memory carries forward)', async () => {
    await persistMemoryUpdate(`<memory_update>\n${DAY_RECORD}\n</memory_update>`, CONFIG, 'Life Tracker');
    const before = getProjectMemory('life/tracker')!.content;

    expect(await persistMemoryUpdate('Screen unchanged, nothing to record.', CONFIG, 'Life Tracker')).toBe(false);
    expect(getProjectMemory('life/tracker')!.content).toBe(before);
  });

  it('is a no-op for an empty/undefined response', async () => {
    expect(await persistMemoryUpdate(undefined, CONFIG, 'Life Tracker')).toBe(false);
    expect(await persistMemoryUpdate('', CONFIG, 'Life Tracker')).toBe(false);
  });

  it('REPLACES the summary rather than appending (the 706 KB-growth guard)', async () => {
    await persistMemoryUpdate(`<memory_update>\n${DAY_RECORD}\n</memory_update>`, CONFIG, 'Life Tracker');
    const first = getProjectMemory('life/tracker')!.content;

    const second = DAY_RECORD.replace('2026-07-30', '2026-07-31');
    await persistMemoryUpdate(`<memory_update>\n${second}\n</memory_update>`, CONFIG, 'Life Tracker');
    const after = getProjectMemory('life/tracker')!.content;

    expect(after).toContain('Day Record: 2026-07-31');
    expect(after).not.toContain('Day Record: 2026-07-30');
    // Replacement, not accumulation: same-size record must not grow the file.
    expect(after.length).toBeLessThanOrEqual(first.length + 1);
  });

  it('never throws on a bad project path — a failed write must not fail the run', async () => {
    const tooDeep: AgentStatefulConfig = { ...CONFIG, memory_project: 'a/b/c/d/e' };
    await expect(
      persistMemoryUpdate(`<memory_update>\n${DAY_RECORD}\n</memory_update>`, tooDeep, 'Life Tracker'),
    ).resolves.toBe(false);
  });
});

describe('write → render contract (persist feeds /api/timeline)', () => {
  it('what the agent persists is what the timeline route parses back', async () => {
    await persistMemoryUpdate(`<memory_update>\n${DAY_RECORD}\n</memory_update>`, CONFIG, 'Life Tracker');

    const stored = getProjectMemory('life/tracker')!.content;
    const { entries, summary } = __parseTimelineFromMemoryForTest(descriptionOf(stored));

    // Both entries must survive: writing through YAML indents every line after
    // the first, which the parser used to reject.
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      startTime: '09:00',
      endTime: '09:30',
      application: 'Editor',
      category: 'coding',
    });
    expect(entries[1]).toMatchObject({ startTime: '09:30', category: 'reading' });
    expect(summary).toEqual({ coding: '0h30m', reading: '0h45m' });
  });

  it('parses indented list items (YAML block-scalar indentation)', () => {
    const indented = [
      '  ### Activity Timeline',
      '  - 08:00-08:30 | Editor | coding | Indented entry',
      '',
      '  ### Summary',
      '  - coding: 0h30m',
    ].join('\n');
    const { entries, summary } = __parseTimelineFromMemoryForTest(indented);
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('Indented entry');
    expect(summary).toEqual({ coding: '0h30m' });
  });

  it('round-trips: persisted state comes back in the next run\'s prompt', async () => {
    await persistMemoryUpdate(`<memory_update>\n${DAY_RECORD}\n</memory_update>`, CONFIG, 'Life Tracker');
    const stored = getProjectMemory('life/tracker')!.content;
    const nextPrompt = buildStatefulMemorySection(stored, CONFIG);
    expect(nextPrompt).toContain('09:30-10:15 | Browser | reading');
  });
});

describe('extractMemoryUpdate', () => {
  it('returns trimmed inner content, or null when absent', () => {
    expect(extractMemoryUpdate('<memory_update>\n  hello  \n</memory_update>')).toBe('hello');
    expect(extractMemoryUpdate('no tag here')).toBeNull();
  });
});
