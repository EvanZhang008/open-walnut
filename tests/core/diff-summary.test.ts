/**
 * diff-summary — the Changed tab's per-file AI summary generator.
 * Contract pinned:
 *   - content hash: stable for identical diffs, moves with content/status/lang
 *   - question building: unified patch for modifications, raw head for adds/
 *     deletes, extreme-brevity + output-language instructions
 *   - generation: cache-first (disk, per session), ONE hidden side question to
 *     the session's own CLI per content hash (NEVER Walnut's model API),
 *     in-flight dedup, failures → typed 502/503, disabled AI → 503 unless
 *     cached, secret/binary files → 422 without any prompt
 *
 * Real: diff-summary code, disk cache under a temp WALNUT_HOME. Fake:
 * sessionRunner (side-question channel), cheap-model gate, session-tracker,
 * session-lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-diff-summary'));

const askMock = vi.fn();
const attachMock = vi.fn();
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    getOrAttachLiveSession: (...args: unknown[]) => attachMock(...args),
    requestTurnCompleteSelfReport: (...args: unknown[]) => askMock(...args),
  },
}));

let aiDisabled = false;
vi.mock('../../src/core/cheap-model.js', () => ({
  backgroundAiDisabled: () => aiDisabled,
}));

const getSessionByClaudeIdMock = vi.fn();
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: (...args: unknown[]) => getSessionByClaudeIdMock(...args),
}));

const getSessionFileChangeMock = vi.fn();
vi.mock('../../src/core/sessions/session-lifecycle.js', () => ({
  getSessionFileChange: (...args: unknown[]) => getSessionFileChangeMock(...args),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  diffSummaryHash, buildDiffText, buildDiffSummaryQuestion, isSensitivePath,
  normalizeLang, summarizeSessionFileChange, DiffSummaryError,
} from '../../src/core/diff-summary.js';

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
  askMock.mockReset();
  askMock.mockResolvedValue('重命名 sync handler(核心改动)');
  attachMock.mockReset();
  attachMock.mockResolvedValue(undefined);
  getSessionByClaudeIdMock.mockReset();
  getSessionByClaudeIdMock.mockResolvedValue({ host: undefined, cwd: '/repo', model: 'opus' });
  getSessionFileChangeMock.mockReset();
  getSessionFileChangeMock.mockResolvedValue({ sessionId: 's1', file: fileChange() });
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

  it('moves with the output language (switching languages regenerates)', () => {
    expect(diffSummaryHash(fileChange(), 'zh')).not.toBe(diffSummaryHash(fileChange(), 'en'));
  });
});

describe('normalizeLang', () => {
  it('reduces locale tags to the primary subtag', () => {
    expect(normalizeLang('zh-CN')).toBe('zh');
    expect(normalizeLang('ZH_Hans')).toBe('zh');
    expect(normalizeLang('en')).toBe('en');
  });
  it('rejects junk', () => {
    expect(normalizeLang('')).toBeUndefined();
    expect(normalizeLang(undefined)).toBeUndefined();
    expect(normalizeLang('!!')).toBeUndefined();
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
    expect(text.split('\n').length).toBeLessThan(300);
  });

  it('describes a pure rename with no content change', () => {
    const text = buildDiffText(fileChange({
      status: 'renamed', oldRelPath: 'src/old.ts', before: 'same\n', after: 'same\n',
    }));
    expect(text).toContain('moved from src/old.ts');
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

describe('buildDiffSummaryQuestion', () => {
  it('names the file, embeds the diff, and demands extreme brevity', () => {
    const q = buildDiffSummaryQuestion(fileChange(), 'en');
    expect(q).toContain('`src/a.ts`');
    expect(q).toContain('+line2 changed');
    expect(q).toContain('FEW words');
    expect(q).toContain('you made this change');
  });

  it('asks for the target output language', () => {
    expect(buildDiffSummaryQuestion(fileChange(), 'zh')).toContain('简体中文');
    expect(buildDiffSummaryQuestion(fileChange(), 'en')).toContain('Write in English');
    // Unknown code degrades to the ISO name form instead of guessing.
    expect(buildDiffSummaryQuestion(fileChange(), 'xx')).toContain("ISO 639-1 code 'xx'");
  });
});

describe('summarizeSessionFileChange', () => {
  it('unknown session → 404', async () => {
    getSessionByClaudeIdMock.mockResolvedValue(null);
    await expect(summarizeSessionFileChange('nope', '/repo/src/a.ts'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('asks the session ONCE, then serves the disk cache for the same content', async () => {
    const first = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(first.cached).toBe(false);
    expect(first.summary).toContain('sync handler');
    // model = the session's own model (the session answered, not a Walnut API call)
    expect(first.model).toBe('opus');
    expect(askMock).toHaveBeenCalledTimes(1);

    const second = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(second.cached).toBe(true);
    expect(second.summary).toBe(first.summary);
    expect(askMock).toHaveBeenCalledTimes(1);
  });

  it('regenerates when the file content moves', async () => {
    await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ after: 'brand new\n' }),
    });
    const res = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(res.cached).toBe(false);
    expect(askMock).toHaveBeenCalledTimes(2);
  });

  it('dedups concurrent requests for the same file into one side question', async () => {
    // Hold the side question open until BOTH requests have had a chance to
    // join it. A fixed sleep is a race under machine load — gate on the call.
    let release!: (v: string) => void;
    let reached!: () => void;
    const reachedAsk = new Promise<void>((r) => { reached = r; });
    askMock.mockImplementation(() => {
      reached();
      return new Promise((resolve) => { release = resolve; });
    });
    const p1 = summarizeSessionFileChange('s1', '/repo/src/a.ts');
    const p2 = summarizeSessionFileChange('s1', '/repo/src/a.ts');
    await reachedAsk;
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    release('One call.');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.summary).toBe('One call.');
    expect(r2.summary).toBe('One call.');
    expect(askMock).toHaveBeenCalledTimes(1);
  });

  it('side-question failure → typed 502, nothing cached', async () => {
    askMock.mockRejectedValue(new Error('control channel broke'));
    await expect(summarizeSessionFileChange('s1', '/repo/src/a.ts'))
      .rejects.toMatchObject({ statusCode: 502 });
    // Next attempt tries again (no poisoned cache entry).
    askMock.mockResolvedValue('Recovered.');
    const res = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(res.summary).toBe('Recovered.');
  });

  it('dead CLI ("No live session") → 503 transient, not a hard failure', async () => {
    askMock.mockRejectedValue(new Error('No live session found for self-report: s1'));
    await expect(summarizeSessionFileChange('s1', '/repo/src/a.ts'))
      .rejects.toMatchObject({ statusCode: 503 });
  });

  it('empty answer → 502', async () => {
    askMock.mockResolvedValue('   ');
    await expect(summarizeSessionFileChange('s1', '/repo/src/a.ts'))
      .rejects.toMatchObject({ statusCode: 502 });
  });

  it('AI disabled → 503 on a cold file, but a cached summary still serves', async () => {
    const warm = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(warm.cached).toBe(false);
    aiDisabled = true;
    const cached = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(cached.cached).toBe(true);
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ relPath: 'src/c.ts', filePath: '/repo/src/c.ts', after: 'cold\n' }),
    });
    await expect(summarizeSessionFileChange('s1', '/repo/src/c.ts'))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(askMock).toHaveBeenCalledTimes(1);
  });

  it('secret-shaped file → 422, session never asked', async () => {
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ relPath: 'config/.env.production', filePath: '/repo/config/.env.production' }),
    });
    await expect(summarizeSessionFileChange('s1', '/repo/config/.env.production'))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(askMock).not.toHaveBeenCalled();
  });

  it('binary content → 422, session never asked', async () => {
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ before: 'PNG\0\0\0binary', after: 'PNG\0\0\0other' }),
    });
    await expect(summarizeSessionFileChange('s1', '/repo/src/a.ts'))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(askMock).not.toHaveBeenCalled();
  });

  it('identical before/after → deterministic caption, session never asked', async () => {
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ before: 'same\n', after: 'same\n' }),
    });
    const res = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(res.summary).toBe('No textual change to this file.');
    expect(res.model).toBe('rule-based');
    expect(askMock).not.toHaveBeenCalled();
  });

  it('pure rename → deterministic "moved from" caption, session never asked', async () => {
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ status: 'renamed', oldRelPath: 'src/old.ts', before: 'same\n', after: 'same\n' }),
    });
    const res = await summarizeSessionFileChange('s1', '/repo/src/a.ts');
    expect(res.summary).toContain('Moved from `src/old.ts`');
    expect(askMock).not.toHaveBeenCalled();
  });

  it('same relPath in two repos → separate cache entries (keyed by filePath)', async () => {
    getSessionFileChangeMock.mockImplementation(async (_sid: string, fp: string) => ({
      sessionId: 's1',
      file: fp.startsWith('/repoA/')
        ? fileChange({ relPath: 'package.json', before: 'a\n', after: 'a2\n' })
        : fileChange({ relPath: 'package.json', before: 'b\n', after: 'b2\n' }),
    }));
    askMock.mockResolvedValueOnce('Repo A dep bump.');
    askMock.mockResolvedValueOnce('Repo B dep bump.');
    await summarizeSessionFileChange('s1', '/repoA/package.json');
    await summarizeSessionFileChange('s1', '/repoB/package.json');
    const cachedA = await summarizeSessionFileChange('s1', '/repoA/package.json');
    const cachedB = await summarizeSessionFileChange('s1', '/repoB/package.json');
    expect(cachedA).toMatchObject({ cached: true, summary: 'Repo A dep bump.' });
    expect(cachedB).toMatchObject({ cached: true, summary: 'Repo B dep bump.' });
    expect(askMock).toHaveBeenCalledTimes(2);
  });

  it('errors carry DiffSummaryError type', async () => {
    getSessionByClaudeIdMock.mockResolvedValue(null);
    await expect(summarizeSessionFileChange('x', '/y')).rejects.toBeInstanceOf(DiffSummaryError);
  });

  it('langHint=zh-CN → Chinese question and Chinese deterministic captions', async () => {
    // Side-question path: the question must ask for Chinese.
    await summarizeSessionFileChange('s1', '/repo/src/a.ts', { langHint: 'zh-CN' });
    const question = askMock.mock.calls[0][1] as string;
    expect(question).toContain('简体中文');
    // Deterministic path: caption itself is Chinese.
    getSessionFileChangeMock.mockResolvedValue({
      sessionId: 's1', file: fileChange({ before: 'same\n', after: 'same\n' }),
    });
    const res = await summarizeSessionFileChange('s1', '/repo/src/b.ts', { langHint: 'zh-CN' });
    expect(res.summary).toBe('无文本改动。');
  });
});
