/**
 * Walnut session-envelope parser — pure, dependency-free, render-agnostic.
 *
 * When one session messages another, Walnut wraps the other session's words in a
 * machine-readable envelope before it reaches the receiving CLI's stdin.
 *
 * The CURRENT wire format (v2) is one tag per delivered message:
 *
 *     <walnut-message kind="peer-note" from="Title [8hex]" from-session="…" …>
 *     BODY
 *     </walnut-message>
 *     Reply when done: walnut tools call session_send '{"in_reply_to":"rq-…",…}'
 *
 * Three kinds ride it: `peer-note` (another session's words), `reply` (the answer
 * routed back to the asker) and `notification` (Walnut ending the wait itself).
 * Attribute values are XML-escaped (`& " < >`); the BODY is verbatim except that
 * every `<walnut-message` / `</walnut-message` in it has its `<` escaped to
 * `&lt;`. That single rule is the anti-spoof guarantee: a body can never contain
 * an open or close tag, so "from the open tag to the FIRST `\n</walnut-message>`"
 * is the body, always, and no payload can promote itself to framing.
 *
 * Claude Code delivers its OWN peer messages as an injected user line: a
 * `<cross-session-message …>` tag wrapped in two fixed pieces of CLI prose. That
 * is parsed here too (source 'claude-code'): the tag is found at a line start,
 * its body runs to the first close tag and is never scanned, and the framing prose
 * is folded into the envelope's `raw` instead of being shown beside the card.
 *
 * LEGACY (below) is the pre-v2 prose the server no longer emits. Transcript JSONL
 * is immutable history, so these four shapes must keep parsing forever:
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
 * An envelope whose shape is recognized but which is structurally broken (a tag
 * that never closes, a broken fence) aborts the whole parse (`null` → the caller
 * renders the raw text). Degrading to plain text is always safe; guessing at a
 * half-parsed envelope is not.
 *
 * Not a security boundary: a HUMAN typing an envelope-shaped message by hand in
 * their own session still gets a card. That text is their own, carries no
 * authorization either way, and the card links a session id only when it
 * resolves against the real session list.
 */

export type SessionEnvelopeKind = 'reply' | 'peer-note' | 'notification' | 'reply-request' | 'trigger';

/** Who framed the message: Walnut's own envelope, or Claude Code's native one. */
export type SessionEnvelopeSource = 'walnut' | 'claude-code';

export interface SessionEnvelopePeer {
  /** Short id as the server printed it (8 chars) — needs prefix resolution. */
  shortId?: string;
  /** Full session id, when the envelope printed one. */
  sessionId?: string;
  /** Owning task id, when the envelope printed one. */
  taskId?: string;
  /** Title as printed. The server flattens + truncates at 80 chars, so this may
   *  end in an ellipsis; the UI prefers a resolved live title. */
  title?: string;
  /** 'local' or a host alias. */
  host?: string;
  /** peer-note only: an unidentified process, i.e. NO tracked session. */
  anonymous?: boolean;
  /** Claude Code only: its transport address for the sender (`uds:…`). Diagnostic
   *  detail for the raw disclosure, never a link. */
  address?: string;
}

export interface SessionEnvelope {
  kind: SessionEnvelopeKind;
  /** Absent means Walnut (every legacy prose shape). */
  source?: SessionEnvelopeSource;
  /** rq-… correlation id, when the envelope carries one. */
  requestId?: string;
  /** The OTHER session: sender for reply/peer-note, target for notification. */
  peer: SessionEnvelopePeer;
  /** One-line clip of what the asker originally asked (reply + notification). */
  askedPreview?: string;
  /** The outcome sentence, verbatim (notification only) — this IS its content.
   *  For a trigger: the `note` attribute ("fired <ISO>, N new items" / "scheduled"). */
  statusLine?: string;
  /** The payload: the other session's own words (reply + peer-note), or the
   *  trigger's delivery (prompt, new items as JSON, the script's `input`). */
  body?: string;
  /** LEGACY only: the fence marker that delimited `body`. Diagnostics + tests. */
  marker?: string;
  /** The reply-request trailer that rode along on this envelope (`Reply when
   *  done: …` in v2, the 4-line `[Reply requested — rq-…]` block before it). */
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
  /** Where the envelope really begins, when framing BEFORE the recognized opener
   *  belongs to it (Claude Code's native shape). Defaults to the opener. */
  start?: number;
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

// ── v2: one `<walnut-message …>` tag per delivered message ───────────────────

const TAG = '<walnut-message';
const TAG_CLOSE = '\n</walnut-message>';
/** A tag opener: the name, then whitespace before the first attribute. */
const TAG_OPENER = /<walnut-message\s/g;
const TAG_HEAD = /^<walnut-message\s/;
/** `name="value"`. A value cannot hold a `"` — the serializer escapes it. */
const ATTR = /([a-z][a-z0-9-]*)="([^"]*)"/g;
/** The kinds the tag carries. Anything else degrades to raw text on purpose. */
const TAG_KINDS = new Set(['peer-note', 'reply', 'notification', 'trigger']);
/** `Title [8hex]` as `sessionHandle()` prints it (4+ so a short id still reads). */
const HANDLE = /\[([0-9a-f]{4,})\]\s*$/i;
/** The one line a peer-note with a `request` may be followed by. */
const TAG_TRAILER = /^Reply when done: /;

/** Reverse of the serializer's `escapeAttr` — `&amp;` LAST or it decodes twice. */
function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Reverse of the serializer's `escapeBody`, in reverse rule order: the tag
 *  sequences first, then the extra `&amp;` the serializer adds to a body that
 *  already held the escaped form (so the two can never collide on the wire). */
function unescapeBody(body: string): string {
  return body
    .replace(/&lt;(\/?)(walnut-message)/gi, '<$1$2')
    .replace(/&amp;lt;(\/?)(walnut-message)/gi, '&lt;$1$2');
}

/** First occurrence of a name wins: a repeated attribute cannot override it. */
function parseAttrs(list: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(list); m; m = ATTR.exec(list)) {
    if (!(m[1] in out)) out[m[1]] = unescapeAttr(m[2]);
  }
  return out;
}

/**
 * Split a printed Walnut handle into its title and its id part. Walnut's own
 * suffix IS a session-id prefix; Claude Code's `name [ref]` is NOT one, so that
 * shape deliberately does not come through here.
 */
function splitHandle(handle: string | undefined): { title?: string; shortId?: string } {
  if (!handle) return {};
  const m = HANDLE.exec(handle);
  if (!m) return { title: handle };
  const title = handle.slice(0, m.index).trim();
  return { ...(title ? { title } : {}), shortId: m[1] };
}

/** Next line-start index (>= from) where a tag opens, or -1. */
function nextTagStart(text: string, from: number): number {
  TAG_OPENER.lastIndex = from;
  for (let m = TAG_OPENER.exec(text); m; m = TAG_OPENER.exec(text)) {
    if (m.index === 0 || text[m.index - 1] === '\n') return m.index;
  }
  return -1;
}

/**
 * Parse one `<walnut-message …>` tag starting at `at`.
 *
 * The open tag is ONE line ending in `>`, and the body runs to the FIRST
 * `\n</walnut-message>` — which is safe precisely because the serializer escapes
 * both tag sequences out of every body. A tag whose shape is recognized but which
 * never closes (or carries a kind this build cannot render) is 'broken': the
 * caller then renders the raw text, which is always safe.
 */
function parseWalnutTag(text: string, at: number): ParseAt | 'broken' {
  const headEnd = lineEnd(text, at);
  if (headEnd >= text.length) return 'broken';
  const head = text.slice(at, headEnd).replace(/\r$/, '');
  if (!head.endsWith('>')) return 'broken';
  const attrs = parseAttrs(head.slice(TAG.length, head.length - 1));
  const kind = attrs.kind;
  if (!kind || !TAG_KINDS.has(kind)) return 'broken';

  const bodyStart = headEnd + 1;
  const closeAt = text.indexOf(TAG_CLOSE, bodyStart);
  if (closeAt < 0) return 'broken';
  const body = unescapeBody(text.slice(bodyStart, closeAt));
  let end = closeAt + TAG_CLOSE.length;

  // The single trailer line, and ONLY when the sender asked for a reply: without
  // a request there is nothing to reply to, so a `Reply when done:` line is the
  // human's own text and must stay in its own segment.
  let replyRequest: SessionEnvelope['replyRequest'] | undefined;
  if (kind === 'peer-note' && attrs.request && text[end] === '\n') {
    const lineStart = end + 1;
    const line = text.slice(lineStart, lineEnd(text, lineStart));
    if (TAG_TRAILER.test(line)) {
      replyRequest = { requestId: attrs.request, ...(findCommand(line) ? { command: findCommand(line) } : {}) };
      end = lineEnd(text, lineStart);
    }
  }

  // A notification is ABOUT a session; the other two come FROM one. A trigger
  // comes from a ROUTINE, not a session: `from` is "Trigger: <name>" (no handle
  // to resolve) and `note` is its one-line status, so it takes the notification's
  // statusLine slot while keeping the whole body as the delivery.
  const notify = kind === 'notification';
  const trigger = kind === 'trigger';
  const handle = notify ? attrs.about : attrs.from;
  const sessionId = notify ? attrs['about-session'] : attrs['from-session'];
  const taskId = notify ? attrs['about-task'] : attrs['from-task'];
  const peer: SessionEnvelopePeer = attrs.anonymous === 'true'
    // No tracked session behind the send: a host and nothing that reads as an id.
    ? { ...(attrs.host ? { host: attrs.host } : {}), anonymous: true }
    : {
      ...splitHandle(handle),
      ...(sessionId ? { sessionId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(attrs.host ? { host: attrs.host } : {}),
    };

  // A notification's body opens with the outcome sentence — that IS its content,
  // so it becomes `statusLine`. What follows is the `Next:` command block, which
  // is machine instruction: it stays in `raw` (the disclosure) plus `followUp`,
  // exactly where the pre-v2 notice put it, and never in the visible body.
  const nl = body.indexOf('\n');
  const statusLine = trigger ? (attrs.note ?? '') : nl < 0 ? body : body.slice(0, nl);
  const followUp = notify ? findCommand(nl < 0 ? '' : body.slice(nl + 1)) : undefined;

  return {
    end,
    envelope: {
      kind: kind as SessionEnvelopeKind,
      source: 'walnut',
      ...(attrs.request ? { requestId: attrs.request } : {}),
      peer,
      ...(attrs.asked ? { askedPreview: attrs.asked } : {}),
      ...(notify ? { statusLine } : trigger ? { statusLine, body } : { body }),
      ...(replyRequest ? { replyRequest } : {}),
      ...(followUp ? { followUp } : {}),
      raw: text.slice(at, end),
    },
  };
}

// ── Claude Code's own cross-session message ──────────────────────────────────

const NATIVE_TAG = '<cross-session-message';
const NATIVE_CLOSE = '\n</cross-session-message>';
const NATIVE_OPENER = /<cross-session-message[\s>]/g;
const NATIVE_HEAD = /^<cross-session-message[\s>]/;
/**
 * The CLI wraps its own tag in two fixed pieces of prose: one line above and one
 * paragraph below. Matched as PREFIXES so a wording change costs the absorption
 * (the prose shows as text) and never the parse.
 */
const NATIVE_FRAMING_BEFORE = /^Another Claude session sent a message/;
const NATIVE_FRAMING_AFTER = /^This came from another Claude session/;

/** The framing line directly above the tag, when it is there. */
function absorbFramingBefore(text: string, at: number): number {
  if (at === 0 || text[at - 1] !== '\n') return at;
  const lineStart = text.lastIndexOf('\n', at - 2) + 1;
  return NATIVE_FRAMING_BEFORE.test(text.slice(lineStart, at - 1)) ? lineStart : at;
}

/**
 * The framing paragraph below the close tag, when it is there: from the first
 * non-blank line after it to the next blank line or the end of the text. Anything
 * that is not that paragraph stays outside the envelope and becomes its own text
 * segment (a batched delivery can put real words after a peer message).
 */
function absorbFramingAfter(text: string, end: number): number {
  let probe = end;
  while (text[probe] === '\n') probe++;
  if (probe === end) return end;
  if (!NATIVE_FRAMING_AFTER.test(text.slice(probe, lineEnd(text, probe)))) return end;
  let cursor = lineEnd(text, probe);
  while (text[cursor] === '\n') {
    const next = cursor + 1;
    if (text.slice(next, lineEnd(text, next)) === '') break;
    cursor = lineEnd(text, next);
  }
  return cursor;
}

/** Next line-start index (>= from) where a native tag opens, or -1. */
function nextNativeStart(text: string, from: number): number {
  NATIVE_OPENER.lastIndex = from;
  for (let m = NATIVE_OPENER.exec(text); m; m = NATIVE_OPENER.exec(text)) {
    if (m.index === 0 || text[m.index - 1] === '\n') return m.index;
  }
  return -1;
}

/**
 * Claude Code delivers a peer message as an INJECTED user line: its own tag,
 * wrapped in the CLI's fixed framing prose. Unlike the Walnut tag, the CLI does
 * NOT escape its bodies, so a sender can put a `</cross-session-message>` line
 * inside one. The body therefore runs to the LAST close tag in the message: a
 * forged early close would otherwise let the rest of the body (say, a fake
 * `<walnut-message>` from "Walnut") parse as a separate, trusted-looking card.
 * The CLI delivers one native message per line, so the last close is the real
 * one; a tag that never closes degrades to raw text.
 *
 * Two things this deliberately does NOT do. It does not read the `[ref]` inside a
 * CLI name as a session-id prefix: those are the CLI's own disambiguation tokens
 * and are NOT id prefixes (a live `fixture-96 [310819]` had session id
 * `6c055e2b…`), so the ref stays inside the title verbatim and only `from-session`
 * can produce a link. And it does not treat the framing prose as content: it is
 * part of `raw`, never a text segment beside the card.
 */
function parseNativeTag(text: string, at: number): ParseAt | 'broken' {
  const headEnd = lineEnd(text, at);
  if (headEnd >= text.length) return 'broken';
  const head = text.slice(at, headEnd).replace(/\r$/, '');
  if (!head.endsWith('>')) return 'broken';
  const closeAt = text.lastIndexOf(NATIVE_CLOSE);
  if (closeAt < headEnd) return 'broken';

  const attrs = parseAttrs(head.slice(NATIVE_TAG.length, head.length - 1));
  const title = attrs['from-name'] || attrs.from;
  const start = absorbFramingBefore(text, at);
  const end = absorbFramingAfter(text, closeAt + NATIVE_CLOSE.length);
  return {
    start,
    end,
    envelope: {
      kind: 'peer-note',
      source: 'claude-code',
      peer: {
        ...(title ? { title } : {}),
        ...(attrs['from-session'] ? { sessionId: attrs['from-session'] } : {}),
        ...(attrs.from ? { address: attrs.from } : {}),
      },
      body: text.slice(headEnd + 1, closeAt),
      raw: text.slice(start, end),
    },
  };
}

function parseAt(text: string, at: number): ParseAt | 'broken' | 'not-an-envelope' {
  const headLine = text.slice(at, lineEnd(text, at));
  if (TAG_HEAD.test(headLine)) return parseWalnutTag(text, at);
  if (NATIVE_HEAD.test(headLine)) return parseNativeTag(text, at);
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
 * Returns `null` when the text holds no envelope, which means "render exactly
 * what you render today". A recognized envelope that is structurally broken
 * (never closes, unknown kind) ends the scan: what was parsed before it keeps
 * its cards, and everything from the broken opener onward is one raw text
 * segment, so a batched delivery does not lose its good cards to one bad one.
 * A batched delivery joins several messages with a blank line, so more than one
 * envelope (and leading human text) is normal.
 */
export function parseSessionEnvelopes(text: string): EnvelopeSegment[] | null {
  if (!text) return null;
  if (!text.includes('[') && !text.includes(TAG) && !text.includes(NATIVE_TAG)) return null;
  const segments: EnvelopeSegment[] = [];
  let pos = 0;
  let found = 0;
  while (pos < text.length) {
    const starts = [nextTagStart(text, pos), nextNativeStart(text, pos), nextHeaderStart(text, pos)]
      .filter((i) => i >= 0);
    const at = starts.length > 0 ? Math.min(...starts) : -1;
    if (at < 0) break;
    const parsed = parseAt(text, at);
    if (parsed === 'broken') break;
    if (parsed === 'not-an-envelope') {
      // A bracketed lookalike in ordinary prose. Step past its line and keep
      // going; nothing was consumed, so no fenced region can be entered here.
      const skip = lineEnd(text, at);
      if (skip <= pos) break;
      pos = skip;
      continue;
    }
    // An envelope may reach BACK over framing that belongs to it, but never over
    // text an earlier segment already owns.
    pushText(segments, text.slice(pos, Math.max(pos, parsed.start ?? at)));
    segments.push({ kind: 'envelope', envelope: parsed.envelope });
    found++;
    pos = parsed.end;
  }
  if (!found) return null;
  pushText(segments, text.slice(pos));
  return segments;
}

/**
 * True when a message is nothing BUT envelopes. This is the test for treating a
 * CLI-injected line (skill dump, compaction summary, peer message) as a card: a
 * skill dump that happens to quote an envelope still carries its own prose, so
 * it fails this and stays a collapsed context row, where clicking to expand is
 * the right affordance.
 */
export function isEnvelopeOnly(segments: EnvelopeSegment[] | null): segments is EnvelopeSegment[] {
  return !!segments && segments.length > 0 && segments.every((s) => s.kind === 'envelope');
}

/** Human label for a kind — shared by the card and its aria labels. */
export function envelopeDirectionLabel(
  kind: SessionEnvelopeKind,
  source?: SessionEnvelopeSource,
): string {
  // Claude Code framed it, not Walnut: say so, so a reader knows which system
  // routed the message and which session list the id belongs to.
  if (source === 'claude-code') return 'Message from another Claude Code session';
  switch (kind) {
    case 'reply': return 'Reply from session';
    case 'peer-note': return 'Message from another session';
    case 'notification': return 'Walnut notification';
    case 'reply-request': return 'Walnut asked you to reply';
    case 'trigger': return 'Trigger fired';
  }
}

/** Glyph for a kind. A text glyph, so it inherits the card's color (contrast rule). */
export function envelopeDirectionGlyph(kind: SessionEnvelopeKind): string {
  switch (kind) {
    case 'reply': return '↩';          // ↩ came back to you
    case 'peer-note': return '→';      // → arrived from elsewhere
    case 'notification': return '◎';   // ◎ Walnut itself speaking
    case 'reply-request': return '↻';  // ↻ your turn to answer
    case 'trigger': return '⚡';        // ⚡ a check script said so
  }
}
