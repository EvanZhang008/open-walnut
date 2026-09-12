/**
 * Microsoft To-Do credential handling: automatic renewal, what a renewal
 * failure MEANS (dead refresh token vs. Microsoft not answering), what Settings
 * shows, and the device-code sign-in the Settings button starts.
 *
 * MSAL and the token file are mocked; nothing here touches the network or the
 * user's ~/.open-walnut.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── MSAL mock ──
const mockAcquireTokenSilent = vi.fn();
const mockAcquireTokenByDeviceCode = vi.fn();
const mockGetAllAccounts = vi.fn();
const mockSerialize = vi.fn().mockReturnValue('{"serialized":true}');
const mockDeserialize = vi.fn();

// vi.mock factories are hoisted above every other statement, so the class the
// mock exports has to be built inside vi.hoisted for the factory to see it.
const { FakeInteractionRequiredAuthError } = vi.hoisted(() => {
  class FakeInteractionRequiredAuthError extends Error {
    errorCode: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'InteractionRequiredAuthError';
      this.errorCode = code;
    }
  }
  return { FakeInteractionRequiredAuthError };
});

vi.mock('@azure/msal-node', () => ({
  InteractionRequiredAuthError: FakeInteractionRequiredAuthError,
  PublicClientApplication: vi.fn().mockImplementation(() => ({
    acquireTokenSilent: mockAcquireTokenSilent,
    acquireTokenByDeviceCode: mockAcquireTokenByDeviceCode,
    getTokenCache: () => ({
      getAllAccounts: mockGetAllAccounts,
      serialize: mockSerialize,
      deserialize: mockDeserialize,
    }),
  })),
}));

// ── Config mock: client_id present unless a test says otherwise ──
const mockGetConfig = vi.fn();
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

// ── Token file mock ──
const mockReadJsonFile = vi.fn();
const mockWriteJsonFile = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/utils/fs.js', () => ({
  readJsonFile: (...args: unknown[]) => mockReadJsonFile(...args),
  writeJsonFile: (...args: unknown[]) => mockWriteJsonFile(...args),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:https', () => ({
  default: { request: vi.fn() },
  request: vi.fn(),
}));

import {
  getAccessToken,
  getAuthStatus,
  beginSignIn,
  isSignInRequiredError,
  MsTodoAuthError,
  getMsTodoSyncStatus,
  _resetAuthMemoryForTesting,
} from '../../src/integrations/microsoft-todo.js';
import { pluginAuthFailureOf } from '../../src/core/integration-types.js';

const HOUR = 3600_000;

function configWith(clientId: string | undefined) {
  mockGetConfig.mockResolvedValue({
    version: 1, user: {}, defaults: { priority: 'none', project: 'personal' }, provider: { type: 'claude-code' },
    plugins: { 'ms-todo': clientId ? { client_id: clientId } : {} },
  });
}

/** What the token FILE holds: a cached access token with this many ms left (negative = expired), or nothing. */
function tokenFile(msLeft: number | null) {
  mockReadJsonFile.mockImplementation((p: string, dflt: unknown) => {
    if (typeof p === 'string' && p.includes('tokens')) {
      if (msLeft === null) return Promise.resolve(dflt);
      return Promise.resolve({
        accessToken: 'cached-token',
        expiresAt: new Date(Date.now() + msLeft).toISOString(),
        msalCache: '{"cache":true}',
      });
    }
    if (typeof p === 'string' && p.includes('delta')) return Promise.resolve({ deltaLinks: {}, listNames: {}, lastSync: '' });
    return Promise.resolve(dflt);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAuthMemoryForTesting();
  configWith('client-123');
  tokenFile(HOUR);
  mockGetAllAccounts.mockResolvedValue([{ username: 'evan@example.com' }]);
  mockAcquireTokenSilent.mockResolvedValue({ accessToken: 'fresh-token', expiresOn: new Date(Date.now() + HOUR) });
  mockSerialize.mockReturnValue('{"serialized":true}');
});

describe('isSignInRequiredError', () => {
  it('MSAL InteractionRequiredAuthError and the invalid_grant family mean sign in again', () => {
    expect(isSignInRequiredError(new FakeInteractionRequiredAuthError('interaction_required', 'x'))).toBe(true);
    expect(isSignInRequiredError(Object.assign(new Error('refresh token expired'), { errorCode: 'invalid_grant' }))).toBe(true);
    expect(isSignInRequiredError(new Error('AADSTS700082: The refresh token has expired due to inactivity.'))).toBe(true);
    expect(isSignInRequiredError(Object.assign(new Error('no account'), { errorCode: 'no_account_found' }))).toBe(true);
  });

  it('network and server failures mean try again later', () => {
    expect(isSignInRequiredError(Object.assign(new Error('getaddrinfo ENOTFOUND login.microsoftonline.com'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(isSignInRequiredError(Object.assign(new Error('Service unavailable'), { errorCode: 'service_unavailable' }))).toBe(false);
    expect(isSignInRequiredError(Object.assign(new Error('Network request failed'), { errorCode: 'network_error' }))).toBe(false);
    expect(isSignInRequiredError(new Error('Unexpected token < in JSON at position 0'))).toBe(false);
    expect(isSignInRequiredError(null)).toBe(false);
    expect(isSignInRequiredError('string')).toBe(false);
  });
});

describe('getAccessToken (automatic renewal)', () => {
  it('renews silently and saves the new token; status is connected with the account', async () => {
    const token = await getAccessToken();
    expect(token).toBe('fresh-token');
    expect(mockWriteJsonFile).toHaveBeenCalledTimes(1);
    const [, saved] = mockWriteJsonFile.mock.calls[0] as [string, { accessToken: string; msalCache: string }];
    expect(saved.accessToken).toBe('fresh-token');
    expect(saved.msalCache).toBe('{"serialized":true}');

    const status = await getAuthStatus();
    expect(status.state).toBe('connected');
    expect(status.account).toBe('evan@example.com');
    expect(status.credentialExpiresAt).toBeTruthy();
    expect(status.signIn).toBeUndefined();
  });

  it('refresh token dead + cached token still valid: keeps working on the cached token, but status says sign in', async () => {
    mockAcquireTokenSilent.mockRejectedValue(new FakeInteractionRequiredAuthError('invalid_grant', 'AADSTS70008: refresh token expired'));
    const token = await getAccessToken();
    expect(token).toBe('cached-token');

    const status = await getAuthStatus();
    expect(status.state).toBe('sign-in-required');
    expect(status.detail).toContain('invalid_grant');
    expect(status.detail).toContain('Sync still works until');
    expect(status.account).toBe('evan@example.com');
    expect(status.lastFailureAt).toBeTruthy();
  });

  it('refresh token dead + cached token expired: a typed sign-in-required error the sync loop can classify', async () => {
    tokenFile(-1000);
    mockAcquireTokenSilent.mockRejectedValue(new FakeInteractionRequiredAuthError('invalid_grant', 'AADSTS70008: refresh token expired'));
    let caught: unknown;
    try { await getAccessToken(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MsTodoAuthError);
    const auth = pluginAuthFailureOf(caught)!;
    expect(auth.authKind).toBe('sign-in-required');
    expect(auth.authCode).toBe('invalid_grant');
    // The message names the UI path; the CLI is an alternative, not the only way.
    expect(auth.message).toMatch(/Settings → Plugins → Microsoft To-Do/);
    expect(auth.message).not.toMatch(/^Not authenticated/);

    const status = await getAuthStatus();
    expect(status.state).toBe('sign-in-required');
    expect(status.detail).toContain('Sync is paused until you sign in');
  });

  it('Microsoft not answering + cached token valid: renewal fails quietly, the cached token is used, status stays connected', async () => {
    mockAcquireTokenSilent.mockRejectedValue(Object.assign(new Error('Network request failed'), { errorCode: 'network_error' }));
    expect(await getAccessToken()).toBe('cached-token');
    const status = await getAuthStatus();
    expect(status.state).toBe('connected');
    expect(status.detail).toContain('renews on its own');
    expect(status.lastFailureAt).toBeTruthy();
  });

  it('Microsoft not answering + cached token expired: an unreachable error, never sign-in advice', async () => {
    tokenFile(-1000);
    mockAcquireTokenSilent.mockRejectedValue(Object.assign(new Error('Network request failed'), { errorCode: 'network_error' }));
    let caught: unknown;
    try { await getAccessToken(); } catch (e) { caught = e; }
    const auth = pluginAuthFailureOf(caught)!;
    expect(auth.authKind).toBe('unreachable');
    expect(auth.authCode).toBe('network_error');
    expect(auth.message).not.toMatch(/sign in|walnut auth/i);
    expect(auth.message).toMatch(/retries on its own/);

    const status = await getAuthStatus();
    expect(status.state).toBe('unreachable');
    expect(status.detail).toContain('did not answer');
  });

  it('no account in the cache: sign-in-required (first run) without touching the token endpoint', async () => {
    tokenFile(null);
    mockGetAllAccounts.mockResolvedValue([]);
    let caught: unknown;
    try { await getAccessToken(); } catch (e) { caught = e; }
    expect(pluginAuthFailureOf(caught)?.authKind).toBe('sign-in-required');
    expect(mockAcquireTokenSilent).not.toHaveBeenCalled();
    const status = await getAuthStatus();
    expect(status.state).toBe('sign-in-required');
    expect(status.detail).toBe('Not signed in yet.');
  });

  it('a later successful renewal clears the remembered failure', async () => {
    mockAcquireTokenSilent.mockRejectedValueOnce(new FakeInteractionRequiredAuthError('invalid_grant', 'dead'));
    await getAccessToken();
    expect((await getAuthStatus()).state).toBe('sign-in-required');
    await getAccessToken();
    const status = await getAuthStatus();
    expect(status.state).toBe('connected');
    expect(status.lastFailureAt).toBeUndefined();
  });

  it('no client_id: not-configured, and status points at Settings', async () => {
    configWith(undefined);
    let caught: unknown;
    try { await getAccessToken(); } catch (e) { caught = e; }
    expect(pluginAuthFailureOf(caught)?.authKind).toBe('not-configured');
    expect((await getAuthStatus()).state).toBe('not-configured');
  });
});

describe('getMsTodoSyncStatus (CLI)', () => {
  it('tells a dead credential from an outage', async () => {
    tokenFile(-1000);
    mockAcquireTokenSilent.mockRejectedValue(Object.assign(new Error('Network request failed'), { errorCode: 'network_error' }));
    const outage = await getMsTodoSyncStatus();
    expect(outage.authenticated).toBe(false);
    expect(outage.authFailure?.kind).toBe('unreachable');

    mockAcquireTokenSilent.mockRejectedValue(new FakeInteractionRequiredAuthError('invalid_grant', 'dead'));
    const dead = await getMsTodoSyncStatus();
    expect(dead.authFailure?.kind).toBe('sign-in-required');

    mockAcquireTokenSilent.mockResolvedValue({ accessToken: 'fresh-token' });
    const ok = await getMsTodoSyncStatus();
    expect(ok.authenticated).toBe(true);
    expect(ok.authFailure).toBeUndefined();
  });
});

describe('beginSignIn (device code from Settings)', () => {
  /** A device-code flow the test finishes by hand. */
  function armDeviceCode(opts: { expiresIn?: number } = {}) {
    let finish!: (result: unknown) => void;
    let fail!: (err: unknown) => void;
    const exchange = new Promise((res, rej) => { finish = res; fail = rej; });
    mockAcquireTokenByDeviceCode.mockImplementation(async (req: { deviceCodeCallback: (r: unknown) => void }) => {
      req.deviceCodeCallback({
        userCode: 'ABCD-1234',
        verificationUri: 'https://microsoft.com/devicelogin',
        message: 'To sign in, use a web browser…',
        expiresIn: opts.expiresIn ?? 900,
      });
      return exchange;
    });
    return { finish, fail };
  }

  it('returns the prompt at once, reports signing-in, then connected when the exchange completes', async () => {
    tokenFile(null);
    mockGetAllAccounts.mockResolvedValue([]);
    const { finish } = armDeviceCode();

    const prompt = await beginSignIn();
    expect(prompt.userCode).toBe('ABCD-1234');
    expect(prompt.verificationUri).toBe('https://microsoft.com/devicelogin');
    expect(Date.parse(prompt.expiresAt) - Date.parse(prompt.startedAt)).toBe(900_000);
    // MSAL was told to wait for the human as long as the code is valid.
    const req = mockAcquireTokenByDeviceCode.mock.calls[0][0] as { timeout: number; scopes: string[] };
    expect(req.timeout).toBe(900);
    expect(req.scopes).toEqual(['Tasks.ReadWrite']);

    const mid = await getAuthStatus();
    expect(mid.state).toBe('signing-in');
    expect(mid.signIn?.userCode).toBe('ABCD-1234');

    // A second click while the code is valid reuses the same prompt: no second flow.
    expect(await beginSignIn()).toBe(prompt);
    expect(mockAcquireTokenByDeviceCode).toHaveBeenCalledTimes(1);

    finish({ accessToken: 'new-token', expiresOn: new Date(Date.now() + HOUR), account: { username: 'evan@example.com' } });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockWriteJsonFile).toHaveBeenCalled();
    const [, saved] = mockWriteJsonFile.mock.calls.at(-1) as [string, { accessToken: string }];
    expect(saved.accessToken).toBe('new-token');

    // The saved file is what status reads next.
    tokenFile(HOUR);
    mockGetAllAccounts.mockResolvedValue([{ username: 'evan@example.com' }]);
    const after = await getAuthStatus();
    expect(after.state).toBe('connected');
    expect(after.signIn).toBeUndefined();
  });

  it('a flow the human never finished: sign-in-required again with the reason, and a new click starts a new flow', async () => {
    tokenFile(null);
    mockGetAllAccounts.mockResolvedValue([]);
    const { fail } = armDeviceCode();
    await beginSignIn();
    fail(Object.assign(new Error('expired_token: the code expired'), { errorCode: 'expired_token' }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const status = await getAuthStatus();
    expect(status.state).toBe('sign-in-required');
    expect(status.detail).toContain('did not complete');
    expect(status.detail).toContain('expired_token');

    armDeviceCode();
    await beginSignIn();
    expect(mockAcquireTokenByDeviceCode).toHaveBeenCalledTimes(2);
  });

  it('rejects only when no prompt ever came', async () => {
    mockAcquireTokenByDeviceCode.mockRejectedValue(new Error('invalid_client'));
    await expect(beginSignIn()).rejects.toThrow('invalid_client');
    expect((await getAuthStatus()).state).not.toBe('signing-in');
  });

  it('refuses without a client_id instead of starting a flow', async () => {
    configWith(undefined);
    await expect(beginSignIn()).rejects.toMatchObject({ authKind: 'not-configured' });
    expect(mockAcquireTokenByDeviceCode).not.toHaveBeenCalled();
  });
});
