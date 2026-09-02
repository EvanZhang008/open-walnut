/**
 * Walnut session-envelope parser — pure, dependency-free, render-agnostic.
 *
 * When one session messages another, Walnut wraps the other session's words in a
 * machine-readable envelope before it reaches the receiving CLI's stdin. Four
 * shapes exist, all authored server-side and NEVER to be changed from here:
 *
 *   1. `[Peer session message] From your user's other session "…" (id, host: …)`
 *      + a `---peer-note-<hash>---` fence          (src/core/peers/peer-wrapper.ts)
 *   2. `[Reply requested — rq-…]` — a 4-line trailer appended OUTSIDE that fence
 *   3. `[Session reply — rq-…]` + a `---session-reply-<hash>---` fence
 *   4. `[Walnut notification — rq-…]` — no fence (nothing untrusted in it)
 *                                                 (src/core/session-requests.ts)
 *
 * The envelope reads as a wall of prose in a chat bubble, which is why the UI
 * parses it into a provenance card. This module does the parsing ONLY.
 *
 * SECURITY: the fence is a prompt-injection defence and this parser must not
 * weaken it. Two rules encode that:
 *
 *  · The scan walks left to right and CONSUMES a whole envelope (framing +
 *    fence + trailer) before looking for the next header, so a header forged
 *    INSIDE a fenced payload is never scanned — it stays payload, exactly as the
 *    envelope's own words promise. Payload text can never become framing.
 *  · The fence marker is taken from the DECLARATION in the framing (the
 *    server's own "everything between the two <marker> markers" sentence), and
 *    the payload runs to the LAST occurrence of that marker. Both choices fail
 *    in the safe direction: a payload that somehow contained the marker (a sha1
 *    fixed point) would make the body BIGGER, never let text escape it.
 *
 * A header whose shape is recognized but whose fence is broken aborts the whole
 * parse (`null` → the caller renders the raw text as it does today). Degrading
 * to plain text is always safe; guessing at a half-parsed envelope is not.
 *
 * Not a security boundary: a HUMAN typing an envelope-shaped message by hand in
 * their own session still gets a card. That text is their own, carries no
 * authorization either way, and the card links a session id only when it
 * resolves against the real session list.
 */

export type SessionEnvelopeKind = 'reply' | 'peer-note' | 'notification' | 'reply-request';

export interface SessionEnvelopePeer {
  /** Short id as the server printed it (8 chars) — needs prefix resolution. */
  shortId?: string;
  /** Full session id, when the envelope printed one (notification shape). */
  sessionId?: string;
  /** Owning task id, when the envelope printed one (notification shape). */
  taskId?: string;
  /** Title as printed. The server flattens + truncates at 80 chars, so this may
   *  end in an ellipsis; the UI prefers a resolved live title. */
  title?: string;
  /** 'local' or a host alias. */
  host?: string;
  /** peer-note only: an unidentified process, i.e. NO tracked session. */
  anonymous?: boolean;
}

export interface SessionEnvelope {
  kind: SessionEnvelopeKind;
  /** rq-… correlation id, when the envelope carries one. */
  requestId?: string;
  /** The OTHER session: sender for reply/peer-note, target for notification. */
  peer: SessionEnvelopePeer;
  /** One-line clip of what the asker originally asked (reply + notification). */
  askedPreview?: string;
  /** The outcome sentence, verbatim (notification only) — this IS its content. */
  statusLine?: string;
  /** The fenced payload: the other session's own words (reply + peer-note). */
  body?: string;
  /** The fence marker that delimited `body`. Diagnostics + tests. */
  marker?: string;
  /** A `[Reply requested — rq-…]` trailer that rode along on this envelope. */
  replyRequest?: { requestId: string; command?: string };
  /** The `walnut tools call …` line the envelope suggested, when it printed one. */
  followUp?: string;
  /** The exact slice this envelope occupied — the "raw envelope" disclosure. */
  raw: string;
}

export type EnvelopeSegment =
  | { kind: 'text'; text: string }
  | { kind: 'envelope'; envelope: SessionEnvelope };

/** Em dash is what the server writes; a hyphen is accepted so a future tweak
 *  to the wording degrades to a card rather than to raw prose. */
const DASH = '[\\u2014\\u2013-]';
const RQ = '(rq-[0-9a-f]{6,})';

const HEAD_REPLY = new RegExp(
  `^\\[Session reply ${DASH} ${RQ}\\] Your request to session "(.*)" `
  + '\\(([^\\s(),]+), host: ([^)]*)\\) got a reply\\. You asked: "(.*)"\\.$',
);
const HEAD_NOTIFY = new RegExp(
  `^\\[Walnut notification ${DASH} ${RQ}\\] About the session (.+) you messaged `
  + '\\(you asked: "(.*)"\\):$',
);
const HEAD_TRAILER = new RegExp(`^\\[Reply requested ${DASH} ${RQ}\\] `);
const HEAD_PEER_NAMED = /^\[Peer session message\] From your user's other session "(.*)" \(([^\s(),]+), host: ([^)]*)\)\. Automated note/;
const HEAD_PEER_ANON = /^\[Peer session message\] From an UNIDENTIFIED process on host (\S+) \(no tracked session/;

/** Any of the four header openers, used only to FIND candidate line starts. */
const HEADER_OPENER = /\[(?:Session reply|Walnut notification|Reply requested|Peer session message)/g;

/** A fence marker declaration: `---<prefix>-<12 hex>---`. */
const MARKER = /---[a-z][a-z-]*-[0-9a-f]{8,}---/;

/** Trailer body lines, in order, after the `[Reply requested …]` header. */
const TRAILER_LINES = [
  /^When you have finished/,
  /^walnut tools call session_send/,
  /^Keep the reply/,
];

const NOTIFY_END = /^This is an automated Walnut status notice/;

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl;
}

/** Every index of `needle` in `text` at or after `from`. */
function occurrences(text: string, needle: string, from: number): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle, from); i !== -1; i = text.indexOf(needle, i + needle.length)) {
    out.push(i);
  }
  return out;
}

/** Next line-start index (>= from) where a header opener appears, or -1. */
function nextHeaderStart(text: string, from: number): number {
  HEADER_OPENER.lastIndex = from;
  for (let m = HEADER_OPENER.exec(text); m; m = HEADER_OPENER.exec(text)) {
    if (m.index === 0 || text[m.index - 1] === '\n') return m.index;
  }
  return -1;
}

interface FenceCut {
  marker: string;
  body: string;
  /** Index just past the closing marker. */
  end: number;
}

/**
 * Cut the fenced payload out of an envelope that starts at `headStart`.
 *
 * The marker is read from its DECLARATION inside the framing (first occurrence),
 * the payload opens at the second occurrence and closes at the LAST — see the
 * security note at the top of this file.
 */
function cutFence(text: string, headStart: number): FenceCut | null {
  const declared = MARKER.exec(text.slice(headStart));
  if (!declared) return null;
  const marker = declared[0];
  const occ = occurrences(text, marker, headStart);
  if (occ.length < 3) return null;
  const open = occ[1];
  const close = occ[occ.length - 1];
  if (close <= open) return null;
  const body = text.slice(open + marker.length, close).replace(/^\n/, '').replace(/\n$/, '');
  return { marker, body, end: close + marker.length };
}

/**
 * The first `walnut tools call …` command inside a slice, if any.
 *
 * It is not always at a line start (the reply's follow-up sentence introduces it
 * mid-line) and the notification's copies carry a trailing `# comment`, so match
 * the quoted-argument form first and fall back to the rest of the line.
 */
function findCommand(slice: string): string | undefined {
  const quoted = /walnut tools call \S+ '[^']*'/.exec(slice);
  if (quoted) return quoted[0];
  const loose = /walnut tools call [^\n]+/.exec(slice);
  return loose ? loose[0].trim() : undefined;
}

/**
 * A `[Reply requested …]` trailer immediately after `end` (peer-note case) or at
 * `end` itself (standalone case). Returns the absorbed extent.
 */
function absorbTrailer(text: string, from: number): { requestId: string; command?: string; end: number } | null {
  const head = HEAD_TRAILER.exec(text.slice(from, lineEnd(text, from)));
  if (!head) return null;
  let cursor = lineEnd(text, from);
  for (const rule of TRAILER_LINES) {
    if (text[cursor] !== '\n') break;
    const next = cursor + 1;
    const line = text.slice(next, lineEnd(text, next));
    if (!rule.test(line)) break;
    cursor = lineEnd(text, next);
  }
  return { requestId: head[1], command: findCommand(text.slice(from, cursor)), end: cursor };
}

interface ParseAt {
  envelope: SessionEnvelope;
  /** Index just past the envelope. */
  end: number;
}

/** JSON-ish `'{"key":"value"' → value` pull from a printed walnut command. */
function argOf(slice: string, tool: string, key: string): string | undefined {
  const re = new RegExp(`${tool} '\\{"${key}":"([^"]+)"`);
  return re.exec(slice)?.[1];
}

function parseReply(text: string, at: number, headLine: string): ParseAt | 'broken' {
  const m = HEAD_REPLY.exec(headLine);
  if (!m) return 'broken';
  const fence = cutFence(text, at);
  if (!fence) return 'broken';
  let end = fence.end;
  // The follow-up line sits after the closing marker, separated by a blank line.
  const tailStart = end + (text.startsWith('\n\n', end) ? 2 : 0);
  let followUp: string | undefined;
  if (tailStart > end) {
    const tailLine = text.slice(tailStart, lineEnd(text, tailStart));
    if (tailLine.startsWith('Continue your work with this answer.')) {
      followUp = findCommand(tailLine);
      end = lineEnd(text, tailStart);
    }
  }
  const raw = text.slice(at, end);
  return {
    end,
    envelope: {
      kind: 'reply',
      requestId: m[1],
      peer: { title: m[2] || undefined, shortId: m[3], host: m[4] || undefined },
      askedPreview: m[5] || undefined,
      body: fence.body,
      marker: fence.marker,
      ...(followUp ? { followUp } : {}),
      raw,
    },
  };
}

function parsePeerNote(text: string, at: number, headLine: string): ParseAt | 'broken' {
  const named = HEAD_PEER_NAMED.exec(headLine);
  const anon = named ? null : HEAD_PEER_ANON.exec(headLine);
  if (!named && !anon) return 'broken';
  const fence = cutFence(text, at);
  if (!fence) return 'broken';
  let end = fence.end;
  // `--- (end of peer note)` suffix belongs to the envelope, not to the next segment.
  const suffix = ' (end of peer note)';
  if (text.startsWith(suffix, end)) end += suffix.length;

  const peer: SessionEnvelopePeer = named
    ? { title: named[1] || undefined, shortId: named[2], host: named[3] || undefined }
    : { host: anon![1], anonymous: true };

  const trailer = text.startsWith('\n\n', end) ? absorbTrailer(text, end + 2) : null;
  if (trailer) end = trailer.end;

  return {
    end,
    envelope: {
      kind: 'peer-note',
      peer,
      body: fence.body,
      marker: fence.marker,
      ...(trailer
        ? { requestId: trailer.requestId, replyRequest: { requestId: trailer.requestId, command: trailer.command } }
        : {}),
      raw: text.slice(at, end),
    },
  };
}

function parseNotification(text: string, at: number, headLine: string): ParseAt | 'broken' {
  const m = HEAD_NOTIFY.exec(headLine);
  if (!m) return 'broken';
  const afterHead = lineEnd(text, at);
  const statusStart = afterHead + 1;
  const statusLine = statusStart <= text.length ? text.slice(statusStart, lineEnd(text, statusStart)) : '';

  // Walk to the closing sentinel; the shape has no fence, so nothing here is
  // attacker-controlled and a line scan is safe.
  let end = lineEnd(text, statusStart);
  let cursor = end;
  for (let guard = 0; guard < 16 && text[cursor] === '\n'; guard++) {
    const next = cursor + 1;
    const line = text.slice(next, lineEnd(text, next));
    cursor = lineEnd(text, next);
    if (NOTIFY_END.test(line)) { end = cursor; break; }
    // Blank line, "Ways to proceed:", indented commands — all part of the notice.
    if (line !== '' && !line.startsWith(' ') && !line.startsWith('Ways to proceed')) break;
    end = cursor;
  }
  const raw = text.slice(at, end);
  const name = m[2];
  const quoted = /^"(.*)"$/.exec(name);
  return {
    end,
    envelope: {
      kind: 'notification',
      requestId: m[1],
      peer: {
        ...(quoted ? { title: quoted[1] } : { shortId: name }),
        ...(argOf(raw, 'task_get', 'id') ? { taskId: argOf(raw, 'task_get', 'id') } : {}),
        ...(argOf(raw, 'session_transcript', 'id') ? { sessionId: argOf(raw, 'session_transcript', 'id') } : {}),
        ...(argOf(raw, 'session_send', 'to') ? { shortId: argOf(raw, 'session_send', 'to') } : {}),
      },
      askedPreview: m[3] || undefined,
      statusLine,
      ...(findCommand(raw) ? { followUp: findCommand(raw) } : {}),
      raw,
    },
  };
}

function parseTrailerOnly(text: string, at: number): ParseAt | 'broken' {
  const absorbed = absorbTrailer(text, at);
  if (!absorbed) return 'broken';
  return {
    end: absorbed.end,
    envelope: {
      kind: 'reply-request',
      requestId: absorbed.requestId,
      peer: {},
      ...(absorbed.command ? { replyRequest: { requestId: absorbed.requestId, command: absorbed.command } } : {}),
      raw: text.slice(at, absorbed.end),
    },
  };
}

function parseAt(text: string, at: number): ParseAt | 'broken' | 'not-an-envelope' {
  const headLine = text.slice(at, lineEnd(text, at));
  if (headLine.startsWith('[Session reply')) return parseReply(text, at, headLine);
  if (headLine.startsWith('[Peer session message]')) return parsePeerNote(text, at, headLine);
  if (headLine.startsWith('[Walnut notification')) return parseNotification(text, at, headLine);
  if (HEAD_TRAILER.test(headLine)) return parseTrailerOnly(text, at);
  return 'not-an-envelope';
}

function pushText(segments: EnvelopeSegment[], raw: string): void {
  const text = raw.replace(/^\n+/, '').replace(/\n+$/, '');
  if (text) segments.push({ kind: 'text', text });
}

/**
 * Split a message into ordinary text and Walnut envelopes, in order.
 *
 * Returns `null` when the text holds no envelope, or when one is recognized but
 * structurally broken — both mean "render exactly what you render today".
 * A batched delivery joins several messages with a blank line, so more than one
 * envelope (and leading human text) is normal.
 */
export function parseSessionEnvelopes(text: string): EnvelopeSegment[] | null {
  if (!text || !text.includes('[')) return null;
  const segments: EnvelopeSegment[] = [];
  let pos = 0;
  let found = 0;
  while (pos < text.length) {
    const at = nextHeaderStart(text, pos);
    if (at < 0) break;
    const parsed = parseAt(text, at);
    if (parsed === 'broken') return null;
    if (parsed === 'not-an-envelope') {
      // A bracketed lookalike in ordinary prose. Step past its line and keep
      // going; nothing was consumed, so no fenced region can be entered here.
      const skip = lineEnd(text, at);
      if (skip <= pos) break;
      pos = skip;
      continue;
    }
    pushText(segments, text.slice(pos, at));
    segments.push({ kind: 'envelope', envelope: parsed.envelope });
    found++;
    pos = parsed.end;
  }
  if (!found) return null;
  pushText(segments, text.slice(pos));
  return segments;
}

/** Human label for a kind — shared by the card and its aria labels. */
export function envelopeDirectionLabel(kind: SessionEnvelopeKind): string {
  switch (kind) {
    case 'reply': return 'Reply from session';
    case 'peer-note': return 'Message from another session';
    case 'notification': return 'Walnut notification';
    case 'reply-request': return 'Walnut asked you to reply';
  }
}

/** Glyph for a kind. A text glyph, so it inherits the card's color (contrast rule). */
export function envelopeDirectionGlyph(kind: SessionEnvelopeKind): string {
  switch (kind) {
    case 'reply': return '↩';          // ↩ came back to you
    case 'peer-note': return '→';      // → arrived from elsewhere
    case 'notification': return '◎';   // ◎ Walnut itself speaking
    case 'reply-request': return '↻';  // ↻ your turn to answer
  }
}
