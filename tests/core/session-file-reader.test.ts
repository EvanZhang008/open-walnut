import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
// Daemon-uniform: createFileReader / readSessionJsonlContent / readSubagentContents route
// local reads through DaemonFileReader('__local__'). No daemon runs in unit tests, so serve
// __local__ from the real fs, honoring the mocked CLAUDE_HOME. (LocalFileReader was deleted —
// the daemon path is now the single reader for both local and remote.)
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js';
import {
  encodeProjectPath,
  canonicalJsonlPath,
  remoteJsonlPath,
  subagentDirPath,
  remoteSubagentDirPath,
  findLocalJsonlPath,
  readSessionJsonlContent,
  readSubagentContents,
} from '../../src/core/session-file-reader.js';
import { readSessionHistory } from '../../src/core/session-history.js';

const tmpBase = CLAUDE_HOME;

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  // Also clean SESSION_STREAMS_DIR (sibling to CLAUDE_HOME, not inside it)
  await fsp.rm(SESSION_STREAMS_DIR, { recursive: true, force: true }).catch(() => {});
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(SESSION_STREAMS_DIR, { recursive: true, force: true }).catch(() => {});
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

// ── createFileReader('__local__') — the daemon-uniform reader (LocalFileReader deleted) ──
// The local reader now goes through DaemonFileReader('__local__'); in unit tests that is the
// real-fs-backed double (mockLocalDaemonReader) resolving ~/.claude → the mocked CLAUDE_HOME.

describe('createFileReader (__local__ via daemon)', () => {
  it('reads an existing file under ~/.claude', async () => {
    const { createFileReader } = await import('../../src/core/session-file-reader.js');
    const reader = await createFileReader(); // undefined host → __local__
    // CLAUDE_HOME is <tmpBase>/.claude; the double maps ~/.claude → CLAUDE_HOME.
    await fsp.writeFile(path.join(CLAUDE_HOME, 'test.txt'), 'hello world');
    const content = await reader.readFile('~/.claude/test.txt');
    expect(content).toBe('hello world');
  });

  it('returns null for missing file', async () => {
    const { createFileReader } = await import('../../src/core/session-file-reader.js');
    const reader = await createFileReader();
    const content = await reader.readFile('~/.claude/nonexistent.txt');
    expect(content).toBeNull();
  });

  it('lists directory contents', async () => {
    const { createFileReader } = await import('../../src/core/session-file-reader.js');
    const reader = await createFileReader();
    const dir = path.join(CLAUDE_HOME, 'testdir');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.txt'), '');
    await fsp.writeFile(path.join(dir, 'b.txt'), '');
    const files = await reader.listDir('~/.claude/testdir');
    expect(files.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('returns empty array for missing directory', async () => {
    const { createFileReader } = await import('../../src/core/session-file-reader.js');
    const reader = await createFileReader();
    const files = await reader.listDir('~/.claude/nope');
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

    const result = await findLocalJsonlPath('sess-123', cwd);
    expect(result).toBe(path.join(dir, 'sess-123.jsonl'));
  });

  it('finds file via fallback search when no cwd', async () => {
    const dir = path.join(tmpBase, 'projects', '-some-project');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'sess-456.jsonl'), '{}');

    const result = await findLocalJsonlPath('sess-456');
    expect(result).toBe(path.join(dir, 'sess-456.jsonl'));
  });

  it('returns null when file does not exist', async () => {
    expect(await findLocalJsonlPath('nonexistent')).toBeNull();
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

  it('returns canonical content when no streams file exists', async () => {
    const sessionId = 'no-streams-test';
    const cwd = '/test';

    // Only canonical JSONL, no streams file
    const canonicalContent = [
      JSON.stringify({ type: 'user', timestamp: '2025-01-01T00:00:00Z', message: { id: 'u1', role: 'user', content: 'Hello' }, cwd }),
      JSON.stringify({ type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } }),
    ].join('\n');
    await writeJsonl(sessionId, cwd, canonicalContent);

    // SESSION_STREAMS_DIR does not exist (not created) — should not crash
    const result = await readSessionJsonlContent(sessionId, cwd);

    expect(result).not.toBeNull();
    expect(result!.source).toBe('local');
    expect(result!.content).toContain('"id":"u1"');
    expect(result!.content).toContain('"id":"a1"');
  });
});

// ── Full pipeline: readSessionHistory → readSessionJsonlContent + parseSessionMessages ──

describe('readSessionHistory', () => {
  /** Helper: write JSONL to the standard Claude Code path. */
  async function writeJsonl(sessionId: string, cwd: string, content: string) {
    const encoded = encodeProjectPath(cwd);
    const dir = path.join(tmpBase, 'projects', encoded);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), content);
  }

  it('parses canonical JSONL into user/assistant messages', async () => {
    const sessionId = 'pipeline-test-1';
    const cwd = '/test';

    const canonicalContent = [
      JSON.stringify({
        type: 'user',
        timestamp: '2025-01-01T00:00:00Z',
        message: { id: 'u1', role: 'user', content: 'Original question' },
        cwd,
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2025-01-01T00:00:01Z',
        message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
      }),
    ].join('\n');
    await writeJsonl(sessionId, cwd, canonicalContent);

    const messages = await readSessionHistory(sessionId, cwd);

    expect(messages.length).toBeGreaterThanOrEqual(2);
    const userMsg = messages.find(m => m.role === 'user' && m.text.includes('Original question'));
    expect(userMsg).toBeDefined();
    const assistantMsg = messages.find(m => m.role === 'assistant' && m.text.includes('Response'));
    expect(assistantMsg).toBeDefined();
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

// ── Tilde expansion logic ──

describe('tilde expansion', () => {
  // Test the ~ → $HOME replacement logic used in remote path handling.
  const tildeToHome = (p: string) => p.replace(/^~/, '$HOME');

  it('replaces leading ~ with $HOME', () => {
    expect(tildeToHome('~/.claude/projects/-test/session.jsonl'))
      .toBe('$HOME/.claude/projects/-test/session.jsonl');
  });

  it('replaces ~ in glob paths', () => {
    expect(tildeToHome('~/.claude/projects/*/session.jsonl'))
      .toBe('$HOME/.claude/projects/*/session.jsonl');
  });

  it('does not modify absolute paths', () => {
    expect(tildeToHome('/absolute/path/to/file.jsonl'))
      .toBe('/absolute/path/to/file.jsonl');
  });

  it('does not modify ~ in the middle of a path', () => {
    expect(tildeToHome('/some/~/path'))
      .toBe('/some/~/path');
  });

  it('handles bare ~', () => {
    expect(tildeToHome('~')).toBe('$HOME');
  });
});
