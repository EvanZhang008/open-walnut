/**
 * E2E tests for the agent coding tools: read_file, write_file, edit_file.
 *
 * Starts a real server on a random port, executes tools via executeTool(),
 * and verifies persistence on the real filesystem (tmpdir via mock constants).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { executeTool } from '../../src/agent/tools.js';

let server: HttpServer;

/** Directory inside tmpdir for test files written by the tools. */
function testFile(...segments: string[]): string {
  return path.join(WALNUT_HOME, 'test-workspace', ...segments);
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── write_file → read_file round-trip ──

describe('write_file → read_file round-trip', () => {
  const filePath = testFile('round-trip.txt');
  const content = 'Hello from E2E test!\nLine two.\nLine three.';

  it('write_file creates the file and returns success', async () => {
    const result = await executeTool('write_file', { path: filePath, content });
    expect(result).toContain('File written');
    expect(result).toContain(filePath);
  });

  it('read_file returns the same content with line numbers', async () => {
    const result = await executeTool('read_file', { path: filePath });
    expect(result).toContain('Hello from E2E test!');
    expect(result).toContain('Line two.');
    expect(result).toContain('Line three.');
  });

  it('file actually exists on disk with correct content', async () => {
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw).toBe(content);
  });
});

// ── write_file with nested directories ──

describe('write_file with nested directories', () => {
  const filePath = testFile('deep', 'nested', 'dir', 'file.txt');
  const content = 'nested content';

  it('creates parent directories and writes file', async () => {
    const result = await executeTool('write_file', { path: filePath, content });
    expect(result).toContain('File written');
  });

  it('file exists on disk at the nested path', async () => {
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw).toBe(content);
  });
});

// ── read_file on non-existent file ──

describe('read_file on non-existent file', () => {
  it('returns an error message', async () => {
    const result = await executeTool('read_file', {
      path: '/tmp/nonexistent-xyz-e2e-test-12345.txt',
    });
    expect(result.toLowerCase()).toMatch(/not found|enoent/);
  });
});

// ── read_file with offset/limit ──

describe('read_file with offset and limit', () => {
  const filePath = testFile('multiline.txt');

  it('returns only the requested slice of lines', async () => {
    // Create a 25-line file
    const lines = Array.from({ length: 25 }, (_, i) => `Line ${i + 1}`);
    await executeTool('write_file', { path: filePath, content: lines.join('\n') });

    // Read with offset=5, limit=3 (1-based: lines 5, 6, 7)
    const result = await executeTool('read_file', {
      path: filePath,
      offset: 5,
      limit: 3,
    });

    expect(result).toContain('Line 5');
    expect(result).toContain('Line 6');
    expect(result).toContain('Line 7');
    // Should NOT contain lines outside the range
    expect(result).not.toContain('Line 4\n');
    expect(result).not.toContain('Line 8');
    // Should include the "(Showing lines ...)" footer
    expect(result).toContain('Showing lines 5');
    expect(result).toContain('of 25 total');
  });
});

// ── read_file on image file ──

describe('read_file on image file', () => {
  const filePath = testFile('test-image.png');

  it('returns inline image content for vision-supported formats', async () => {
    // Write some binary-ish bytes with a PNG header
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00,
    ]);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, pngHeader);

    const result = await executeTool('read_file', { path: filePath });
    // Vision-supported images return an array: [image content block, text metadata]
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].source?.media_type).toBe('image/png');
    expect(blocks[1].type).toBe('text');
    expect(blocks[1].text).toContain('image/png');
    expect(blocks[1].text).toContain('bytes');
  });
});

// ── edit_file basic replacement ──

describe('edit_file basic replacement', () => {
  const filePath = testFile('edit-basic.txt');
  const original = 'The quick brown fox jumps over the lazy dog.';

  it('replaces a unique string and confirms via read_file', async () => {
    await executeTool('write_file', { path: filePath, content: original });

    const editResult = await executeTool('edit_file', {
      path: filePath,
      old_string: 'brown fox',
      new_string: 'red panda',
    });
    expect(editResult).toContain('File edited');
    expect(editResult).toContain('1 replacement');

    // Verify via read_file
    const readResult = await executeTool('read_file', { path: filePath });
    expect(readResult).toContain('red panda');
    expect(readResult).not.toContain('brown fox');

    // Verify via direct filesystem read
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw).toBe('The quick red panda jumps over the lazy dog.');
  });
});

// ── edit_file non-unique match error ──

describe('edit_file non-unique match error', () => {
  const filePath = testFile('edit-nonunique.txt');

  it('returns error when old_string matches multiple times', async () => {
    const content = 'hello world\nhello again\nhello once more';
    await executeTool('write_file', { path: filePath, content });

    const result = await executeTool('edit_file', {
      path: filePath,
      old_string: 'hello',
      new_string: 'goodbye',
    });
    expect(result.toLowerCase()).toContain('error');
    expect(result).toContain('3 times');
  });
});

// ── edit_file replace_all ──

describe('edit_file replace_all', () => {
  const filePath = testFile('edit-replaceall.txt');

  it('replaces all occurrences when replace_all is true', async () => {
    const content = 'hello world\nhello again\nhello once more';
    await executeTool('write_file', { path: filePath, content });

    const editResult = await executeTool('edit_file', {
      path: filePath,
      old_string: 'hello',
      new_string: 'goodbye',
      replace_all: true,
    });
    expect(editResult).toContain('3 replacement');

    // Verify via read_file
    const readResult = await executeTool('read_file', { path: filePath });
    expect(readResult).not.toContain('hello');
    expect(readResult).toContain('goodbye world');
    expect(readResult).toContain('goodbye again');
    expect(readResult).toContain('goodbye once more');
  });
});

// ── edit_file string not found ──

describe('edit_file string not found', () => {
  const filePath = testFile('edit-notfound.txt');

  it('returns error when old_string is not in the file', async () => {
    await executeTool('write_file', {
      path: filePath,
      content: 'some existing content',
    });

    const result = await executeTool('edit_file', {
      path: filePath,
      old_string: 'nonexistent string xyz',
      new_string: 'replacement',
    });
    expect(result.toLowerCase()).toContain('error');
    expect(result.toLowerCase()).toContain('not found');
  });
});

// ── Full lifecycle: write → edit → read → edit → read ──

describe('full lifecycle: write → edit → read → edit → read', () => {
  const filePath = testFile('lifecycle.ts');

  it('completes a multi-step write/edit/read cycle', async () => {
    // Step 1: Write initial file
    const initial = [
      'function greet(name: string): string {',
      '  return `Hello, ${name}!`;',
      '}',
      '',
      'export default greet;',
    ].join('\n');

    const writeResult = await executeTool('write_file', {
      path: filePath,
      content: initial,
    });
    expect(writeResult).toContain('File written');

    // Step 2: First edit — change function name
    const edit1Result = await executeTool('edit_file', {
      path: filePath,
      old_string: 'function greet(name: string)',
      new_string: 'function sayHello(name: string)',
    });
    expect(edit1Result).toContain('File edited');

    // Step 3: Read and verify first edit
    const read1Result = await executeTool('read_file', { path: filePath });
    expect(read1Result).toContain('sayHello');
    expect(read1Result).not.toContain('function greet(');

    // Step 4: Second edit — change the return value
    const edit2Result = await executeTool('edit_file', {
      path: filePath,
      old_string: 'return `Hello, ${name}!`',
      new_string: 'return `Hi there, ${name}! Welcome.`',
    });
    expect(edit2Result).toContain('File edited');

    // Step 5: Read and verify final state
    const read2Result = await executeTool('read_file', { path: filePath });
    expect(read2Result).toContain('sayHello');
    expect(read2Result).toContain('Hi there');
    expect(read2Result).toContain('Welcome.');
    expect(read2Result).not.toContain('function greet(');

    // Also verify on disk
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw).toContain('function sayHello(name: string)');
    expect(raw).toContain('return `Hi there, ${name}! Welcome.`');
    expect(raw).toContain('export default greet;'); // export name unchanged
  });
});
