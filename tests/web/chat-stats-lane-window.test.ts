/**
 * The chat stats divide by the window the lane's Claude Code session reported, and say when that
 * window is only an estimate (2026-11-07). A review found the cached stats kept the old estimate
 * flag when the lane's window turned from the name's estimate into the CLI's own same number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/chat-history.js', () => ({
  getLastUpdated: async () => 'same-mtime',
  getModelContext: async () => [],
  getCompactionSummary: async () => null,
}));
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => ({ agent: { main_model: 'unknown-model' } }) }));

import { computeChatStats } from '../../src/web/routes/chat-history.js';
import { recordLaneWindow } from '../../src/core/token-truth.js';

describe('chat stats window', () => {
  beforeEach(() => { /* each test uses its own conversation id */ });

  it('before the lane reports, the configured model\'s window is flagged as an estimate', async () => {
    const s = await computeChatStats('general', 'conv-a');
    expect(s.contextWindowEstimate).toBe(true);
  });

  it('follows the lane\'s window and its estimate flag, though the history did not change', async () => {
    recordLaneWindow('conv-b', { window: 1_000_000, source: 'model-string', estimate: true });
    expect(await computeChatStats('general', 'conv-b')).toMatchObject({ contextWindow: 1_000_000, contextWindowEstimate: true });
    recordLaneWindow('conv-b', { window: 1_000_000, source: 'cli-model-usage', estimate: false });
    const exact = await computeChatStats('general', 'conv-b');
    expect(exact.contextWindow).toBe(1_000_000);
    expect(exact.contextWindowEstimate).toBeUndefined();
  });
});
