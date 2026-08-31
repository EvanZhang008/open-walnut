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
  /** Exactly one of html | markdown | htmlRef — see letterFieldMaxBytes. */
  html?: string;
  markdown?: string;
  /**
   * A staged body already on the hub's disk, from `POST /api/v1/human-inbox/body`
   * or from the gateway's chunked `argsFile` pull. Stands in for `html` so a
   * 100MB document never has to be a string in a JSON request. Accepts either
   * spelling — the op/route body uses `html_ref`, same as `task_refs`.
   */
  htmlRef?: string;
  html_ref?: string;
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
  /** Staged body ref — same lane as NewLetter.htmlRef, either spelling. */
  htmlRef?: string;
  html_ref?: string;
  text: string;
}

/** A letter plus the body content read off disk (what the reader needs). */
export interface LetterThreadEntry extends ThreadEntry {
  /** Body content for a rich turn; absent when plain text OR when deferred. */
  body?: string;
  /** True when `bodyFile` was recorded but is gone from disk. */
  bodyMissing?: boolean;
  /** Size of this turn's body document on disk. */
  bodyBytes?: number;
  /** Too big to inline — stream it from `bodyUrl` instead. */
  bodyDeferred?: boolean;
  bodyUrl?: string;
}

export interface LetterDetail extends LetterRecord {
  /**
   * The document, inline — present whenever it fits under
   * LETTER_INLINE_BODY_MAX_BYTES (so: essentially every prose letter). ABSENT
   * for a big media body; `bodyUrl` then says where to stream it from.
   */
  body?: string;
  /** True when the body file is gone — `body` then holds an inline note. */
  bodyMissing?: boolean;
  /** Size of the body document on disk, always present. */
  bodyBytes?: number;
  /**
   * Set (with `body` omitted) when the document was too big to inline. Fetch it
   * from `bodyUrl`, which streams and honours Range.
   */
  bodyDeferred?: boolean;
  /** Streaming route for the document — relative, same origin as this reply. */
  bodyUrl?: string;
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
 * MEDIA: a daily digest embeds its podcast as a base64
 * `<audio src="data:audio/mpeg;base64,…">`, and a short clip the same way with
 * `<video>`. Splitting it out (rather than raising the plain cap too) keeps the
 * fields that live in index.json, and the preview work every letter pays, as
 * small as they were.
 *
 * 100MB, and the number is a DISK sanity bound, not a transport ceiling. An
 * earlier version of this comment claimed the ceiling belonged to the transport
 * (one 32MB WebSocket frame on the phone's bridge hop). That was true only
 * because the body used to ride INLINE inside the letter JSON, which is a
 * design choice, not a law: a body over LETTER_INLINE_BODY_MAX_BYTES now leaves
 * the envelope entirely and moves in bounded batches at both edges.
 *
 *   in   — a big payload rides a FILE on the sender's host, and the hub pulls it
 *          back in HUMAN_INBOX_CHUNK_BYTES slices (gateway `argsFile`, or the
 *          two-step `POST /api/v1/human-inbox/body` ref for HTTP senders)
 *   out  — GET /api/v1/human-inbox/:id/body streams the file with Range; on a
 *          cloud replica each Range is served by looping the same bounded
 *          `server.human-inbox.body` pull, so no single frame ever holds it all
 *
 * So neither direction has a whole-body frame to blow up any more, and 100MB is
 * just "one letter must not quietly eat the disk". 100MB of base64 audio is
 * roughly two and a half hours of speech.
 *
 * Ordering invariant, pinned by tests/core/human-inbox-caps.test.ts: the only
 * layers that must still exceed a size are the ones a body can cross WHOLE —
 * the inline lane. HUMAN_INBOX_CHUNK_BYTES < WS frame maxPayload keeps the
 * batched lane safe at any total size.
 */
export const LETTER_HTML_MAX_BYTES = 100 * 1024 * 1024;

/**
 * How much body the letter-detail JSON still carries inline. Under this, `body`
 * is embedded exactly as before (one round trip for the overwhelming majority
 * of letters, which are prose). Over it, the detail answers with `bodyBytes` +
 * `bodyUrl` and no `body`, and the reader fetches the document from the
 * streaming route.
 *
 * 1MB is chosen to be far under every frame and parser limit on the path, so
 * the envelope response size stops being a function of the media a letter
 * happens to embed.
 */
export const LETTER_INLINE_BODY_MAX_BYTES = 1024 * 1024;

/**
 * One batch, for every hop that moves a body without holding it whole: the
 * hub's chunked pull of a sender-side `argsFile`, and the replica's chunked
 * relay of a body Range over the bridge.
 *
 * 2MB matches MAX_BRIDGE_FILE_BYTES (routes/file-content-bridge.ts) and the
 * daemon twins' fs.readRange budget — deliberately the same number, because
 * this is the same lesson: a frame that big survives the corporate SSH proxies
 * that kill larger ones, and sits far under the 32MB maxPayload that `ws`
 * enforces by closing the socket with 1009 before any handler runs.
 */
export const HUMAN_INBOX_CHUNK_BYTES = 2 * 1024 * 1024;

/** Which cap one field is held to. Unknown names get the plain cap. */
export function letterFieldMaxBytes(field: string): number {
  return field === 'html' ? LETTER_HTML_MAX_BYTES : LETTER_BODY_MAX_BYTES;
}

/** Envelope preview / push body budget. */
export const LETTER_PREVIEW_MAX_CHARS = 300;
