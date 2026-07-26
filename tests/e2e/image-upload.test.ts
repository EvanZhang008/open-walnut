/**
 * E2E tests for image upload — disk-based storage.
 *
 * Verifies:
 * 1. Images are saved to ~/.open-walnut/images/{timestamp}-{hash}.{ext}
 * 2. GET /api/images/:filename serves saved images correctly
 * 3. Chat history stores path-based image blocks (not inline base64)
 * 4. getModelContext() hydrates path-based images back to base64 for API
 * 5. No MAX_IMAGE_SIZE restriction exists
 * 6. Invalid filenames and nonexistent files return proper errors
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, IMAGES_DIR } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { buildImageAnnotation } from '../../src/web/routes/images.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

// Create a minimal valid PNG (2x2 red pixels)
function createTestPng(): Buffer {
  // Smallest valid PNG: 1x1 pixel, RGBA, 8-bit
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4' +
    'nGP4z8BQDwAEgAF/pooBPQAAAABJRU5ErkJggg==';
  return Buffer.from(pngBase64, 'base64');
}

// Chat storage is conversation-scoped: target the General agent's active
// conversation for the history hydration tests.
let convId: string;

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  const { getActiveConversationId } = await import('../../src/core/conversations.js');
  convId = await getActiveConversationId('general');
}, 15_000);

afterAll(async () => {
  await stopServer();
}, 15_000);

// ── Image endpoint tests ──

describe('GET /api/images/:filename', () => {
  it('returns 404 for nonexistent image', async () => {
    const res = await fetch(apiUrl('/api/images/nonexistent.png'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Image not found');
  });

  it('returns 400 for invalid filename (path traversal)', async () => {
    const res = await fetch(apiUrl('/api/images/..%2F..%2Fetc%2Fpasswd'));
    // Express URL-decodes params, so our regex check catches ../
    expect([400, 404]).toContain(res.status);
  });

  it('serves a saved image with correct headers', async () => {
    // Manually save an image to the images dir
    await fs.mkdir(IMAGES_DIR, { recursive: true });
    const testPng = createTestPng();
    const filename = '1700000000000-abc123def456.png';
    await fs.writeFile(path.join(IMAGES_DIR, filename), testPng);

    const res = await fetch(apiUrl(`/api/images/${filename}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(testPng.length);
  });

  it('serves JPEG images with correct content type', async () => {
    await fs.mkdir(IMAGES_DIR, { recursive: true });
    const filename = '1700000000001-abc123def456.jpg';
    // Write a dummy file (not a real JPEG, just for content-type testing)
    await fs.writeFile(path.join(IMAGES_DIR, filename), Buffer.from('fake-jpeg'));

    const res = await fetch(apiUrl(`/api/images/${filename}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });
});

// ── saveImageToDisk utility tests ──

describe('saveImageToDisk()', () => {
  it('saves base64 data to disk with correct naming and content', async () => {
    const { saveImageToDisk } = await import('../../src/web/routes/images.js');
    const testPng = createTestPng();
    const base64Data = testPng.toString('base64');

    const result = await saveImageToDisk(base64Data, 'image/png');

    // Verify filename format: {timestamp}-{hash}.{ext}
    expect(result.filename).toMatch(/^\d+-[a-f0-9]{12}\.png$/);
    expect(result.filePath).toBe(path.join(IMAGES_DIR, result.filename));

    // Verify file exists and content matches
    const saved = await fs.readFile(result.filePath);
    expect(saved).toEqual(testPng);
  });

  it('uses correct extension for different media types', async () => {
    const { saveImageToDisk } = await import('../../src/web/routes/images.js');
    const base64Data = Buffer.from('test-data').toString('base64');

    const jpg = await saveImageToDisk(base64Data, 'image/jpeg');
    expect(jpg.filename).toMatch(/\.jpg$/);

    const gif = await saveImageToDisk(base64Data, 'image/gif');
    expect(gif.filename).toMatch(/\.gif$/);

    const webp = await saveImageToDisk(base64Data, 'image/webp');
    expect(webp.filename).toMatch(/\.webp$/);
  });

  it('same content produces same hash (content-addressed)', async () => {
    const { saveImageToDisk } = await import('../../src/web/routes/images.js');
    const base64Data = Buffer.from('deterministic-content').toString('base64');

    const r1 = await saveImageToDisk(base64Data, 'image/png');
    const r2 = await saveImageToDisk(base64Data, 'image/png');

    // Hash portion should be identical
    const hash1 = r1.filename.split('-')[1].split('.')[0];
    const hash2 = r2.filename.split('-')[1].split('.')[0];
    expect(hash1).toBe(hash2);
  });
});

// ── readImageAsBase64 utility tests ──

describe('readImageAsBase64()', () => {
  it('reads a saved image and returns base64 + mediaType', async () => {
    const { readImageAsBase64, saveImageToDisk } = await import('../../src/web/routes/images.js');
    const testPng = createTestPng();
    const base64Data = testPng.toString('base64');
    const { filePath } = await saveImageToDisk(base64Data, 'image/png');

    const result = await readImageAsBase64(filePath);
    expect(result).not.toBeNull();
    expect(result!.data).toBe(base64Data);
    expect(result!.mediaType).toBe('image/png');
  });

  it('returns null for nonexistent file', async () => {
    const { readImageAsBase64 } = await import('../../src/web/routes/images.js');
    const result = await readImageAsBase64('/nonexistent/path.png');
    expect(result).toBeNull();
  });
});

// ── Chat history hydration tests ──

describe('Chat history image hydration', () => {
  it('getModelContext() stores path-based images, hydrateImagePaths() converts to base64', async () => {
    const { saveImageToDisk } = await import('../../src/web/routes/images.js');
    const chatHistory = await import('../../src/core/chat-history.js');

    const testPng = createTestPng();
    const base64Data = testPng.toString('base64');
    const { filePath } = await saveImageToDisk(base64Data, 'image/png');

    // Store a user message with path-based image in chat history
    await chatHistory.addAIMessages([
      {
        role: 'user',
        content: [
          { type: 'image', path: filePath, media_type: 'image/png' },
          { type: 'text', text: 'What is this image?' },
        ],
      } as any,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'It is a red pixel.' }],
      } as any,
    ], { agentId: 'general', conversationId: convId });

    // getModelContext returns path-based blocks (lightweight for token counting)
    const context = await chatHistory.getModelContext('general', convId);
    const userMsgWithImage = context.find((m: any) => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return false;
      return (m.content as any[]).some((b: any) => b.type === 'image' && b.path);
    }) as any;
    expect(userMsgWithImage).toBeDefined();

    // hydrateImagePaths() converts path-based blocks to base64 for API
    const hydrated = await chatHistory.hydrateImagePaths(context);
    const hydratedUserMsg = hydrated.find((m: any) => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return false;
      return (m.content as any[]).some((b: any) => b.type === 'image' && b.source);
    }) as any;

    expect(hydratedUserMsg).toBeDefined();
    const imageBlock = (hydratedUserMsg.content as any[]).find((b: any) => b.type === 'image');
    expect(imageBlock.source).toBeDefined();
    expect(imageBlock.source.type).toBe('base64');
    expect(imageBlock.source.media_type).toBe('image/png');
    expect(imageBlock.source.data).toBe(base64Data);
    // The path field should NOT be present in the hydrated version
    expect(imageBlock.path).toBeUndefined();
  });

  it('hydrateImagePaths() gracefully handles missing image files', async () => {
    const chatHistory = await import('../../src/core/chat-history.js');

    // Store a user message with a path to a nonexistent file
    await chatHistory.addAIMessages([
      {
        role: 'user',
        content: [
          { type: 'image', path: '/nonexistent/image.png', media_type: 'image/png' },
          { type: 'text', text: 'Missing image test' },
        ],
      } as any,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
      } as any,
    ], { agentId: 'general', conversationId: convId });

    // Get raw context then hydrate
    const context = await chatHistory.getModelContext('general', convId);
    const hydrated = await chatHistory.hydrateImagePaths(context);

    // Missing files become text placeholders — should not throw
    const lastUserMsg = [...hydrated].reverse().find((m: any) => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return false;
      return (m.content as any[]).some(
        (b: any) => b.type === 'text' && typeof b.text === 'string' && b.text.includes('file not found'),
      );
    }) as any;
    expect(lastUserMsg).toBeDefined();
  });
});

// ── <attached-images> annotation tests ──

describe('<attached-images> annotation in chat.ts', () => {
  it('chat.ts composes the annotation through buildImageAnnotation, not a hand-rolled string', async () => {
    // This assertion USED to grep chat.ts for the literal '<attached-images>' and
    // for 'imageAnnotation + agentMessage'. Both broke the moment chat.ts was
    // refactored to call buildImageAnnotation() — behaviour identical, test red.
    // That is the standing cost of source-text assertions, so this now checks the
    // WIRING (one shared builder, no second copy of the format) and leaves the
    // format itself to the behavioural tests below that call the real function.
    const chatRouteContent = await fs.readFile(
      path.resolve(import.meta.dirname, '../../src/web/routes/chat.ts'),
      'utf-8',
    );
    expect(chatRouteContent).toContain('buildImageAnnotation(savedImages)');
    // No second, divergent copy of the tag format anywhere in the route.
    expect(chatRouteContent).not.toContain('<attached-images>');
  });

  // These tests used to REPRODUCE the annotation logic in the test body ("Reproduce
  // the exact logic from chat.ts") and then assert on their own copy — a tautology
  // that would pass even if the production function were deleted. buildImageAnnotation
  // is exported from src/web/routes/images.ts, so call the real thing.
  it('annotation format: 1-indexed, one path per line, XML-wrapped', () => {
    const result = buildImageAnnotation([
      { filePath: '/home/user/.open-walnut/images/1700000000000-abc123.png' },
      { filePath: '/home/user/.open-walnut/images/1700000000001-def456.jpg' },
    ]);

    expect(result).toBe(
      '<attached-images>\n' +
      'Image 1: /home/user/.open-walnut/images/1700000000000-abc123.png\n' +
      'Image 2: /home/user/.open-walnut/images/1700000000001-def456.jpg\n' +
      '</attached-images>\n\n',
    );
  });

  it('annotation with single image', () => {
    const result = buildImageAnnotation([{ filePath: '/home/user/.open-walnut/images/1700000000000-abc123.png' }]);

    expect(result).toContain('Image 1:');
    expect(result).not.toContain('Image 2:');
  });

  it('annotation is prepended to user message, not appended', () => {
    const agentMessage = 'What do you think about this design?';
    const result = buildImageAnnotation([{ filePath: '/path/to/image.png' }]) + agentMessage;

    // Annotation comes first — Claude reads the paths before the question.
    expect(result.indexOf('<attached-images>')).toBe(0);
    expect(result.indexOf(agentMessage)).toBeGreaterThan(result.indexOf('</attached-images>'));
  });
});

// ── System prompt includes image instruction ──

describe('Agent system prompt image instruction', () => {
  it('tells the agent to pass image file paths into session prompts', async () => {
    // The CONTRACT: a session can only read an image if its path is in the prompt,
    // so the butler's prompt must say so. Asserting the old exact headings
    // ('### Image attachments', '<attached-images>') made this fail when the same
    // instruction was reworded into a numbered list (commit ae0cd90) — a false
    // alarm on unchanged behaviour. Assert the substance instead of the wording.
    const contextContent = await fs.readFile(
      path.resolve(import.meta.dirname, '../../src/agent/context.ts'),
      'utf-8',
    );
    expect(contextContent).toMatch(/image/i);
    expect(contextContent).toContain('file paths in the session prompt');
    expect(contextContent).toMatch(/Read tool/);
  });
});

// ── No MAX_IMAGE_SIZE check ──

describe('MAX_IMAGE_SIZE removal', () => {
  it('no MAX_IMAGE_SIZE in backend chat route', async () => {
    const chatRouteContent = await fs.readFile(
      path.resolve(import.meta.dirname, '../../src/web/routes/chat.ts'),
      'utf-8',
    );
    expect(chatRouteContent).not.toContain('MAX_IMAGE_SIZE');
  });

  it('no MAX_IMAGE_SIZE in frontend ChatInput', async () => {
    const chatInputContent = await fs.readFile(
      path.resolve(import.meta.dirname, '../../web/src/components/chat/ChatInput.tsx'),
      'utf-8',
    );
    expect(chatInputContent).not.toContain('MAX_IMAGE_SIZE');
  });
});
