/**
 * Where a send stands, and what the card says about it.
 *
 * Two ids move independently here, which is the whole reason this is a reducer and not a switch on
 * one field: the DRAFT reports itself on `plugin:mail:draft-changed` and the ledger row reports
 * itself on `plugin:mail:send-settled`, they are separate emits, and they can arrive in either
 * order. A settled send is the more authoritative of the two (it is the row that talked to the
 * mail server), so a terminal send state WINS over whatever the draft last said: without that
 * rule, `send-settled unknown` landing before its `draft-changed` shows "Sending…" over a message
 * that may already be in somebody's mailbox.
 *
 * Pure and DOM-free: `tests/web/mail-compose-status.test.ts` drives event sequences through it.
 */
import type {
  MailAccountDto,
  MailDraftDto,
  MailDraftState,
  MailProviderSummary,
  MailSendDto,
  MailSendState,
} from '@/api/mail';
import { providerIdOf } from '@/api/mail';

/** What the composer pane shows. `composing` means the form, everything else means the card. */
export type SendPhase = 'composing' | 'waiting' | 'sending' | 'sent' | 'failed' | 'unknown' | 'discarded';

export interface SendStatus {
  phase: SendPhase;
  /** The revision this status is about. An event for an older one is ignored. */
  revision: number;
  /** The outstanding approval letter, while there is one. */
  letterId?: string;
  /** The ledger row being watched, which is what a retry names. */
  sendId?: string;
  sendState?: MailSendState;
  /** The server's own words about a failure. */
  error?: string;
  settledAt?: number;
  /**
   * Ledger rows this status has moved past, newest last.
   *
   * A retired row can still be DELIVERED: the bus redelivers, and a retry issues a fresh revision
   * whose row does not exist yet, so at that moment there is no `sendId` to compare an event
   * against. Without this list, a redelivered `send-settled failed` for the previous attempt turns
   * a fresh "Waiting for approval" into "Not sent". `send-settled` carries no revision (see
   * `MailSendSettledEvent`), so remembering the ids is the only way to tell.
   */
  retiredSends?: string[];
}

const TERMINAL_SEND: MailSendState[] = ['sent', 'failed', 'unknown'];

/** How many retired rows are remembered. A draft has one row per revision, so this is generous. */
const MAX_RETIRED = 8;

/**
 * The status a freshly loaded draft is in, taking its newest ledger row into account.
 *
 * "Newest" is by REVISION, not by `attemptedAt`: the ledger key is `<draftId>:<revision>` and it is
 * unique, so revision is a total order over a draft's attempts and it exists before the attempt
 * runs. `attemptedAt` is undefined on a row that has not been claimed yet, so ordering by it put a
 * brand new attempt behind a settled one. (`SendDto` carries no `createdAt` to tie-break with; the
 * send id is the last resort so the answer never depends on array order.)
 */
export function statusOfDraft(draft: MailDraftDto, sends: MailSendDto[] = []): SendStatus {
  const newest = [...sends].sort(compareSends)[0];
  const retired = sends
    .filter((one) => one.sendId !== newest?.sendId)
    .sort((a, b) => -compareSends(a, b))
    .map((one) => one.sendId);
  return {
    phase: phaseOf(draft.state, newest?.state),
    revision: draft.revision,
    ...(draft.letterId ? { letterId: draft.letterId } : {}),
    ...(newest ? { sendId: newest.sendId, sendState: newest.state } : {}),
    ...(newest?.error || draft.error ? { error: newest?.error || draft.error } : {}),
    ...(newest?.settledAt ? { settledAt: newest.settledAt } : {}),
    ...(retired.length ? { retiredSends: retired.slice(-MAX_RETIRED) } : {}),
  };
}

/**
 * A status rebuilt from a server answer, keeping the rows the old one had already moved past.
 *
 * Every send, retry and reload answer REPLACES the whole status, and `statusOfDraft` only knows the
 * ledger rows it was handed: a retry's answer carries none at all. Without this, the retry forgets
 * the row it just retired, and that row's redelivered `send-settled failed` lands as the fresh ask's
 * outcome ("Not sent" over a letter the human is being asked to approve).
 */
export function statusFollowing(
  previous: SendStatus,
  draft: MailDraftDto,
  sends: MailSendDto[] = [],
): SendStatus {
  const next = statusOfDraft(draft, sends);
  const retired = [...(previous.retiredSends ?? [])];
  if (previous.sendId) retired.push(previous.sendId);
  for (const id of next.retiredSends ?? []) retired.push(id);
  const kept = [...new Set(retired)].filter((id) => id !== next.sendId).slice(-MAX_RETIRED);
  return kept.length ? { ...next, retiredSends: kept } : next;
}

/** Newest first. */
function compareSends(a: MailSendDto, b: MailSendDto): number {
  if (b.revision !== a.revision) return b.revision - a.revision;
  if ((b.attemptedAt ?? 0) !== (a.attemptedAt ?? 0)) return (b.attemptedAt ?? 0) - (a.attemptedAt ?? 0);
  return b.sendId.localeCompare(a.sendId);
}

/**
 * A `draft-changed`.
 *
 * An event for an OLDER revision than the one on screen is dropped: the console may have PATCHed
 * since, and replaying the previous revision's state would flip the pane back under the human.
 */
export function reduceDraftChanged(
  status: SendStatus,
  event: { state: string; revision: number },
): SendStatus {
  if (event.revision < status.revision) return status;
  const next: SendStatus = { ...status, revision: event.revision };
  // A new revision is a new ledger key, so the previous attempt's row and error belong to a version
  // of this text that no longer exists. They go BEFORE the phase is resolved: resolving first would
  // fold the old attempt's `failed` into a fresh ask and the card would call it broken. The row is
  // RETIRED rather than forgotten, so its late event cannot come back as this revision's outcome.
  if (event.revision > status.revision) {
    if (next.sendId) next.retiredSends = [...(next.retiredSends ?? []), next.sendId].slice(-MAX_RETIRED);
    delete next.sendId;
    delete next.sendState;
    delete next.error;
    delete next.settledAt;
  }
  next.phase = phaseOf(event.state as MailDraftState, next.sendState);
  if (next.phase !== 'waiting') delete next.letterId;
  return next;
}

/** A `send-settled`. The ledger is what talked to the mail server, so it wins. */
export function reduceSendSettled(
  status: SendStatus,
  event: { sendId: string; state: string },
): SendStatus {
  const sendState = event.state as MailSendState;
  // Another draft's row never reaches here (the caller filters by draftId), but an OLD row of this
  // draft can, in two shapes. A row this status has already moved past is refused outright, whatever
  // it now says. A different row while the current outcome is already settled is refused too: the
  // settled one talked to the mail server, the other cannot un-say it.
  if (status.retiredSends?.includes(event.sendId)) return status;
  const settled = !!status.sendState && TERMINAL_SEND.includes(status.sendState);
  if (status.sendId && status.sendId !== event.sendId && settled) return status;
  return {
    ...status,
    sendId: event.sendId,
    sendState,
    phase: phaseOf(phaseAsDraftState(status.phase), sendState),
  };
}

/**
 * The draft state and the send state, resolved into one thing to show.
 *
 * `sending` covers `approved` too: the approval is minted and the attempt is next, and telling the
 * human "approved" would invite them to press something.
 *
 * A LEDGER ROW OUTRANKS `pending_approval`. The row only exists once the approval was minted, so
 * "Waiting for approval on your phone" over a live attempt is both wrong and an invitation to go
 * answer a letter that is already spent. The draft's own `draft-changed` may simply not have arrived
 * yet, which is the ordering this whole file exists for.
 */
export function phaseOf(draftState: MailDraftState, sendState?: MailSendState): SendPhase {
  if (sendState && TERMINAL_SEND.includes(sendState)) return sendState as SendPhase;
  if (draftState === 'sent' || draftState === 'failed' || draftState === 'unknown') return draftState;
  if (draftState === 'discarded') return 'discarded';
  if (draftState === 'approved' || draftState === 'sending') return 'sending';
  if (sendState) return 'sending';
  if (draftState === 'pending_approval') return 'waiting';
  return 'composing';
}

/** The card's own phase, read back as the draft state it implies. Keeps the reducer one function. */
function phaseAsDraftState(phase: SendPhase): MailDraftState {
  switch (phase) {
    case 'waiting': return 'pending_approval';
    case 'sending': return 'sending';
    case 'sent': return 'sent';
    case 'failed': return 'failed';
    case 'unknown': return 'unknown';
    case 'discarded': return 'discarded';
    default: return 'composing';
  }
}

/** The one line at the top of the card. */
export function statusHeadline(status: SendStatus): string {
  switch (status.phase) {
    case 'waiting': return 'Waiting for approval on your phone';
    case 'sending': return 'Sending…';
    case 'sent': return status.settledAt ? `Sent at ${clockOf(status.settledAt)}` : 'Sent';
    case 'failed': return 'Not sent';
    case 'unknown': return 'Walnut cannot tell whether this was sent';
    case 'discarded': return 'Discarded';
    default: return 'Draft';
  }
}

/** The sentence under the headline. `unknown` is the one that has to be exact. */
export function statusDetail(status: SendStatus): string {
  switch (status.phase) {
    case 'waiting':
      return 'Your phone has a letter showing exactly this message. Answering Send sends it.';
    case 'sending':
      return 'Walnut is handing it to the mail server.';
    case 'sent':
      return 'It is on its way, and it appears in Sent once the provider files its copy.';
    case 'failed':
      return status.error || 'The mail server refused it before any of the message was sent.';
    case 'unknown':
      return 'The server may or may not have sent this. Check the Sent folder before trying again.';
    default:
      return '';
  }
}

/** `HH:MM` in the human's own clock. Mail stamps are instants, never wall time. */
export function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Whether a phase still shows the form rather than the card. */
export function isComposingPhase(phase: SendPhase): boolean {
  return phase === 'composing';
}

/** A retry is offered for `failed` only. `unknown` may never be retried: SMTP has no dedupe. */
export function canRetry(status: SendStatus): boolean {
  return status.phase === 'failed' && !!status.sendId;
}

/** The pill a drafts row shows. One word per state, and a colour per word in the css. */
export const DRAFT_STATE_LABEL: Record<MailDraftState, string> = {
  composing: 'Draft',
  pending_approval: 'Waiting',
  approved: 'Sending',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  unknown: 'Unknown',
  discarded: 'Discarded',
};

/** The states the Drafts row counts: everything a human still has to finish. */
export const OPEN_DRAFT_STATES: MailDraftState[] = ['composing', 'pending_approval', 'failed', 'unknown'];

export function isOpenDraft(draft: MailDraftDto): boolean {
  return OPEN_DRAFT_STATES.includes(draft.state);
}

/**
 * Whether this account may be offered a compose button.
 *
 * The ACCOUNT's own answer wins when the server sent one. `MailAccountDto.capabilities` carries the
 * provider's per-account verdict (`accountCapabilities`, which exists precisely because one IMAP
 * account may have SMTP settings and another may not), so an account that cannot send no longer
 * gets a Send button that was only ever going to fail.
 *
 * The provider-level flag stays as the fallback, for a provider with no per-account answer and for a
 * tab that was open across the deploy which added the field. The fine answer still arrives as a 409
 * `unsupported` from the send itself, which the composer shows verbatim.
 */
export function canSendFrom(
  providers: MailProviderSummary[],
  accountId: string | undefined,
  accounts?: MailAccountDto[],
): boolean {
  if (!accountId) return false;
  const account = accounts?.find((one) => one.accountId === accountId);
  if (account?.capabilities) return account.capabilities.send;
  const provider = providers.find((one) => one.id === providerIdOf(accountId));
  return !!provider?.capabilities.send;
}

export const CANNOT_SEND_TITLE = 'This account cannot send; add SMTP settings';
