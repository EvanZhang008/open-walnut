/**
 * Tests for qmd-session-sync v2 content indexing (src/core/qmd-session-sync.ts).
 * Mocks the QMD store + session-history reader so we can assert the serialized
 * doc shape without the 2GB embedding model:
 *  - local session conversation body gets indexed (## Turn headings)
 *  - remote session is metadata-only (no JSONL pull over the tunnel)
 *  - summary is prepended as a # Session Gist heading
 *  - hash-skip avoids redundant re-inserts
 *  - JSONL read failure does not overwrite an existing doc
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionRecord } from '../../src/core/types.js';
import type { SessionHistoryMessage } from '../../src/core/session-history.js';

// ── Mock QMD store: capture inserted content keyed by docPath ──
interface FakeDoc { id: number; path: string; title: string; hash: string }
const docs = new Map<string, FakeDoc>();
const contentByHash = new Map<string, string>();
let nextId = 1;

const fakeStore = {
  internal: {
    findActiveDocument: (_coll: string, docPath: string) => docs.get(docPath) ?? null,
    getHashesNeedingEmbedding: () => 0,
    insertContent: (hash: string, content: string) => { contentByHash.set(hash, content); },
    insertDocument: (_coll: string, docPath: string, title: string, hash: string) => {
      docs.set(docPath, { id: nextId++, path: docPath, title, hash });
    },
    updateDocument: (id: number, title: string, hash: string) => {
      for (const d of docs.values()) if (d.id === id) { d.title = title; d.hash = hash; }
    },
  },
  embed: vi.fn(async () => ({})),
};

vi.mock('../../src/core/qmd-store.js', () => ({
  getSessionStore: vi.fn(async () => fakeStore),
  DEFAULT_QMD_MODEL: 'test-model',
  embedQmdStore: vi.fn(async (
    store: { embed: (options: unknown) => Promise<unknown> },
    _label: string,
    options: unknown,
  ) => store.embed(options)),
}));

vi.mock('../../src/core/task-manager.js', () => ({
  listTasks: vi.fn(async () => []),
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => []),
}));

// Mock session-history: return canned messages for a known local sid, throw for "boom".
const localMessages: SessionHistoryMessage[] = [
  { role: 'user', text: 'how do I index session content with QMD', timestamp: '2026-05-05T10:00:00.000Z' },
  { role: 'assistant', text: 'use buildIndexedContent then embed', timestamp: '2026-05-05T10:01:00.000Z',
    tools: [{ name: 'Read', input: { file_path: '/x' }, result: 'SECRET_TOOL_RESULT' }] },
];
vi.mock('../../src/core/session-history.js', () => ({
  readSessionHistory: vi.fn(async (sid: string) => {
    if (sid === 'boom') throw new Error('jsonl read failed');
    if (sid === 'empty') return [];
    return localMessages;
  }),
}));

vi.mock('../../src/providers/acp-session-history.js', () => ({
  readAcpSessionHistoryState: vi.fn(async () => ({
    journalExists: true,
    messages: [{
      role: 'user',
      text: 'codex journal semantic sentinel',
      timestamp: '2026-07-19T10:00:00.000Z',
    }],
  })),
}));

import { syncSession } from '../../src/core/qmd-session-sync.js';

function sess(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    claudeSessionId: 'sid-1', taskId: '', project: 'p', process_status: 'completed' as never,
    mode: 'default' as never, startedAt: '2026-05-05T09:00:00Z', lastActiveAt: '2026-05-05T10:00:00Z',
    messageCount: 2, title: 'My Session', cwd: '/Users/me/proj',
    ...overrides,
  };
}

function docContent(docPath: string): string {
  const d = docs.get(docPath);
  return d ? (contentByHash.get(d.hash) ?? '') : '';
}

beforeEach(() => {
  docs.clear();
  contentByHash.clear();
  nextId = 1;
  vi.clearAllMocks();
});

describe('qmd-session-sync v2 content indexing', () => {
  it('indexes local session conversation body with turn headings', async () => {
    await syncSession(sess({ claudeSessionId: 'sid-1' }));
    const content = docContent('sess-sid-1');
    expect(content).toContain('## Turn 1');
    expect(content).toContain('how do I index session content');
    expect(content).toContain('use buildIndexedContent');
    expect(content).toContain('Tools: Read');
    // tool result body must NOT leak into the index
    expect(content).not.toContain('SECRET_TOOL_RESULT');
  });

  it('keeps remote sessions metadata-only (no JSONL pull)', async () => {
    await syncSession(sess({ claudeSessionId: 'sid-remote', host: 'clouddev' }));
    const content = docContent('sess-sid-remote');
    expect(content).toContain('# Session Metadata');
    expect(content).toContain('Host: clouddev');
    // No conversation turns — body skipped for remote
    expect(content).not.toContain('## Turn 1');
    expect(content).not.toContain('use buildIndexedContent');
  });

  it('prepends the summary as a # Session Gist heading', async () => {
    await syncSession(sess({ claudeSessionId: 'sid-1', summary: 'Topics: QMD indexing' }));
    const content = docContent('sess-sid-1');
    expect(content.startsWith('# Session Gist\nTopics: QMD indexing')).toBe(true);
  });

  it('hash-skips an unchanged re-sync', async () => {
    await syncSession(sess({ claudeSessionId: 'sid-1' }));
    const firstHash = docs.get('sess-sid-1')!.hash;
    contentByHash.clear(); // if it re-inserts, content reappears
    await syncSession(sess({ claudeSessionId: 'sid-1' }));
    expect(docs.get('sess-sid-1')!.hash).toBe(firstHash);
    expect(contentByHash.size).toBe(0); // no re-insert
  });

  it('does not overwrite an existing doc when JSONL read fails', async () => {
    await syncSession(sess({ claudeSessionId: 'boom' }), undefined, {
      includeContent: false,
    });
    const original = docContent('sess-boom');

    await syncSession(sess({
      claudeSessionId: 'boom',
      title: 'Must not replace the rich document',
    }));

    expect(docContent('sess-boom')).toBe(original);
    expect(docContent('sess-boom'))
      .not.toContain('Must not replace the rich document');
  });

  it('indexes Codex conversation content from the ACP journal', async () => {
    await syncSession(sess({
      claudeSessionId: 'codex-session',
      engine: 'codex',
      acpRuntimeId: 'runtime-1',
      acpJournalPath: '/tmp/codex-session.acp.jsonl',
    }));

    expect(docContent('sess-codex-session'))
      .toContain('codex journal semantic sentinel');
  });
});
