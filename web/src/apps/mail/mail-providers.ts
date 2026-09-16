/**
 * The provider list, and the difference between "there are none" and "we never got the list".
 *
 * Every capability the console gates on (mark read, send, the add-an-account form) is DATA from
 * `/providers`, never a guess: a provider that cannot change a flag answers 409, and pretending
 * otherwise makes the mailbox drift from what every other mail client shows. That is right, and it
 * had one hole. A FAILED read left `providers: []`, which is exactly what a healthy empty list looks
 * like, so a tab that opened while the mail plugin was still starting — `Not found: GET
 * /api/plugins/mail/providers`, seen in the wild on 2026-09-16 — decided for the rest of its life
 * that nothing could mark anything read. Clicking a message then did nothing: no request, no error,
 * no visible change. The list only ever reloaded on a `providers-changed` event, and no event comes
 * for a registration that already happened.
 *
 * So the answer has three states, and the third one asks rather than assumes: `providerFor` re-reads
 * the list once when it does not know, and tells the caller whether the answer can be trusted.
 *
 * It lives in its own file because both the action layer and the read-flag layer need it, and
 * `mail-read-flag.ts` importing `mail-actions.ts` (which imports it back) would be a cycle.
 */
import { listMailProviders, mailFailure, providerIdOf, type MailProviderSummary } from '@/api/mail';
import { log } from '@/utils/log';
import { patch, run, store } from './mail-store';

export interface ProviderAnswer {
  provider?: MailProviderSummary;
  /** A `/providers` answer landed, so an absent provider means it really is not registered. */
  known: boolean;
}

/** Read the list. One request at a time; `force` re-reads even when one is already in flight. */
export function loadProviders(force = false): Promise<void> {
  return run('providers', async () => {
    try {
      const answer = await listMailProviders();
      patch({ providers: answer.providers ?? [], providersKnown: true });
    } catch (error) {
      // Left UNKNOWN on purpose: `providers` keeps whatever it had, and the next caller that needs
      // a capability will ask again instead of reading this failure as "there are no providers".
      log.warn('mail', 'provider list failed', { error: mailFailure(error).message });
    }
  }, force);
}

/**
 * Should a read-flag control be OFFERED for this account? Synchronous, for a render.
 *
 * A provider that says no gets no control. An answer nobody has yet gets one anyway: hiding it is
 * the same silent dead end as the click that did nothing, and the click itself asks again before it
 * sends anything (`mayMarkRead` in mail-read-flag.ts).
 */
export function mayOfferMarkRead(providers: MailProviderSummary[], accountId: string): boolean {
  const provider = providers.find((one) => one.id === providerIdOf(accountId));
  if (provider) return provider.capabilities.markRead === true;
  return !store.state.providersKnown;
}

/** The provider behind an account id, re-reading the list once when it is not known yet. */
export async function providerFor(accountId: string): Promise<ProviderAnswer> {
  const find = () => store.state.providers.find((one) => one.id === providerIdOf(accountId));
  const held = find();
  if (held) return { provider: held, known: true };
  // The list DID land and this provider is not in it: it really is gone, and no re-read will find it.
  if (store.state.providersKnown) return { known: true };
  await loadProviders(true);
  const after = find();
  return { ...(after ? { provider: after } : {}), known: store.state.providersKnown };
}
