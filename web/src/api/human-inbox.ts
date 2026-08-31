/**
 * Human Inbox API client — letters from agents to the human.
 *
 * Mirrors the frozen route contract (docs/plan/human-inbox.md P1):
 *   GET  /api/v1/human-inbox[?archived=1]     envelopes (no bodies)
 *   GET  /api/v1/human-inbox/:id              record + body + thread bodies
 *   POST /api/v1/human-inbox/:id/read|pin|archive
 *   POST /api/v1/human-inbox/:id/answer       { actionId, freeText? }
 *   POST /api/v1/human-inbox/:id/human-reply  { text }
 *
 * The LETTER STORE is canonical for read/pin/archive/answered — the notification
 * envelope in the feed only mirrors it. So every surface reads state from here,
 * never from the notification record.
 */
import { apiGet, apiPost } from './client';

export type LetterType = 'completion' | 'action_required' | 'review' | 'info';
export type LetterBodyFormat = 'html' | 'markdown';

export interface LetterAction {
  id: string;
  label: string;
  description?: string;
}

/** Stamped server-side from the caller's session id — an agent can't forge it. */
export interface LetterSender {
  sessionId: string;
  sessionTitle?: string;
  taskId?: string;
  taskTitle?: string;
  project?: string;
  host: string;
}

export interface LetterAnswer {
  actionId: string;
  label: string;
  freeText?: string;
  at: number;
}

export interface LetterThreadEntry {
  from: 'agent' | 'human';
  text: string;
  bodyFormat?: LetterBodyFormat;
  bodyFile?: string;
  at: number;
  /** Rich body content, present only on GET /:id (the list omits all bodies). */
  body?: string;
  /** Size of this turn's document on disk. */
  bodyBytes?: number;
  /** Too big to inline — stream the document from `bodyUrl` instead. */
  bodyDeferred?: boolean;
  bodyUrl?: string;
}

/** Index record — what the envelope rows render. No body content. */
export interface LetterEnvelope {
  id: string;
  subject: string;
  type: LetterType;
  bodyFormat: LetterBodyFormat;
  textPreview: string;
  sender: LetterSender;
  createdAt: number;
  read: boolean;
  pinned: boolean;
  archived: boolean;
  actions?: LetterAction[];
  answered?: LetterAnswer;
  thread?: LetterThreadEntry[];
  /** Task ids the letter cites — rendered as the usual task pills. */
  taskRefs?: string[];
}

/** GET /:id — the envelope plus the resolved body + thread body contents. */
export interface LetterDetail extends LetterEnvelope {
  /**
   * The document, inline. EMPTY when the server deferred it because it was over
   * LETTER_INLINE_BODY_MAX_BYTES — a 100MB digest never rides this JSON. Check
   * `bodyDeferred` and render from `bodyUrl` in that case.
   */
  body: string;
  thread: LetterThreadEntry[];
  /** The body file is gone; `body` then holds the server's inline note. */
  bodyMissing?: boolean;
  /** Size of the document on disk, whether inlined or deferred. */
  bodyBytes?: number;
  /** The document was too big to inline — stream it from `bodyUrl`. */
  bodyDeferred?: boolean;
  /** Streaming route for the document (`…/:id/body`), same origin. */
  bodyUrl?: string;
}

/**
 * How far a human reply/answer got toward the origin session.
 *
 * `skipped` is NOT a failure: an `external` sender (a hand-started agent) has no
 * session to deliver to, and the answer is still recorded in the thread.
 * `deferred` is not one either: the origin session is parked on a permission
 * prompt, so the answer waits in its queue instead of auto-denying that prompt.
 */
export type LetterDeliveryStatus = 'delivered' | 'queued' | 'deferred' | 'skipped' | 'failed' | 'unknown';

export interface LetterActionResult {
  delivery: LetterDeliveryStatus;
  /** Machine-readable why, for skipped/failed (mapped to human text by the UI). */
  reason?: string;
  letter?: LetterDetail;
}

const BASE = '/api/v1/human-inbox';

type Json = Record<string, unknown>;

const asRecord = (v: unknown): Json => (v && typeof v === 'object' ? v as Json : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Unwrap a list response. The route returns the envelope array; accept the
 * common wrapper shapes too so a wrapped payload degrades to "renders fine"
 * instead of "inbox looks empty".
 */
function unwrapList(raw: unknown): LetterEnvelope[] {
  if (Array.isArray(raw)) return raw as LetterEnvelope[];
  const obj = asRecord(raw);
  for (const key of ['letters', 'items', 'feed', 'data']) {
    const v = obj[key];
    if (Array.isArray(v)) return v as LetterEnvelope[];
  }
  return [];
}

/** The body text of a letter or thread entry, whichever field carries it. */
function pickBody(o: Json): string {
  return str(o.body) ?? str(o.bodyContent) ?? str(o.html) ?? str(o.markdown) ?? '';
}

function normalizeDetail(raw: unknown): LetterDetail {
  const outer = asRecord(raw);
  // `{ letter: {...}, body, thread }` and a flat record are both accepted; the
  // body/thread always win from the outer object when it carries them.
  const inner = asRecord(outer.letter ?? outer);
  const record = { ...inner, ...(outer.letter ? outer : {}) } as Json;
  const threadRaw = Array.isArray(record.thread) ? record.thread : [];
  const thread: LetterThreadEntry[] = threadRaw.map((e) => {
    const entry = asRecord(e);
    const body = pickBody(entry);
    return {
      from: entry.from === 'human' ? 'human' : 'agent',
      text: str(entry.text) ?? '',
      at: typeof entry.at === 'number' ? entry.at : 0,
      ...(entry.bodyFormat === 'html' || entry.bodyFormat === 'markdown'
        ? { bodyFormat: entry.bodyFormat as LetterBodyFormat } : {}),
      ...(str(entry.bodyFile) ? { bodyFile: str(entry.bodyFile) } : {}),
      ...(body ? { body } : {}),
      ...(typeof entry.bodyBytes === 'number' ? { bodyBytes: entry.bodyBytes } : {}),
      ...(entry.bodyDeferred === true ? { bodyDeferred: true } : {}),
      ...(str(entry.bodyUrl) ? { bodyUrl: str(entry.bodyUrl) } : {}),
    };
  });
  return {
    ...(record as unknown as LetterEnvelope),
    body: pickBody(record),
    thread,
    ...(typeof record.bodyBytes === 'number' ? { bodyBytes: record.bodyBytes } : {}),
    ...(record.bodyDeferred === true ? { bodyDeferred: true } : {}),
    ...(str(record.bodyUrl) ? { bodyUrl: str(record.bodyUrl) } : {}),
  };
}

const DELIVERY_STATUSES = new Set(['delivered', 'queued', 'deferred', 'skipped', 'failed']);

/**
 * Map the write routes' `{ letter, delivery }` into one delivery vocabulary.
 * The server sends `delivery` as an OBJECT (`{status, reason?, sessionId?,
 * messageId?}`); a bare string is accepted too so an older/relayed payload still
 * reads as a status instead of silently becoming 'unknown'.
 */
function normalizeResult(raw: unknown): LetterActionResult {
  const o = asRecord(raw);
  const d = asRecord(o.delivery);
  const status = str(d.status) ?? str(o.delivery) ?? str(o.deliveryStatus);
  const delivery: LetterDeliveryStatus = status && DELIVERY_STATUSES.has(status)
    ? status as LetterDeliveryStatus
    : 'unknown';
  const reason = str(d.reason) ?? str(o.deliveryError);
  return {
    delivery,
    ...(reason ? { reason } : {}),
    ...(o.letter ? { letter: normalizeDetail(o) } : {}),
  };
}

/** Human text for a delivery outcome — the reader shows it non-blocking. */
export function deliveryText(delivery: LetterDeliveryStatus, reason?: string): string {
  switch (delivery) {
    case 'queued':
    case 'delivered':
      return 'Sent to the agent';
    case 'deferred':
      return 'Queued — the agent is waiting on a permission prompt, so your answer '
        + 'reaches it when that prompt is resolved';
    case 'skipped':
      return reason === 'origin_session_gone'
        ? 'Saved — the sending session is gone, so nothing was delivered'
        : 'Saved — this letter has no origin session to answer';
    case 'failed':
      return 'Saved, but delivery to the agent failed';
    default:
      return 'Saved';
  }
}

/** Envelope list, newest first is NOT guaranteed by the server — callers sort. */
export async function listLetters(
  opts?: { archived?: boolean; signal?: AbortSignal },
): Promise<LetterEnvelope[]> {
  const raw = await apiGet<unknown>(
    BASE,
    opts?.archived ? { archived: '1' } : undefined,
    { signal: opts?.signal, timeoutMs: 12_000 },
  );
  return unwrapList(raw);
}

export async function getLetter(id: string, opts?: { signal?: AbortSignal }): Promise<LetterDetail> {
  const raw = await apiGet<unknown>(
    `${BASE}/${encodeURIComponent(id)}`,
    undefined,
    { signal: opts?.signal, timeoutMs: 15_000 },
  );
  return normalizeDetail(raw);
}

export async function setLetterRead(id: string, read: boolean): Promise<void> {
  await apiPost(`${BASE}/${encodeURIComponent(id)}/read`, { read });
}

export async function setLetterPinned(id: string, pinned: boolean): Promise<void> {
  await apiPost(`${BASE}/${encodeURIComponent(id)}/pin`, { pinned });
}

export async function setLetterArchived(id: string, archived: boolean): Promise<void> {
  await apiPost(`${BASE}/${encodeURIComponent(id)}/archive`, { archived });
}

/** Click ONE action button. 409 = already answered (the store is the referee). */
export async function answerLetter(
  id: string,
  actionId: string,
  freeText?: string,
): Promise<LetterActionResult> {
  const raw = await apiPost<unknown>(`${BASE}/${encodeURIComponent(id)}/answer`, {
    actionId,
    ...(freeText ? { freeText } : {}),
  });
  return normalizeResult(raw);
}

/** Free-text reply from the human — threads under the letter and is delivered. */
export async function humanReplyToLetter(id: string, text: string): Promise<LetterActionResult> {
  const raw = await apiPost<unknown>(`${BASE}/${encodeURIComponent(id)}/human-reply`, { text });
  return normalizeResult(raw);
}

/** Sort order for the inbox: pinned first, then newest. */
export function compareLetters(a: LetterEnvelope, b: LetterEnvelope): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  return (b.createdAt ?? 0) - (a.createdAt ?? 0);
}

/** An action_required letter nobody has answered yet — a real to-do. */
export function isAwaitingDecision(l: LetterEnvelope): boolean {
  return l.type === 'action_required' && !l.answered && !l.archived;
}

/**
 * A letter that PROMISED a decision and carries nothing to decide with.
 *
 * The server now refuses to accept one, so this only ever matches a letter
 * already on disk. It still has to be named, because the reader used to gate the
 * whole decision block on `actions.length > 0` and so showed an "Action needed"
 * badge above a document with no way to answer it.
 */
export function isDecisionWithoutOptions(l: LetterEnvelope): boolean {
  return l.type === 'action_required' && (l.actions?.length ?? 0) === 0 && !l.answered;
}

export const LETTER_TYPE_LABEL: Record<LetterType, string> = {
  completion: 'Completed',
  action_required: 'Action needed',
  review: 'Review',
  info: 'Info',
};
