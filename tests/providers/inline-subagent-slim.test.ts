/**
 * runInlineSubagent `slim` preset ratchet — the one-flag utility-child combo.
 * Without it a claude -p child inhales ~32.5k tokens (CLI system prompt +
 * tool manuals + the cwd's CLAUDE.md chain), runs in the server's repo cwd
 * (directory-scoped cron-adoption hazard), and drops its transcript where the
 * session-import scan lists it. Pin the flag expansion and the override rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { createMockConstants } from '../helpers/mock-constants.js';

const { spawnMock, settingsJsonRef } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  settingsJsonRef: { value: null as string | null },
}));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-inline-subagent-slim'));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../../src/core/claude-cli-detect.js', () => ({
  resolveClaudeCliExecutable: () => '/usr/local/bin/claude',
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      if (settingsJsonRef.value !== null && /\.claude[/\\]settings\.json$/.test(String(p))) {
        return settingsJsonRef.value;
      }
      return real.readFileSync(p as never, ...(rest as never[]));
    }) as typeof real.readFileSync,
  };
});

import { runInlineSubagent, _resetUserSettingsEnvCacheForTesting } from '../../src/providers/inline-subagent.js';

function fakeProc(): EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: { write: () => void; end: () => void }; kill: () => void } {
  const proc = new EventEmitter() as ReturnType<typeof fakeProc>;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = { write: () => {}, end: () => {} };
  proc.kill = () => {};
  return proc;
}

async function run(opts: Partial<Parameters<typeof runInlineSubagent>[0]>): Promise<{ args: string[]; spawnOpts: { cwd?: string; env?: Record<string, string> } }> {
  const proc = fakeProc();
  spawnMock.mockReturnValueOnce(proc);
  const done = runInlineSubagent({ prompt: 'p', toolUseId: 'tu-slim', systemPrompt: 'tiny', ...opts });
  // Let the runner attach listeners, then finish the child cleanly.
  await new Promise((r) => setTimeout(r, 10));
  proc.emit('exit', 0);
  await done;
  const [, args, spawnOpts] = spawnMock.mock.calls.at(-1)!;
  return { args, spawnOpts };
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('runInlineSubagent slim preset', () => {
  it('slim:true expands to replace-prompt + no tools + no settings + --bare + tmpdir cwd', async () => {
    const { args, spawnOpts } = await run({ slim: true });
    expect(args).toContain('--system-prompt');
    expect(args).not.toContain('--append-system-prompt');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('--bare');
    expect(spawnOpts.cwd).toBe(tmpdir());
  });

  it('explicit fields win over the preset (slim + Bash keeps Bash)', async () => {
    const { args, spawnOpts } = await run({ slim: true, tools: ['Bash'], cwd: '/somewhere/else' });
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash');
    expect(spawnOpts.cwd).toBe('/somewhere/else');
    expect(args).toContain('--bare');
  });

  it('without slim, nothing changes: full shell, append prompt, inherited cwd', async () => {
    const { args, spawnOpts } = await run({});
    expect(args).toContain('--append-system-prompt');
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--bare');
    expect(spawnOpts.cwd).toBe(process.cwd());
  });

  it('EVERY child (slim or not) carries the utility entrypoint marker so the import scan skips it', async () => {
    for (const opts of [{ slim: true }, {}]) {
      const { spawnOpts } = await run(opts);
      expect(spawnOpts.env?.CLAUDE_CODE_ENTRYPOINT).toBe('walnut-utility');
    }
  });

  it('a settings-less child gets ~/.claude/settings.json env re-applied (Bedrock auth lives there)', async () => {
    settingsJsonRef.value = JSON.stringify({ env: { WALNUT_TEST_BEDROCK_FLAG: '1', WALNUT_TEST_REGION: 'us-west-2', NOT_A_STRING: 42 } });
    try {
      _resetUserSettingsEnvCacheForTesting();
      const { spawnOpts } = await run({ slim: true });
      expect(spawnOpts.env?.WALNUT_TEST_BEDROCK_FLAG).toBe('1');
      expect(spawnOpts.env?.WALNUT_TEST_REGION).toBe('us-west-2');
      expect(spawnOpts.env?.NOT_A_STRING).toBeUndefined();
      // Not slim → the CLI loads settings itself; no injection.
      _resetUserSettingsEnvCacheForTesting();
      const plain = await run({});
      expect(plain.spawnOpts.env?.WALNUT_TEST_BEDROCK_FLAG).toBeUndefined();
    } finally {
      settingsJsonRef.value = null;
      _resetUserSettingsEnvCacheForTesting();
    }
  });
});
