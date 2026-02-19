/**
 * E2E tests for the exec tool — real shell command execution.
 *
 * Starts a real server on a random port, then exercises the exec tool
 * with actual shell commands, verifying output, exit codes, timeouts,
 * working directories, environment variables, and pipelines.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { executeTool } from '../../src/agent/tools.js';

// ── Helpers ──

let server: HttpServer;

interface ExecResult {
  status: string;
  exit_code: number | null;
  output: string;
  duration_ms: number;
  timeout?: boolean;
  timeout_seconds?: number;
  reason?: string;
}

function parseExecResult(raw: string): ExecResult {
  return JSON.parse(raw) as ExecResult;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Tests ──

describe('Exec tool E2E', () => {
  it('executes a simple echo command', async () => {
    const raw = await executeTool('exec', { command: 'echo "hello e2e"' });
    const result = parseExecResult(raw);

    expect(result.status).toBe('success');
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain('hello e2e');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('captures multi-line output', async () => {
    const raw = await executeTool('exec', { command: 'printf "line1\\nline2\\nline3"' });
    const result = parseExecResult(raw);

    expect(result.status).toBe('success');
    expect(result.output).toContain('line1');
    expect(result.output).toContain('line2');
    expect(result.output).toContain('line3');
  });

  it('propagates non-zero exit codes', async () => {
    const raw = await executeTool('exec', { command: 'exit 42' });
    const result = parseExecResult(raw);

    expect(result.exit_code).toBe(42);
    expect(result.status).toBe('error');
  });

  it('captures stderr output', async () => {
    const raw = await executeTool('exec', { command: 'echo "err" >&2' });
    const result = parseExecResult(raw);

    expect(result.output).toContain('err');
  });

  it('respects working directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-cwd-'));
    try {
      const raw = await executeTool('exec', { command: 'pwd', workdir: tmpDir });
      const result = parseExecResult(raw);

      expect(result.status).toBe('success');
      // Resolve both to handle symlinks (e.g. macOS /var -> /private/var)
      const expectedDir = await fs.realpath(tmpDir);
      const actualDir = result.output.trim();
      expect(actualDir).toBe(expectedDir);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('injects environment variables', async () => {
    const raw = await executeTool('exec', {
      command: 'echo $E2E_TEST_VAR',
      env: { E2E_TEST_VAR: 'e2e_value' },
    });
    const result = parseExecResult(raw);

    expect(result.status).toBe('success');
    expect(result.output).toContain('e2e_value');
  });

  it('times out long-running commands', async () => {
    const start = Date.now();
    const raw = await executeTool('exec', {
      command: 'sleep 30',
      timeout_seconds: 1,
    });
    const elapsed = Date.now() - start;
    const result = parseExecResult(raw);

    expect(result.status).toBe('timeout');
    expect(result.timeout).toBe(true);
    expect(result.timeout_seconds).toBe(1);
    // Should complete well before 30 seconds
    expect(elapsed).toBeLessThan(10_000);
  });

  it('handles command not found', async () => {
    const raw = await executeTool('exec', {
      command: 'this_command_does_not_exist_xyz',
    });
    const result = parseExecResult(raw);

    expect(result.exit_code).toBe(127);
    expect(result.status).toBe('error');
    expect(result.output.toLowerCase()).toMatch(/not found|no such file/i);
  });

  it('supports shell pipelines', async () => {
    const raw = await executeTool('exec', { command: 'echo "a b c" | wc -w' });
    const result = parseExecResult(raw);

    expect(result.status).toBe('success');
    expect(result.output.trim()).toBe('3');
  });

  it('creates files via exec and they persist on disk', async () => {
    const tmpFile = path.join(os.tmpdir(), `e2e-exec-test-${Date.now()}.txt`);
    try {
      const raw = await executeTool('exec', {
        command: `echo "created by exec" > "${tmpFile}"`,
      });
      const result = parseExecResult(raw);
      expect(result.status).toBe('success');

      // Verify file was actually created on disk
      const content = await fs.readFile(tmpFile, 'utf-8');
      expect(content.trim()).toBe('created by exec');
    } finally {
      await fs.rm(tmpFile, { force: true });
    }
  });

  it('write_file + exec round-trip: create a script then run it', async () => {
    const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-script-'));
    const scriptPath = path.join(scriptDir, 'test-script.sh');

    try {
      // Use write_file tool to create a script
      await executeTool('write_file', {
        path: scriptPath,
        content: '#!/bin/bash\necho "script ran successfully"',
      });

      // Use exec tool to run it
      const raw = await executeTool('exec', {
        command: `bash "${scriptPath}"`,
      });
      const result = parseExecResult(raw);

      expect(result.status).toBe('success');
      expect(result.output).toContain('script ran successfully');
    } finally {
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });
});
