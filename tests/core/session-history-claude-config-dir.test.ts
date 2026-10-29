/**
 * A session whose CLI ran under another Claude config dir keeps its history.
 *
 * The CLI writes its transcript under $CLAUDE_CONFIG_DIR/projects when that is
 * set, and every CLI a daemon spawns inherits the daemon's env, which the local
 * daemon inherits from this server. The server used to build every transcript
 * path from a literal `~/.claude/projects`, so such a session showed no history
 * (found in a real-CLI acceptance run). Paths now come from one resolver
 * (src/core/claude-config-dir.ts); a remote host keeps tilde paths its own
 * daemon expands.
 *
 * The local daemon is the real-fs double (tests/helpers/mock-local-daemon-reader.ts):
 * `~` maps to the mocked CLAUDE_HOME's parent, absolute paths read as they are.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  canonicalJsonlPath,
  remoteJsonlPath,
  readSessionJsonlContent,
  readSubagentContents,
} from '../../src/core/session-file-reader.js';
import { readSessionHistory } from '../../src/core/session-history.js';
import { claudeProjectsDir, claudeProjectsSearchRoots, localClaudeProjectsDir } from '../../src/core/claude-config-dir.js';

const CWD = '/work/marina';
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
let configDir = '';

function transcript(sessionId: string): string {
  return [
    JSON.stringify({ type: 'user', uuid: `${sessionId}-u1`, parentUuid: null, timestamp: '2026-10-29T00:00:00Z', cwd: CWD, message: { role: 'user', content: 'Question under a custom config dir' } }),
    JSON.stringify({ type: 'assistant', uuid: `${sessionId}-a1`, parentUuid: `${sessionId}-u1`, timestamp: '2026-10-29T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Answer from the custom config dir' }] } }),
  ].join('\n') + '\n';
}

async function writeUnder(root: string, sessionId: string): Promise<string> {
  const dir = path.join(root, 'projects', encodeProjectPath(CWD));
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await fsp.writeFile(file, transcript(sessionId));
  return file;
}

beforeEach(async () => {
  configDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-claude-config-')));
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true });
  await fsp.mkdir(CLAUDE_HOME, { recursive: true });
});

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  await fsp.rm(configDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('session history under CLAUDE_CONFIG_DIR', () => {
  it('reads the transcript from the config dir the session ran under', async () => {
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const sid = 'cfgdir-history-1';
    const file = await writeUnder(configDir, sid);

    const read = await readSessionJsonlContent(sid, CWD);
    expect(read?.source).toBe('local');
    expect(read?.resolvedRemotePath).toBe(file);

    const messages = await readSessionHistory(sid, CWD);
    expect(messages.find((m) => m.role === 'user' && m.text.includes('Question under a custom config dir'))).toBeDefined();
    expect(messages.find((m) => m.role === 'assistant' && m.text.includes('Answer from the custom config dir'))).toBeDefined();
  });

  it('reads its subagent transcripts from the same dir', async () => {
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const sid = 'cfgdir-subagents-1';
    const sub = path.join(configDir, 'projects', encodeProjectPath(CWD), sid, 'subagents');
    await fsp.mkdir(sub, { recursive: true });
    await fsp.writeFile(path.join(sub, 'agent-x1.jsonl'), '{"type":"assistant","message":{"id":"s1","role":"assistant","content":[{"type":"text","text":"sub"}]}}\n');
    const map = await readSubagentContents(sid, CWD);
    expect([...map.keys()]).toEqual(['x1']);
  });

  it('builds local paths from the config dir and leaves remote paths to their daemon', () => {
    process.env.CLAUDE_CONFIG_DIR = configDir + '/';
    expect(localClaudeProjectsDir()).toBe(path.join(configDir, 'projects'));
    expect(canonicalJsonlPath('s1', CWD)).toBe(path.join(configDir, 'projects', encodeProjectPath(CWD), 's1.jsonl'));
    expect(remoteJsonlPath('s1', CWD)).toBe(`${configDir}/projects/${encodeProjectPath(CWD)}/s1.jsonl`);
    expect(remoteJsonlPath('s1', CWD, '__local__')).toBe(`${configDir}/projects/${encodeProjectPath(CWD)}/s1.jsonl`);
    // A remote host's env is its own: its daemon expands ~ and walks its own CLAUDE_CONFIG_DIR.
    expect(remoteJsonlPath('s1', CWD, 'dev-box')).toBe(`~/.claude/projects/${encodeProjectPath(CWD)}/s1.jsonl`);
    expect(claudeProjectsSearchRoots('dev-box')).toEqual(['~/.claude/projects']);
    expect(claudeProjectsSearchRoots()).toEqual([path.join(configDir, 'projects'), '~/.claude/projects']);
  });

  it('keeps the default ~/.claude when CLAUDE_CONFIG_DIR is unset or not absolute', async () => {
    for (const value of [undefined, '', 'relative/dir']) {
      if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = value;
      expect(claudeProjectsDir()).toBe('~/.claude/projects');
      expect(localClaudeProjectsDir()).toBe(path.join(CLAUDE_HOME, 'projects'));
    }
    delete process.env.CLAUDE_CONFIG_DIR;
    const sid = 'cfgdir-default-1';
    await writeUnder(CLAUDE_HOME, sid);
    const messages = await readSessionHistory(sid, CWD);
    expect(messages.find((m) => m.role === 'assistant' && m.text.includes('Answer from the custom config dir'))).toBeDefined();
  });
});
