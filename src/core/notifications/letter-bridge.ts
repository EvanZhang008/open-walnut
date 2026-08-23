/**
 * Human Inbox → notification bridge.
 *
 * A letter IS a notification, just one whose body is a document. So every letter
 * gets an ENVELOPE record in the notification feed (kind 'letter', dedupKey
 * `letter:<id>`, `letterId` pointing at the document) and shows up on the bell
 * next to permissions and cron lines — while the body, thread and the canonical
 * read/pin/archive state stay in the letter store, which is durable and unbounded.
 *
 * Why an envelope at all instead of one more list the UI has to poll: the bell
 * count, the rail sections, the WS live feed and the iOS notification list are
 * already built on this store. Mirroring the envelope buys the whole existing
 * surface for one small record per letter.
 *
 * Condition-system fit (see the notification store's `resolved` doc): a letter
 * ends only by HUMAN action, so it carries no recoveryKey and no expiry — the
 * error sweeps (recoverNotifications / expireErrorNotifications /
 * expireKeylessErrorNotifications) all filter on kind 'operation-error' and the
 * permission sweep on kind 'permission', so none of them can ever touch a letter.
 *
 * Wiring: `ensureLetterBridge()` is idempotent and is called by the letter store
 * before it emits (server.ts is off-limits for this change, and the store is the
 * only thing that can produce a letter event — so "the store is loaded" is
 * exactly the moment the bridge must exist). Tests install it directly.
 */

import { bus, eventData, EventNames, type BusEvent } from '../event-bus.js';
import type { HumanInboxLetterEvent } from '../event-types.js';
import { addNotification, updateLetterNotification, type NewNotification } from './store.js';
import { log } from '../../logging/index.js';

type Broadcast = (name: string, data: unknown) => void;

/** Bus subscriber name. Non-global: letter events are emitted to '*'. */
const SUBSCRIBER = 'human-inbox-letters';

/** Same read-time bounds the rest of the feed uses. */
const MAX_TITLE = 200;
const MAX_BODY = 600;

/**
 * A sender the route could not resolve to a real session (a hand-started agent).
 * Kept OFF the record's `sessionId` so the UI never renders a deep link into a
 * session that does not exist — the envelope still shows host + subject.
 */
const EXTERNAL_SENDER_SID = 'external';

let installed = false;
let explicitBroadcast: Broadcast | null = null;
let wsBroadcast: Broadcast | null = null;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cap(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Push a record to connected UIs so the bell updates without a refresh.
 *
 * The WS broadcaster is resolved lazily (and only when no explicit one was
 * supplied) so this module stays importable from core/CLI contexts that never
 * boot a web server, and so tests can install a spy instead.
 */
async function broadcast(name: string, data: unknown): Promise<void> {
  try {
    if (explicitBroadcast) {
      explicitBroadcast(name, data);
      return;
    }
    if (!wsBroadcast) {
      const mod = await import('../../web/ws/handler.js');
      wsBroadcast = mod.broadcastEvent;
    }
    wsBroadcast(name, data);
  } catch (err) {
    // No WS layer in this process is normal, not an error.
    log.notif.debug('human-inbox bridge: broadcast unavailable', { error: errMsg(err) });
  }
}

/** The envelope record for a letter. Severity is always 'info': a letter is
 *  correspondence, and its urgency is carried by its TYPE (the Needs Action rail
 *  reads `action_required`), not by dressing the card up as an error. */
function envelopeFor(data: HumanInboxLetterEvent): NewNotification {
  const sessionId = data.senderSessionId && data.senderSessionId !== EXTERNAL_SENDER_SID
    ? data.senderSessionId
    : undefined;
  return {
    kind: 'letter',
    severity: 'info',
    title: cap(data.subject, MAX_TITLE) ?? 'Letter',
    dedupKey: `letter:${data.letterId}`,
    letterId: data.letterId,
    ...(cap(data.textPreview, MAX_BODY) ? { body: cap(data.textPreview, MAX_BODY) } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(data.senderTitle ? { sessionTitle: data.senderTitle } : {}),
    ...(data.host ? { host: data.host } : {}),
  };
}

async function handleLetterEvent(data: HumanInboxLetterEvent): Promise<void> {
  if (!data?.letterId) return;

  if (data.kind === 'reply') {
    // The agent answered in the thread: refresh the preview and make it unread
    // again (that is news), and bump it so the cap keeps the live thread.
    const preview = cap(data.textPreview, MAX_BODY);
    const updated = await updateLetterNotification(data.letterId, {
      // An empty preview leaves the previous body alone rather than blanking it.
      ...(preview ? { body: preview } : {}),
      read: false,
      bump: true,
    });
    if (updated) {
      await broadcast('notification:updated', updated);
      return;
    }
    // No envelope: the record was dismissed, or evicted before letters were
    // cap-protected. The letter itself is still live, so re-create the envelope
    // rather than leaving a thread the bell can never mention again.
  }

  const record = await addNotification(envelopeFor(data));
  log.notif.info('human-inbox: envelope notification', {
    letterId: data.letterId, kind: data.kind, notificationId: record.id,
  });
  await broadcast('notification:new', record);
}

/**
 * Mirror the letter store's read flag onto the envelope.
 *
 * Read state is CANONICAL in the letter store (the human reads a document, not a
 * card), so this is one-directional. Never throws and never rejects: callers fire
 * it and forget, and losing the mirror must not fail the read itself.
 */
export async function mirrorLetterReadState(letterId: string, read: boolean): Promise<void> {
  try {
    const updated = await updateLetterNotification(letterId, { read });
    if (updated) await broadcast('notification:updated', updated);
  } catch (err) {
    log.notif.warn('human-inbox bridge: failed to mirror letter read state', {
      letterId, read, error: errMsg(err),
    });
  }
}

/**
 * Install the bridge (idempotent). Safe to call on every letter operation.
 * Passing a `broadcast` replaces the lazily-resolved WS one (tests, or a future
 * caller that owns its own fan-out).
 */
export function ensureLetterBridge(opts: { broadcast?: Broadcast } = {}): void {
  if (opts.broadcast) explicitBroadcast = opts.broadcast;
  if (installed && bus.has(SUBSCRIBER)) return;

  bus.subscribe(
    SUBSCRIBER,
    (event: BusEvent) => {
      const data = eventData<typeof EventNames.HUMAN_INBOX_LETTER>(event) as HumanInboxLetterEvent;
      // Deliberately fire-and-forget with an internal catch: the bus dispatch is
      // synchronous, and a throw here would be logged as an error — which the
      // log-error bridge turns into ANOTHER notification.
      void handleLetterEvent(data).catch((err) => {
        log.notif.warn('human-inbox bridge: failed to write envelope notification', {
          letterId: data?.letterId, error: errMsg(err),
        });
      });
    },
    (event: BusEvent) => event.name === EventNames.HUMAN_INBOX_LETTER,
  );
  installed = true;
}

/** Remove the bridge (tests / shutdown). */
export function uninstallLetterBridge(): void {
  bus.unsubscribe(SUBSCRIBER);
  installed = false;
  explicitBroadcast = null;
  wsBroadcast = null;
}
