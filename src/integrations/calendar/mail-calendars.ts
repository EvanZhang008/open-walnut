/**
 * Mail accounts that bring their calendar ("Add its calendar" / "Remove its calendar" in
 * Apps > Calendar), behind the `mail_calendars` experiment.
 *
 * Adding tries first and writes only what worked: the account's calendars are looked for with
 * its saved password, and only when some are found is the account written into
 * `mail_calendar_accounts`. A try that finds none answers why (the provider needs its own
 * sign-in, the server offers no calendar, refused the password, or its own error) and changes
 * nothing.
 *
 * A calendar server found somewhere the account does not point (a guessed host, a redirect to
 * another domain) gets no password until the person says so: the answer is `found-server` with
 * its URL, and the row's "Use this server" sends it back as `server`, which is saved as the
 * account's `caldav_url` (through the host's broker) before the add is tried again. Only a server
 * this process itself reported for that account in the last 30 minutes is taken (`offered`):
 * any other `server` is refused (409) and nothing is sent, so no caller can point a saved
 * password at a host of its choosing. A `caldav_url` typed in the IMAP account's own settings is
 * another matter: that form asks for the password again.
 *
 * A Google or Microsoft account cannot be read with its mail password; it signs in instead
 * (sign-in/), and once signed in its calendar is added here the same way (`readSignedInCalendar`).
 * Its source is the signed-in one (sign-in/sources.ts). "Remove its calendar" forgets the
 * sign-in too.
 */
import { CalendarHelperError } from '../../core/calendar/helper-error.js';
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js';
import type { PluginRouteRequest } from '../../core/plugins/plugin-route-adapter.js';
import type { CoreMailCalendarCredentialsApi } from '../../core/calendar/mail-credentials.js';
import { calendarErrorCode } from './api.js';
import { fromPersonHere } from './routes.js';
import { createCalDavSource } from './caldav/source.js';
import { signedInCalendarSource } from './sign-in/sources.js';
import type { CalendarSignInStore } from './sign-in/store.js';
import { clearCalendarSignInState } from './sign-in/flow.js';
import { signInNeededText, signInProvider } from './sign-in-provider.js';
import { mailCalendarsOn, readCalendarConfig, readExperimentalFlags, type CalendarConfigPatcher } from './config.js';
import { caldavSourceIdFor, calendarSourceOf } from './event-rules.js';
import type { CalendarService, MailCalendarSourceFactory } from './service.js';
import type { CalendarInfo, CalendarSourceReason, CalendarSourceStatus } from './types.js';

const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._-]{1,128}$/;

/**
 * The factory activate installs: per mail account, its signed-in source when it signed in with
 * its provider, else a CalDAV source whose password is asked of the host's broker.
 */
export function mailCalendarSourceFactory(broker: CoreMailCalendarCredentialsApi | undefined, signIns?: CalendarSignInStore): MailCalendarSourceFactory {
  return (accountId) => (signIns && signedInCalendarSource(signIns, accountId))
    ?? createCalDavSource({ accountId, credentials: async () => broker?.credentials(accountId) });
}

export type AddMailCalendarResult =
  | { ok: true; source: CalendarSourceStatus; calendars: CalendarInfo[] }
  | { ok: false; reason: CalendarSourceReason | 'off' | 'usage'; message: string }
  /** A calendar server where the account does not point: `server` is what "Use this server" sends back. */
  | { ok: false; reason: 'found-server'; message: string; server: string }
  /** A `server` this Walnut did not just offer for this account. */
  | { ok: false; reason: 'server-not-offered'; message: string };

/** How long a reported server may be picked. */
export const OFFER_TTL_MS = 30 * 60_000;
/** Per account: the server this process last reported as found-server, and when. */
const offered = new Map<string, { url: string; at: number }>();

/** The one thing the calendar may write into a mail account: its calendar server. */
export type SaveCalendarServer = (accountId: string, url: string) => Promise<boolean>;

/** One add or remove at a time, so two clicks never drop each other's account. Never rejects. */
let tail: Promise<unknown> = Promise.resolve();

function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = tail.then(run, run);
  tail = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Try the account's calendar and, when it has one, read it from now on. `address` (what the
 * mail list shows) only words the answer for an account Walnut keeps no password for.
 */
export function addMailCalendar(
  service: CalendarService,
  accountId: string,
  patchConfig: CalendarConfigPatcher,
  opts: { address?: string; server?: string; saveServer?: SaveCalendarServer } = {},
): Promise<AddMailCalendarResult> {
  const { address } = opts;
  return serial(async (): Promise<AddMailCalendarResult> => {
    if (!ACCOUNT_ID_RE.test(accountId)) return { ok: false, reason: 'usage', message: 'not a mail account id' };
    if (!mailCalendarsOn(await readExperimentalFlags())) return { ok: false, reason: 'off', message: 'Calendars of mail accounts are an experiment that is off. Settings > Experimental turns it on.' };
    if (opts.server !== undefined) {
      const offer = offered.get(accountId);
      if (!offer || offer.url !== opts.server || Date.now() - offer.at > OFFER_TTL_MS) {
        return { ok: false, reason: 'server-not-offered', message: 'Walnut uses a calendar server only right after it found that server for this account. Try Add its calendar again.' };
      }
      offered.delete(accountId);
      const saved = typeof opts.server === 'string' && opts.saveServer ? await opts.saveServer(accountId, opts.server).catch(() => false) : false;
      if (!saved) return { ok: false, reason: 'usage', message: 'Walnut could not save that calendar server on this mail account (it takes an https address).' };
    }
    const candidate = service.mailCalendarCandidate(accountId);
    if (!candidate) return { ok: false, reason: 'not-configured', message: 'Mail accounts cannot bring their calendars on this Walnut.' };
    let calendars: CalendarInfo[];
    try {
      calendars = await candidate.source.listCalendars();
    } catch (err) {
      const code = calendarErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      const server = (err as { serverUrl?: unknown }).serverUrl;
      if (code === 'found-server' && typeof server === 'string') {
        offered.set(accountId, { url: server, at: Date.now() });
        return { ok: false, reason: 'found-server', message, server };
      }
      if (code === 'not-configured' && address) {
        const provider = signInProvider({ address, hosts: {} });
        if (provider) return { ok: false, reason: 'needs-sign-in', message: signInNeededText(provider) };
        return { ok: false, reason: 'not-configured', message: 'Walnut keeps no password for this mail account (it signs in another way), so it cannot read its calendar.' };
      }
      return { ok: false, reason: (code as CalendarSourceReason | undefined) ?? 'fetch-error', message };
    }
    candidate.adopt();
    const current = (await readCalendarConfig()).mail_calendar_accounts ?? [];
    if (!current.includes(accountId)) await patchConfig({ mail_calendar_accounts: [...current, accountId] });
    await service.reloadConfig();
    const sourceId = caldavSourceIdFor(accountId);
    const status = service.statuses().find((s) => s.id === sourceId);
    if (!status) throw new CalendarHelperError('the calendar was saved but is not read; reload Walnut', 'fetch-error');
    // With the service's visibility overlay; the try's own list when that read fails.
    const listed = await service.listCalendars().then((all) => all.filter((c) => calendarSourceOf(c.id) === sourceId), () => calendars);
    return { ok: true, source: status, calendars: listed };
  });
}

/**
 * A sign-in just saved: add the account's calendar, or, when it is read already (a sign-in that
 * had expired), read it again so its row stops saying to sign in.
 */
export async function readSignedInCalendar(service: CalendarService, accountId: string, patchConfig: CalendarConfigPatcher, address: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = (await readCalendarConfig()).mail_calendar_accounts ?? [];
  if (!current.includes(accountId)) {
    const added = await addMailCalendar(service, accountId, patchConfig, { address });
    return added.ok ? { ok: true } : { ok: false, message: added.message };
  }
  await service.listCalendarsDetailed().catch(() => undefined);
  await service.refreshAll().catch(() => undefined);
  const status = service.statuses().find((s) => s.id === caldavSourceIdFor(accountId));
  return !status || status.available ? { ok: true } : { ok: false, message: status.message ?? 'Its calendar did not answer.' };
}

/** Stop reading the account's calendar. Its events leave every view; the calendar itself is untouched. */
export function removeMailCalendar(service: CalendarService, accountId: string, patchConfig: CalendarConfigPatcher): Promise<{ removed: boolean }> {
  return serial(async () => {
    const current = (await readCalendarConfig()).mail_calendar_accounts ?? [];
    if (!current.includes(accountId)) return { removed: false };
    await patchConfig({ mail_calendar_accounts: current.filter((id) => id !== accountId) });
    await service.reloadConfig();
    return { removed: true };
  });
}

/** The account id out of `/mail-accounts/<id>/calendar` (either mount path). */
function accountIdFrom(request: PluginRouteRequest): string {
  const m = /\/mail-accounts\/([^/]+)\/calendar\/?$/.exec(request.path.split('?')[0]);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return '';
  }
}

export function registerMailCalendarRoutes(walnut: WalnutServerPluginApi, resolve: () => CalendarService, broker?: CoreMailCalendarCredentialsApi, signIns?: CalendarSignInStore): void {
  const patch: CalendarConfigPatcher = (next) => walnut.config.patch(next);
  const saveServer: SaveCalendarServer | undefined = broker ? (accountId, url) => broker.setCalendarServer(accountId, url) : undefined;

  walnut.http.route('post', '/mail-accounts/:accountId/calendar', async (request) => {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json<Record<string, unknown> | null>()) ?? {};
    } catch {
      body = {};
    }
    const address = typeof body.address === 'string' ? body.address : undefined;
    const server = typeof body.server === 'string' ? body.server : undefined;
    // Using a server Walnut found means the person saw that host and agreed: the password goes there.
    if (server !== undefined && !fromPersonHere(request)) {
      return { status: 403, json: { ok: false, reason: 'human-approval-required', message: 'Only the person at this Mac can approve a calendar server: Settings > Calendar > Add its calendar.' } };
    }
    try {
      const result = await addMailCalendar(resolve(), accountIdFrom(request), patch, { address, server, saveServer });
      const status = result.ok ? 200 : result.reason === 'usage' ? 400 : result.reason === 'server-not-offered' ? 409 : 200;
      return { status, json: result };
    } catch (err) {
      walnut.log.warn('adding a mail calendar failed', { error: String(err).slice(0, 200) });
      return { status: 502, json: { ok: false, reason: 'fetch-error', message: err instanceof Error ? err.message : String(err) } };
    }
  });

  walnut.http.route('delete', '/mail-accounts/:accountId/calendar', async (request) => {
    try {
      const service = resolve();
      const accountId = accountIdFrom(request);
      const result = await removeMailCalendar(service, accountId, patch);
      // Its sign-in goes with it (the provider is told when it can be): adding it again signs in again.
      if (signIns && ACCOUNT_ID_RE.test(accountId)) {
        clearCalendarSignInState(accountId);
        await signIns.forget(accountId).catch((err: unknown) => walnut.log.warn('forgetting a calendar sign-in failed', { error: String(err).slice(0, 200) }));
      }
      return { json: { ...result, sources: service.statuses() } };
    } catch (err) {
      return { status: 503, json: { error: err instanceof Error ? err.message : String(err) } };
    }
  });
}
