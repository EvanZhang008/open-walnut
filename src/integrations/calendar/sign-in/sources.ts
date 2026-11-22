/**
 * The calendar source of a mail account signed in with its provider: Google's calendars over
 * Google's CalDAV (the same CalDAV source as a mail server's, with the sign-in in place of the
 * password), Microsoft's through Graph. The sign-in is read from the store on every use, so a
 * new sign-in ("Sign in again") reaches a source already in place without rebuilding it.
 */
import { CalendarHelperError } from '../../../core/calendar/helper-error.js';
import { createCalDavSource } from '../caldav/source.js';
import type { FetchLike } from '../caldav/dav.js';
import { createGraphSource } from '../graph/source.js';
import type { CalendarSource } from '../types.js';
import { googleCalDavStart, graphBase } from './providers.js';
import type { CalendarSignInStore } from './store.js';

export function signedInCalendarSource(store: CalendarSignInStore, accountId: string, opts: { fetch?: FetchLike; localZone?: () => string } = {}): CalendarSource | null {
  const provider = store.providerOf(accountId);
  if (!provider) return null;
  const gone = () => new CalendarHelperError(`Walnut is not signed in to ${provider} for this calendar on this computer. Sign in again.`, 'needs-sign-in');
  if (provider === 'Microsoft') {
    return createGraphSource({
      accountId,
      fetch: opts.fetch,
      ...(opts.localZone ? { localZone: opts.localZone } : {}),
      signIn: async () => {
        const t = await store.read(accountId);
        return t ? { bearer: store.bearer(accountId, provider), address: t.email ?? t.address, base: graphBase() } : undefined;
      },
    });
  }
  return createCalDavSource({
    accountId,
    fetch: opts.fetch,
    credentials: async () => {
      const t = await store.read(accountId);
      if (!t) throw gone();
      const email = t.email ?? t.address;
      return { accountId, address: email, password: '', hosts: { caldav: googleCalDavStart(email) }, bearer: store.bearer(accountId, provider) };
    },
  });
}
