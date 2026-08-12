import { describe, expect, it } from 'vitest';
import { isJunkProject, isJunkTask, isLedgerJunk } from '../../src/core/task-junk.js';

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
