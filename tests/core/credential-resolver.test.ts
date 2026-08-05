import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveCredentialFrom,
  readClaudeSettingsEnv,
  readClaudeCredentialExport,
  DEFAULT_REGION,
  type ResolveInputs,
} from '../../src/core/credential-resolver.js';
import type { Config } from '../../src/core/types.js';

// Minimal Config shell — only the fields the resolver reads matter.
function baseConfig(over: Partial<Config> = {}): Config {
  return {
    version: 1,
    user: {},
    defaults: { priority: 'none' },
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

describe('resolveCredentialFrom — awsCredentialExport (credential_process)', () => {
  it('settings.json awsCredentialExport is used when no env-block creds exist', () => {
    const r = resolveCredentialFrom(inputs({
      claudeCredentialExport: 'my-export-cmd',
    }));
    expect(r.source).toBe('claude-settings');
    expect(r.method).toBe('credential_process');
    expect(r.credentialExportCmd).toBe('my-export-cmd');
  });

  it('env-block static creds still WIN over awsCredentialExport (no regression)', () => {
    const r = resolveCredentialFrom(inputs({
      claudeEnv: { AWS_BEARER_TOKEN_BEDROCK: 'settings-tok' },
      claudeCredentialExport: 'my-export-cmd',
    }));
    expect(r.method).toBe('bearer_token');
    expect(r.bearerToken).toBe('settings-tok');
  });

  it('process.env static creds also win over awsCredentialExport', () => {
    const r = resolveCredentialFrom(inputs({
      processEnv: { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' },
      claudeCredentialExport: 'my-export-cmd',
    }));
    expect(r.method).toBe('access_keys');
  });

  it('awsCredentialExport beats the bare ~/.aws chain', () => {
    const r = resolveCredentialFrom(inputs({
      claudeCredentialExport: 'my-export-cmd',
      awsFiles: { credentials: true, config: true },
    }));
    expect(r.method).toBe('credential_process');
    expect(r.credentialExportCmd).toBe('my-export-cmd');
  });

  it('config.providers.bedrock.aws_credential_export is honored', () => {
    const r = resolveCredentialFrom(inputs({
      config: baseConfig({ providers: { bedrock: { api: 'bedrock', aws_credential_export: 'cfg-cmd' } } }),
    }));
    expect(r.source).toBe('config');
    expect(r.method).toBe('credential_process');
    expect(r.credentialExportCmd).toBe('cfg-cmd');
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

describe('readClaudeCredentialExport', () => {
  const tmp = path.join(os.tmpdir(), `walnut-credexp-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  afterEach(() => { try { fs.rmSync(tmp); } catch { /* ignore */ } });

  it('returns undefined when the file does not exist', () => {
    expect(readClaudeCredentialExport(path.join(os.tmpdir(), 'missing-xyz.json'))).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    fs.writeFileSync(tmp, '{ not json');
    expect(readClaudeCredentialExport(tmp)).toBeUndefined();
  });

  it('reads the top-level awsCredentialExport command', () => {
    fs.writeFileSync(tmp, JSON.stringify({
      env: { AWS_REGION: 'us-west-2' },
      awsCredentialExport: '"/path/to/claude" default-credential-export',
    }));
    expect(readClaudeCredentialExport(tmp)).toBe('"/path/to/claude" default-credential-export');
  });

  it('returns undefined when awsCredentialExport is absent or blank', () => {
    fs.writeFileSync(tmp, JSON.stringify({ awsCredentialExport: '   ' }));
    expect(readClaudeCredentialExport(tmp)).toBeUndefined();
  });
});

describe('traceCredentialResolution — step-by-step transparency', () => {
  it('marks the winning rung "won", earlier rungs "empty", later rungs "not-reached"', async () => {
    const { traceCredentialResolution } = await import('../../src/core/credential-resolver.js');
    // process.env (rung 3) wins; rungs 1-2 empty; rungs 4-5 not reached.
    const trace = traceCredentialResolution(inputs({
      processEnv: { AWS_BEARER_TOKEN_BEDROCK: 'tok-abcd1234' },
      awsFiles: { credentials: true, config: true },
    }));
    expect(trace.steps).toHaveLength(5);
    expect(trace.steps.map(s => s.outcome)).toEqual(['empty', 'empty', 'won', 'not-reached', 'not-reached']);
    expect(trace.winner.source).toBe('env');
    expect(trace.winner.method).toBe('bearer_token');
  });

  it('never leaks full key material — only a masked tail', async () => {
    const { traceCredentialResolution } = await import('../../src/core/credential-resolver.js');
    // Deliberately NOT AKIA-prefixed: the pre-commit secret scanner would flag a
    // realistic-looking access key even in test data. Masking only needs the tail.
    const secret = 'WALNUTFAKEIOSFODNN7EXAMPLE';
    const trace = traceCredentialResolution(inputs({
      processEnv: { AWS_ACCESS_KEY_ID: secret, AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG' },
    }));
    const dump = JSON.stringify(trace);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain('wJalrXUtnFEMI');
    expect(trace.winner.keyHint).toBe('…MPLE');
  });

  it('labels each rung with its owner (walnut / claude-code / shell-env / aws-cli)', async () => {
    const { traceCredentialResolution } = await import('../../src/core/credential-resolver.js');
    const trace = traceCredentialResolution(inputs());
    expect(trace.steps.map(s => s.owner)).toEqual(
      ['walnut', 'claude-code', 'shell-env', 'claude-code', 'aws-cli'],
    );
  });

  it('falls through to the ~/.aws existence rung and flags that contents are unvalidated', async () => {
    const { traceCredentialResolution } = await import('../../src/core/credential-resolver.js');
    const trace = traceCredentialResolution(inputs({ awsFiles: { credentials: true, config: false } }));
    const last = trace.steps[4];
    expect(last.outcome).toBe('won');
    expect(last.source).toBe('aws-files');
    expect(last.checkedFor.join(' ')).toMatch(/NOT validated/);
    expect(trace.winner.method).toBe('aws_chain');
  });

  it('reports region provenance independently of the credential winner', async () => {
    const { traceCredentialResolution } = await import('../../src/core/credential-resolver.js');
    const trace = traceCredentialResolution(inputs({
      config: baseConfig({ providers: { bedrock: { api: 'bedrock', region: 'eu-west-1' } } } as Partial<Config>),
      processEnv: { AWS_BEARER_TOKEN_BEDROCK: 'tok-1234' },
    }));
    expect(trace.region.value).toBe('eu-west-1');
    expect(trace.region.source).toContain('config.yaml');
    expect(trace.winner.source).toBe('env');
  });

  it('trace winner always agrees with resolveCredentialFrom', async () => {
    const { traceCredentialResolution } = await import('../../src/core/credential-resolver.js');
    const cases: Partial<ResolveInputs>[] = [
      {},
      { processEnv: { AWS_PROFILE: 'walnut-dev' } },
      { claudeEnv: { AWS_BEARER_TOKEN_BEDROCK: 'x' } },
      { claudeCredentialExport: 'ada credentials print' },
      { awsFiles: { credentials: true, config: true } },
    ];
    for (const over of cases) {
      const inp = inputs(over);
      const resolved = resolveCredentialFrom(inp);
      const trace = traceCredentialResolution(inp);
      expect(trace.winner.source).toBe(resolved.source);
      expect(trace.winner.method).toBe(resolved.method);
    }
  });
});
