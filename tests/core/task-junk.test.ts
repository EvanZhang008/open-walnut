import { describe, expect, it } from 'vitest';
import {
  isJunkProject, isJunkTask, isLedgerJunk, isSearchArtifact, SEARCH_ASK_TAG,
} from '../../src/core/task-junk.js';
import { taskToDoc, sessionToDoc } from '../../src/core/search/serializers.js';
import type { SessionRecord, Task } from '../../src/core/types.js';

describe('isJunkProject', () => {
  it('flags the known test/verify project family', () => {
    for (const p of [
      'Test', 'Test2', 'TestCat', 'Test Category', 'VerifyCat', 'UITest-Claude',
      'TestLocal', 'GroupTestCat', 'E2E-Test', 'test', '__TestCat', '__TestReorder',
      '__dragtest__', 'VC', 'VP', 'Personal2',
    ]) {
      expect(isJunkProject(p), p).toBe(true);
    }
  });

  it('keeps real projects (bilingual) and Inbox', () => {
    for (const p of [
      'Walnut', 'Marina', 'Acme Website', '任务', 'Personal', 'Life',
      'Tax', 'Immigration', 'Career', '', undefined, null,
      // "test"/"verify" as an interior substring without a word/case boundary
      'Attestation', 'Contest Prep',
    ]) {
      expect(isJunkProject(p as string), String(p)).toBe(false);
    }
  });
});

describe('isJunkTask', () => {
  it('is project-driven — a real-project task with a test-ish title survives', () => {
    expect(isJunkTask({ project: 'Walnut', title: 'Fix test:quick pipeline' })).toBe(false);
    expect(isJunkTask({ project: 'VerifyCat', title: 'Anything' })).toBe(true);
  });
});

describe('isLedgerJunk', () => {
  it('additionally drops probe-style Inbox titles', () => {
    expect(isLedgerJunk({ project: '', title: 'Burst message echo test' })).toBe(true);
    expect(isLedgerJunk({ project: '', title: 'V6 unread dot probe' })).toBe(true);
    expect(isLedgerJunk({ project: '', title: 'Response and command compliance tests' })).toBe(true);
  });

  it('keeps real Inbox tasks', () => {
    expect(isLedgerJunk({ project: '', title: '打开并试用最新编辑器代码' })).toBe(false);
    expect(isLedgerJunk({ project: '', title: 'H1b' })).toBe(false);
    expect(isLedgerJunk({ project: 'Walnut', title: 'Fix test:quick pipeline' })).toBe(false);
  });
});

describe('isSearchArtifact — the search feature must not index its own queries', () => {
  const askTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'mtest001-0a01',
    title: 'Search query: walnut ios app',
    project: 'Ask Walnut',
    tags: [SEARCH_ASK_TAG],
    updated_at: '2026-09-21T02:40:36.885Z',
    ...overrides,
  } as Task);

  it('flags a task carrying the AI-search tag', () => {
    expect(isSearchArtifact(askTask())).toBe(true);
  });

  it('does not flag ordinary tasks, including untagged ones in the same project', () => {
    expect(isSearchArtifact({ tags: [] })).toBe(false);
    expect(isSearchArtifact({ tags: undefined })).toBe(false);
    expect(isSearchArtifact({ tags: ['walnut:external-sessions'] })).toBe(false);
    // Project is NOT the marker: a task the user typed in Ask Walnut is real work.
    expect(isSearchArtifact(askTask({ tags: [] }))).toBe(false);
  });

  it('keeps the ask task out of the search index', () => {
    // Without this the row matches the query that created it on the highest
    // weighted field, and it was observed taking 3 of 8 result slots.
    expect(taskToDoc(askTask())).toBeNull();
    expect(taskToDoc(askTask({ tags: [] }))).not.toBeNull();
  });

  it('keeps the session adopted for the ask out of the search index', () => {
    const session = {
      claudeSessionId: '00000000-0000-4000-8000-000000000001',
      title: 'Search query: walnut ios app',
      project: 'Ask Walnut',
      startedAt: '2026-09-21T02:40:25.646Z',
      lastActiveAt: '2026-09-21T02:40:36.885Z',
    } as SessionRecord;
    expect(sessionToDoc({ session, task: askTask() })).toBeNull();
    // Same session, ordinary owning task: indexed as usual.
    expect(sessionToDoc({ session, task: askTask({ tags: [] }) })).not.toBeNull();
  });
});
