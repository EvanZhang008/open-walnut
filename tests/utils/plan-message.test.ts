import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readPlanFromSession, buildPlanExecutionMessage } from '../../src/utils/plan-message.js';

// Mock dependencies
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(),
}));

vi.mock('../../src/core/session-history.js', () => ({
  findSessionJsonlPath: vi.fn(),
  extractPlanContent: vi.fn(),
}));

vi.mock('../../src/core/session-file-reader.js', () => ({
  createFileReader: vi.fn(),
  readSessionJsonlContent: vi.fn(),
}));

vi.mock('../../src/constants.js', () => ({
  CLAUDE_HOME: '/home/user/.claude',
}));

import { getSessionByClaudeId } from '../../src/core/session-tracker.js';
import { findSessionJsonlPath, extractPlanContent } from '../../src/core/session-history.js';
import { createFileReader, readSessionJsonlContent } from '../../src/core/session-file-reader.js';

const mockGetSession = vi.mocked(getSessionByClaudeId);
const mockFindJsonl = vi.mocked(findSessionJsonlPath);
const mockExtractPlan = vi.mocked(extractPlanContent);
const mockCreateReader = vi.mocked(createFileReader);
const mockReadJsonl = vi.mocked(readSessionJsonlContent);

function makeReader(files: Record<string, string | null> = {}) {
  return {
    readFile: vi.fn(async (p: string) => files[p] ?? null),
    listDir: vi.fn(async () => []),
  };
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    claudeSessionId: 'sess-123',
    taskId: 'task-1',
    project: 'TestProject',
    process_status: 'stopped',
    work_status: 'agent_complete',
    mode: 'plan',
    last_status_change: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
    messageCount: 1,
    planCompleted: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readPlanFromSession', () => {
  it('returns error when session not found', async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await readPlanFromSession('nonexistent');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('not found');
  });

  it('returns error when planCompleted is false', async () => {
    mockGetSession.mockResolvedValue(makeRecord({ planCompleted: false }) as never);
    const result = await readPlanFromSession('sess-123');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('has not completed a plan');
  });

  describe('Strategy 1: planFile from session record', () => {
    it('reads local plan file via LocalFileReader', async () => {
      const reader = makeReader({ '/home/user/.claude/plans/my-plan.md': '# Plan\nDo stuff' });
      mockCreateReader.mockReturnValue(reader);
      mockGetSession.mockResolvedValue(makeRecord({
        planFile: '/home/user/.claude/plans/my-plan.md',
      }) as never);

      const result = await readPlanFromSession('sess-123');
      expect(result).toEqual({
        content: '# Plan\nDo stuff',
        planFile: '/home/user/.claude/plans/my-plan.md',
      });
      expect(mockCreateReader).toHaveBeenCalledWith(undefined); // no host = local
    });

    it('reads remote plan file via RemoteFileReader (SSH)', async () => {
      const reader = makeReader({ '/home/remoteuser/.claude/plans/remote-plan.md': '# Remote Plan' });
      mockCreateReader.mockReturnValue(reader);
      mockGetSession.mockResolvedValue(makeRecord({
        host: 'clouddev',
        planFile: '/home/remoteuser/.claude/plans/remote-plan.md',
      }) as never);

      const result = await readPlanFromSession('sess-123');
      expect(result).toEqual({
        content: '# Remote Plan',
        planFile: '/home/remoteuser/.claude/plans/remote-plan.md',
      });
      expect(mockCreateReader).toHaveBeenCalledWith('clouddev');
    });

    it('falls through when planFile content is empty', async () => {
      const reader = makeReader({ '/home/user/.claude/plans/empty.md': '   ' });
      mockCreateReader.mockReturnValue(reader);
      mockGetSession.mockResolvedValue(makeRecord({
        planFile: '/home/user/.claude/plans/empty.md',
      }) as never);

      const result = await readPlanFromSession('sess-123');
      // Should fall through to error (no other strategies configured)
      expect(result).toHaveProperty('error');
    });
  });

  describe('Strategy 2: JSONL slug → plans/{slug}.md', () => {
    it('reads plan via slug from local JSONL', async () => {
      const reader = makeReader({
        '/home/user/.claude/projects/-work/sess-123.jsonl': '{"slug":"my-cool-plan"}\n',
        '/home/user/.claude/plans/my-cool-plan.md': '# Cool Plan\nStep 1',
      });
      mockCreateReader.mockReturnValue(reader);
      mockGetSession.mockResolvedValue(makeRecord({ cwd: '/work' }) as never);
      mockFindJsonl.mockReturnValue('/home/user/.claude/projects/-work/sess-123.jsonl');

      const result = await readPlanFromSession('sess-123');
      expect(result).toEqual({
        content: '# Cool Plan\nStep 1',
        planFile: '/home/user/.claude/plans/my-cool-plan.md',
      });
    });

    it('reads plan via slug from remote JSONL with tilde path', async () => {
      mockCreateReader.mockReturnValue(makeReader({
        '~/.claude/plans/remote-slug.md': '# Remote Plan via Slug',
      }));
      mockGetSession.mockResolvedValue(makeRecord({
        host: 'clouddev',
        cwd: '/home/user/project',
      }) as never);
      mockReadJsonl.mockResolvedValue({
        content: '{"slug":"remote-slug"}\n',
        source: 'remote',
      });

      const result = await readPlanFromSession('sess-123');
      expect(result).toEqual({
        content: '# Remote Plan via Slug',
        planFile: '~/.claude/plans/remote-slug.md',
      });
      // Should use readSessionJsonlContent for remote, not findSessionJsonlPath
      expect(mockReadJsonl).toHaveBeenCalledWith('sess-123', '/home/user/project', 'clouddev', undefined);
      expect(mockFindJsonl).not.toHaveBeenCalled();
    });
  });

  describe('Strategy 3: extractPlanContent fallback', () => {
    it('extracts plan from JSONL tool_use blocks when file not found', async () => {
      const reader = makeReader(); // no files
      mockCreateReader.mockReturnValue(reader);
      mockGetSession.mockResolvedValue(makeRecord({
        host: 'clouddev',
        cwd: '/remote/project',
      }) as never);
      mockReadJsonl.mockResolvedValue(null);
      mockExtractPlan.mockResolvedValue('# Extracted Plan\nFrom JSONL');

      const result = await readPlanFromSession('sess-123');
      expect(result).toEqual({
        content: '# Extracted Plan\nFrom JSONL',
        planFile: '(extracted from session sess-123 JSONL)',
      });
      expect(mockExtractPlan).toHaveBeenCalledWith('sess-123', '/remote/project', 'clouddev');
    });

    it('uses record.planFile as planFile hint when extracting', async () => {
      const reader = makeReader(); // readFile returns null for the planFile path
      mockCreateReader.mockReturnValue(reader);
      mockGetSession.mockResolvedValue(makeRecord({
        host: 'clouddev',
        planFile: '/remote/.claude/plans/x.md',
      }) as never);
      mockReadJsonl.mockResolvedValue(null);
      mockExtractPlan.mockResolvedValue('# Extracted');

      const result = await readPlanFromSession('sess-123');
      expect(result).toEqual({
        content: '# Extracted',
        planFile: '/remote/.claude/plans/x.md',
      });
    });
  });

  it('returns error when all strategies fail', async () => {
    const reader = makeReader();
    mockCreateReader.mockReturnValue(reader);
    mockGetSession.mockResolvedValue(makeRecord({ host: 'clouddev' }) as never);
    mockReadJsonl.mockResolvedValue(null);
    mockExtractPlan.mockResolvedValue(null);

    const result = await readPlanFromSession('sess-123');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Could not find plan file');
  });
});

describe('buildPlanExecutionMessage', () => {
  it('builds message with default instruction', () => {
    const msg = buildPlanExecutionMessage('/path/to/plan.md', '# My Plan');
    expect(msg).toContain('Execute the plan below');
    expect(msg).toContain('Plan file: /path/to/plan.md');
    expect(msg).toContain('# My Plan');
    expect(msg).toContain('IMPORTANT: If your context is ever compacted');
  });

  it('builds message with custom instruction', () => {
    const msg = buildPlanExecutionMessage('/path/to/plan.md', '# My Plan', 'Custom instruction here');
    expect(msg).toContain('Custom instruction here');
    expect(msg).not.toContain('Execute the plan below');
  });
});
