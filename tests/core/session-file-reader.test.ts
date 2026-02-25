import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  canonicalJsonlPath,
  remoteJsonlPath,
  subagentDirPath,
  remoteSubagentDirPath,
  LocalFileReader,
  findLocalJsonlPath,
  readSessionJsonlContent,
  readSubagentContents,
} from '../../src/core/session-file-reader.js';

const tmpBase = CLAUDE_HOME;

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

// ── Path helpers ──

describe('encodeProjectPath', () => {
  it('replaces slashes with dashes', () => {
    expect(encodeProjectPath('/Users/foo/bar')).toBe('-Users-foo-bar');
  });

  it('handles root path', () => {
    expect(encodeProjectPath('/')).toBe('-');
  });
});

describe('canonicalJsonlPath', () => {
  it('builds local absolute path', () => {
    const result = canonicalJsonlPath('abc123', '/Users/foo/bar');
    expect(result).toBe(path.join(CLAUDE_HOME, 'projects', '-Users-foo-bar', 'abc123.jsonl'));
  });
});

describe('remoteJsonlPath', () => {
  it('builds remote path with cwd', () => {
    expect(remoteJsonlPath('abc123', '/Users/foo/bar')).toBe(
      '~/.claude/projects/-Users-foo-bar/abc123.jsonl',
    );
  });

  it('builds glob path without cwd', () => {
    expect(remoteJsonlPath('abc123')).toBe('~/.claude/projects/*/abc123.jsonl');
  });
});

describe('subagentDirPath', () => {
  it('builds local subagent directory path', () => {
    const result = subagentDirPath('sess1', '/test');
    expect(result).toBe(path.join(CLAUDE_HOME, 'projects', '-test', 'sess1', 'subagents'));
  });
});

describe('remoteSubagentDirPath', () => {
  it('builds remote subagent path with cwd', () => {
    expect(remoteSubagentDirPath('sess1', '/test')).toBe(
      '~/.claude/projects/-test/sess1/subagents',
    );
  });

  it('builds glob path without cwd', () => {
    expect(remoteSubagentDirPath('sess1')).toBe(
      '~/.claude/projects/*/sess1/subagents',
    );
  });
});

// ── LocalFileReader ──

describe('LocalFileReader', () => {
  const reader = new LocalFileReader();

  it('reads an existing file', async () => {
    const filePath = path.join(tmpBase, 'test.txt');
    await fsp.writeFile(filePath, 'hello world');
    const content = await reader.readFile(filePath);
    expect(content).toBe('hello world');
  });

  it('returns null for missing file', async () => {
    const content = await reader.readFile(path.join(tmpBase, 'nonexistent.txt'));
    expect(content).toBeNull();
  });

  it('lists directory contents', async () => {
    const dir = path.join(tmpBase, 'testdir');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.txt'), '');
    await fsp.writeFile(path.join(dir, 'b.txt'), '');
    const files = await reader.listDir(dir);
    expect(files.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('returns empty array for missing directory', async () => {
    const files = await reader.listDir(path.join(tmpBase, 'nope'));
    expect(files).toEqual([]);
  });
});

// ── findLocalJsonlPath ──

describe('findLocalJsonlPath', () => {
  it('finds file when cwd is provided', async () => {
    const cwd = '/Users/test/project';
    const encoded = encodeProjectPath(cwd);
    const dir = path.join(tmpBase, 'projects', encoded);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'sess-123.jsonl'), '{}');

    const result = findLocalJsonlPath('sess-123', cwd);
    expect(result).toBe(path.join(dir, 'sess-123.jsonl'));
  });

  it('finds file via fallback search when no cwd', async () => {
    const dir = path.join(tmpBase, 'projects', '-some-project');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'sess-456.jsonl'), '{}');

    const result = findLocalJsonlPath('sess-456');
    expect(result).toBe(path.join(dir, 'sess-456.jsonl'));
  });

  it('returns null when file does not exist', () => {
    expect(findLocalJsonlPath('nonexistent')).toBeNull();
  });
});

// ── readSessionJsonlContent ──

describe('readSessionJsonlContent', () => {
  /** Helper: write JSONL to the standard Claude Code path. */
  async function writeJsonl(sessionId: string, cwd: string, content: string) {
    const encoded = encodeProjectPath(cwd);
    const dir = path.join(tmpBase, 'projects', encoded);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), content);
  }

  it('reads from local canonical path', async () => {
    await writeJsonl('s1', '/test', '{"type":"user"}\n');
    const result = await readSessionJsonlContent('s1', '/test');
    expect(result).not.toBeNull();
    expect(result!.source).toBe('local');
    expect(result!.content).toContain('{"type":"user"}');
  });

  it('returns null for missing session', async () => {
    const result = await readSessionJsonlContent('nonexistent', '/test');
    expect(result).toBeNull();
  });

  it('reads from outputFile fallback', async () => {
    const tmpFile = path.join(tmpBase, 'tmp-output.jsonl');
    await fsp.writeFile(tmpFile, '{"type":"assistant"}\n');
    const result = await readSessionJsonlContent('missing', '/test', undefined, tmpFile);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('outputFile');
  });
});

// ── readSubagentContents ──

describe('readSubagentContents', () => {
  it('reads local subagent JSONL files', async () => {
    const cwd = '/test/project';
    const encoded = encodeProjectPath(cwd);
    const subDir = path.join(tmpBase, 'projects', encoded, 'sess1', 'subagents');
    await fsp.mkdir(subDir, { recursive: true });
    await fsp.writeFile(
      path.join(subDir, 'agent-abc123.jsonl'),
      '{"type":"assistant","message":{"id":"a1","role":"assistant","content":[{"type":"text","text":"hello"}]}}\n',
    );
    await fsp.writeFile(
      path.join(subDir, 'agent-def456.jsonl'),
      '{"type":"user","message":{"id":"u1","role":"user","content":[{"type":"text","text":"hi"}]}}\n',
    );

    const result = await readSubagentContents('sess1', cwd);
    expect(result.size).toBe(2);
    expect(result.has('abc123')).toBe(true);
    expect(result.has('def456')).toBe(true);
    expect(result.get('abc123')).toContain('hello');
  });

  it('returns empty map when no subagents directory', async () => {
    const result = await readSubagentContents('nonexistent', '/test');
    expect(result.size).toBe(0);
  });

  it('skips non-agent files in subagents directory', async () => {
    const cwd = '/test';
    const encoded = encodeProjectPath(cwd);
    const subDir = path.join(tmpBase, 'projects', encoded, 'sess2', 'subagents');
    await fsp.mkdir(subDir, { recursive: true });
    await fsp.writeFile(path.join(subDir, 'agent-valid.jsonl'), '{"type":"user"}');
    await fsp.writeFile(path.join(subDir, 'not-agent.jsonl'), '{"type":"user"}');
    await fsp.writeFile(path.join(subDir, 'readme.md'), 'docs');

    const result = await readSubagentContents('sess2', cwd);
    expect(result.size).toBe(1);
    expect(result.has('valid')).toBe(true);
  });
});
