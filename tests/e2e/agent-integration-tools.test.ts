/**
 * E2E: Integration tools (slack, tts) via executeTool() with a real server.
 *
 * External services are mocked at module boundary:
 *   - @slack/web-api → mock WebClient
 *   - edge-tts → mock ttsSave
 *
 * Everything else is real: Express server, event bus, config loading,
 * tool dispatch, parameter validation, error handling.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

// ── Mock constants to isolate from real data ──
vi.mock('../../src/constants.js', () => createMockConstants());

// ── Slack mocks ──
const mockPostMessage = vi.fn().mockResolvedValue({
  ok: true,
  channel: 'C123',
  ts: '1234567890.123456',
  message: { text: 'hello e2e' },
});
const mockConversationsHistory = vi.fn().mockResolvedValue({
  ok: true,
  messages: [
    { user: 'U001', text: 'Hello from channel', ts: '1700000000.000001' },
    { user: 'U002', text: 'Reply here', ts: '1700000000.000002', thread_ts: '1700000000.000001' },
    { user: 'U003', text: 'Another message', ts: '1700000000.000003' },
  ],
});
const mockReactionsAdd = vi.fn().mockResolvedValue({ ok: true });
const mockPinsAdd = vi.fn().mockResolvedValue({ ok: true });

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: { postMessage: mockPostMessage },
    conversations: { history: mockConversationsHistory },
    reactions: { add: mockReactionsAdd },
    pins: { add: mockPinsAdd },
  })),
}));

// ── edge-tts mock ──
const mockTtsSave = vi.fn().mockImplementation(async (_text: string, filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'fake-mp3-audio-data');
});

vi.mock('edge-tts', () => ({
  ttsSave: mockTtsSave,
  tts: vi.fn().mockResolvedValue(Buffer.from('fake-audio')),
  getVoices: vi.fn().mockResolvedValue([]),
}));


import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { executeTool } from '../../src/agent/tools.js';
import { _resetForTesting } from '../../src/core/task-manager.js';

// ── Setup / Teardown ──

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

beforeAll(async () => {
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  // Re-set default mock implementations after clearAllMocks
  mockPostMessage.mockResolvedValue({
    ok: true,
    channel: 'C123',
    ts: '1234567890.123456',
    message: { text: 'hello e2e' },
  });
  mockConversationsHistory.mockResolvedValue({
    ok: true,
    messages: [
      { user: 'U001', text: 'Hello from channel', ts: '1700000000.000001' },
      { user: 'U002', text: 'Reply here', ts: '1700000000.000002', thread_ts: '1700000000.000001' },
      { user: 'U003', text: 'Another message', ts: '1700000000.000003' },
    ],
  });
  mockReactionsAdd.mockResolvedValue({ ok: true });
  mockPinsAdd.mockResolvedValue({ ok: true });
  mockTtsSave.mockImplementation(async (_text: string, filePath: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'fake-mp3-audio-data');
  });
});

// ═══════════════════════════════════════════════════════════
// Slack tool E2E
// ═══════════════════════════════════════════════════════════

describe('Slack tool E2E', () => {
  it('send_message dispatches through executeTool and calls Slack API', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const result = await executeTool('integration_slack', {
        action: 'send_message',
        channel: '#test-channel',
        text: 'hello e2e',
      });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.ts).toBe('1234567890.123456');
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: '#test-channel',
        text: 'hello e2e',
        thread_ts: undefined,
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('send_message with thread_ts sends threaded reply', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const result = await executeTool('integration_slack', {
        action: 'send_message',
        channel: '#test-channel',
        text: 'threaded reply',
        thread_ts: '1700000000.000001',
      });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: '#test-channel',
        text: 'threaded reply',
        thread_ts: '1700000000.000001',
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('read_messages returns formatted channel history', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const result = await executeTool('integration_slack', {
        action: 'read_messages',
        channel: 'C123',
        limit: 5,
      });
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(3);
      expect(parsed[0].user).toBe('U001');
      expect(parsed[0].text).toBe('Hello from channel');
      expect(parsed[1].thread_ts).toBe('1700000000.000001');
      expect(mockConversationsHistory).toHaveBeenCalledWith({
        channel: 'C123',
        limit: 5,
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('read_messages with empty channel returns no-messages text', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    mockConversationsHistory.mockResolvedValueOnce({ ok: true, messages: [] });
    try {
      const result = await executeTool('integration_slack', {
        action: 'read_messages',
        channel: 'C-empty',
      });
      expect(result).toContain('No messages found');
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('react adds emoji reaction', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const result = await executeTool('integration_slack', {
        action: 'react',
        channel: 'C123',
        timestamp: '1700000000.000001',
        emoji: 'thumbsup',
      });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(mockReactionsAdd).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1700000000.000001',
        name: 'thumbsup',
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('react returns error when timestamp missing', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const result = await executeTool('integration_slack', {
        action: 'react',
        channel: 'C123',
        emoji: 'thumbsup',
      });
      expect(result).toContain('Error');
      expect(result).toContain('timestamp is required');
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('react returns error when emoji missing', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const result = await executeTool('integration_slack', {
        action: 'react',
        channel: 'C123',
        timestamp: '1700000000.000001',
      });
      expect(result).toContain('Error');
      expect(result).toContain('emoji is required');
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('pin pins a message', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const result = await executeTool('integration_slack', {
        action: 'pin',
        channel: 'C123',
        timestamp: '1700000000.000001',
      });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(mockPinsAdd).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1700000000.000001',
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('missing token returns configuration error', async () => {
    const saved = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    try {
      const result = await executeTool('integration_slack', {
        action: 'send_message',
        channel: '#general',
        text: 'this should fail',
      });
      expect(result).toContain('Error');
      expect(result).toContain('not configured');
    } finally {
      if (saved) process.env.SLACK_BOT_TOKEN = saved;
    }
  });

  it('unknown action returns error', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const result = await executeTool('integration_slack', {
        action: 'invalid_action',
        channel: 'C123',
      });
      expect(result).toContain('Error');
      expect(result).toContain('Unknown action');
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('Slack API error is caught and returned as error string', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    mockPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));
    try {
      const result = await executeTool('integration_slack', {
        action: 'send_message',
        channel: '#nonexistent',
        text: 'hello',
      });
      expect(result).toContain('Error');
      expect(result).toContain('channel_not_found');
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('send_message without text returns error', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const result = await executeTool('integration_slack', {
        action: 'send_message',
        channel: '#general',
      });
      expect(result).toContain('Error');
      expect(result).toContain('text is required');
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });
});

// ═══════════════════════════════════════════════════════════
// TTS tool E2E
// ═══════════════════════════════════════════════════════════

describe('TTS tool E2E', () => {
  it('synthesizes text to speech and returns audio path', async () => {
    const result = await executeTool('integration_tts', { text: 'Hello world from E2E' });
    const parsed = JSON.parse(result);
    expect(parsed.audio_path).toContain('.mp3');
    expect(parsed.voice).toBe('en-US-AriaNeural');
    expect(parsed.text_length).toBe(20);
    expect(parsed.duration_estimate_seconds).toBeGreaterThan(0);
    expect(mockTtsSave).toHaveBeenCalledWith(
      'Hello world from E2E',
      expect.stringContaining('.mp3'),
      { voice: 'en-US-AriaNeural' },
    );
    // Verify the mock actually created the file
    expect(fs.existsSync(parsed.audio_path)).toBe(true);
  });

  it('uses custom voice parameter', async () => {
    const result = await executeTool('integration_tts', {
      text: 'Custom voice test',
      voice: 'en-US-GuyNeural',
    });
    const parsed = JSON.parse(result);
    expect(parsed.voice).toBe('en-US-GuyNeural');
    expect(mockTtsSave).toHaveBeenCalledWith(
      'Custom voice test',
      expect.any(String),
      { voice: 'en-US-GuyNeural' },
    );
  });

  it('returns error when text is empty', async () => {
    const result = await executeTool('integration_tts', { text: '' });
    expect(result).toContain('Error');
  });

  it('handles TTS engine failure gracefully', async () => {
    mockTtsSave.mockRejectedValueOnce(new Error('TTS engine unavailable'));
    const result = await executeTool('integration_tts', { text: 'This should fail' });
    expect(result).toContain('Error');
    expect(result).toContain('TTS engine unavailable');
  });

  it('generates unique filenames for different texts', async () => {
    const result1 = await executeTool('integration_tts', { text: 'First message' });
    const result2 = await executeTool('integration_tts', { text: 'Second message' });
    const path1 = JSON.parse(result1).audio_path;
    const path2 = JSON.parse(result2).audio_path;
    expect(path1).not.toBe(path2);
  });

  it('audio file is saved under WALNUT_HOME/media/tts/', async () => {
    const result = await executeTool('integration_tts', { text: 'Path check' });
    const parsed = JSON.parse(result);
    const expectedDir = path.join(WALNUT_HOME, 'media', 'tts');
    expect(parsed.audio_path.startsWith(expectedDir)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Cross-tool round-trip E2E
// ═══════════════════════════════════════════════════════════

describe('Cross-tool round-trip E2E', () => {
  it('file_write → shell_exec → file_read pipeline works within the same server', async () => {
    const testFile = path.join(WALNUT_HOME, 'cross-tool-test.txt');

    // Step 1: write a file using the write_file tool.
    // The param is `source` (a content-source URI; an absolute path is one of the
    // accepted forms), not `path`.
    const writeResult = await executeTool('file_write', {
      source: testFile,
      content: 'Hello from E2E cross-tool test\nLine 2\nLine 3',
    });
    // Returns JSON: { status, content_hash }.
    const written = JSON.parse(writeResult) as { status: string; content_hash: string };
    expect(written.status).toBe('updated');
    expect(written.content_hash).toBeTruthy();

    // Step 2: use exec to verify the file exists and has content
    const execResult = await executeTool('shell_exec', {
      command: `cat "${testFile}"`,
    });
    expect(execResult).toContain('Hello from E2E cross-tool test');

    // Step 3: read the file back
    const readResult = await executeTool('file_read', {
      source: testFile,
    });
    expect(readResult).toContain('Hello from E2E cross-tool test');
    expect(readResult).toContain('Line 2');
    expect(readResult).toContain('Line 3');
  });

  it('task + slack tools coexist: create task then send slack notification', async () => {
    // Project is the only grouping layer — create the row up front, then file a
    // task under it (the reply names the project, so no "(new project)" note).
    const projectResult = await executeTool('task_create', { type: 'project', name: 'Marina' });
    expect(projectResult).toContain('Project created');

    const taskResult = await executeTool('task_create', {
      title: 'Integration test task',
      project: 'Marina',
    });
    expect(taskResult).toContain('Task created');
    expect(taskResult).toContain('Marina');
    expect(taskResult).not.toContain('new project');
    // The reply embeds a `<task-ref id="…" label="…"/>` tag (taskRef in tools.ts).
    const taskId = taskResult.match(/<task-ref id="([^"]+)"/)?.[1];
    expect(taskId).toBeTruthy();

    // Send a Slack notification about the task (mocked)
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const slackResult = await executeTool('integration_slack', {
        action: 'send_message',
        channel: '#notifications',
        text: `Task created: ${taskId}`,
      });
      const parsed = JSON.parse(slackResult);
      expect(parsed.ok).toBe(true);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(taskId!),
        }),
      );
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }

    // Verify the task exists via REST, filed under the project we created
    const res = await fetch(apiUrl(`/api/tasks/${taskId}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { id: string; title: string; project: string } };
    expect(body.task.title).toBe('Integration test task');
    expect(body.task.project).toBe('Marina');
  });
});

// ═══════════════════════════════════════════════════════════
// Unknown tool dispatch
// ═══════════════════════════════════════════════════════════

describe('Tool dispatch errors', () => {
  it('executeTool returns error for unknown tool name', async () => {
    const result = await executeTool('nonexistent_tool', {});
    expect(result).toContain('Error');
    expect(result).toContain('Unknown tool');
  });
});
