import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { evaluateExecPolicy, type ToolExecConfig } from '../../../src/agent/tools/exec-policy.js';
import { execTool } from '../../../src/agent/tools/exec-tool.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── exec-policy tests ──

describe('evaluateExecPolicy', () => {
  it('allows any command in full mode with empty deny list', () => {
    const config: ToolExecConfig = { security: 'full', deny: [] };
    expect(evaluateExecPolicy('echo hello', config)).toEqual({ allowed: true });
  });

  it('blocks command matching deny pattern in full mode', () => {
    const config: ToolExecConfig = { security: 'full', deny: ['sudo *'] };
    const result = evaluateExecPolicy('sudo rm -rf /', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('deny pattern');
  });

  it('blocks command matching deny pattern in deny mode', () => {
    const config: ToolExecConfig = { security: 'deny', deny: ['rm -rf /*'] };
    const result = evaluateExecPolicy('rm -rf /tmp', config);
    expect(result.allowed).toBe(false);
  });

  it('allows non-matching command in deny mode', () => {
    const config: ToolExecConfig = { security: 'deny', deny: ['sudo *'] };
    expect(evaluateExecPolicy('echo hello', config)).toEqual({ allowed: true });
  });

  it('allows matching command in allowlist mode', () => {
    const config: ToolExecConfig = { security: 'allowlist', allow: ['echo *', 'ls *'] };
    expect(evaluateExecPolicy('echo hello world', config)).toEqual({ allowed: true });
  });

  it('blocks non-matching command in allowlist mode', () => {
    const config: ToolExecConfig = { security: 'allowlist', allow: ['echo *'] };
    const result = evaluateExecPolicy('rm file.txt', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in allowlist');
  });

  it('deny list takes precedence over allowlist', () => {
    const config: ToolExecConfig = {
      security: 'allowlist',
      allow: ['sudo *'],
      deny: ['sudo rm *'],
    };
    const result = evaluateExecPolicy('sudo rm -rf /', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('deny pattern');
  });

  it('defaults to full mode when no security specified', () => {
    const config: ToolExecConfig = {};
    expect(evaluateExecPolicy('anything', config)).toEqual({ allowed: true });
  });

  it('supports ? glob for single character matching', () => {
    const config: ToolExecConfig = { security: 'deny', deny: ['rm -r?'] };
    expect(evaluateExecPolicy('rm -rf', config).allowed).toBe(false);
    expect(evaluateExecPolicy('rm -rv', config).allowed).toBe(false);
    expect(evaluateExecPolicy('rm -rfv', config).allowed).toBe(true);
  });
});

// ── exec-tool tests ──

describe('execTool', () => {
  it('has correct tool definition shape', () => {
    expect(execTool.name).toBe('exec');
    expect(execTool.description).toBeDefined();
    expect(execTool.input_schema.required).toContain('command');
    expect(typeof execTool.execute).toBe('function');
  });

  it('runs echo and captures output', async () => {
    const result = await execTool.execute({ command: 'echo hello' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.exit_code).toBe(0);
    expect(parsed.output).toContain('hello');
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('captures non-zero exit code', async () => {
    const result = await execTool.execute({ command: 'exit 1' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.exit_code).toBe(1);
  });

  it('captures stderr in output', async () => {
    const result = await execTool.execute({ command: 'echo err >&2' });
    const parsed = JSON.parse(result);
    expect(parsed.output).toContain('err');
  });

  it('times out long-running commands', async () => {
    const result = await execTool.execute({
      command: 'sleep 30',
      timeout_seconds: 1,
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('timeout');
    expect(parsed.timeout).toBe(true);
    expect(parsed.timeout_seconds).toBe(1);
  }, 15_000);

  it('truncates large output', async () => {
    // Generate output larger than 50k chars
    // Each line of "seq 1 20000" is at most 6 chars, so ~100k total
    const result = await execTool.execute({
      command: 'seq 1 20000',
    });
    const parsed = JSON.parse(result);
    // With default 50k max, the output should be truncated
    if (parsed.output.length > 50_000) {
      // If somehow still large, check marker is present
      expect(parsed.output).toContain('[truncated middle]');
    }
    // The important thing: the status should still be success
    expect(parsed.status).toBe('success');
    expect(parsed.exit_code).toBe(0);
  }, 10_000);

  it('uses specified working directory', async () => {
    const testDir = path.join(tmpDir, 'workdir-test');
    await fs.mkdir(testDir, { recursive: true });
    const result = await execTool.execute({
      command: 'pwd',
      workdir: testDir,
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    // Resolve symlinks for macOS where /tmp -> /private/tmp
    const realTestDir = await fs.realpath(testDir);
    expect(parsed.output.trim()).toBe(realTestDir);
  });

  it('passes environment variables', async () => {
    const result = await execTool.execute({
      command: 'echo $MY_TEST_VAR',
      env: { MY_TEST_VAR: 'test_value_123' },
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.output).toContain('test_value_123');
  });

  it('handles command not found', async () => {
    const result = await execTool.execute({
      command: 'nonexistent_command_xyz_123',
    });
    const parsed = JSON.parse(result);
    // Command not found usually gives exit code 127
    expect(parsed.exit_code).not.toBe(0);
    expect(parsed.output).toBeTruthy();
  });

  it('handles pipes and shell features', async () => {
    const result = await execTool.execute({
      command: 'echo "line1\nline2\nline3" | wc -l',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.output.trim()).toBe('3');
  });
});

// ── exec-tool with security policy (config mock) ──

describe('exec tool with deny policy', () => {
  it('blocks denied commands via config', async () => {
    // Mock getConfig to return a deny-list config
    const { getConfig } = await import('../../../src/core/config-manager.js');
    const originalGetConfig = getConfig;

    vi.spyOn(
      await import('../../../src/core/config-manager.js'),
      'getConfig',
    ).mockResolvedValue({
      version: 1,
      user: {},
      defaults: { priority: 'none', category: 'personal' },
      provider: { type: 'claude-code' },
      tools: {
        exec: {
          security: 'deny',
          deny: ['sudo *', 'rm -rf /*'],
        },
      },
    });

    const result = await execTool.execute({ command: 'sudo apt install foo' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('blocked');
    expect(parsed.reason).toContain('deny pattern');

    vi.restoreAllMocks();
  });

  it('blocks non-allowlisted commands in allowlist mode', async () => {
    vi.spyOn(
      await import('../../../src/core/config-manager.js'),
      'getConfig',
    ).mockResolvedValue({
      version: 1,
      user: {},
      defaults: { priority: 'none', category: 'personal' },
      provider: { type: 'claude-code' },
      tools: {
        exec: {
          security: 'allowlist',
          allow: ['echo *'],
        },
      },
    });

    const result = await execTool.execute({ command: 'cat /etc/passwd' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('blocked');
    expect(parsed.reason).toContain('not in allowlist');

    // But echo should work
    const echoResult = await execTool.execute({ command: 'echo allowed' });
    const echoParsed = JSON.parse(echoResult);
    expect(echoParsed.status).toBe('success');
    expect(echoParsed.output).toContain('allowed');

    vi.restoreAllMocks();
  });
});
