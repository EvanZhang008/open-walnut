/**
 * The sign-ins mail accounts' calendars were given, one file per account in
 * `<dataDir>/local/calendar/` (0600 in a 0700 folder; `local/` is never synced): the provider,
 * the address the person signed in as, and the tokens. Never in config, never logged.
 *
 * `providerOf` answers from memory (loaded once, kept as files are written and removed), so the
 * calendar can decide which kind of source an account gets without a file read on its way.
 *
 * `bearer(accountId)` is what a source carries on each request: the cached access token,
 * renewed when it nears expiry or a server refused it. Every way it can end for good (no sign-in,
 * the grant revoked or expired, the client it was made with no longer set) is `needs-sign-in`,
 * which the account's row shows with "Sign in again"; the events already read stay meanwhile.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CalendarHelperError } from '../../../core/calendar/helper-error.js';
import {
  deleteTokenFile, makeAccessTokenGetter, readTokenFile, revokeGrant, updateTokenFile, writeTokenFile,
  type OAuthClient, type OAuthTokens,
} from '../../../core/oauth/desktop-oauth.js';
import { calendarSignInDir } from '../../../core/oauth/google-grants.js';
import type { DavBearer } from '../caldav/dav.js';
import type { SignInProvider } from '../sign-in-provider.js';
import { CALENDAR_SIGN_INS, tokenHosts } from './providers.js';

export interface CalendarSignIn extends OAuthTokens {
  provider: SignInProvider;
  account_id: string;
  /** The mail account's address, as its row shows it. */
  address: string;
}

const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._-]{1,128}$/;
const FILE_RE = /^sign-in-(.+)\.json$/;

export class CalendarSignInStore {
  private readonly dir: string;
  private readonly index = new Map<string, SignInProvider>();
  private readonly getters = new Map<string, (force?: boolean) => Promise<string>>();

  constructor(
    dataDir: string,
    private readonly clientFor: (provider: SignInProvider) => Promise<OAuthClient | null>,
    private readonly opts: {
      fetchImpl?: typeof fetch;
      /**
       * Whether forgetting this sign-in may revoke its grant at the provider. A Google grant can
       * be shared (Drive backups signed in with the same client as the same account): the last
       * holder revokes it. Unset: never revoke.
       */
      mayRevoke?: (t: CalendarSignIn, file: string) => Promise<boolean>;
    } = {},
  ) {
    this.dir = calendarSignInDir(dataDir);
  }

  private file(accountId: string): string {
    if (!ACCOUNT_ID_RE.test(accountId)) throw new CalendarHelperError('not a mail account id', 'usage');
    return path.join(this.dir, `sign-in-${accountId.replace(':', '_')}.json`);
  }

  /** Read which accounts are signed in. A missing folder is none. */
  async load(): Promise<void> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!FILE_RE.test(name)) continue;
      const t = await readTokenFile<CalendarSignIn>(path.join(this.dir, name)).catch(() => null);
      if (t && (t.provider === 'Google' || t.provider === 'Microsoft') && ACCOUNT_ID_RE.test(t.account_id)) this.index.set(t.account_id, t.provider);
    }
  }

  providerOf(accountId: string): SignInProvider | undefined {
    return this.index.get(accountId);
  }

  async read(accountId: string): Promise<CalendarSignIn | null> {
    const t = await readTokenFile<CalendarSignIn>(this.file(accountId));
    return t && t.account_id === accountId ? t : null;
  }

  async save(t: CalendarSignIn): Promise<void> {
    await writeTokenFile(this.file(t.account_id), t);
    this.index.set(t.account_id, t.provider);
    // A new sign-in starts with its own token, not one cached from the last.
    this.getters.delete(t.account_id);
  }

  /**
   * Forget an account's sign-in here. The provider is told to drop the grant only when it can be
   * (Google has a revoke page, Microsoft none) and no other sign-in on this machine holds it.
   */
  async forget(accountId: string): Promise<boolean> {
    const file = this.file(accountId);
    const t = await this.read(accountId).catch(() => null);
    if (t && (await this.opts.mayRevoke?.(t, file).catch(() => false))) await revokeGrant(CALENDAR_SIGN_INS[t.provider], t.refresh_token, this.opts.fetchImpl);
    await deleteTokenFile(file);
    this.getters.delete(accountId);
    return this.index.delete(accountId) || !!t;
  }

  /** Whether forgetting this account's sign-in would revoke its grant at the provider (false: Walnut stays in the account's app list). */
  async revokesOnForget(accountId: string): Promise<boolean> {
    const t = await this.read(accountId).catch(() => null);
    return !!t && !!(await this.opts.mayRevoke?.(t, this.file(accountId)).catch(() => false));
  }

  /** What a request of this account's calendar carries. */
  bearer(accountId: string, provider: SignInProvider): DavBearer {
    const get = () => {
      let getter = this.getters.get(accountId);
      if (!getter) {
        getter = this.getter(accountId, provider);
        this.getters.set(accountId, getter);
      }
      return getter;
    };
    return { provider, token: () => get()(false), renew: () => get()(true), hosts: tokenHosts(provider) };
  }

  private getter(accountId: string, provider: SignInProvider): (force?: boolean) => Promise<string> {
    const again = (why: string) => new CalendarHelperError(`${why} Sign in again.`, 'needs-sign-in');
    return makeAccessTokenGetter<CalendarSignIn>({
      provider: CALENDAR_SIGN_INS[provider],
      read: () => this.read(accountId),
      // The file holds one account's sign-in; a file of another account is never written.
      update: (change) => updateTokenFile<CalendarSignIn>(this.file(accountId), (cur) => (cur && cur.account_id !== accountId ? null : change(cur))),
      client: async () => {
        const [client, t] = await Promise.all([this.clientFor(provider), this.read(accountId)]);
        // A refresh needs the client the sign-in was made with.
        if (!client || (t && client.clientId !== t.client_id)) throw again(`The ${provider} client this sign-in was made with is no longer set on this computer.`);
        return client;
      },
      notConnected: () => again(`Walnut is not signed in to ${provider} for this calendar on this computer.`),
      revoked: () => again(`The ${provider} sign-in for this calendar was revoked or has expired.`),
      fetchImpl: this.opts.fetchImpl,
    });
  }
}
