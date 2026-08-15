import { describe, it, expect } from 'vitest';
import { CredentialProcessCache, runCredentialProcess, type ProcessCredentials } from '../../src/core/aws-credential-process.js';

/** Build a fake runner that hands out a fresh cred each call, tracking call count. */
function fakeRunner(makeExpiration: (call: number) => string | undefined) {
  let calls = 0;
  const runner = async (): Promise<ProcessCredentials> => {
    calls += 1;
    return {
      accessKeyId: `AKIA${calls}`,
      secretAccessKey: `secret${calls}`,
      sessionToken: `token${calls}`,
      expiration: makeExpiration(calls),
    };
  };
  return { runner, calls: () => calls };
}

describe('CredentialProcessCache — lazy TTL refresh', () => {
  it('reuses the cached credential within its lifetime (does NOT re-run per call)', async () => {
    let clock = 1_000_000;
    // 60-min expiry, like real temp creds.
    const { runner, calls } = fakeRunner(() => new Date(clock + 60 * 60 * 1000).toISOString());
    const cache = new CredentialProcessCache('cmd', runner, () => clock);

    const a = await cache.get();
    const b = await cache.get();
    const c = await cache.get();
    expect(calls()).toBe(1);            // one command run, three reads
    expect(a.accessKeyId).toBe('AKIA1');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('re-runs the command once the refresh margin is crossed (near expiry)', async () => {
    let clock = 1_000_000;
    const { runner, calls } = fakeRunner(() => new Date(clock + 60 * 60 * 1000).toISOString());
    const cache = new CredentialProcessCache('cmd', runner, () => clock);

    const first = await cache.get();
    expect(first.accessKeyId).toBe('AKIA1');

    // Jump to 56 min later — within the 5-min refresh margin of the 60-min expiry.
    clock += 56 * 60 * 1000;
    const second = await cache.get();
    expect(calls()).toBe(2);            // refreshed
    expect(second.accessKeyId).toBe('AKIA2');
  });

  it('falls back to a default TTL when the command reports no Expiration', async () => {
    let clock = 1_000_000;
    const { runner, calls } = fakeRunner(() => undefined);   // no Expiration
    const cache = new CredentialProcessCache('cmd', runner, () => clock);

    await cache.get();
    expect(calls()).toBe(1);
    // Still within default TTL (15 min) → reuse.
    clock += 10 * 60 * 1000;
    await cache.get();
    expect(calls()).toBe(1);
    // Past default TTL → refresh.
    clock += 10 * 60 * 1000;
    await cache.get();
    expect(calls()).toBe(2);
  });

  it('reset() forces a fresh run on the next get() (e.g. after a 403)', async () => {
    let clock = 1_000_000;
    const { runner, calls } = fakeRunner(() => new Date(clock + 60 * 60 * 1000).toISOString());
    const cache = new CredentialProcessCache('cmd', runner, () => clock);

    await cache.get();
    expect(calls()).toBe(1);
    cache.reset();
    await cache.get();
    expect(calls()).toBe(2);
  });

  it('concurrent get() calls share a single command invocation', async () => {
    let clock = 1_000_000;
    let calls = 0;
    let release!: (c: ProcessCredentials) => void;
    const gate = new Promise<ProcessCredentials>((r) => { release = r; });
    const runner = async () => { calls += 1; return gate; };
    const cache = new CredentialProcessCache('cmd', runner, () => clock);

    const p1 = cache.get();
    const p2 = cache.get();
    release({ accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'tok', expiration: new Date(clock + 3_600_000).toISOString() });
    const [a, b] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);   // both awaited the same in-flight run
    expect(a).toBe(b);
  });
});

describe('runCredentialProcess — real command execution', () => {
  it('parses a valid Credentials JSON payload from a shell command', async () => {
    const json = JSON.stringify({
      Credentials: {
        AccessKeyId: 'ASIA_TEST', SecretAccessKey: 'sec', SessionToken: 'sess',
        Expiration: '2099-01-01T00:00:00Z',
      },
    }).replace(/'/g, "'\\''");
    const creds = await runCredentialProcess(`printf '%s' '${json}'`);
    expect(creds.accessKeyId).toBe('ASIA_TEST');
    expect(creds.secretAccessKey).toBe('sec');
    expect(creds.sessionToken).toBe('sess');
    expect(creds.expiration).toBe('2099-01-01T00:00:00Z');
  });

  // The AWS-documented credential_process protocol is FLAT (Version + the fields
  // at the top level) — that's what SSO/ada-style helpers emit. Rejecting it made
  // the Personal AI fall through to expired ~/.aws creds and 403 for 18h (2026-07-26).
  it('parses the standard FLAT credential_process payload (Version at top level)', async () => {
    const json = JSON.stringify({
      Version: 1,
      AccessKeyId: 'ASIA_FLAT', SecretAccessKey: 'flatsec', SessionToken: 'flatsess',
      Expiration: '2099-06-01T00:00:00Z',
    }).replace(/'/g, "'\\''");
    const creds = await runCredentialProcess(`printf '%s' '${json}'`);
    expect(creds.accessKeyId).toBe('ASIA_FLAT');
    expect(creds.secretAccessKey).toBe('flatsec');
    expect(creds.sessionToken).toBe('flatsess');
    expect(creds.expiration).toBe('2099-06-01T00:00:00Z');
  });

  it('prefers the nested Credentials object when BOTH shapes are present', async () => {
    const json = JSON.stringify({
      AccessKeyId: 'ASIA_ROOT', SecretAccessKey: 'rootsec',
      Credentials: { AccessKeyId: 'ASIA_NESTED', SecretAccessKey: 'nestedsec' },
    }).replace(/'/g, "'\\''");
    const creds = await runCredentialProcess(`printf '%s' '${json}'`);
    expect(creds.accessKeyId).toBe('ASIA_NESTED');
    expect(creds.secretAccessKey).toBe('nestedsec');
  });

  it('rejects with a clear error when the command fails (SSO expired → honest error, not a hang)', async () => {
    await expect(runCredentialProcess('exit 7')).rejects.toThrow(/awsCredentialExport command failed/);
  });

  it('rejects when the command output is not valid JSON', async () => {
    await expect(runCredentialProcess("printf 'not json'")).rejects.toThrow(/did not return valid JSON/);
  });

  it('rejects when neither shape carries credentials, naming the keys it did get', async () => {
    await expect(runCredentialProcess(`printf '%s' '{"Foo":1}'`))
      .rejects.toThrow(/did not return AWS credentials.*Got keys: Foo/s);
  });
});
