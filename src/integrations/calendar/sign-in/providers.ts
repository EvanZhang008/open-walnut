/**
 * The two sign-ins a mail account's calendar can need (sign-in-provider.ts says which): Google's,
 * whose calendars are then read over Google's CalDAV with the sign-in's token, and Microsoft's,
 * read through Microsoft Graph. Here: each one's pages and scopes, where its token may go, and
 * which OAuth client it uses.
 *
 * Clients. Walnut has no published client of its own yet (as for Drive backups), so a person
 * makes one, once, and pastes it into the calendar's page; it is kept in the calendar plugin's
 * secret store on this machine, beside the sign-ins it made (which are per machine too). Google:
 * the calendar's own client, else the one Drive backups use (its setting, the environment, this
 * machine's client file), since one Google client may hold both scopes. Microsoft: the
 * calendar's own client id, else `WALNUT_MICROSOFT_CLIENT_ID`. A Microsoft client is a public
 * client (no secret; PKCE stands in for it).
 *
 * The `WALNUT_*_URL` variables point a test at fakes; every token goes only to the host its URL
 * names (dav.ts `DavBearer.hosts`).
 */
import { getConfig } from '../../../core/config-manager.js';
import { BUILTIN_GOOGLE_CLIENT, oauthEndpoints, resolveOAuthClient } from '../../../core/backup/gdrive-oauth.js';
import type { OAuthClient, OAuthProvider } from '../../../core/oauth/desktop-oauth.js';
import { grantHeldElsewhere } from '../../../core/oauth/google-grants.js';
import type { SignInProvider } from '../sign-in-provider.js';

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
export const MICROSOFT_CALENDAR_SCOPE = 'Calendars.ReadWrite';

/** Walnut's own published Microsoft client goes here once it exists (a public client). */
export const BUILTIN_MICROSOFT_CLIENT_ID = '';

/** Where a Google account's calendars are found: its CalDAV principal (`{email}` filled in). */
export function googleCalDavStart(email: string): string {
  const template = process.env.WALNUT_GOOGLE_CALDAV_URL || 'https://apidata.googleusercontent.com/caldav/v2/{email}/user';
  return template.replace('{email}', encodeURIComponent(email));
}

/** Microsoft Graph, without a trailing slash. */
export function graphBase(): string {
  return (process.env.WALNUT_GRAPH_URL || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
}

function microsoftEndpoints(): { auth: string; token: string } {
  return {
    auth: process.env.WALNUT_MICROSOFT_AUTH_URL || 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: process.env.WALNUT_MICROSOFT_TOKEN_URL || 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  };
}

export const CALENDAR_SIGN_INS: Readonly<Record<SignInProvider, OAuthProvider>> = {
  Google: {
    name: 'Google',
    what: 'your Google calendar',
    again: 'Choose "Sign in with Google" again.',
    endpoints: oauthEndpoints,
    scopes: ['openid', 'email', GOOGLE_CALENDAR_SCOPE],
    requiredScope: GOOGLE_CALENDAR_SCOPE,
    scopeMissing: 'Walnut was not given access to your Google calendar. Sign in again and tick the calendar box on the Google page.',
    authParams: { access_type: 'offline', prompt: 'consent' },
  },
  Microsoft: {
    name: 'Microsoft',
    what: 'your Outlook calendar',
    again: 'Choose "Sign in with Microsoft" again.',
    endpoints: microsoftEndpoints,
    scopes: ['openid', 'email', 'offline_access', MICROSOFT_CALENDAR_SCOPE],
    requiredScope: MICROSOFT_CALENDAR_SCOPE,
    scopeMissing: 'Walnut was not given access to your Outlook calendar. Sign in again and allow calendar access on the Microsoft page.',
    // Consent every time, as Google's: a sign-in an agent started never finishes on one click.
    authParams: { prompt: 'consent' },
    scopeOnRefresh: true,
  },
};

/** The one host each provider's token may go to (its calendar server). */
export function tokenHosts(provider: SignInProvider): string[] {
  return [new URL(provider === 'Google' ? googleCalDavStart('x@example.com') : graphBase()).host];
}

/** The calendar plugin's secret store (walnut.secrets), as far as clients need it. */
export interface ClientSecrets {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Where a client came from: set on the calendar's page, Drive backups' Google client, or built in (or the environment). */
export type ClientSource = 'calendar' | 'drive' | 'builtin';

export interface ResolvedClient { client: OAuthClient; from: ClientSource }

const GOOGLE_KEY = 'google_client';
const MICROSOFT_KEY = 'microsoft_client_id';

async function ownGoogle(secrets: ClientSecrets): Promise<OAuthClient | null> {
  try {
    const raw = JSON.parse((await secrets.get(GOOGLE_KEY)) ?? '{}') as { client_id?: unknown; client_secret?: unknown };
    const id = typeof raw.client_id === 'string' ? raw.client_id.trim() : '';
    if (!id) return null;
    const secret = typeof raw.client_secret === 'string' ? raw.client_secret.trim() : '';
    return { clientId: id, clientSecret: secret || undefined, source: 'custom' };
  } catch {
    return null;
  }
}

/** Drive backups' Google client: its own setting (in use or kept for later), the environment, this machine's file. */
async function driveGoogle(dataDir: string): Promise<OAuthClient | null> {
  const backup = ((await getConfig()) as { backup?: { destination?: Record<string, unknown>; other_destinations?: Array<Record<string, unknown>> } }).backup;
  const dest = backup?.destination?.type === 'gdrive' ? backup.destination : backup?.other_destinations?.find((o) => o.type === 'gdrive');
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return resolveOAuthClient({ client_id: str(dest?.client_id), client_secret: str(dest?.client_secret) }, dataDir);
}

/** The client a provider's sign-in uses now, and where it came from; null when there is none yet. */
export async function resolveCalendarClient(provider: SignInProvider, secrets: ClientSecrets, dataDir: string): Promise<ResolvedClient | null> {
  if (provider === 'Google') {
    const own = await ownGoogle(secrets);
    if (own) return { client: own, from: 'calendar' };
    const drive = await driveGoogle(dataDir);
    if (!drive) return null;
    return { client: drive, from: BUILTIN_GOOGLE_CLIENT.clientId && drive.clientId === BUILTIN_GOOGLE_CLIENT.clientId ? 'builtin' : 'drive' };
  }
  const own = (await secrets.get(MICROSOFT_KEY))?.trim();
  if (own) return { client: { clientId: own, source: 'custom' }, from: 'calendar' };
  const id = process.env.WALNUT_MICROSOFT_CLIENT_ID?.trim() || BUILTIN_MICROSOFT_CLIENT_ID;
  return id ? { client: { clientId: id, source: 'builtin' }, from: 'builtin' } : null;
}

/**
 * Whether forgetting a Google calendar sign-in may revoke its grant: only when it was made with a
 * client that is not Drive backups' and no other sign-in here holds the same grant
 * (google-grants.ts). A Microsoft grant has no revoke page; it is only forgotten here.
 */
export async function calendarGrantMayGo(t: { provider: SignInProvider; client_id: string; email?: string; address: string }, file: string, dataDir: string): Promise<boolean> {
  if (t.provider !== 'Google') return false;
  if (await grantHeldElsewhere(dataDir, file, { client_id: t.client_id, email: t.email ?? t.address })) return false;
  return (await driveGoogle(dataDir))?.clientId !== t.client_id;
}

/** Keep a client set on the calendar's page (an empty id removes it). */
export async function saveCalendarClient(provider: SignInProvider, secrets: ClientSecrets, client: { clientId: string; clientSecret?: string }): Promise<void> {
  const id = client.clientId.trim();
  if (provider === 'Google') {
    if (!id) return secrets.delete(GOOGLE_KEY);
    return secrets.set(GOOGLE_KEY, JSON.stringify({ client_id: id, client_secret: client.clientSecret?.trim() ?? '' }));
  }
  if (!id) return secrets.delete(MICROSOFT_KEY);
  return secrets.set(MICROSOFT_KEY, id);
}
