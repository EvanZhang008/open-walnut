import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  formatDateKey,
  estimateTokens,
  appendDailyLog,
  getDailyLog,
  getRecentDailyLogs,
  getDailyLogsWithinBudget,
  splitDailyLogEntries,
  truncateDailyLogToFit,
  compactDailyLog,
} from '../../src/core/daily-log.js';
import { WALNUT_HOME, DAILY_DIR } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('formatDateKey', () => {
  it('returns YYYY-MM-DD for a given date', () => {
    const d = new Date(2025, 0, 15); // Jan 15, 2025
    expect(formatDateKey(d)).toBe('2025-01-15');
  });

  it('returns today when no date given', () => {
    const result = formatDateKey();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('zero-pads single-digit months and days', () => {
    const d = new Date(2025, 2, 5); // Mar 5, 2025
    expect(formatDateKey(d)).toBe('2025-03-05');
  });
});

describe('estimateTokens', () => {
  it('returns exact known value (canary for tokenizer changes)', () => {
    // Pin a known value — detects tokenizer behavior changes on package upgrades
    expect(estimateTokens('hello world')).toBe(2);
  });

  it('returns reasonable values for longer text', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length); // always fewer tokens than chars
  });

  it('handles single word', () => {
    expect(estimateTokens('hello')).toBeGreaterThan(0);
  });

  it('handles JSON content correctly', () => {
    const json = JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
    const tokens = estimateTokens(json);
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(json.length); // fewer tokens than chars
  });

  it('returns consistent results across calls (singleton reuse)', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const t1 = estimateTokens(text);
    const t2 = estimateTokens(text);
    const t3 = estimateTokens(text);
    expect(t1).toBe(t2);
    expect(t2).toBe(t3);
  });
});

describe('appendDailyLog', () => {
  it('creates file with YAML frontmatter on first call', () => {
    appendDailyLog('Test entry', 'test');

    const dateKey = formatDateKey();
    const content = fs.readFileSync(path.join(DAILY_DIR, `${dateKey}.md`), 'utf-8');
    expect(content).toContain(`name: '${dateKey}'`);
    expect(content).toContain('---');
    expect(content).toContain('Test entry');
    expect(content).toContain('test');
  });

  it('appends multiple entries', () => {
    appendDailyLog('First entry', 'test1');
    appendDailyLog('Second entry', 'test2');

    const result = getDailyLog()!;
    expect(result.content).toContain('First entry');
    expect(result.content).toContain('Second entry');
    expect(result.content).toContain('test1');
    expect(result.content).toContain('test2');
  });

  it('includes projectPath tag when provided', () => {
    appendDailyLog('Project entry', 'session', 'work/my-project');

    const result = getDailyLog()!;
    expect(result.content).toContain('[work/my-project]');
    expect(result.content).toContain('Project entry');
  });

  it('does not include projectPath tag when not provided', () => {
    appendDailyLog('No project entry', 'test');

    const result = getDailyLog()!;
    // Should have "— test\n" without brackets
    expect(result.content).toMatch(/— test\n/);
    expect(result.content).not.toContain('[');
  });
});

describe('getDailyLog', () => {
  it('returns content + hash for today', () => {
    appendDailyLog('Today entry', 'test');
    const result = getDailyLog();
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Today entry');
    expect(result!.contentHash).toHaveLength(12);
  });

  it('returns null for missing date', () => {
    const result = getDailyLog('2020-01-01');
    expect(result).toBeNull();
  });

  it('returns content for a specific date', () => {
    // Write directly to a specific date file
    const dateKey = '2025-06-15';
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DAILY_DIR, `${dateKey}.md`),
      '# Daily Log: 2025-06-15\n\n## 10:00 — test\nSpecific date content\n\n',
      'utf-8',
    );

    const result = getDailyLog(dateKey);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Specific date content');
  });
});

describe('getRecentDailyLogs', () => {
  it('returns multiple days', () => {
    // Create logs for today and yesterday manually
    fs.mkdirSync(DAILY_DIR, { recursive: true });

    const today = formatDateKey();
    const yesterday = formatDateKey(new Date(Date.now() - 86400000));

    fs.writeFileSync(path.join(DAILY_DIR, `${today}.md`), `# Daily Log: ${today}\n\nToday log`, 'utf-8');
    fs.writeFileSync(path.join(DAILY_DIR, `${yesterday}.md`), `# Daily Log: ${yesterday}\n\nYesterday log`, 'utf-8');

    const logs = getRecentDailyLogs(7);
    expect(logs.length).toBe(2);
    expect(logs[0].date).toBe(today);
    expect(logs[1].date).toBe(yesterday);
  });

  it('returns empty array when no logs exist', () => {
    const logs = getRecentDailyLogs(7);
    expect(logs).toEqual([]);
  });
});

describe('splitDailyLogEntries', () => {
  it('splits by heading boundary', () => {
    const content = [
      '# Daily Log: 2025-01-15',
      '',
      '## 10:00 — session [work/homelab]',
      'First entry content',
      '',
      '## 11:00 — agent [life]',
      'Second entry content',
      '',
      '## 14:30 — chat-compaction',
      'Third entry content',
      '',
    ].join('\n');

    const entries = splitDailyLogEntries(content);
    expect(entries).toHaveLength(4); // header + 3 entries
    expect(entries[0]).toContain('# Daily Log');
    expect(entries[1]).toContain('10:00');
    expect(entries[1]).toContain('First entry content');
    expect(entries[2]).toContain('11:00');
    expect(entries[2]).toContain('Second entry content');
    expect(entries[3]).toContain('14:30');
    expect(entries[3]).toContain('Third entry content');
  });

  it('handles empty content', () => {
    expect(splitDailyLogEntries('')).toEqual([]);
    expect(splitDailyLogEntries('   ')).toEqual([]);
  });

  it('handles header-only file', () => {
    const entries = splitDailyLogEntries('# Daily Log: 2025-01-15\n\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('Daily Log');
  });

  it('handles single entry', () => {
    const content = '# Daily Log: 2025-01-15\n\n## 10:00 — test\nSingle entry\n\n';
    const entries = splitDailyLogEntries(content);
    expect(entries).toHaveLength(2); // header + 1 entry
    expect(entries[1]).toContain('Single entry');
  });
});

describe('truncateDailyLogToFit', () => {
  it('keeps newest entries within budget', () => {
    // Build a log with 3 entries of known size
    const entries = [
      '# Daily Log: 2025-01-15\n',
      '## 10:00 — session\n' + 'A '.repeat(200) + '\n',
      '## 11:00 — session\n' + 'B '.repeat(200) + '\n',
      '## 14:00 — session\nSmall newest entry\n',
    ].join('\n');

    // Use a budget that fits the newest entry but not all
    const newestTokens = estimateTokens('## 14:00 — session\nSmall newest entry\n');
    const result = truncateDailyLogToFit(entries, newestTokens + 5);

    expect(result).toContain('Small newest entry');
    expect(result).toContain('earlier entries omitted');
  });

  it('returns at least one entry even if it exceeds budget', () => {
    const content = '# Daily Log: 2025-01-15\n\n## 10:00 — test\n' + 'Long content '.repeat(500) + '\n';
    const result = truncateDailyLogToFit(content, 1); // impossibly small budget

    // Should still have content — the newest entry is always included
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Long content');
  });

  it('returns full content when budget is sufficient', () => {
    const content = '# Daily Log: 2025-01-15\n\n## 10:00 — test\nShort content\n\n';
    const result = truncateDailyLogToFit(content, 10000);

    expect(result).toContain('Short content');
    expect(result).not.toContain('omitted');
  });

  it('returns empty string for empty content', () => {
    expect(truncateDailyLogToFit('', 1000)).toBe('');
  });
});

describe('getDailyLogsWithinBudget', () => {
  it('truncates oversized today instead of returning empty', () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });

    const today = formatDateKey();
    // Create a multi-entry log that exceeds a small budget
    const content = [
      `# Daily Log: ${today}`,
      '',
      '## 10:00 — session [work/homelab]',
      'A '.repeat(500),
      '',
      '## 11:00 — agent [life]',
      'B '.repeat(500),
      '',
      '## 14:00 — chat-compaction',
      'Most recent entry with important info',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(DAILY_DIR, `${today}.md`), content, 'utf-8');

    // Small budget — should truncate but NOT return empty
    const result = getDailyLogsWithinBudget(50);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Most recent entry');
  });

  it('includes omission marker when truncated', () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });

    const today = formatDateKey();
    const content = [
      `# Daily Log: ${today}`,
      '',
      '## 10:00 — session',
      'A '.repeat(500),
      '',
      '## 14:00 — session',
      'Recent info',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(DAILY_DIR, `${today}.md`), content, 'utf-8');

    const result = getDailyLogsWithinBudget(50);
    expect(result).toContain('earlier entries omitted');
  });

  it('returns content when budget is sufficient', () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });

    const today = formatDateKey();
    fs.writeFileSync(path.join(DAILY_DIR, `${today}.md`), 'Short log content', 'utf-8');

    const result = getDailyLogsWithinBudget(10000);
    expect(result).toContain('Short log content');
  });

  it('includes multiple days when budget allows', () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });

    const today = formatDateKey();
    const yesterday = formatDateKey(new Date(Date.now() - 86400000));

    fs.writeFileSync(path.join(DAILY_DIR, `${today}.md`), `# Daily Log: ${today}\n\n## 10:00 — test\nToday\n`, 'utf-8');
    fs.writeFileSync(path.join(DAILY_DIR, `${yesterday}.md`), `# Daily Log: ${yesterday}\n\n## 10:00 — test\nYesterday\n`, 'utf-8');

    const result = getDailyLogsWithinBudget(10000);
    expect(result).toContain('Today');
    expect(result).toContain('Yesterday');
  });
});

describe('compactDailyLog', () => {
  it('creates .bak and writes summary when over threshold', async () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });

    const dateKey = '2025-06-15';
    const largeContent = `# Daily Log: ${dateKey}\n\n` + '## 10:00 — test\n' + 'Content '.repeat(2000) + '\n';
    fs.writeFileSync(path.join(DAILY_DIR, `${dateKey}.md`), largeContent, 'utf-8');

    const summarizer = vi.fn(async () => 'This is the compacted summary of the day.');
    const result = await compactDailyLog(dateKey, 100, summarizer);

    expect(result).toBe(true);
    expect(summarizer).toHaveBeenCalledOnce();

    // .bak should exist with original content
    const bakContent = fs.readFileSync(path.join(DAILY_DIR, `${dateKey}.bak.md`), 'utf-8');
    expect(bakContent).toContain('Content ');

    // .md should have compacted content
    const newContent = fs.readFileSync(path.join(DAILY_DIR, `${dateKey}.md`), 'utf-8');
    expect(newContent).toContain('compacted');
    expect(newContent).toContain('compacted summary');
  });

  it('skips when under threshold', async () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });

    const dateKey = '2025-06-16';
    fs.writeFileSync(path.join(DAILY_DIR, `${dateKey}.md`), '# Daily Log\n\nShort content\n', 'utf-8');

    const summarizer = vi.fn(async () => 'summary');
    const result = await compactDailyLog(dateKey, 100000, summarizer);

    expect(result).toBe(false);
    expect(summarizer).not.toHaveBeenCalled();

    // No .bak should exist
    expect(fs.existsSync(path.join(DAILY_DIR, `${dateKey}.bak.md`))).toBe(false);
  });

  it('returns false when file does not exist', async () => {
    const summarizer = vi.fn(async () => 'summary');
    const result = await compactDailyLog('2020-01-01', 100, summarizer);

    expect(result).toBe(false);
    expect(summarizer).not.toHaveBeenCalled();
  });
});
