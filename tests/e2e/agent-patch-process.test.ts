/**
 * E2E: apply_patch and process tools with real filesystem and process registry.
 *
 * Starts a real server, uses real file I/O for apply_patch, and exercises
 * the process registry for the process tool.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createApplyPatchTool } from '../../src/agent/tools/apply-patch.js';
import { createProcessTool } from '../../src/agent/tools/process-tool.js';
import {
  addSession,
  appendOutput,
  markExited,
  markBackgrounded,
  resetProcessRegistryForTests,
} from '../../src/core/bash-process-registry.js';
import type { ProcessSession } from '../../src/core/bash-process-registry.js';

// ── Helpers ──

let server: HttpServer;
let tmpDir: string;
let patchTool: ReturnType<typeof createApplyPatchTool>;
let processTool: ReturnType<typeof createProcessTool>;

function makePatch(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

function makeSession(overrides: Partial<ProcessSession> = {}): ProcessSession {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    command: 'echo hello',
    startedAt: Date.now(),
    maxOutputChars: 100_000,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: '',
    tail: '',
    exited: false,
    truncated: false,
    backgrounded: false,
    ...overrides,
  };
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });

  tmpDir = path.join(WALNUT_HOME, 'patch-test-workspace');
  await fs.mkdir(tmpDir, { recursive: true });

  patchTool = createApplyPatchTool(tmpDir);
  processTool = createProcessTool();
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── apply_patch tests ──

describe('apply_patch tool E2E', () => {
  it('adds a new file via patch', async () => {
    const result = await patchTool.execute({
      input: makePatch(
        `*** Add File: new-file.txt\n+Hello from patch\n+Line two`,
      ),
    });

    expect(result).toContain('Success');
    expect(result).toContain('A new-file.txt');

    const content = await fs.readFile(path.join(tmpDir, 'new-file.txt'), 'utf8');
    expect(content).toBe('Hello from patch\nLine two\n');
  });

  it('updates an existing file', async () => {
    const filePath = path.join(tmpDir, 'update-target.txt');
    await fs.writeFile(filePath, 'line one\nline two\nline three\n', 'utf8');

    const result = await patchTool.execute({
      input: makePatch(
        [
          '*** Update File: update-target.txt',
          ' line one',
          '-line two',
          '+line TWO CHANGED',
          ' line three',
        ].join('\n'),
      ),
    });

    expect(result).toContain('Success');
    expect(result).toContain('M update-target.txt');

    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('line one\nline TWO CHANGED\nline three\n');
  });

  it('deletes a file via patch', async () => {
    const filePath = path.join(tmpDir, 'delete-me.txt');
    await fs.writeFile(filePath, 'temporary content\n', 'utf8');

    const result = await patchTool.execute({
      input: makePatch('*** Delete File: delete-me.txt'),
    });

    expect(result).toContain('Success');
    expect(result).toContain('D delete-me.txt');

    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('applies a multi-file patch (add + update)', async () => {
    const existingPath = path.join(tmpDir, 'multi-existing.txt');
    await fs.writeFile(existingPath, 'old content\n', 'utf8');

    const result = await patchTool.execute({
      input: makePatch(
        [
          '*** Add File: multi-new.txt',
          '+brand new file',
          '*** Update File: multi-existing.txt',
          '-old content',
          '+new content',
        ].join('\n'),
      ),
    });

    expect(result).toContain('Success');
    expect(result).toContain('A multi-new.txt');
    expect(result).toContain('M multi-existing.txt');

    const newContent = await fs.readFile(
      path.join(tmpDir, 'multi-new.txt'),
      'utf8',
    );
    expect(newContent).toBe('brand new file\n');

    const updatedContent = await fs.readFile(existingPath, 'utf8');
    expect(updatedContent).toBe('new content\n');
  });

  it('handles @@ context markers targeting a specific section', async () => {
    const filePath = path.join(tmpDir, 'context-markers.txt');
    // Use unique line content so context markers can find the right section
    const lines: string[] = [];
    for (let i = 1; i <= 25; i++) {
      lines.push(`row_${i}_data`);
    }
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');

    // @@ context sets the search position to just after "row_10_data",
    // then old lines start matching from that position onward.
    const result = await patchTool.execute({
      input: makePatch(
        [
          '*** Update File: context-markers.txt',
          '@@ row_10_data',
          '-row_11_data',
          '-row_12_data',
          '+row_11_CHANGED',
          '+row_12_CHANGED',
        ].join('\n'),
      ),
    });

    expect(result).toContain('Success');

    const content = await fs.readFile(filePath, 'utf8');
    const resultLines = content.split('\n');
    // Lines 1-10 unchanged (0-indexed: 0-9)
    expect(resultLines[0]).toBe('row_1_data');
    expect(resultLines[9]).toBe('row_10_data');
    // Lines 11-12 changed (0-indexed: 10-11)
    expect(resultLines[10]).toBe('row_11_CHANGED');
    expect(resultLines[11]).toBe('row_12_CHANGED');
    // Lines 13+ unchanged
    expect(resultLines[12]).toBe('row_13_data');
    expect(resultLines[24]).toBe('row_25_data');
  });

  it('full lifecycle: write_file → apply_patch → read_file → verify', async () => {
    // Use write_file tool-style to create a file
    const filePath = path.join(tmpDir, 'lifecycle.txt');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'initial content\nsecond line\n', 'utf8');

    // Apply a patch
    const patchResult = await patchTool.execute({
      input: makePatch(
        [
          '*** Update File: lifecycle.txt',
          ' initial content',
          '-second line',
          '+modified line',
          '+added line',
        ].join('\n'),
      ),
    });
    expect(patchResult).toContain('Success');

    // Read back and verify
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('initial content\nmodified line\nadded line\n');
  });

  it('returns error for bad patch format (no Begin Patch)', async () => {
    const result = await patchTool.execute({
      input: 'This is not a valid patch',
    });

    expect(result).toContain('Error');
    expect(result).toContain('Begin Patch');
  });

  it('returns error for empty input', async () => {
    const result = await patchTool.execute({ input: '' });
    expect(result).toContain('Error');
  });

  it('creates nested directories for new files', async () => {
    const result = await patchTool.execute({
      input: makePatch(
        '*** Add File: deep/nested/dir/file.txt\n+nested content',
      ),
    });

    expect(result).toContain('Success');
    const content = await fs.readFile(
      path.join(tmpDir, 'deep/nested/dir/file.txt'),
      'utf8',
    );
    expect(content).toBe('nested content\n');
  });
});

// ── process tool tests ──

describe('process tool E2E', () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
  });

  it('list returns empty when no sessions exist', async () => {
    const result = await processTool.execute({ action: 'list' });
    expect(result).toBe('No running or recent sessions.');
  });

  it('list shows running backgrounded sessions', async () => {
    const session = makeSession({ backgrounded: true, pid: 12345 });
    addSession(session);

    const result = await processTool.execute({ action: 'list' });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].session_id).toBe(session.id);
    expect(parsed[0].status).toBe('running');
    expect(parsed[0].command).toBe('echo hello');
  });

  it('list shows finished sessions', async () => {
    const session = makeSession({ backgrounded: true });
    addSession(session);
    markExited(session, 0, null, 'completed');

    const result = await processTool.execute({ action: 'list' });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe('completed');
    expect(parsed[0].exit_code).toBe(0);
  });

  it('read returns output from a backgrounded session', async () => {
    const session = makeSession({ backgrounded: true });
    addSession(session);
    appendOutput(session, 'stdout', 'hello world\n');

    const result = await processTool.execute({
      action: 'read',
      session_id: session.id,
    });

    expect(result).toContain('hello world');
    expect(result).toContain('Process still running');
  });

  it('read returns output from a finished session', async () => {
    const session = makeSession({ backgrounded: true });
    addSession(session);
    appendOutput(session, 'stdout', 'output before exit\n');
    markExited(session, 0, null, 'completed');

    const result = await processTool.execute({
      action: 'read',
      session_id: session.id,
    });

    expect(result).toContain('output before exit');
    expect(result).toContain('Process exited with code 0');
  });

  it('read returns error for unknown session', async () => {
    const result = await processTool.execute({
      action: 'read',
      session_id: 'nonexistent',
    });
    expect(result).toContain('No session found');
  });

  it('read on non-backgrounded session returns appropriate message', async () => {
    const session = makeSession({ backgrounded: false });
    addSession(session);

    const result = await processTool.execute({
      action: 'read',
      session_id: session.id,
    });
    expect(result).toContain('not backgrounded');
  });

  it('kill on non-existent session returns error', async () => {
    const result = await processTool.execute({
      action: 'kill',
      session_id: 'ghost',
    });
    expect(result).toContain('No active session found');
  });

  it('send requires session_id', async () => {
    const result = await processTool.execute({ action: 'send' });
    expect(result).toContain('session_id is required');
  });

  it('unknown action returns error', async () => {
    const result = await processTool.execute({ action: 'bogus', session_id: 'fake' });
    expect(result).toContain('Unknown action');
  });

  it('list shows both running and finished sessions together', async () => {
    const running = makeSession({ backgrounded: true, command: 'sleep 999' });
    addSession(running);

    const finished = makeSession({ backgrounded: true, command: 'echo done' });
    addSession(finished);
    markExited(finished, 0, null, 'completed');

    const result = await processTool.execute({ action: 'list' });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
    const statuses = parsed.map((s: { status: string }) => s.status);
    expect(statuses).toContain('running');
    expect(statuses).toContain('completed');
  });

  it('read drains pending output (second read is empty)', async () => {
    const session = makeSession({ backgrounded: true });
    addSession(session);
    appendOutput(session, 'stdout', 'first chunk\n');

    const result1 = await processTool.execute({
      action: 'read',
      session_id: session.id,
    });
    expect(result1).toContain('first chunk');

    const result2 = await processTool.execute({
      action: 'read',
      session_id: session.id,
    });
    expect(result2).toContain('(no new output)');
  });
});
