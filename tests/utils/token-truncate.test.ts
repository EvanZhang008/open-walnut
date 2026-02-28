import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/constants.js', () => {
  const path = require('node:path');
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), `walnut-tt-${Date.now()}`);
  return {
    WALNUT_HOME: tmp,
    TASKS_DIR: path.join(tmp, 'tasks'),
    TASKS_FILE: path.join(tmp, 'tasks', 'tasks.json'),
    MEMORY_DIR: path.join(tmp, 'memory'),
    PROJECTS_MEMORY_DIR: path.join(tmp, 'memory', 'projects'),
    CHAT_HISTORY_FILE: path.join(tmp, 'chat-history.json'),
    CONFIG_FILE: path.join(tmp, 'config.yaml'),
  };
});

import { truncateToTokenBudget } from '../../src/utils/token-truncate.js';

describe('truncateToTokenBudget', () => {
  it('returns text unchanged when within budget', () => {
    const short = 'hello world';
    expect(truncateToTokenBudget(short, 100)).toBe(short);
  });

  it('truncates text that exceeds budget', () => {
    // ~1000 tokens at 3.5 chars/token = ~3500 chars budget
    const longText = 'word '.repeat(2000); // ~10000 chars, ~2857 tokens
    const result = truncateToTokenBudget(longText, 500);
    expect(result.length).toBeLessThan(longText.length);
    expect(result).toContain('[...truncated]');
  });

  it('snaps to word boundary', () => {
    // Use text with distinct words to verify we don't cut mid-word
    const text = 'abcdefghij klmnopqrst uvwxyzabcd '.repeat(200);
    const result = truncateToTokenBudget(text, 50);
    const beforeMarker = result.replace('\n\n[...truncated]', '');
    // Should end at a complete word — not in the middle of one of our 10-char words
    const lastWord = beforeMarker.trim().split(/\s+/).pop() ?? '';
    expect(['abcdefghij', 'klmnopqrst', 'uvwxyzabcd']).toContain(lastWord);
  });

  it('handles empty string', () => {
    expect(truncateToTokenBudget('', 100)).toBe('');
  });
});
