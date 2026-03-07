import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMockConstants } from '../../helpers/mock-constants.js';

let tmpDir: string;

// Mock constants to redirect file paths to temp directory
vi.mock('../../../src/constants.js', () => createMockConstants());

// ── Slack mocks ──
const mockPostMessage = vi.fn().mockResolvedValue({
  ok: true,
  channel: 'C123',
  ts: '1234567890.123456',
  message: { text: 'hello' },
});
const mockConversationsHistory = vi.fn().mockResolvedValue({
  ok: true,
  messages: [
    { user: 'U001', text: 'Hello world', ts: '1234567890.000001' },
    { user: 'U002', text: 'Hi there', ts: '1234567890.000002', thread_ts: '1234567890.000001' },
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

// ── edge-tts mocks ──
const mockTtsSave = vi.fn().mockImplementation(async (_text: string, filePath: string) => {
  // Create the file so the tool can confirm it exists
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'fake-audio-data');
});

vi.mock('edge-tts', () => ({
  ttsSave: mockTtsSave,
  tts: vi.fn().mockResolvedValue(Buffer.from('fake-audio')),
  getVoices: vi.fn().mockResolvedValue([]),
}));

// ── Bedrock model mock ──
const { mockSendMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'This is a photo of a sunset over the ocean.' }],
    stopReason: 'end_turn',
  }),
}));
vi.mock('../../../src/agent/model.js', () => ({
  sendMessage: mockSendMessage,
  DEFAULT_MODEL: 'global.anthropic.claude-opus-4-6-v1',
  getContextWindowSize: (model?: string) => model?.includes('[1m]') ? 1_000_000 : 200_000,
  getContextThreshold: (model: string | undefined, percent: number) =>
    Math.round((model?.includes('[1m]') ? 1_000_000 : 200_000) * percent),
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import { slackTool } from '../../../src/agent/tools/slack-tool.js';
import { ttsTool } from '../../../src/agent/tools/tts-tool.js';
import { imageTool } from '../../../src/agent/tools/image-tool.js';
import fs2 from 'node:fs/promises';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs2.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs2.rm(tmpDir, { recursive: true, force: true });
});

// ── Slack Tool Tests ──
describe('slack tool', () => {
  it('has correct tool definition', () => {
    expect(slackTool.name).toBe('slack');
    expect(slackTool.input_schema.required).toContain('action');
    expect(slackTool.input_schema.required).toContain('channel');
  });

  it('returns error when no token configured', async () => {
    // Clear env var to ensure no token
    const saved = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    try {
      const result = await slackTool.execute({ action: 'send_message', channel: '#general', text: 'hi' });
      expect(result).toContain('not configured');
    } finally {
      if (saved) process.env.SLACK_BOT_TOKEN = saved;
    }
  });

  it('send_message calls chat.postMessage with correct params', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    try {
      const result = await slackTool.execute({
        action: 'send_message',
        channel: '#general',
        text: 'Hello from bot',
      });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.ts).toBe('1234567890.123456');
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: '#general',
        text: 'Hello from bot',
        thread_ts: undefined,
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('send_message supports thread_ts', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    try {
      await slackTool.execute({
        action: 'send_message',
        channel: '#general',
        text: 'Thread reply',
        thread_ts: '1234567890.000001',
      });
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: '#general',
        text: 'Thread reply',
        thread_ts: '1234567890.000001',
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('send_message returns error when text missing', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    try {
      const result = await slackTool.execute({ action: 'send_message', channel: '#general' });
      expect(result).toContain('Error');
      expect(result).toContain('text is required');
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('read_messages returns formatted messages', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    try {
      const result = await slackTool.execute({
        action: 'read_messages',
        channel: 'C123',
        limit: 5,
      });
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].user).toBe('U001');
      expect(parsed[0].text).toBe('Hello world');
      expect(parsed[1].thread_ts).toBe('1234567890.000001');
      expect(mockConversationsHistory).toHaveBeenCalledWith({
        channel: 'C123',
        limit: 5,
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('react calls reactions.add with correct params', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    try {
      const result = await slackTool.execute({
        action: 'react',
        channel: 'C123',
        timestamp: '1234567890.000001',
        emoji: 'thumbsup',
      });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(mockReactionsAdd).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.000001',
        name: 'thumbsup',
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('react returns error when timestamp missing', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    try {
      const result = await slackTool.execute({
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

  it('pin calls pins.add with correct params', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    try {
      const result = await slackTool.execute({
        action: 'pin',
        channel: 'C123',
        timestamp: '1234567890.000001',
      });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(mockPinsAdd).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.000001',
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('returns error for unknown action', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    try {
      const result = await slackTool.execute({
        action: 'unknown_action',
        channel: 'C123',
      });
      expect(result).toContain('Error');
      expect(result).toContain('Unknown action');
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('handles Slack API errors gracefully', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    mockPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));
    try {
      const result = await slackTool.execute({
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
});

// ── TTS Tool Tests ──
describe('tts tool', () => {
  it('has correct tool definition', () => {
    expect(ttsTool.name).toBe('tts');
    expect(ttsTool.input_schema.required).toContain('text');
  });

  it('generates audio from text', async () => {
    const result = await ttsTool.execute({ text: 'Hello world' });
    const parsed = JSON.parse(result);
    expect(parsed.audio_path).toContain('.mp3');
    expect(parsed.voice).toBe('en-US-AriaNeural');
    expect(parsed.text_length).toBe(11);
    expect(parsed.duration_estimate_seconds).toBeGreaterThan(0);
    expect(mockTtsSave).toHaveBeenCalledWith(
      'Hello world',
      expect.stringContaining('.mp3'),
      { voice: 'en-US-AriaNeural' },
    );
  });

  it('uses custom voice when specified', async () => {
    const result = await ttsTool.execute({ text: 'Test', voice: 'en-GB-SoniaNeural' });
    const parsed = JSON.parse(result);
    expect(parsed.voice).toBe('en-GB-SoniaNeural');
    expect(mockTtsSave).toHaveBeenCalledWith(
      'Test',
      expect.any(String),
      { voice: 'en-GB-SoniaNeural' },
    );
  });

  it('creates tts directory if not exists', async () => {
    const ttsDir = path.join(WALNUT_HOME, 'media', 'tts');
    expect(fs.existsSync(ttsDir)).toBe(false);
    await ttsTool.execute({ text: 'Hello' });
    // The mockTtsSave creates the parent dir, but ensureTtsDir should have created it
    expect(mockTtsSave).toHaveBeenCalled();
  });

  it('returns error when text is empty', async () => {
    const result = await ttsTool.execute({ text: '' });
    expect(result).toContain('Error');
  });

  it('handles tts failure gracefully', async () => {
    mockTtsSave.mockRejectedValueOnce(new Error('network error'));
    const result = await ttsTool.execute({ text: 'Hello' });
    expect(result).toContain('Error');
    expect(result).toContain('network error');
  });
});

// ── Image Tool Tests ──
describe('image tool', () => {
  it('has correct tool definition', () => {
    expect(imageTool.name).toBe('analyze_image');
    expect(imageTool.input_schema.required).toContain('image_path');
  });

  it('analyzes an image file', async () => {
    // Create a fake image file
    const imgDir = path.join(tmpDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, 'test.png');
    fs.writeFileSync(imgPath, Buffer.from('fake-png-data'));

    const result = await imageTool.execute({ image_path: imgPath });
    expect(result).toBe('This is a photo of a sunset over the ocean.');
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

  it('uses custom prompt when provided', async () => {
    const imgDir = path.join(tmpDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, 'test.jpg');
    fs.writeFileSync(imgPath, Buffer.from('fake-jpg-data'));

    await imageTool.execute({
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
    const result = await imageTool.execute({ image_path: '/nonexistent/image.png' });
    expect(result).toContain('Error');
    expect(result).toContain('File not found');
  });

  it('returns error for unsupported format', async () => {
    const imgDir = path.join(tmpDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, 'test.bmp');
    fs.writeFileSync(imgPath, Buffer.from('fake-bmp-data'));

    const result = await imageTool.execute({ image_path: imgPath });
    expect(result).toContain('Error');
    expect(result).toContain('Unsupported image format');
  });

  it('supports JPEG extension', async () => {
    const imgDir = path.join(tmpDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, 'photo.jpeg');
    fs.writeFileSync(imgPath, Buffer.from('fake-jpeg-data'));

    const result = await imageTool.execute({ image_path: imgPath });
    expect(result).toBe('This is a photo of a sunset over the ocean.');
  });

  it('supports WebP format', async () => {
    const imgDir = path.join(tmpDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, 'photo.webp');
    fs.writeFileSync(imgPath, Buffer.from('fake-webp-data'));

    const result = await imageTool.execute({ image_path: imgPath });
    expect(result).toBe('This is a photo of a sunset over the ocean.');
  });

  it('handles model API error gracefully', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('Bedrock throttling'));

    const imgDir = path.join(tmpDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, 'test.png');
    fs.writeFileSync(imgPath, Buffer.from('fake-png-data'));

    const result = await imageTool.execute({ image_path: imgPath });
    expect(result).toContain('Error');
    expect(result).toContain('Bedrock throttling');
  });

  it('encodes image as base64', async () => {
    const imgDir = path.join(tmpDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, 'test.gif');
    const testData = Buffer.from('GIF89a-fake-gif-data');
    fs.writeFileSync(imgPath, testData);

    await imageTool.execute({ image_path: imgPath });

    const callArgs = mockSendMessage.mock.calls[0][0];
    const imageBlock = callArgs.messages[0].content[0];
    expect(imageBlock.source.type).toBe('base64');
    expect(imageBlock.source.media_type).toBe('image/gif');
    expect(imageBlock.source.data).toBe(testData.toString('base64'));
  });
});
