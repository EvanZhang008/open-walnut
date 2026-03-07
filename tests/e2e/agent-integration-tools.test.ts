/**
 * E2E: Integration tools (slack, tts, image) via executeTool() with a real server.
 *
 * External services are mocked at module boundary:
 *   - @slack/web-api → mock WebClient
 *   - edge-tts → mock ttsSave
 *   - ../agent/model.js → mock sendMessage (Bedrock)
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

// ── Bedrock model mock (for image tool) ──
const { mockSendMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'A beautiful landscape with mountains and a lake.' }],
    stopReason: 'end_turn',
  }),
}));

vi.mock('../../src/agent/model.js', () => ({
  sendMessage: mockSendMessage,
  sendMessageStream: vi.fn(),
  resetClient: vi.fn(),
  DEFAULT_MODEL: 'global.anthropic.claude-opus-4-6-v1',
  getContextWindowSize: (model?: string) => model?.includes('[1m]') ? 1_000_000 : 200_000,
  getContextThreshold: (model: string | undefined, percent: number) =>
    Math.round((model?.includes('[1m]') ? 1_000_000 : 200_000) * percent),
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
  mockSendMessage.mockResolvedValue({
    content: [{ type: 'text', text: 'A beautiful landscape with mountains and a lake.' }],
    stopReason: 'end_turn',
  });
});

// ═══════════════════════════════════════════════════════════
// Slack tool E2E
// ═══════════════════════════════════════════════════════════

describe('Slack tool E2E', () => {
  it('send_message dispatches through executeTool and calls Slack API', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
      const result = await executeTool('slack', {
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
    const result = await executeTool('tts', { text: 'Hello world from E2E' });
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
    const result = await executeTool('tts', {
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
    const result = await executeTool('tts', { text: '' });
    expect(result).toContain('Error');
  });

  it('handles TTS engine failure gracefully', async () => {
    mockTtsSave.mockRejectedValueOnce(new Error('TTS engine unavailable'));
    const result = await executeTool('tts', { text: 'This should fail' });
    expect(result).toContain('Error');
    expect(result).toContain('TTS engine unavailable');
  });

  it('generates unique filenames for different texts', async () => {
    const result1 = await executeTool('tts', { text: 'First message' });
    const result2 = await executeTool('tts', { text: 'Second message' });
    const path1 = JSON.parse(result1).audio_path;
    const path2 = JSON.parse(result2).audio_path;
    expect(path1).not.toBe(path2);
  });

  it('audio file is saved under WALNUT_HOME/media/tts/', async () => {
    const result = await executeTool('tts', { text: 'Path check' });
    const parsed = JSON.parse(result);
    const expectedDir = path.join(WALNUT_HOME, 'media', 'tts');
    expect(parsed.audio_path.startsWith(expectedDir)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Image analysis tool E2E
// ═══════════════════════════════════════════════════════════

describe('Image analysis tool E2E', () => {
  let imgDir: string;

  beforeAll(() => {
    imgDir = path.join(WALNUT_HOME, 'test-images');
    fs.mkdirSync(imgDir, { recursive: true });
  });

  it('analyzes a PNG image via executeTool', async () => {
    const imgPath = path.join(imgDir, 'landscape.png');
    fs.writeFileSync(imgPath, Buffer.from('fake-png-data'));

    const result = await executeTool('analyze_image', { image_path: imgPath });
    expect(result).toBe('A beautiful landscape with mountains and a lake.');
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('image analysis'),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([
              expect.objectContaining({ type: 'text', text: 'Describe this image in detail' }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('passes custom prompt to the model', async () => {
    const imgPath = path.join(imgDir, 'custom-prompt.jpg');
    fs.writeFileSync(imgPath, Buffer.from('fake-jpg-data'));

    await executeTool('analyze_image', {
      image_path: imgPath,
      prompt: 'What color is the sky?',
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ type: 'text', text: 'What color is the sky?' }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('returns error for non-existent file', async () => {
    const result = await executeTool('analyze_image', {
      image_path: '/nonexistent/image.png',
    });
    expect(result).toContain('Error');
    expect(result).toContain('File not found');
  });

  it('returns error for unsupported format', async () => {
    const txtPath = path.join(imgDir, 'document.bmp');
    fs.writeFileSync(txtPath, Buffer.from('not-an-image'));

    const result = await executeTool('analyze_image', { image_path: txtPath });
    expect(result).toContain('Error');
    expect(result).toContain('Unsupported image format');
  });

  it('supports JPEG extension', async () => {
    const imgPath = path.join(imgDir, 'photo.jpeg');
    fs.writeFileSync(imgPath, Buffer.from('fake-jpeg-data'));

    const result = await executeTool('analyze_image', { image_path: imgPath });
    expect(result).toBe('A beautiful landscape with mountains and a lake.');
  });

  it('supports WebP format', async () => {
    const imgPath = path.join(imgDir, 'modern.webp');
    fs.writeFileSync(imgPath, Buffer.from('fake-webp-data'));

    const result = await executeTool('analyze_image', { image_path: imgPath });
    expect(result).toBe('A beautiful landscape with mountains and a lake.');
  });

  it('supports GIF format', async () => {
    const imgPath = path.join(imgDir, 'animation.gif');
    fs.writeFileSync(imgPath, Buffer.from('fake-gif-data'));

    const result = await executeTool('analyze_image', { image_path: imgPath });
    expect(result).toBe('A beautiful landscape with mountains and a lake.');
  });

  it('encodes image data as base64 in the API call', async () => {
    const imgPath = path.join(imgDir, 'base64-test.png');
    const testData = Buffer.from('PNG-test-data-for-base64');
    fs.writeFileSync(imgPath, testData);

    await executeTool('analyze_image', { image_path: imgPath });

    const callArgs = mockSendMessage.mock.calls[0][0];
    const imageBlock = callArgs.messages[0].content[0];
    expect(imageBlock.source.type).toBe('base64');
    expect(imageBlock.source.media_type).toBe('image/png');
    expect(imageBlock.source.data).toBe(testData.toString('base64'));
  });

  it('handles model API error gracefully', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('Bedrock throttling'));
    const imgPath = path.join(imgDir, 'error-test.png');
    fs.writeFileSync(imgPath, Buffer.from('fake-png'));

    const result = await executeTool('analyze_image', { image_path: imgPath });
    expect(result).toContain('Error');
    expect(result).toContain('Bedrock throttling');
  });
});

// ═══════════════════════════════════════════════════════════
// Cross-tool round-trip E2E
// ═══════════════════════════════════════════════════════════

describe('Cross-tool round-trip E2E', () => {
  it('write_file → exec → read_file pipeline works within the same server', async () => {
    const testFile = path.join(WALNUT_HOME, 'cross-tool-test.txt');

    // Step 1: write a file using the write_file tool
    const writeResult = await executeTool('write_file', {
      path: testFile,
      content: 'Hello from E2E cross-tool test\nLine 2\nLine 3',
    });
    expect(writeResult).toContain('File written');

    // Step 2: use exec to verify the file exists and has content
    const execResult = await executeTool('exec', {
      command: `cat "${testFile}"`,
    });
    expect(execResult).toContain('Hello from E2E cross-tool test');

    // Step 3: read the file back
    const readResult = await executeTool('read_file', {
      path: testFile,
    });
    expect(readResult).toContain('Hello from E2E cross-tool test');
    expect(readResult).toContain('Line 2');
    expect(readResult).toContain('Line 3');
  });

  it('task + slack tools coexist: create task then send slack notification', async () => {
    // Create a task
    await executeTool('create_task', { type: 'category', name: 'Test', source: 'ms-todo' });
    const taskResult = await executeTool('create_task', {
      title: 'Integration test task',
      category: 'Test',
    });
    expect(taskResult).toContain('Task created');
    const taskId = taskResult.match(/\[([^\]]+)\]/)?.[1];
    expect(taskId).toBeTruthy();

    // Send a Slack notification about the task (mocked)
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e-test';
    try {
      const slackResult = await executeTool('slack', {
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

    // Verify the task exists via REST
    const res = await fetch(apiUrl(`/api/tasks/${taskId}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { id: string; title: string } };
    expect(body.task.title).toBe('Integration test task');
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
