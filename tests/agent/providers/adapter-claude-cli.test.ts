import { describe, it, expect } from 'vitest';
import type { AdapterCallOptions, Tool } from '../../../src/agent/providers/types.js';
import {
  buildArgs, buildSpawnEnv, serializePrompt, normalizeCliModel,
} from '../../../src/agent/providers/adapter-claude-cli.js';

/** Minimal AdapterCallOptions builder. */
function opts(over: Partial<AdapterCallOptions> = {}): AdapterCallOptions {
  return {
    providerConfig: { api: 'claude-cli' },
    model: 'default',
    maxTokens: 4096,
    system: 'You are the Personal AI.',
    messages: [{ role: 'user', content: 'hello' }],
    ...over,
  };
}

describe('buildArgs — text-only argv on the CLI\'s own login', () => {
  it('disables ALL tools via --tools "" (deny-all), NOT a wildcard', () => {
    const args = buildArgs(opts());
    const i = args.indexOf('--tools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('');                 // empty string = deny-all
    expect(args).not.toContain('--disallowedTools');
    expect(args).not.toContain('*');
  });

  it('does not override the user\'s settings (their auth, Bedrock or subscription, applies as-is)', () => {
    // The old --settings '{"env":{"CLAUDE_CODE_USE_BEDROCK":""}}' forced the
    // subscription and broke the provider for everyone whose Claude Code runs on Bedrock.
    expect(buildArgs(opts())).not.toContain('--settings');
  });

  it('NEVER uses --bare (that would force API-key-only)', () => {
    expect(buildArgs(opts())).not.toContain('--bare');
  });

  it('runs in print mode with stream-json output', () => {
    const args = buildArgs(opts());
    expect(args).toContain('-p');
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2))
      .toEqual(['--output-format', 'stream-json']);
    expect(args).toContain('--verbose');
  });

  it('passes the Personal AI persona via --system-prompt (replace)', () => {
    const args = buildArgs(opts({ system: 'You are Walnut.' }));
    const i = args.indexOf('--system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toContain('You are Walnut.');
  });

  it('forwards a real claude alias as --model but drops Bedrock/1m ids', () => {
    expect(buildArgs(opts({ model: 'haiku' })).includes('--model')).toBe(true);
    const bedrockArgs = buildArgs(opts({ model: 'global.anthropic.claude-opus-4-8' }));
    expect(bedrockArgs).not.toContain('--model');       // Bedrock id dropped
    const defaultArgs = buildArgs(opts({ model: 'default' }));
    expect(defaultArgs).not.toContain('--model');       // sentinel → subscription default
  });

  it('appends the pseudo-tool protocol to the system prompt when tools are requested', () => {
    const tools: Tool[] = [{ name: 'task_query', description: 'q', input_schema: { type: 'object' } }];
    const args = buildArgs(opts({ tools }));
    const sys = args[args.indexOf('--system-prompt') + 1];
    expect(sys).toContain('Tool protocol');
    expect(sys).toContain('task_query');           // schema embedded
    expect(sys).toContain('"tool_calls"');         // output contract stated
    // The CLI's OWN tools stay off regardless — protocol tools are executed by walnut.
    const i = args.indexOf('--tools');
    expect(args[i + 1]).toBe('');
  });
});

describe('buildSpawnEnv — the CLI keeps its own auth', () => {
  it('passes Bedrock/Anthropic auth through untouched and strips only the nested-session marker', () => {
    // A Bedrock-backed Claude Code (CLAUDE_CODE_USE_BEDROCK + AWS creds in the env) has to
    // stay Bedrock-backed inside the spawn, or the provider is unusable for that user.
    const base = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-secret',
      AWS_BEARER_TOKEN_BEDROCK: 'bearer-secret',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'wjalr',
      AWS_PROFILE: 'dev',
      AWS_REGION: 'us-west-2',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDECODE: '1',
    };
    const env = buildSpawnEnv(base);
    for (const k of [
      'ANTHROPIC_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'AWS_REGION', 'CLAUDE_CODE_USE_BEDROCK',
    ]) {
      expect(env[k], `${k} must reach the CLI`).toBe(base[k as keyof typeof base]);
    }
    expect(env.CLAUDECODE, 'the nested-session marker must not reach the child').toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('stamps the walnut-utility entrypoint so the import scan never lists these children', () => {
    const env = buildSpawnEnv({ PATH: '/usr/bin', CLAUDE_CODE_ENTRYPOINT: 'cli' });
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('walnut-utility');
  });

  it('does not mutate the source env object', () => {
    const base = { ANTHROPIC_API_KEY: 'sk-secret', PATH: '/x' };
    buildSpawnEnv(base);
    expect(base.ANTHROPIC_API_KEY).toBe('sk-secret');   // original untouched
  });

  it('COMPLIANCE: no credential VALUE ever appears in the argv', () => {
    // Even if the process env is polluted with secrets, argv must be clean.
    const args = buildArgs(opts());
    const joined = args.join(' ');
    for (const secret of ['sk-secret', 'AKIA', 'bearer-secret', 'tok-secret']) {
      expect(joined).not.toContain(secret);
    }
  });
});

describe('serializePrompt — Anthropic messages → plain text', () => {
  it('flattens a simple user turn', () => {
    expect(serializePrompt([{ role: 'user', content: 'hi there' }]))
      .toBe('User: hi there');
  });

  it('labels assistant and user turns for continuity', () => {
    const p = serializePrompt([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(p).toBe('User: q1\n\nAssistant: a1\n\nUser: q2');
  });

  it('flattens block content (text/tool_use/tool_result) into text', () => {
    const p = serializePrompt([{
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'tool_result', tool_use_id: 't1', content: 'result-data' },
      ],
    }] as any);
    expect(p).toContain('look at this');
    expect(p).toContain('result-data');
  });

  it('skips empty messages', () => {
    const p = serializePrompt([
      { role: 'user', content: '' },
      { role: 'user', content: 'real' },
    ]);
    expect(p).toBe('User: real');
  });
});

describe('normalizeCliModel', () => {
  it('accepts plain claude ids and short aliases', () => {
    expect(normalizeCliModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeCliModel('opus')).toBe('opus');
    expect(normalizeCliModel('sonnet')).toBe('sonnet');
    expect(normalizeCliModel('haiku')).toBe('haiku');
  });

  it('drops Bedrock/inference-profile ids', () => {
    expect(normalizeCliModel('global.anthropic.claude-opus-4-8')).toBeUndefined();
    expect(normalizeCliModel('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBeUndefined();
    expect(normalizeCliModel('apac.anthropic.claude-sonnet-4-6')).toBeUndefined();
  });

  it('strips the [1m] context marker', () => {
    expect(normalizeCliModel('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
  });

  it('drops the "default" sentinel (→ subscription default)', () => {
    expect(normalizeCliModel('default')).toBeUndefined();
    expect(normalizeCliModel(undefined)).toBeUndefined();
  });
});
