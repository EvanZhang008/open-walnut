import { describe, it, expect } from 'vitest';
import { extractProgressLines, summarizeProgress } from '../../src/core/task-progress.js';

const NOTE = `## Executive Summary
Something about the task.

## Progress
- [DONE] Route lands the projection — GET /api/tasks/bulk
- [WIP] Op schema wiring
  - sub-detail that carries no label of its own
- [WAIT] Waiting on the deploy window
- [TODO] Docs
- [BLOCKED] Needs the upstream fix
- a plain bullet with no status label

## Work Log
- did a lot of things nobody triaging needs to read, several KB of them
`;

describe('extractProgressLines', () => {
  it('returns only the Progress section status bullets, in note order', () => {
    expect(extractProgressLines(NOTE)).toEqual([
      { status: 'DONE', text: 'Route lands the projection — GET /api/tasks/bulk' },
      { status: 'WIP', text: 'Op schema wiring' },
      { status: 'WAIT', text: 'Waiting on the deploy window' },
      { status: 'TODO', text: 'Docs' },
      { status: 'BLOCKED', text: 'Needs the upstream fix' },
    ]);
  });

  it('never reaches into the other sections', () => {
    const lines = extractProgressLines(NOTE);
    expect(lines.some((l) => l.text.includes('nobody triaging'))).toBe(false);
    expect(lines.some((l) => l.text.includes('Something about'))).toBe(false);
  });

  it('tolerates markdown wrappers, mixed case and a missing bullet marker', () => {
    const note = '## Progress\n- **[wip]** bolded label\n[DONE]: no bullet at all\n* [todo] star bullet\n';
    expect(extractProgressLines(note)).toEqual([
      { status: 'WIP', text: 'bolded label' },
      { status: 'DONE', text: 'no bullet at all' },
      { status: 'TODO', text: 'star bullet' },
    ]);
  });

  it('is empty — not an error — for a note with no Progress section or no note at all', () => {
    expect(extractProgressLines('## Work Log\n- only a log\n')).toEqual([]);
    expect(extractProgressLines('')).toEqual([]);
    expect(extractProgressLines(undefined)).toEqual([]);
    expect(extractProgressLines('## Progress\n\n')).toEqual([]);
  });

  it('counts bullets per status', () => {
    expect(summarizeProgress(extractProgressLines(NOTE)))
      .toEqual({ DONE: 1, WIP: 1, WAIT: 1, TODO: 1, BLOCKED: 1 });
    expect(summarizeProgress([])).toEqual({ DONE: 0, WIP: 0, WAIT: 0, TODO: 0, BLOCKED: 0 });
  });
});
