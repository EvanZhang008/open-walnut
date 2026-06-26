import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveCredentialFrom,
  readClaudeSettingsEnv,
  DEFAULT_REGION,
  type ResolveInputs,
} from '../../src/core/credential-resolver.js';
import type { Config } from '../../src/core/types.js';

// Minimal Config shell — only the fields the resolver reads matter.
function baseConfig(over: Partial<Config> = {}): Config {
  return {
    version: 1,
    user: {},
    defaults: { priority: 'none', category: 'personal' },
    provider: { type: 'claude-code' },
    ...over,
  } as Config;
}

function inputs(over: Partial<ResolveInputs> = {}): ResolveInputs {
  return {
    config: baseConfig(),
    claudeEnv: {},
    processEnv: {},
    awsFiles: { credentials: false, config: false },
    ...over,
  };
}

describe('resolveCredentialFrom — priority chain', () => {
  it('returns source=none when nothing is available', () => {
    const r = resolveCredentialFrom(inputs());
    expect(r.source).toBe('none');
    expect(r.method).toBeNull();
  });

  it('config.yaml bearer token wins over everything', () => {
    const r = resolveCredentialFrom(inputs({
      config: baseConfig({ providers: { bedrock: { api: 'bedrock', bearer_token: 'cfg-tok' } } }),
      claudeEnv: { AWS_BEARER_TOKEN_BEDROCK: 'settings-tok' },
      processEnv: { AWS_BEARER_TOKEN_BEDROCK: 'env-tok' },
      awsFiles: { credentials: true, config: true },
    }));
    expect(r.source).toBe('config');
    expect(r.method).toBe('bearer_token');
    expect(r.bearerToken).toBe('cfg-tok');
  });

  it('legacy config.provider.bedrock_bearer_token is honored', () => {
    const r = resolveCredentialFrom(inputs({
      config: baseConfig({ provider: { type: 'claude-code', bedrock_bearer_token: 'legacy-tok' } }),
    }));
    expect(r.source).toBe('config');
    expect(r.bearerToken).toBe('legacy-tok');
  });

  it('claude settings.json env beats process.env and ~/.aws', () => {
    const r = resolveCredentialFrom(inputs({
      claudeEnv: { AWS_BEARER_TOKEN_BEDROCK: 'settings-tok' },
      processEnv: { AWS_BEARER_TOKEN_BEDROCK: 'env-tok' },
      awsFiles: { credentials: true, config: true },
    }));
    expect(r.source).toBe('claude-settings');
    expect(r.bearerToken).toBe('settings-tok');
  });

  it('process.env beats ~/.aws when settings.json is empty', () => {
    const r = resolveCredentialFrom(inputs({
      processEnv: { AWS_BEARER_TOKEN_BEDROCK: 'env-tok' },
      awsFiles: { credentials: true, config: false },
    }));
    expect(r.source).toBe('env');
    expect(r.method).toBe('bearer_token');
  });

  it('falls back to aws-files / default credential chain', () => {
    const r = resolveCredentialFrom(inputs({ awsFiles: { credentials: true, config: false } }));
    expect(r.source).toBe('aws-files');
    expect(r.method).toBe('aws_chain');
    expect(r.detail).toContain('credentials');
  });

  it('~/.aws/config alone also counts', () => {
    const r = resolveCredentialFrom(inputs({ awsFiles: { credentials: false, config: true } }));
    expect(r.source).toBe('aws-files');
    expect(r.detail).toContain('config');
  });
});

describe('resolveCredentialFrom — auth method extraction within a source', () => {
  it('bearer token preferred over access keys preferred over profile', () => {
    const r = resolveCredentialFrom(inputs({
      processEnv: {
        AWS_BEARER_TOKEN_BEDROCK: 'tok',
        AWS_ACCESS_KEY_ID: 'AKIA',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_PROFILE: 'dev',
      },
    }));
    expect(r.method).toBe('bearer_token');
  });

  it('access keys when no bearer token', () => {
    const r = resolveCredentialFrom(inputs({
      processEnv: { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' },
    }));
    expect(r.method).toBe('access_keys');
    expect(r.accessKeyId).toBe('AKIA');
    expect(r.secretAccessKey).toBe('secret');
  });

  it('profile when only AWS_PROFILE is set', () => {
    const r = resolveCredentialFrom(inputs({ processEnv: { AWS_PROFILE: 'dev' } }));
    expect(r.method).toBe('profile');
    expect(r.profile).toBe('dev');
    expect(r.detail).toContain('dev');
  });

  it('lone access key (no secret) is not usable', () => {
    const r = resolveCredentialFrom(inputs({ processEnv: { AWS_ACCESS_KEY_ID: 'AKIA' } }));
    expect(r.source).toBe('none');
  });
});

describe('resolveCredentialFrom — region resolution', () => {
  it('defaults to DEFAULT_REGION when nothing sets it', () => {
    const r = resolveCredentialFrom(inputs({ processEnv: { AWS_BEARER_TOKEN_BEDROCK: 'tok' } }));
    expect(r.region).toBe(DEFAULT_REGION);
  });

  it('config region applies even when the key comes from a lower source', () => {
    const r = resolveCredentialFrom(inputs({
      config: baseConfig({ providers: { bedrock: { api: 'bedrock', region: 'eu-central-1' } } }),
      processEnv: { AWS_BEARER_TOKEN_BEDROCK: 'env-tok' },
    }));
    expect(r.source).toBe('env');       // key from env
    expect(r.region).toBe('eu-central-1'); // region still from config
  });

  it('AWS_REGION from settings.json applies', () => {
    const r = resolveCredentialFrom(inputs({
      claudeEnv: { AWS_BEARER_TOKEN_BEDROCK: 'tok', AWS_REGION: 'ap-southeast-2' },
    }));
    expect(r.region).toBe('ap-southeast-2');
  });

  it('AWS_DEFAULT_REGION is a fallback for AWS_REGION', () => {
    const r = resolveCredentialFrom(inputs({
      processEnv: { AWS_BEARER_TOKEN_BEDROCK: 'tok', AWS_DEFAULT_REGION: 'us-east-1' },
    }));
    expect(r.region).toBe('us-east-1');
  });
});

describe('readClaudeSettingsEnv', () => {
  const tmp = path.join(os.tmpdir(), `walnut-cred-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  afterEach(() => { try { fs.rmSync(tmp); } catch { /* ignore */ } });

  it('returns {} when the file does not exist', () => {
    expect(readClaudeSettingsEnv(path.join(os.tmpdir(), 'definitely-missing-xyz.json'))).toEqual({});
  });

  it('returns {} for malformed JSON', () => {
    fs.writeFileSync(tmp, '{ not json');
    expect(readClaudeSettingsEnv(tmp)).toEqual({});
  });

  it('extracts only string values from the env block', () => {
    fs.writeFileSync(tmp, JSON.stringify({
      env: { AWS_BEARER_TOKEN_BEDROCK: 'tok', AWS_REGION: 'us-west-2', NUMBER: 5, NESTED: { a: 1 } },
      other: 'ignored',
    }));
    expect(readClaudeSettingsEnv(tmp)).toEqual({ AWS_BEARER_TOKEN_BEDROCK: 'tok', AWS_REGION: 'us-west-2' });
  });

  it('returns {} when there is no env block', () => {
    fs.writeFileSync(tmp, JSON.stringify({ enabledPlugins: { 'foo@bar': true } }));
    expect(readClaudeSettingsEnv(tmp)).toEqual({});
  });
});
