/**
 * Unit tests for fork-title.ts — the fork-prompt → short English label summarizer.
 *
 * Covers: normalizeLabel cleaning rules (word cap, length cap, non-ASCII strip,
 * quote/punctuation strip) and summarizeForkPrompt's model + fallback behavior
 * (mocked model, so no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the model layer so summarizeForkPrompt never hits the network.
const sendMessageMock = vi.fn();
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
// Mock config so summarizeForkPrompt's getConfig() resolves a provider.
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ agent: { main_provider: 'bedrock' } }),
}));

import { normalizeLabel, summarizeForkPrompt, parseForkTitle, titleCoversLabel } from '../../src/core/fork-title.js';

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

describe('normalizeLabel', () => {
  it('passes a clean 2-4 word title through unchanged', () => {
    expect(normalizeLabel('Fix Login Redirect')).toBe('Fix Login Redirect');
  });

  it('caps at 4 words', () => {
    expect(normalizeLabel('Add Retry Backoff To Webhook Delivery')).toBe('Add Retry Backoff To');
  });

  it('strips surrounding quotes the model may add', () => {
    expect(normalizeLabel('"Refactor Stream Parser"')).toBe('Refactor Stream Parser');
  });

  it('strips non-ASCII (CJK guard) so external sync never sees Chinese', () => {
    // Chinese chars become spaces → collapsed away, ASCII words survive.
    expect(normalizeLabel('修复 Login Bug')).toBe('Login Bug');
  });

  it('drops punctuation except hyphen and trailing periods', () => {
    expect(normalizeLabel('Fix login, redirect.')).toBe('Fix login redirect');
  });

  it('returns empty string when nothing usable survives', () => {
    expect(normalizeLabel('！！！')).toBe('');
    expect(normalizeLabel('')).toBe('');
  });

  it('caps overly long single-word labels at the length limit', () => {
    const long = 'Supercalifragilisticexpialidocioussupercalifragilistic';
    const out = normalizeLabel(long);
    expect(out.length).toBeLessThanOrEqual(40);
  });
});

describe('summarizeForkPrompt', () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
  });

  it('returns the normalized model label on success', async () => {
    sendMessageMock.mockResolvedValue(textResult('Add Retry Backoff'));
    const label = await summarizeForkPrompt('Please add exponential retry backoff to the webhook sender');
    expect(label).toBe('Add Retry Backoff');
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it('caps maxTokens small so the SDK does not demand streaming (regression: 64K default → streaming-required error → always-heuristic)', async () => {
    sendMessageMock.mockResolvedValue(textResult('Fix Login'));
    await summarizeForkPrompt('fix the login bug');
    const callArgs = sendMessageMock.mock.calls[0][0] as { config?: { maxTokens?: number } };
    expect(callArgs.config?.maxTokens).toBeDefined();
    expect(callArgs.config!.maxTokens!).toBeLessThanOrEqual(256);
  });

  it('returns empty string for empty/whitespace prompts without calling the model', async () => {
    const label = await summarizeForkPrompt('   ');
    expect(label).toBe('');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to a heuristic English label when the model throws', async () => {
    sendMessageMock.mockRejectedValue(new Error('bedrock unreachable'));
    const label = await summarizeForkPrompt('Continue working on the stream parser refactor');
    // Stopwords (continue/working/on/the) dropped, first meaningful words Title-Cased.
    expect(label).toBe('Stream Parser Refactor');
  });

  it('falls back to heuristic when the model returns an empty/garbage label', async () => {
    sendMessageMock.mockResolvedValue(textResult('！！！'));
    const label = await summarizeForkPrompt('fix the login redirect loop');
    // "the" is a stopword; first 4 meaningful words Title-Cased.
    expect(label).toBe('Fix Login Redirect Loop');
  });

  it('never throws — returns a string even on total failure', async () => {
    sendMessageMock.mockRejectedValue(new Error('boom'));
    // A prompt with only stopwords → heuristic yields '' (caller keeps placeholder).
    const label = await summarizeForkPrompt('please can you');
    expect(typeof label).toBe('string');
  });
});

describe('parseForkTitle', () => {
  it('parses the bare placeholder shape', () => {
    expect(parseForkTitle('Fork of Notes redesign')).toEqual({ label: null, sourceTitle: 'Notes redesign' });
  });

  it('parses the refined shape', () => {
    expect(parseForkTitle('Fix Login Redirect - fork of Notes redesign'))
      .toEqual({ label: 'Fix Login Redirect', sourceTitle: 'Notes redesign' });
  });

  it('returns null for a human-authored title (never rewrite those)', () => {
    expect(parseForkTitle('Retire the star system')).toBeNull();
    expect(parseForkTitle('')).toBeNull();
    expect(parseForkTitle('forklift of doom')).toBeNull();
  });
});

describe('titleCoversLabel', () => {
  it('true when the title already mentions the topic (paraphrase damping)', () => {
    expect(titleCoversLabel('Star System Removal - fork of UI polish', 'Remove Star System')).toBe(true);
  });

  it('false when the label is a genuinely new topic', () => {
    expect(titleCoversLabel('Context Inspector - fork of UI polish', 'Remove Star System')).toBe(false);
  });

  it('true for an empty label (nothing to cover)', () => {
    expect(titleCoversLabel('anything', '')).toBe(true);
  });
});
