/**
 * Human Inbox — the record shapes for letters from agents to the human.
 *
 * A letter is a notification whose body is a DOCUMENT: the agent writes subject
 * + body once, well, for a human reader, and the human reads/replies/pins/
 * archives it. The envelope (who sent it, from which task/host) is stamped
 * server-side from the caller's session id, never written by the agent.
 *
 * Frozen contract: docs/plan/human-inbox-todo.md → "Letter record (store)".
 */

/** WHY the letter exists. Drives how the UI treats it (badges, Needs Action). */
export type LetterType = 'completion' | 'action_required' | 'review' | 'info';

/** Body is either ready-made HTML or markdown the reader renders. */
export type LetterBodyFormat = 'html' | 'markdown';

/** A one-click decision the reader renders as a button (action_required only). */
export interface LetterAction {
  id: string;
  label: string;
  description?: string;
}

/** Stamped server-side from the caller's session id — agents cannot set this. */
export interface LetterSender {
  sessionId: string;
  sessionTitle?: string;
  taskId?: string;
  taskTitle?: string;
  project?: string;
  host: string;
}

/** The human's answer to an `action_required` letter. */
export interface LetterAnswer {
  actionId: string;
  label: string;
  freeText?: string;
  at: number;
}

/**
 * One turn in the letter's conversation. `text` is always present (the plain
 * fallback shown in the thread); `bodyFile` + `bodyFormat` exist only when the
 * turn carried a rich body, stored beside the letter as `<id>.r<n>.<ext>`.
 */
export interface ThreadEntry {
  from: 'agent' | 'human';
  text: string;
  bodyFormat?: LetterBodyFormat;
  bodyFile?: string;
  at: number;
}

/** The index record. Bodies live in their own files, never in here. */
export interface LetterRecord {
  /** `lt-<timestamp36>-<rand>` */
  id: string;
  subject: string;
  type: LetterType;
  bodyFormat: LetterBodyFormat;
  /** <= 300 chars of plain text, for the envelope row and the phone push. */
  textPreview: string;
  sender: LetterSender;
  createdAt: number;
  read: boolean;
  pinned: boolean;
  archived: boolean;
  actions?: LetterAction[];
  answered?: LetterAnswer;
  thread: ThreadEntry[];
  /** Task ids the letter cites; the reader renders them as task pills. */
  taskRefs?: string[];
}

/** What a caller supplies to sendLetter. id/createdAt/state are stamped here. */
export interface NewLetter {
  subject: string;
  type: LetterType;
  /** Exactly one of html | markdown — see letterFieldMaxBytes for the caps. */
  html?: string;
  markdown?: string;
  /** Short plain-text preview; derived from the body when absent. */
  text?: string;
  /** action_required only. */
  actions?: LetterAction[];
  /** Accepts either spelling — the op/route body uses `task_refs`. */
  taskRefs?: string[];
  task_refs?: string[];
  pin?: boolean;
  /** Stamped by the route from the caller's sid, not by the agent. */
  sender: LetterSender;
}

/** A rich thread reply from the origin agent. */
export interface AgentReplyInput {
  html?: string;
  markdown?: string;
  text: string;
}

/** A letter plus the body content read off disk (what the reader needs). */
export interface LetterThreadEntry extends ThreadEntry {
  /** Body content for a rich turn; absent when the turn was plain text. */
  body?: string;
  /** True when `bodyFile` was recorded but is gone from disk. */
  bodyMissing?: boolean;
}

export interface LetterDetail extends LetterRecord {
  body: string;
  /** True when the body file is gone — `body` then holds an inline note. */
  bodyMissing?: boolean;
  thread: LetterThreadEntry[];
}

/** Envelope list + the unread count the bell/rail badge shows. */
export interface LetterList {
  letters: LetterRecord[];
  unreadCount: number;
}

export const LETTER_TYPES: readonly LetterType[] = [
  'completion',
  'action_required',
  'review',
  'info',
];

/**
 * Cap for the PLAIN fields — a markdown body, a thread turn's text, an answer's
 * note. Prose written for one phone screen; anything this big is already a
 * file's job.
 */
export const LETTER_BODY_MAX_BYTES = 200 * 1024;

/**
 * Cap for an HTML body, which is the one field that legitimately carries inline
 * MEDIA: a daily audio digest embeds its podcast as a base64 `<audio src="data:
 * audio/mpeg;base64,…">`, which is 2-5MB for a few minutes of speech. Splitting
 * it out (rather than raising the plain cap too) keeps the fields that live in
 * index.json, and the preview work every letter pays, as small as they were.
 *
 * Everything on the path has to clear this: the daemon's gateway request line
 * (GATEWAY_MAX_LINE_BYTES, the reason this used to be 200KB on every transport)
 * and the express body limit (15mb).
 */
export const LETTER_HTML_MAX_BYTES = 10 * 1024 * 1024;

/** Which cap one field is held to. Unknown names get the plain cap. */
export function letterFieldMaxBytes(field: string): number {
  return field === 'html' ? LETTER_HTML_MAX_BYTES : LETTER_BODY_MAX_BYTES;
}

/** Envelope preview / push body budget. */
export const LETTER_PREVIEW_MAX_CHARS = 300;
