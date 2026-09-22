/**
 * Jev decision client — contract pinned:
 *   - unconfigured (no section / no key / unresolvable reference) → no client
 *   - decide() posts state+questions to the endpoint (default first-party,
 *     trailing slash trimmed) with Bearer auth and returns the answers map
 *   - non-OK / missing answers → throws (callers fall back to their old path)
 *   - every successful call records usage (source 'jev'); a failing usage
 *     write never fails the decision
 *   - ${file:} secrets resolve trimmed; jev.api_key is masked by redactConfig
 *
 * Real: client, secret resolution, redaction. Fake: fetch, usage tracker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-jev-client'));
const recordMock = vi.fn();
vi.mock('../../src/core/usage/index.js', () => ({
  usageTracker: { record: (...args: unknown[]) => recordMock(...args) },
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { getJevClient, readChoice } from '../../src/core/decision/jev-client.js';
import { resolveSecret } from '../../src/model/providers/secret.js';
import { redactConfig } from '../../src/core/config-redact.js';
import type { Config } from '../../src/core/types.js';

const fetchMock = vi.fn();

function cfg(jev?: Config['jev']): Config {
  return { version: 1, user: {}, defaults: { priority: 'backlog' }, jev } as Config;
}

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const CHOICE_ANSWER = {
  model: 'jev-1.13.0',
  answers: {
    pick: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 },
  },
  usage: { input_tokens: 100, output_tokens: 7 },
};

beforeEach(() => {
  fetchMock.mockReset();
  recordMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getJevClient availability', () => {
  it('returns undefined without a jev section', () => {
    expect(getJevClient(cfg())).toBeUndefined();
  });

  it('returns undefined without an api_key', () => {
    expect(getJevClient(cfg({}))).toBeUndefined();
  });

  it('returns undefined when the key reference resolves to nothing', () => {
    expect(getJevClient(cfg({ api_key: '${env:JEV_TEST_UNSET_VAR}' }))).toBeUndefined();
    expect(getJevClient(cfg({ api_key: '${file:/nonexistent/jev.key}' }))).toBeUndefined();
  });
});

describe('decide', () => {
  it('posts to the first-party endpoint by default with Bearer auth', async () => {
    fetchMock.mockResolvedValue(okResponse(CHOICE_ANSWER));
    const client = getJevClient(cfg({ api_key: 'test-key-value' }))!;

    const answers = await client.decide('some state', {
      pick: { type: 'choice', instructions: 'pick one', criteria: { a: 'A', b: 'B' } },
    });

    expect(answers.pick).toMatchObject({ type: 'choice', choice: 'a', confidence: 0.8 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key-value');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'jev-latest', state: 'some state' });
    expect(body.questions.pick.type).toBe('choice');
  });

  it('honors custom endpoint (trailing slash trimmed) and model', async () => {
    fetchMock.mockResolvedValue(okResponse(CHOICE_ANSWER));
    const client = getJevClient(cfg({
      api_key: 'k',
      endpoint: 'https://gateway.example.com/api/alpha/decisions/',
      model: 'typesafe/jev-1.13',
    }))!;

    await client.decide('s', { pick: { type: 'noul', instructions: 'true?' } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example.com/api/alpha/decisions');
    expect(JSON.parse(init.body as string).model).toBe('typesafe/jev-1.13');
  });

  it('throws on non-OK with the status and a truncated body', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 429, statusText: 'Too Many Requests',
      text: async () => 'rate limited '.repeat(100),
    });
    const client = getJevClient(cfg({ api_key: 'k' }))!;

    await expect(client.decide('s', { q: { type: 'noul', instructions: 'x' } }))
      .rejects.toThrow(/Jev 429/);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('throws when the response has no answers object', async () => {
    fetchMock.mockResolvedValue(okResponse({ model: 'jev-1.13.0' }));
    const client = getJevClient(cfg({ api_key: 'k' }))!;

    await expect(client.decide('s', { q: { type: 'noul', instructions: 'x' } }))
      .rejects.toThrow(/no answers/);
  });

  it('records usage with the server-reported model and attribution ids', async () => {
    fetchMock.mockResolvedValue(okResponse(CHOICE_ANSWER));
    const client = getJevClient(cfg({ api_key: 'k' }))!;

    await client.decide('s', { pick: { type: 'noul', instructions: 'x' } }, { taskId: 't-1' });

    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'jev',
      model: 'jev-1.13.0',
      input_tokens: 100,
      output_tokens: 7,
      taskId: 't-1',
    }));
  });

  it('still returns the answers when the usage write throws', async () => {
    fetchMock.mockResolvedValue(okResponse(CHOICE_ANSWER));
    recordMock.mockImplementation(() => { throw new Error('db locked'); });
    const client = getJevClient(cfg({ api_key: 'k' }))!;

    const answers = await client.decide('s', { pick: { type: 'noul', instructions: 'x' } });
    expect(answers.pick).toBeDefined();
  });
});

describe('${file:} secret references (confined to <walnut-home>/secrets/)', () => {
  const secretsDir = path.join(WALNUT_HOME, 'secrets');
  beforeEach(() => { fs.mkdirSync(secretsDir, { recursive: true }); });

  it('reads the key from a secrets-dir file, trimmed of the trailing newline', () => {
    const file = path.join(secretsDir, 'api.key');
    fs.writeFileSync(file, 'file-key-value\n');
    expect(resolveSecret(`\${file:${file}}`)).toBe('file-key-value');
  });

  it('resolves an empty or missing file to undefined', () => {
    const empty = path.join(secretsDir, 'empty.key');
    fs.writeFileSync(empty, '\n');
    expect(resolveSecret(`\${file:${empty}}`)).toBeUndefined();
    expect(resolveSecret(`\${file:${path.join(secretsDir, 'missing.key')}}`)).toBeUndefined();
  });

  it('rejects paths outside the secrets dir (config is API-writable; unconfined ${file:} would be an arbitrary-file read)', () => {
    const outside = path.join(WALNUT_HOME, 'not-a-secret.txt');
    fs.writeFileSync(outside, 'leak-me');
    expect(resolveSecret(`\${file:${outside}}`)).toBeUndefined();
    expect(resolveSecret('${file:/etc/hosts}')).toBeUndefined();
    // Traversal back out of the secrets dir is a plain path once resolved.
    expect(resolveSecret(`\${file:${secretsDir}/../not-a-secret.txt}`)).toBeUndefined();
  });

  it('rejects ~user paths instead of silently resolving them under $HOME', () => {
    expect(resolveSecret('${file:~nobody/secrets/api.key}')).toBeUndefined();
  });

  it('feeds the file key into the Authorization header', async () => {
    const file = path.join(secretsDir, 'auth-header.key');
    fs.writeFileSync(file, 'from-file\n');
    fetchMock.mockResolvedValue(okResponse(CHOICE_ANSWER));
    const client = getJevClient(cfg({ api_key: `\${file:${file}}` }))!;

    await client.decide('s', { q: { type: 'noul', instructions: 'x' } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer from-file');
  });
});

describe('readChoice (wire-shape validation)', () => {
  it('accepts a well-formed choice', () => {
    expect(readChoice({ type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 0.9 }))
      .toEqual({ choice: 'a', confidence: 0.9 });
  });

  it('rejects a missing or non-numeric confidence (fail closed, never fail open)', () => {
    expect(readChoice({ type: 'choice', choice: 'a' })).toBeUndefined();
    expect(readChoice({ type: 'choice', choice: 'a', confidence: '0.9' })).toBeUndefined();
    expect(readChoice({ type: 'choice', choice: 'a', confidence: NaN })).toBeUndefined();
  });

  it('rejects wrong types and non-choice answers', () => {
    expect(readChoice(undefined)).toBeUndefined();
    expect(readChoice({ type: 'noul', noul: 0.5 })).toBeUndefined();
    expect(readChoice({ type: 'choice', choice: 42, confidence: 0.9 })).toBeUndefined();
  });
});

describe('shared OpenRouter provider credential', () => {
  const OR = 'https://openrouter.ai/api/alpha/decisions';
  function cfgShared(jev: Config['jev'], providerKey?: string): Config {
    return {
      ...cfg(jev),
      providers: providerKey ? { openrouter: { api: 'openai-chat', api_key: providerKey } } : {},
    } as Config;
  }

  it('an OpenRouter endpoint rides providers.openrouter.api_key when jev has no own key', async () => {
    fetchMock.mockResolvedValue(okResponse(CHOICE_ANSWER));
    const client = getJevClient(cfgShared({ endpoint: OR }, 'shared-key'));
    expect(client).toBeDefined();
    await client!.decide('s', {});
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer shared-key');
  });

  it('jev.api_key overrides the shared credential', async () => {
    fetchMock.mockResolvedValue(okResponse(CHOICE_ANSWER));
    const client = getJevClient(cfgShared({ endpoint: OR, api_key: 'own-key' }, 'shared-key'));
    await client!.decide('s', {});
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer own-key');
  });

  it('a non-OpenRouter endpoint never borrows the OpenRouter key', () => {
    // First-party TypeSafe endpoint + only a shared OpenRouter key = NOT
    // configured. Sending an OpenRouter credential to another host would
    // leak it to the wrong party.
    expect(getJevClient(cfgShared({}, 'shared-key'))).toBeUndefined();
    expect(getJevClient(cfgShared({ endpoint: 'https://api.typesafe.ai/v1/systemone' }, 'shared-key'))).toBeUndefined();
  });

  it('absent jev section stays unconfigured even with a shared key (the section is the opt-in)', () => {
    expect(getJevClient(cfgShared(undefined, 'shared-key'))).toBeUndefined();
  });

  it('falls back to OPENROUTER_API_KEY from the environment for an OpenRouter endpoint', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'env-key');
    fetchMock.mockResolvedValue(okResponse(CHOICE_ANSWER));
    const client = getJevClient(cfgShared({ endpoint: OR }));
    expect(client).toBeDefined();
    await client!.decide('s', {});
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer env-key');
    vi.unstubAllEnvs();
  });
});

describe('client identity', () => {
  it('exposes the model the requests will carry', () => {
    expect(getJevClient(cfg({ api_key: 'k-model-test' }))!.model).toBe('jev-latest');
    expect(getJevClient(cfg({ api_key: 'k-model-test2', model: 'typesafe/jev-1.13' }))!.model).toBe('typesafe/jev-1.13');
  });

  it('treats non-string config values as unset instead of throwing', () => {
    expect(getJevClient(cfg({ api_key: 8080 as unknown as string }))).toBeUndefined();
    const client = getJevClient(cfg({ api_key: 'k-nonstring', endpoint: 8080 as unknown as string, model: 7 as unknown as string }));
    expect(client!.model).toBe('jev-latest');
  });
});

describe('config redaction', () => {
  it('masks jev.api_key before config leaves the box', () => {
    const redacted = redactConfig({ jev: { api_key: 'sk-test-1234567890abcd', model: 'jev-latest' } }) as {
      jev: { api_key: string; model: string };
    };
    expect(redacted.jev.api_key).not.toContain('sk-test');
    expect(redacted.jev.api_key).toMatch(/^••••/);
    expect(redacted.jev.model).toBe('jev-latest');
  });
});
