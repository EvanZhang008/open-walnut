/**
 * The routes of a mail account's calendar sign-in (Google, Microsoft), behind the
 * `mail_calendars` experiment like the rest of mail accounts' calendars:
 *
 *   GET  /mail-accounts/sign-in-providers?ids= which of these accounts sign in, and with whom
 *   GET  /mail-accounts/:id/sign-in           where it stands: provider, client, signed in, waiting
 *   POST /mail-accounts/:id/sign-in           start one; answers the provider's page
 *   POST /mail-accounts/:id/sign-in/complete  the browser was elsewhere: the address it landed on
 *   POST /mail-accounts/:id/sign-in/cancel    the person closed the provider's page
 *   POST /mail-accounts/:id/sign-in/decide    a sign-in as another account: {use: true} keeps it, {use: false} discards it
 *   GET  /sign-in-clients/:provider           which client a provider's sign-in uses
 *   POST /sign-in-clients/:provider           set one ({client_id, client_secret}), checked first
 *
 * Which provider an account signs in with is told by its address and its mail servers (a Google
 * Workspace or Microsoft 365 account on its own domain is known by imap.gmail.com or
 * outlook.office365.com), read from the mail account itself (the broker's `account`), so a
 * sign-in starts only for a real mail account of that provider.
 *
 * Starting a sign-in is open to agents: it finishes only on the provider's own consent page
 * (`prompt=consent` on both), which is the person's yes. Setting, replacing or removing the
 * OAuth client is a credentials change, so only the person at this Mac makes it (the rule of
 * Phase A's server confirm, `fromPersonHere`); reading which client is set is open.
 */
import { checkClient } from '../../../core/oauth/desktop-oauth.js';
import type { WalnutServerPluginApi } from '../../../core/plugins/server-api.js';
import type { PluginRouteRequest } from '../../../core/plugins/plugin-route-adapter.js';
import { calendarErrorCode } from '../api.js';
import { fromPersonHere } from '../routes.js';
import { mailCalendarsOn, readExperimentalFlags } from '../config.js';
import { signInProvider, type SignInProvider } from '../sign-in-provider.js';
import { calendarSignInState, cancelCalendarSignIn, completeCalendarSignIn, decideCalendarSignIn, startCalendarSignIn, type SignInDeps, type SignInOutcome } from './flow.js';
import { CALENDAR_SIGN_INS, saveCalendarClient, type ClientSecrets, type ResolvedClient } from './providers.js';

const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._-]{1,128}$/;
const OFF = { ok: false, reason: 'off', message: 'Calendars of mail accounts are an experiment that is off. Settings > Experimental turns it on.' };

/** The account id out of `/mail-accounts/<id>/sign-in[/...]` (either mount path). */
function accountIdFrom(request: PluginRouteRequest): string {
  const m = /\/mail-accounts\/([^/]+)\/sign-in(?:\/[a-z]+)?\/?$/.exec(request.path.split('?')[0]);
  if (!m) return '';
  try {
    const id = decodeURIComponent(m[1]);
    return ACCOUNT_ID_RE.test(id) ? id : '';
  } catch {
    return '';
  }
}

function providerFrom(request: PluginRouteRequest): SignInProvider | null {
  const m = /\/sign-in-clients\/(Google|Microsoft)\/?$/i.exec(request.path.split('?')[0]);
  if (!m) return null;
  return m[1].toLowerCase() === 'google' ? 'Google' : 'Microsoft';
}

async function body(request: PluginRouteRequest): Promise<Record<string, unknown>> {
  try {
    return (await request.json<Record<string, unknown> | null>()) ?? {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** An outcome as a route answers it. */
const answer = (o: SignInOutcome) => (o.ok ? { ok: true } : { ok: false, message: o.message, ...(o.held ? { held: o.held } : {}) });

/** What the page may show of a client: where it came from and its id (never its secret). */
function clientView(resolved: ResolvedClient | null): { ready: boolean; from?: string; clientId?: string } {
  return resolved ? { ready: true, from: resolved.from, clientId: resolved.client.clientId } : { ready: false };
}

const on = async () => mailCalendarsOn(await readExperimentalFlags());

/** A mail account as the sign-in needs it: its address and mail servers (no password). */
export type MailAccountLookup = (accountId: string) => Promise<{ address: string; hosts: { imap?: string; smtp?: string } } | undefined>;

export function registerSignInRoutes(walnut: WalnutServerPluginApi, deps: SignInDeps, secrets: ClientSecrets, accountOf: MailAccountLookup): void {
  /** The account and the provider it signs in with, from the mail account itself; null for no such account. */
  const lookup = async (accountId: string): Promise<{ address: string; provider: SignInProvider | null } | null> => {
    const account = await accountOf(accountId).catch(() => undefined);
    if (!account) return null;
    return { address: account.address, provider: signInProvider(account) };
  };

  walnut.http.route('get', '/mail-accounts/sign-in-providers', async (request) => {
    if (!(await on())) return { json: { off: true, providers: {} } };
    const ids = str(request.query.ids).split(',').filter((id) => ACCOUNT_ID_RE.test(id)).slice(0, 100);
    const providers: Record<string, SignInProvider> = {};
    for (const id of ids) {
      const found = deps.store.providerOf(id) ?? (await lookup(id))?.provider;
      if (found) providers[id] = found;
    }
    return { json: { providers } };
  });

  walnut.http.route('get', '/mail-accounts/:accountId/sign-in', async (request) => {
    if (!(await on())) return { json: { off: true } };
    const accountId = accountIdFrom(request);
    if (!accountId) return { status: 400, json: { error: 'not a mail account id' } };
    const provider = deps.store.providerOf(accountId) ?? (await lookup(accountId))?.provider ?? null;
    if (!provider) return { json: { provider: null } };
    const signIn = await deps.store.read(accountId).catch(() => null);
    return {
      json: {
        provider,
        client: clientView(await deps.client(provider)),
        signedIn: !!signIn,
        // Whether Remove leaves Walnut in the account's app list (a grant Drive backups share, or Microsoft's).
        ...(signIn ? { email: signIn.email ?? signIn.address, keepsGrant: !(await deps.store.revokesOnForget(accountId)) } : {}),
        ...calendarSignInState(accountId),
      },
    };
  });

  walnut.http.route('post', '/mail-accounts/:accountId/sign-in', async (request) => {
    if (!(await on())) return { json: OFF };
    const accountId = accountIdFrom(request);
    // A real mail account of a provider that signs in (no listener is opened for any other id).
    const account = accountId ? await lookup(accountId) : null;
    if (!account?.provider) return { status: 400, json: { ok: false, reason: 'usage', message: 'Only a Google or Microsoft mail account set up in Walnut signs in for its calendar.' } };
    const { address, provider } = account;
    try {
      const { authUrl } = await startCalendarSignIn(deps, accountId, address, provider);
      walnut.log.info('calendar sign-in started', { accountId, provider });
      return { json: { ok: true, authUrl } };
    } catch (err) {
      const code = calendarErrorCode(err);
      return { status: code === 'not-configured' ? 200 : 502, json: { ok: false, reason: code === 'not-configured' ? 'no-client' : 'fetch-error', message: err instanceof Error ? err.message : String(err) } };
    }
  });

  walnut.http.route('post', '/mail-accounts/:accountId/sign-in/complete', async (request) => {
    if (!(await on())) return { json: OFF };
    const accountId = accountIdFrom(request);
    const url = str((await body(request)).url);
    const provider = accountId ? deps.store.providerOf(accountId) ?? (await lookup(accountId))?.provider ?? 'Google' : null;
    if (!accountId || !provider || !url) return { status: 400, json: { ok: false, message: 'Paste the whole address from the browser.' } };
    try {
      return { json: answer(await completeCalendarSignIn(accountId, url, provider)) };
    } catch (err) {
      return { status: 400, json: { ok: false, message: err instanceof Error ? err.message : String(err) } };
    }
  });

  walnut.http.route('post', '/mail-accounts/:accountId/sign-in/cancel', async (request) => {
    if (!(await on())) return { json: OFF };
    const accountId = accountIdFrom(request);
    if (!accountId) return { status: 400, json: { ok: false } };
    return { json: { ok: true, cancelled: cancelCalendarSignIn(accountId) } };
  });

  walnut.http.route('post', '/mail-accounts/:accountId/sign-in/decide', async (request) => {
    if (!(await on())) return { json: OFF };
    const accountId = accountIdFrom(request);
    const use = (await body(request)).use;
    if (!accountId || typeof use !== 'boolean') return { status: 400, json: { ok: false, message: 'Say {"use": true} to keep the sign-in or {"use": false} to discard it.' } };
    try {
      const outcome = await decideCalendarSignIn(deps, accountId, use);
      walnut.log.info('calendar sign-in as another account decided', { accountId, use });
      return { json: answer(outcome) };
    } catch (err) {
      return { status: 400, json: { ok: false, message: err instanceof Error ? err.message : String(err) } };
    }
  });

  walnut.http.route('get', '/sign-in-clients/:provider', async (request) => {
    const provider = providerFrom(request);
    if (!provider) return { status: 404, json: { error: 'no such sign-in' } };
    return { json: clientView(await deps.client(provider)) };
  });

  walnut.http.route('post', '/sign-in-clients/:provider', async (request) => {
    if (!(await on())) return { json: OFF };
    const provider = providerFrom(request);
    if (!provider) return { status: 404, json: { ok: false, message: 'no such sign-in' } };
    // Which app the person's consent page names, and every sign-in made with it: the person's call.
    if (!fromPersonHere(request)) {
      return { status: 403, json: { ok: false, reason: 'human-approval-required', message: `Only the person at this Mac sets the ${provider} client: Apps > Calendar > Mail accounts.` } };
    }
    const sent = await body(request);
    const clientId = str(sent.client_id);
    const clientSecret = str(sent.client_secret) || undefined;
    if (!clientId) {
      await saveCalendarClient(provider, secrets, { clientId: '' });
      return { json: { ok: true, removed: true, client: clientView(await deps.client(provider)) } };
    }
    // Google's token exchange for a desktop client needs both; Microsoft's public client has no secret.
    if (provider === 'Google' && !clientSecret) return { status: 400, json: { ok: false, message: 'Add the client secret too: Google needs both.' } };
    const checked = await checkClient(CALENDAR_SIGN_INS[provider], { clientId, clientSecret, source: 'custom' });
    if (!checked.ok) return { json: { ok: false, message: `${provider} does not accept this client: ${checked.message}` } };
    await saveCalendarClient(provider, secrets, { clientId, clientSecret });
    walnut.log.info('calendar sign-in client saved', { provider });
    return { json: { ok: true, client: clientView(await deps.client(provider)) } };
  });
}
