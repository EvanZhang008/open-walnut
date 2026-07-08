import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
// Daemon-uniform: local reads go through DaemonFileReader('__local__'). No daemon runs
// in unit tests, so serve __local__ from the real fs, honoring the mocked CLAUDE_HOME.
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  findSessionJsonlPath,
  readSessionHistory,
  extractPlanContent,
  readSessionHistoryPaginated,
} from '../../src/core/session-history.js';

const tmpBase = CLAUDE_HOME;

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

/** Helper: write JSONL lines to the expected Claude Code path. */
async function writeJsonl(sessionId: string, cwd: string, lines: unknown[]) {
  const encoded = encodeProjectPath(cwd);
  const dir = path.join(tmpBase, 'projects', encoded);
  await fsp.mkdir(dir, { recursive: true });
  const content = lines.map(l => JSON.stringify(l)).join('\n');
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), content);
}

/** Helper: build a JSONL message line. */
function msg(id: string, role: 'user' | 'assistant', text: string, extras?: {
  tools?: unknown[];
  thinking?: string;
  model?: string;
}) {
  const content: unknown[] = [];
  if (extras?.thinking) content.push({ type: 'thinking', thinking: extras.thinking });
  content.push({ type: 'text', text });
  if (extras?.tools) content.push(...extras.tools);
  return {
    type: role,
    timestamp: `2025-01-01T00:00:${String(parseInt(id.replace(/\D/g, '') || '0')).padStart(2, '0')}Z`,
    message: { id, role, content, ...(extras?.model ? { model: extras.model } : {}) },
  };
}

describe('encodeProjectPath', () => {
  it('replaces slashes with dashes', () => {
    expect(encodeProjectPath('/Users/foo/bar')).toBe('-Users-foo-bar');
  });

  it('handles root path', () => {
    expect(encodeProjectPath('/')).toBe('-');
  });

  it('handles deeply nested path', () => {
    expect(encodeProjectPath('/a/b/c/d/e')).toBe('-a-b-c-d-e');
  });
});

describe('findSessionJsonlPath', () => {
  it('finds file when cwd is provided', async () => {
    const cwd = '/Users/test/project';
    const encoded = encodeProjectPath(cwd);
    const dir = path.join(tmpBase, 'projects', encoded);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'sess-123.jsonl'), '{}');

    const result = await findSessionJsonlPath('sess-123', cwd);
    expect(result).toBe(path.join(dir, 'sess-123.jsonl'));
  });

  it('finds file via fallback search when no cwd', async () => {
    const dir = path.join(tmpBase, 'projects', '-some-project');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'sess-456.jsonl'), '{}');

    const result = await findSessionJsonlPath('sess-456');
    expect(result).toBe(path.join(dir, 'sess-456.jsonl'));
  });

  it('returns null when file does not exist', async () => {
    const result = await findSessionJsonlPath('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when projects dir does not exist', async () => {
    const result = await findSessionJsonlPath('anything', '/no/such/path');
    expect(result).toBeNull();
  });
});

describe('readSessionHistory', () => {
  it('parses user and assistant messages', async () => {
    await writeJsonl('s1', '/test', [
      msg('u1', 'user', 'Hello'),
      msg('a1', 'assistant', 'Hi there!', { model: 'claude-3' }),
    ]);

    const messages = await readSessionHistory('s1', '/test');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].text).toBe('Hello');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].text).toBe('Hi there!');
    expect(messages[1].model).toBe('claude-3');
  });

  it('exports the stable msgId (API message.id for assistant, uuid fallback)', async () => {
    // Phase 0 of the ACP-dialect alignment: the messageMap key (message.id ??
    // uuid ?? synthetic) must be exported so streaming blocks and history
    // messages share a natural key (id-based promotion instead of content match).
    await writeJsonl('s-msgid', '/test', [
      { type: 'user', timestamp: '2025-01-01T00:00:00Z', uuid: 'uuid-u1', message: { role: 'user', content: 'Hello' } },
      msg('msg_bdrk_abc123', 'assistant', 'Hi there!'),
    ]);

    const messages = await readSessionHistory('s-msgid', '/test');
    expect(messages).toHaveLength(2);
    // user line has no message.id → falls back to the JSONL line uuid
    expect(messages[0].msgId).toBe('uuid-u1');
    // assistant line exports the API message id — the SAME id the live stream
    // carries in message_start → SESSION_TEXT_DELTA.msgId
    expect(messages[1].msgId).toBe('msg_bdrk_abc123');
  });

  it('hides CLI-injected task-notification echoes (background-agent completion plumbing)', async () => {
    // When an async background agent finishes, the CLI injects a
    // <task-notification>…<result>full report</result> user message into the
    // main session (FIFO) and re-logs it as a normal user STRING line, plus a
    // queue-operation enqueue with the same content. Neither is something the
    // human typed — rendered raw, the whole agent report shows up as a giant
    // "You" bubble in main chat (inc-1783552157700). Both the echo line and
    // the Pattern-B synthetic must be hidden; real user messages stay.
    const notification = '<task-notification>\n<task-id>a96085a7cdf51037f</task-id>\n<status>completed</status>\n<summary>Agent "Extended cluster research" finished</summary>\n<result>Here is the full 5000-word report…</result>\n</task-notification>';
    await writeJsonl('s-tasknotif', '/test', [
      msg('u1', 'user', 'run the research'),
      msg('a1', 'assistant', 'Launched the agent.'),
      // Pattern-B shape: enqueue with no nearby matching user STRING twin
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2025-01-01T00:01:00Z', content: notification },
      // Pattern-A shape: the CLI's re-logged user STRING echo
      { type: 'user', timestamp: '2025-01-01T00:01:30Z', uuid: 'uuid-notif', message: { role: 'user', content: notification } },
      msg('a2', 'assistant', 'The agent found the answer: …'),
    ]);

    const messages = await readSessionHistory('s-tasknotif', '/test');
    expect(messages.map(m => m.text)).toEqual([
      'run the research',
      'Launched the agent.',
      'The agent found the answer: …',
    ]);
  });

  it('hides pure-plumbing injected lines; rewrites human-action echoes (all corpus shapes)', async () => {
    // Corpus-enumerated shapes (4000-session scan, Mac + remote). Pure plumbing
    // is hidden; lines representing a real human action are rewritten readable.
    await writeJsonl('s-injected', '/test', [
      msg('u1', 'user', 'real question'),
      // hide: local-command boilerplate + stdout
      { type: 'user', timestamp: '2025-01-01T00:01:00Z', uuid: 'i1', message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>' } },
      { type: 'user', timestamp: '2025-01-01T00:01:01Z', uuid: 'i2', message: { role: 'user', content: '<local-command-stdout>Set model to sonnet</local-command-stdout>' } },
      // hide: bash-mode output echo
      { type: 'user', timestamp: '2025-01-01T00:01:02Z', uuid: 'i3', message: { role: 'user', content: '<bash-stdout>/usr/local/bin/claude</bash-stdout><bash-stderr></bash-stderr>' } },
      // rewrite: slash command (command-name first — Mac ordering)
      { type: 'user', timestamp: '2025-01-01T00:01:03Z', uuid: 'i4', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>' } },
      // rewrite: slash command (command-message first — remote ordering, no args)
      { type: 'user', timestamp: '2025-01-01T00:01:04Z', uuid: 'i5', message: { role: 'user', content: '<command-message>compact</command-message> <command-name>/compact</command-name>' } },
      // rewrite: bash-mode input
      { type: 'user', timestamp: '2025-01-01T00:01:05Z', uuid: 'i6', message: { role: 'user', content: '<bash-input>which claude</bash-input>' } },
      // rewrite: teammate mail
      { type: 'user', timestamp: '2025-01-01T00:01:06Z', uuid: 'i7', message: { role: 'user', content: '<teammate-message teammate_id="ui-dev" color="yellow">Task #3 frontend done</teammate-message>' } },
      // NOT injected: human message that merely starts with '<'
      { type: 'user', timestamp: '2025-01-01T00:01:07Z', uuid: 'i8', message: { role: 'user', content: '<div> tags are escaping in my app, help' } },
      msg('a1', 'assistant', 'On it.'),
    ]);

    const messages = await readSessionHistory('s-injected', '/test');
    expect(messages.map(m => m.text)).toEqual([
      'real question',
      '/model sonnet',
      '/compact',
      '! which claude',
      '[Teammate ui-dev] Task #3 frontend done',
      '<div> tags are escaping in my app, help',
      'On it.',
    ]);
  });

  it('deduplicates assistant messages by id', async () => {
    await writeJsonl('s2', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Part 1' }] } },
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Part 2' }] } },
    ]);

    const messages = await readSessionHistory('s2', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Part 1\nPart 2');
  });

  it('deduplicates identical text blocks from replayed lines (4x repeat bug)', async () => {
    // Simulates daemon reconnect replaying the same JSONL line 4 times.
    // Without dedup, textParts.join('\n') would produce the text 4 times.
    const textLine = { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Let me check the quota.' }] } };
    await writeJsonl('s-dedup-text', '/test', [
      textLine, textLine, textLine, textLine,
    ]);

    const messages = await readSessionHistory('s-dedup-text', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Let me check the quota.');
  });

  it('deduplicates identical thinking blocks from replayed lines', async () => {
    // Realistic case: thinking + text (thinking-only messages with no text/tools
    // are filtered as abandoned API calls)
    const thinkLine = { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'thinking', thinking: 'Deep thought' }, { type: 'text', text: 'Answer' }] } };
    await writeJsonl('s-dedup-think', '/test', [
      thinkLine, thinkLine, thinkLine,
    ]);

    const messages = await readSessionHistory('s-dedup-think', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBe('Deep thought');
    expect(messages[0].text).toBe('Answer');
  });

  it('filters abandoned API calls (thinking-only, no text or tools)', async () => {
    // When Claude Code retries an API call, the abandoned first call may have
    // only thinking content with no visible text. These should be filtered out.
    const abandonedLine = { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'thinking', thinking: 'Deep thought' }] } };
    await writeJsonl('s-abandoned', '/test', [abandonedLine]);

    const messages = await readSessionHistory('s-abandoned', '/test');
    expect(messages).toHaveLength(0);
  });

  it('filters whitespace-only assistant text from abandoned API calls', async () => {
    // Claude Code sometimes emits "\n\n" as initial text before real content.
    // If the API call is abandoned, only "\n\n" remains — should be filtered.
    const emptyTextLine = { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '\n\n' }] } };
    await writeJsonl('s-whitespace', '/test', [emptyTextLine]);

    const messages = await readSessionHistory('s-whitespace', '/test');
    expect(messages).toHaveLength(0);
  });

  it('deduplicates identical tool_use blocks by block id', async () => {
    const toolLine = { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file: 'test.ts' } }] } };
    await writeJsonl('s-dedup-tool', '/test', [
      toolLine, toolLine,
    ]);

    const messages = await readSessionHistory('s-dedup-tool', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].tools).toHaveLength(1);
    expect(messages[0].tools![0].name).toBe('Read');
  });

  it('keeps distinct text blocks even with same message id', async () => {
    // Normal case: same message.id but genuinely different content blocks
    await writeJsonl('s-dedup-distinct', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'First part' }] } },
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Second part' }] } },
      { type: 'assistant', timestamp: '2025-01-01T00:00:02Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { cmd: 'ls' } }] } },
    ]);

    const messages = await readSessionHistory('s-dedup-distinct', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('First part\nSecond part');
    expect(messages[0].tools).toHaveLength(1);
  });

  it('extracts tool_use blocks', async () => {
    await writeJsonl('s3', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'tool_use', name: 'Read', input: { file: 'test.ts' } },
        { type: 'text', text: 'Done reading.' },
      ] } },
    ]);

    const messages = await readSessionHistory('s3', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].tools).toHaveLength(1);
    expect(messages[0].tools![0].name).toBe('Read');
    expect(messages[0].text).toBe('Done reading.');
  });

  it('extracts thinking blocks', async () => {
    await writeJsonl('s4', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'thinking', thinking: 'Let me think...' },
        { type: 'text', text: 'Here is my answer.' },
      ] } },
    ]);

    const messages = await readSessionHistory('s4', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBe('Let me think...');
    expect(messages[0].text).toBe('Here is my answer.');
  });

  it('refreshes planContent from disk when plan file was updated after JSONL capture', async () => {
    // Simulate: Write tool wrote plan v1 to a file, ExitPlanMode captured it.
    // Then the agent continued editing → disk now has v2.
    const planPath = path.join(tmpBase, 'plans', 'test-plan.md');
    await fsp.mkdir(path.dirname(planPath), { recursive: true });

    await writeJsonl('s-plan-refresh', '/test', [
      msg('u1', 'user', 'Make a plan'),
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'tool_use', name: 'Write', input: {
          file_path: planPath,  // path inside tmpBase which acts as ~/.claude/
          content: '# Plan v1\nOriginal plan content',
        } },
      ] } },
      { type: 'assistant', timestamp: '2025-01-01T00:00:02Z', message: { id: 'a2', role: 'assistant', content: [
        { type: 'tool_use', name: 'ExitPlanMode', input: { plan: '(see plan below)' } },
      ] } },
    ]);

    // Simulate agent editing the plan file after ExitPlanMode
    await fsp.writeFile(planPath, '# Plan v2\nUpdated plan content');

    const messages = await readSessionHistory('s-plan-refresh', '/test');

    // Find the ExitPlanMode tool
    const exitMsg = messages.find(m => m.tools?.some(t => t.name === 'ExitPlanMode'));
    expect(exitMsg).toBeDefined();
    const exitTool = exitMsg!.tools!.find(t => t.name === 'ExitPlanMode');
    expect(exitTool).toBeDefined();

    // planContent should be the DISK version (v2), not the JSONL version (v1)
    expect(exitTool!.planContent).toBe('# Plan v2\nUpdated plan content');
  });

  it('returns empty array for missing file', async () => {
    const messages = await readSessionHistory('nonexistent', '/test');
    expect(messages).toEqual([]);
  });

  it('includes queue-operation enqueue entries as user messages at correct positions', async () => {
    await writeJsonl('s-fifo', '/test', [
      msg('u1', 'user', 'Read 3 files'),
      // Assistant starts working (first segment)
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'tool_use', name: 'Read', input: { file: 'f1.ts' } },
        { type: 'text', text: 'File 1 read.' },
      ] } },
      // FIFO-injected mid-stream user message
      { type: 'queue-operation', operation: 'enqueue', content: 'hi', timestamp: '2025-01-01T00:00:02Z' },
      // Assistant continues (new segment — different message ID after FIFO)
      { type: 'assistant', timestamp: '2025-01-01T00:00:03Z', message: { id: 'a2', role: 'assistant', content: [
        { type: 'tool_use', name: 'Read', input: { file: 'f2.ts' } },
        { type: 'text', text: 'File 2 read.' },
      ] } },
      // Another FIFO message
      { type: 'queue-operation', operation: 'enqueue', content: 'stop', timestamp: '2025-01-01T00:00:04Z' },
      // queue-operation remove entries (cleanup) — should be ignored
      { type: 'queue-operation', operation: 'remove', timestamp: '2025-01-01T00:00:04Z' },
      // Assistant final response
      { type: 'assistant', timestamp: '2025-01-01T00:00:05Z', message: { id: 'a3', role: 'assistant', content: [
        { type: 'text', text: 'Stopping.' },
      ] } },
    ]);

    const messages = await readSessionHistory('s-fifo', '/test');
    // Should be: user prompt, assistant segment 1, user "hi", assistant segment 2, user "stop", assistant "Stopping"
    expect(messages).toHaveLength(6);
    expect(messages[0]).toMatchObject({ role: 'user', text: 'Read 3 files' });
    expect(messages[1]).toMatchObject({ role: 'assistant', text: 'File 1 read.' });
    expect(messages[2]).toMatchObject({ role: 'user', text: 'hi' });
    expect(messages[3]).toMatchObject({ role: 'assistant', text: 'File 2 read.' });
    expect(messages[4]).toMatchObject({ role: 'user', text: 'stop' });
    expect(messages[5]).toMatchObject({ role: 'assistant', text: 'Stopping.' });
  });

  it('ignores queue-operation entries that are not enqueue', async () => {
    await writeJsonl('s-fifo-ignore', '/test', [
      msg('u1', 'user', 'Hello'),
      { type: 'queue-operation', operation: 'remove', timestamp: '2025-01-01T00:00:01Z' },
      { type: 'queue-operation', operation: 'dequeue', timestamp: '2025-01-01T00:00:02Z' },
      msg('a1', 'assistant', 'Hi'),
    ]);

    const messages = await readSessionHistory('s-fifo-ignore', '/test');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', text: 'Hello' });
    expect(messages[1]).toMatchObject({ role: 'assistant', text: 'Hi' });
  });

  it('skips unparseable JSONL lines', async () => {
    const encoded = encodeProjectPath('/test');
    const dir = path.join(tmpBase, 'projects', encoded);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 's5.jsonl'),
      '{"type":"user","timestamp":"T","message":{"id":"u1","role":"user","content":[{"type":"text","text":"ok"}]}}\nnot json\n{"type":"assistant","timestamp":"T","message":{"id":"a1","role":"assistant","content":[{"type":"text","text":"yes"}]}}'
    );

    const messages = await readSessionHistory('s5', '/test');
    expect(messages).toHaveLength(2);
  });
});

// ── extractPlanContent ──

describe('extractPlanContent', () => {
  it('extracts plan from Write to ~/.claude/plans/', async () => {
    await writeJsonl('plan-write', '/test', [
      msg('u1', 'user', 'Make a plan'),
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'text', text: 'Here is my plan.' },
        { type: 'tool_use', name: 'Write', input: {
          file_path: '/Users/test/.claude/plans/my-plan.md',
          content: '# Plan\n\n## Step 1\nDo things',
        } },
      ] } },
      { type: 'assistant', timestamp: '2025-01-01T00:00:02Z', message: { id: 'a2', role: 'assistant', content: [
        { type: 'tool_use', name: 'ExitPlanMode', input: {} },
      ] } },
    ]);

    const plan = await extractPlanContent('plan-write', '/test');
    expect(plan).toBe('# Plan\n\n## Step 1\nDo things');
  });

  it('falls back to ExitPlanMode.input.plan when no Write', async () => {
    await writeJsonl('plan-exit', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Simple plan text' } },
      ] } },
    ]);

    const plan = await extractPlanContent('plan-exit', '/test');
    expect(plan).toBe('Simple plan text');
  });

  it('returns null when no plan in session', async () => {
    await writeJsonl('no-plan', '/test', [
      msg('u1', 'user', 'Hello'),
      msg('a1', 'assistant', 'Hi there'),
    ]);

    const plan = await extractPlanContent('no-plan', '/test');
    expect(plan).toBeNull();
  });

  it('returns null for missing session file', async () => {
    const plan = await extractPlanContent('nonexistent', '/test');
    expect(plan).toBeNull();
  });

  it('returns null for empty JSONL file', async () => {
    const encoded = encodeProjectPath('/test');
    const dir = path.join(tmpBase, 'projects', encoded);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'empty.jsonl'), '');

    const plan = await extractPlanContent('empty', '/test');
    expect(plan).toBeNull();
  });

  it('prefers Write content over ExitPlanMode.input.plan', async () => {
    await writeJsonl('plan-both', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'tool_use', name: 'Write', input: {
          file_path: '/home/.claude/plans/test.md',
          content: 'Detailed plan from Write',
        } },
        { type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Short plan from ExitPlanMode' } },
      ] } },
    ]);

    const plan = await extractPlanContent('plan-both', '/test');
    expect(plan).toBe('Detailed plan from Write');
  });
});

// ── readSessionHistoryPaginated ──

describe('readSessionHistoryPaginated', () => {
  it('returns page 1 as most recent messages', async () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(msg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`));
    }
    await writeJsonl('pag-basic', '/test', lines);

    const result = await readSessionHistoryPaginated('pag-basic', '/test', { pageSize: 3, page: 1 });
    expect(result.messages).toHaveLength(3);
    // Page 1 = newest → messages 9, 8, 7 (reversed)
    expect(result.messages[0].text).toBe('Message 9');
    expect(result.messages[1].text).toBe('Message 8');
    expect(result.messages[2].text).toBe('Message 7');
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 3,
      total: 10,
      totalPages: 4, // ceil(10/3) = 4
    });
  });

  it('returns page 2 with older messages', async () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(msg(`m${i}`, 'assistant', `Message ${i}`));
    }
    await writeJsonl('pag-p2', '/test', lines);

    const result = await readSessionHistoryPaginated('pag-p2', '/test', { pageSize: 3, page: 2 });
    expect(result.messages).toHaveLength(3);
    // Page 2 = messages 6, 5, 4 (reversed, offset 3)
    expect(result.messages[0].text).toBe('Message 6');
    expect(result.messages[1].text).toBe('Message 5');
    expect(result.messages[2].text).toBe('Message 4');
  });

  it('returns last page with remaining messages', async () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(msg(`m${i}`, 'assistant', `Message ${i}`));
    }
    await writeJsonl('pag-last', '/test', lines);

    const result = await readSessionHistoryPaginated('pag-last', '/test', { pageSize: 3, page: 4 });
    // Last page: only 1 message (Message 0)
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('Message 0');
  });

  it('returns empty for page beyond total', async () => {
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(msg(`m${i}`, 'assistant', `Message ${i}`));
    }
    await writeJsonl('pag-beyond', '/test', lines);

    const result = await readSessionHistoryPaginated('pag-beyond', '/test', { pageSize: 3, page: 10 });
    expect(result.messages).toHaveLength(0);
    expect(result.pagination.total).toBe(5);
    expect(result.pagination.totalPages).toBe(2);
  });

  it('returns empty result for missing session', async () => {
    const result = await readSessionHistoryPaginated('nonexistent', '/test', { pageSize: 5, page: 1 });
    expect(result.messages).toEqual([]);
    expect(result.pagination).toEqual({ page: 1, pageSize: 5, total: 0, totalPages: 0 });
  });

  it('defaults to page 1, pageSize 20', async () => {
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(msg(`m${i}`, 'assistant', `Message ${i}`));
    }
    await writeJsonl('pag-default', '/test', lines);

    const result = await readSessionHistoryPaginated('pag-default', '/test');
    expect(result.messages).toHaveLength(5); // all fit in pageSize 20
    expect(result.pagination.pageSize).toBe(20);
    expect(result.pagination.page).toBe(1);
  });

  it('handles single-message session', async () => {
    await writeJsonl('pag-single', '/test', [
      msg('m0', 'user', 'Hello'),
    ]);

    const result = await readSessionHistoryPaginated('pag-single', '/test', { pageSize: 5, page: 1 });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('Hello');
    expect(result.pagination.totalPages).toBe(1);
  });
});
