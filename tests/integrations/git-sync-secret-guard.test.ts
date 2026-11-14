/** The shared credential detector still refuses secrets in outbound letters. */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-secretguard-test'));

import {
  findSecretsInText,
  findSecretsInTextAsync,
  secretPathKind,
} from '../../src/integrations/git-sync-secrets.js';

// ── Fake credentials, built at runtime ─────────────────────────────────────

let seed = 0x5eed;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function randFrom(alphabet: string, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64URL = ALNUM + '-_';
const fake = {
  github: () => ['gh', 'p_', randFrom(ALNUM, 36)].join(''),
  aws: () => ['AK', 'IA', randFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)].join(''),
  google: () => ['AI', 'za', randFrom(B64URL, 35)].join(''),
  slack: () => ['xo', 'xb-', randFrom('0123456789', 12), '-', randFrom('0123456789', 12), '-', randFrom(ALNUM, 24)].join(''),
  pem: () => ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----\n', randFrom(ALNUM + '+/', 64), '\n-----END RSA PRIVATE KEY-----'].join(''),
  opaque: (n = 120) => randFrom(ALNUM + '-_.', n),
  jwt: () => ['ey', 'J', randFrom(B64URL, 30), '.ey', 'J', randFrom(B64URL, 60), '.', randFrom(B64URL, 43)].join(''),
};

/** The shape of the file that leaked: the MSAL cache is JSON stored as a string inside JSON. */
function msalCacheFile(): string {
  const inner = JSON.stringify({
    AccessToken: { k: { credential_type: 'AccessToken', secret: fake.opaque(1400) } },
    RefreshToken: { k: { credential_type: 'RefreshToken', secret: fake.opaque(390) } },
  });
  return JSON.stringify({ accessToken: fake.opaque(1400), expiresAt: '2026-07-25T17:55:18.000Z', msalCache: inner }, null, 2);
}

// ── Rules ────────────────────────────────────────────────────────────────────

describe('findSecretsInText', () => {
  it('finds each kind of credential, by kind and line, never by value', () => {
    const cases: Array<[string, string]> = [
      ['github-token', `token = ${fake.github()}`],
      ['aws-access-key', `key: ${fake.aws()}`],
      ['google-api-key', `"key": "${fake.google()}"`],
      ['slack-token', `SLACK=${fake.slack()}`],
      ['private-key', fake.pem()],
      ['oauth-token-field', `{"refresh_token": "${fake.opaque(80)}"}`],
      ['jwt', `Authorization: Bearer ${fake.jwt()}`],
      ['url-credentials', `origin https://walnut:${randFrom('0123456789abcdef', 32)}@hub.example.net/git/data`],
    ];
    for (const [kind, text] of cases) {
      const found = findSecretsInText(`line one\n${text}\n`);
      expect(found, kind).toContainEqual({ kind, line: 2 });
      expect(JSON.stringify(found)).not.toContain(text.slice(-20));
    }
  });

  it('finds the leaked MSAL cache shape, escaped quotes and all', () => {
    const kinds = findSecretsInText(msalCacheFile()).map((f) => f.kind);
    expect(kinds).toContain('msal-credential');
    expect(kinds).toContain('oauth-token-field');
  });

  it('leaves placeholders, references and low-entropy text alone', () => {
    const benign = [
      `aws key ${['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('')} from the docs`,
      `"access_token": "\${ACCESS_TOKEN_FROM_ENV_VARIABLE_PLEASE_SET}"`,
      `"refresh_token": "${'a'.repeat(60)}"`,
      'https://walnut:<device-token>@example.net/git/data',
      'https://user:password@host',
      ['xo', 'xb-000000000000-000000000000-', 'x'.repeat(24)].join(''),
      'function accessToken() { return cache.accessToken }',
      'the words PRIVATE KEY in prose',
    ];
    for (const text of benign) expect(findSecretsInText(text), text).toEqual([]);
  });

  it('names credential stores by path', () => {
    expect(secretPathKind('.env')).toBe('env-file');
    expect(secretPathKind('notes/app/.env.local')).toBe('env-file');
    expect(secretPathKind('notes/app/.env.example')).toBeNull();
    expect(secretPathKind('keys/id_ed25519')).toBe('ssh-key');
    expect(secretPathKind('a/store.p12')).toBe('key-store');
    expect(secretPathKind('notes/env.md')).toBeNull();
    expect(secretPathKind('notes/keys.md')).toBeNull();
  });

  it('finds Slack tokens of the newer formats and a bearer token', () => {
    const rotating = ['xo', 'xe.xo', 'xp-1-', randFrom(ALNUM, 40)].join('');
    expect(findSecretsInText(rotating).map((f) => f.kind)).toEqual(['slack-token']);
    expect(findSecretsInText(`-H "Authorization: Bearer ${fake.opaque(48)}"`).map((f) => f.kind)).toContain('bearer-token');
    expect(findSecretsInText('-H "Authorization: Bearer $TOKEN"')).toEqual([]);
  });

  it('scans text of any size in slices, a credential on a slice edge included', async () => {
    const key = fake.github();
    const filler = 'x'.repeat(256 * 1024 - 11) + ' ';
    expect(await findSecretsInTextAsync(`${filler}${key}\nmore\n`)).toEqual([{ kind: 'github-token', line: 1 }]);
    const lines = Array.from({ length: 30000 }, (_, i) => `line ${i} of a long transcript`);
    lines[25000] = `token ${key}`;
    expect(await findSecretsInTextAsync(lines.join('\n'))).toEqual([{ kind: 'github-token', line: 25001 }]);
  });
});
