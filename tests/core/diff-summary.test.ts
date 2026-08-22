/**
 * diff-summary — the Changed tab's per-file AI summary generator.
 * Contract pinned:
 *   - content hash: stable for identical diffs, moves with content/status
 *   - prompt building: unified patch for modifications, raw head for adds/
 *     deletes, sibling-file context capped, self excluded
 *   - generation: cache-first (disk, per session), one model call per content
 *     hash, in-flight dedup, empty/failed model → typed 502, disabled AI → 503
 *     unless cached
 *
 * Real: diff-summary code, disk cache under a temp WALNUT_HOME. Fake:
 * sendMessage, cheap-model gate, session-tracker, session-lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-diff-summary'));

const sendMessageMock = vi.fn();
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

let aiDisabled = false;
vi.mock('../../src/core/cheap-model.js', () => ({
  fastModelFor: () => 'test-fast-model',
  backgroundAiDisabled: () => aiDisabled,
}));

const getSessionByClaudeIdMock = vi.fn();
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: (...args: unknown[]) => getSessionByClaudeIdMock(...args),
}));

const getSessionFileChangeMock = vi.fn();
const getSessionChangesMock = vi.fn();
vi.mock('../../src/core/sessions/session-lifecycle.js', () => ({
  getSessionFileChange: (...args: unknown[]) => getSessionFileChangeMock(...args),
  getSessionChanges: (...args: unknown[]) => getSessionChangesMock(...args),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  diffSummaryHash, buildDiffText, buildDiffSummaryPrompt, isSensitivePath,
  summarizeSessionFileChange, DiffSummaryError,
} from '../../src/core/diff-summary.js';

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

function fileChange(over: Partial<{
  filePath: string; relPath: string; before: string; after: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed'; oldRelPath?: string;
}> = {}) {
  return {
    filePath: '/repo/src/a.ts',
    relPath: 'src/a.ts',
    before: 'line1\nline2\n',
    after: 'line1\nline2 changed\n',
    status: 'modified' as const,
    ...over,
  };
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  aiDisabled = false;
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(textResult('Renames the sync handler. In this changeset: the core edit.'));
  getSessionByClaudeIdMock.mockReset();
  getSessionByClaudeIdMock.mockResolvedValue({ host: undefined, cwd: '/repo' });
  getSessionFileChangeMock.mockReset();
  getSessionFileChangeMock.mockResolvedValue({ sessionId: 's1', repoRoot: '/repo', file: fileChange() });
  getSessionChangesMock.mockReset();
  getSessionChangesMock.mockResolvedValue({
    groups: [{ files: [
      { relPath: 'src/a.ts', status: 'modified' },
      { relPath: 'src/b.ts', status: 'added' },
    ] }],
  });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('diffSummaryHash', () => {
  it('is stable for identical content', () => {
    expect(diffSummaryHash(fileChange())).toBe(diffSummaryHash(fileChange()));
  });

  it('moves when content or status changes', () => {
    const base = diffSummaryHash(fileChange());
    expect(diffSummaryHash(fileChange({ after: 'other\n' }))).not.toBe(base);
    expect(diffSummaryHash(fileChange({ status: 'deleted' }))).not.toBe(base);
  });
});

describe('buildDiffText', () => {
  it('emits a unified patch for a modification', () => {
    const text = buildDiffText(fileChange());
    expect(text).toContain('@@');
    expect(text).toContain('-line2');
    expect(text).toContain('+line2 changed');
  });

  it('sends raw head content for adds, flagged when truncated', () => {
    const big = Array.from({ length: 500 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const text = buildDiffText(fileChange({ status: 'added', before: '', after: big }));
    expect(text).toMatch(/^NEW FILE/);
    expect(text).toContain('…(truncated)');
    expect(text.split('\n').length).toBeLessThan(400);
  });

  it('describes a pure rename with no content change', () => {
    const text = buildDiffText(fileChange({
      status: 'renamed', oldRelPath: 'src/old.ts', before: 'same\n', after: 'same\n',
    }));
    expect(text).toContain('moved from src/old.ts');
  });
});

describe('buildDiffSummaryPrompt', () => {
  it('lists siblings but never the file itself', () => {
    const prompt = buildDiffSummaryPrompt(fileChange(), [
      { relPath: 'src/a.ts', status: 'modified' },
      { relPath: 'src/b.ts', status: 'added' },
    ]);
    expect(prompt).toContain('src/b.ts');
    // Self appears only in the "File:" header, not the sibling list (the
    // unified diff carries no filename lines — buildDiffText emits @@ hunks only).
    expect(prompt.match(/src\/a\.ts/g)).toHaveLength(1);
  });

  it('caps the sibling list and reports the exact overflow', () => {
    // 80 siblings, none of them the file itself: 60 shown, 20 hidden.
    const siblings = Array.from({ length: 80 }, (_, i) => ({ relPath: `src/f${i}.ts`, status: 'modified' }));
    const prompt = buildDiffSummaryPrompt(fileChange(), siblings);
    expect(prompt).toContain('…and 20 more files');
    expect(prompt).not.toContain('src/f75.ts');
  });

  it('says so when this is the only changed file', () => {
    const prompt = buildDiffSummaryPrompt(fileChange(), [{ relPath: 'src/a.ts', status: 'modified' }]);
    expect(prompt).toContain('the only changed file');
  });

  it('null siblings (fetch failed) says context is unavailable, not "only file"', () => {
    const prompt = buildDiffSummaryPrompt(fileChange(), null);
    expect(prompt).toContain('changeset context unavailable');
    expect(prompt).not.toContain('only changed file');
  });
});

describe('isSensitivePath', () => {
  it('matches secret-shaped basenames anywhere in the tree', () => {
    for (const p of ['.env', 'config/.env.production', 'id_rsa', 'certs/server.pem', 'a/b.key', 'credentials.json', '.npmrc']) {
      expect(isSensitivePath(p), p).toBe(true);
    }
  });
  it('leaves ordinary code files alone', () => {
    for (const p of ['src/env.ts', 'keyboard.ts', 'docs/credentials-guide.md', 'src/a.ts']) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});

describe('summarizeSessionFileChange', () => {
  it('unknown session → 404', async () => {
    getSessionByClaudeIdMock.mockResolvedValue(null);
    await expect(summarizeSessionFileChange('nope', '/repo/src/a.ts'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('generates once, then serves the disk cache for the same content', async () => {
    const first = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(first.cached).toBe(false);
    expect(first.summary).toContain('sync handler');
    expect(first.model).toBe('test-fast-model');
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const second = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(second.cached).toBe(true);
    expect(second.summary).toBe(first.summary);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('regenerates when the file content moves', async () => {
    await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', repoRoot: '/repo', file: fileChange({ after: 'brand new\n' }),
    });
    const res = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(res.cached).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('dedups concurrent requests for the same file into one model call', async () => {
    // Hold the model call open until BOTH requests have had a chance to join
    // it. A fixed sleep is a race under machine load — gate on the call itself.
    let release!: (v: unknown) => void;
    let modelReached!: () => void;
    const reachedModel = new Promise<void>((r) => { modelReached = r; });
    sendMessageMock.mockImplementation(() => {
      modelReached();
      return new Promise((resolve) => { release = resolve; });
    });
    const p1 = summarizeSessionFileChange('s1', '/repo/src/a.ts');
    const p2 = summarizeSessionFileChange('s1', '/repo/src/a.ts');
    await reachedModel;
    // p2 attaches to p1's in-flight entry during ITS pre-model awaits; give the
    // event loop a few turns to drain them before releasing.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    release(textResult('One call.'));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.summary).toBe('One call.');
    expect(r2.summary).toBe('One call.');
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('model failure → typed 502, nothing cached', async () => {
    sendMessageMock.mockRejectedValue(new Error('bedrock down'));
    await expect(summarizeSessionFileChange('s1', '/repo/src/a.ts'))
      .rejects.toMatchObject({ statusCode: 502 });
    // Next attempt tries again (no poisoned cache entry).
    sendMessageMock.mockResolvedValue(textResult('Recovered.'));
    const res = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(res.summary).toBe('Recovered.');
  });

  it('empty model output → 502', async () => {
    sendMessageMock.mockResolvedValue(textResult('   '));
    await expect(summarizeSessionFileChange('s1', '/repo/src/a.ts'))
      .rejects.toMatchObject({ statusCode: 502 });
  });

  it('AI disabled → 503 on a cold file, but a cached summary still serves', async () => {
    const warm = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(warm.cached).toBe(false);
    aiDisabled = true;
    // Cached content: served without a model call.
    const cached = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(cached.cached).toBe(true);
    // Cold content: refuses instead of calling the model.
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', repoRoot: '/repo', file: fileChange({ relPath: 'src/c.ts', filePath: '/repo/src/c.ts', after: 'cold\n' }),
    });
    await expect(summarizeSessionFileChange('s1', '/repo/src/c.ts'))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('sibling-list failure is non-fatal and the prompt admits the gap', async () => {
    getSessionChangesMock.mockRejectedValue(new Error('daemon offline'));
    const res = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(res.summary).toBeTruthy();
    // The model must be told the context is missing — an empty sibling list
    // would make it claim "only changed file", a confidently false statement.
    const req = sendMessageMock.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(req.messages[0].content).toContain('changeset context unavailable');
  });

  it('secret-shaped file → 422, model never called', async () => {
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ relPath: 'config/.env.production', filePath: '/repo/config/.env.production' }),
    });
    await expect(summarizeSessionFileChange('s1', '/repo/config/.env.production'))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('binary content → 422, model never called', async () => {
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ before: 'PNG\0\0\0binary', after: 'PNG\0\0\0other' }),
    });
    await expect(summarizeSessionFileChange('s1', '/repo/src/a.ts'))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('identical before/after → deterministic caption, no model call', async () => {
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ before: 'same\n', after: 'same\n' }),
    });
    const res = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(res.summary).toBe('No textual change to this file.');
    expect(res.model).toBe('rule-based');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('pure rename → deterministic "moved from" caption, no model call', async () => {
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ status: 'renamed', oldRelPath: 'src/old.ts', before: 'same\n', after: 'same\n' }),
    });
    const res = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(res.summary).toContain('Moved from `src/old.ts`');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('max_tokens truncation is returned once but never cached', async () => {
    sendMessageMock.mockResolvedValue({ content: [{ type: 'text', text: 'Cut off mid-' }], stopReason: 'max_tokens' });
    const first = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(first.summary).toBe('Cut off mid-');
    // Same content again → regenerates instead of serving the truncated text.
    sendMessageMock.mockResolvedValue(textResult('Full sentence.'));
    const second = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(second.cached).toBe(false);
    expect(second.summary).toBe('Full sentence.');
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('same relPath in two repos → separate cache entries (keyed by filePath)', async () => {
    getSessionFileChangeMock.mockImplementation(async (_sid: string, fp: string) => ({
      sessionId: 's1',
      file: fp.startsWith('/repoA/')
        ? fileChange({ relPath: 'package.json', before: 'a\n', after: 'a2\n' })
        : fileChange({ relPath: 'package.json', before: 'b\n', after: 'b2\n' }),
    }));
    sendMessageMock.mockResolvedValueOnce(textResult('Repo A dep bump.'));
    sendMessageMock.mockResolvedValueOnce(textResult('Repo B dep bump.'));
    await summarizeSessionFileChange('s1', '/repoA/package.json');
    await summarizeSessionFileChange('s1', '/repoB/package.json');
    const cachedA = await summarizeSessionFileChange('s1', '/repoA/package.json');
    const cachedB = await summarizeSessionFileChange('s1', '/repoB/package.json');
    expect(cachedA).toMatchObject({ cached: true, summary: 'Repo A dep bump.' });
    expect(cachedB).toMatchObject({ cached: true, summary: 'Repo B dep bump.' });
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('errors carry DiffSummaryError type', async () => {
    getSessionByClaudeIdMock.mockResolvedValue(null);
    await expect(summarizeSessionFileChange('x', '/y')).rejects.toBeInstanceOf(DiffSummaryError);
  });
});
