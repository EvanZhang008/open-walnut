/**
 * A meeting invite in the reader: when it is, where, what you answered, and Accept / Tentative /
 * Decline.
 *
 * The calendar is asked every time the card mounts (the reader keys its header on the message), never
 * cached here: an answer given on the phone or a moved meeting changes the calendar without changing
 * the mail. The buttons are live from the first frame, before that read lands, because the server
 * finds the meeting itself when it answers; a person who opened an invite to accept it should not wait
 * on a calendar read to be allowed to click.
 *
 * An answer is a write the organizer sees, so a click is sent exactly once and every button is
 * disabled until it settles. A 202 (still sending) is followed by a few reads of the calendar until it
 * shows the answer; a failure re-reads the calendar too, because a write that failed half way may
 * still have landed and only the calendar can say.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  answerMailInvite,
  mailFailure,
  readMailInvite,
  type MailInviteDetails,
  type MailInviteResponse,
} from '@/api/mail';
import { log } from '@/utils/log';
import { CalendarIcon } from './mail-icons';
import { INVITE_BUTTONS, answeredAs, inviteAnswerLine, inviteWhen } from './mail-invite-state';

interface Props {
  accountId: string;
  messageId: string;
  kind: 'request' | 'canceled';
}

/** How many times a still-checking calendar read is asked again, and how far apart. */
const PENDING_TRIES = 5;
const PENDING_GAP_MS = 2_500;
/**
 * How many times an answer still on its way is asked about. Past the server's 60s answer deadline,
 * which always ends the "answering" state, so the buttons never stay locked on a lost answer.
 */
const SETTLE_TRIES = 30;

export function MailInviteCard({ accountId, messageId, kind }: Props) {
  const [details, setDetails] = useState<MailInviteDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [answering, setAnswering] = useState<MailInviteResponse | null>(null);
  /** A warning about the last answer: not confirmed, or still on its way. */
  const [note, setNote] = useState<string | null>(null);
  /** The last answer from THIS card landed: the status line says so with a tick. */
  const [confirmed, setConfirmed] = useState(false);
  const alive = useRef(true);
  // Set on mount as well as cleared on unmount: a development double mount runs the cleanup once.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /** Read the calendar, asking again while the server says it is still checking. */
  const load = useCallback(async (
    until?: (seen: MailInviteDetails) => boolean,
    tries = PENDING_TRIES,
  ): Promise<MailInviteDetails | null> => {
    setChecking(true);
    setLoadError(null);
    for (let attempt = 0; attempt < tries; attempt += 1) {
      try {
        const answer = await readMailInvite(accountId, messageId);
        if (!alive.current) return null;
        if (answer.invite && (!until || until(answer.invite))) {
          setDetails(answer.invite);
          setChecking(false);
          return answer.invite;
        }
        if (answer.invite) setDetails(answer.invite);
      } catch (error) {
        if (!alive.current) return null;
        const failure = mailFailure(error);
        log.warn('mail', 'invite read failed', { accountId, messageId, error: failure.message });
        setLoadError(failure.message);
        setChecking(false);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, PENDING_GAP_MS));
      if (!alive.current) return null;
    }
    setChecking(false);
    return null;
  }, [accountId, messageId]);

  useEffect(() => { void load(); }, [load]);

  // An answer sent from elsewhere (another tab, or this card before the reader was reopened) is still
  // on its way: show it as sending, and read again until it settles, so nobody is invited to click twice.
  const elsewhere = answering ? undefined : details?.answering;
  useEffect(() => {
    if (!elsewhere) return;
    void load((seen) => !seen.answering, SETTLE_TRIES).then((settled) => {
      if (!settled || !alive.current) return;
      // It landed or it did not; either way a "still sending" warning is over, and the status line
      // now holds the calendar's answer.
      if (settled.response === answeredAs(elsewhere)) {
        setNote(null);
        setConfirmed(true);
      } else {
        setNote('Your answer was not confirmed. The calendar still shows the answer above.');
      }
    });
  }, [elsewhere, load]);

  const answer = async (response: MailInviteResponse) => {
    if (answering) return;
    setAnswering(response);
    setNote(null);
    setConfirmed(false);
    log.info('mail', 'invite answer sending', { accountId, messageId, response });
    try {
      const sent = await answerMailInvite(accountId, messageId, response);
      if (!alive.current) return;
      if (sent.invite) {
        setDetails(sent.invite);
        setConfirmed(true);
        return;
      }
      // 202: still sending. Read until the server stops reporting it in flight, then trust the calendar.
      const settled = await load((seen) => !seen.answering, SETTLE_TRIES);
      if (!alive.current) return;
      if (settled?.response === answeredAs(response)) setConfirmed(true);
      else if (settled) setNote('Your answer was not confirmed. The calendar still shows the answer above.');
      else setNote('Walnut is still sending your answer. Check again in a moment.');
    } catch (error) {
      if (!alive.current) return;
      const failure = mailFailure(error);
      log.warn('mail', 'invite answer failed', { accountId, messageId, response, error: failure.message });
      setNote(`Your answer was not confirmed: ${failure.message}`);
      void load();
    } finally {
      if (alive.current) setAnswering(null);
    }
  };

  const when = details ? inviteWhen(details) : '';
  // Live before the calendar read lands (see the file comment), and after it only when it says so.
  const offerButtons = details ? details.canRespond : kind === 'request' && !loadError;
  const canceled = details?.state === 'canceled' || (!details && kind === 'canceled');
  const status = canceled
    ? 'This meeting was canceled.'
    : details
      ? [
        details.recurring ? 'Repeats' : '',
        details.state === 'open' && details.response && details.response !== 'organizer'
          ? inviteAnswerLine(details.response)
          : '',
      ]
        .filter(Boolean).join(' · ')
      : '';

  return (
    <section
      className="mail-invite"
      data-testid="mail-invite"
      data-state={details?.state ?? (canceled ? 'canceled' : checking ? 'checking' : 'unknown')}
      data-response={details?.response ?? ''}
      aria-label="Meeting invite"
    >
      <span className="mail-invite-glyph" aria-hidden="true"><CalendarIcon /></span>
      <div className="mail-invite-text">
        <p className="mail-invite-when" data-testid="mail-invite-when">
          {when || (checking && !details ? 'Checking your calendar…' : 'Meeting invite')}
        </p>
        {details?.location && (
          <p className="mail-invite-where" data-testid="mail-invite-where" title={details.location}>
            {details.location}
          </p>
        )}
        {status && (
          <p
            className="mail-invite-status"
            data-testid="mail-invite-status"
            {...(confirmed && !canceled ? { 'data-confirmed': 'true', role: 'status' } : {})}
          >
            {status}
          </p>
        )}
        {details?.reason && !details.canRespond && !canceled && (
          <p className="mail-invite-reason" data-testid="mail-invite-reason">{details.reason}</p>
        )}
        {loadError && (
          <p className="mail-invite-reason" data-testid="mail-invite-load-error">
            Could not check your calendar: {loadError}{' '}
            <button type="button" className="mail-invite-link" onClick={() => { void load(); }}>Try again</button>
          </p>
        )}
        {note && (
          <p className="mail-invite-note" data-testid="mail-invite-note" role="status">
            {note}
          </p>
        )}
      </div>
      {offerButtons && !canceled && (
        <div className="mail-invite-actions" role="group" aria-label="Answer this invite">
          {INVITE_BUTTONS.map((button) => {
            const chosen = details?.response === answeredAs(button.response);
            const busy = (answering ?? elsewhere) === button.response;
            return (
              <button
                key={button.response}
                type="button"
                className={`mail-invite-btn${chosen ? ' chosen' : ''}`}
                data-testid={`mail-invite-${button.response}`}
                data-response={button.response}
                aria-pressed={chosen}
                aria-busy={busy || undefined}
                disabled={answering !== null || !!elsewhere}
                onClick={() => { void answer(button.response); }}
              >
                {busy && <span className="mail-reader-unsub-spin" aria-hidden="true" />}
                {busy ? button.busy : button.label}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
