/**
 * Leading machine-banner splitter for a session transcript's USER rows — pure,
 * dependency-free, render-agnostic.
 *
 * Walnut sometimes PREPENDS a machine-written block to the message it hands a
 * `claude` CLI session, using the repo's `[Banner]…[/Banner]` convention:
 *
 *   [Conversation context]
 *   ## Conversation turns you have not seen (injected by Walnut)
 *   …
 *   [/Conversation context]
 *
 *   what the human actually typed
 *
 * The transcript stores that whole string as ONE user turn, so the session panel
 * used to render the injected prose inside the human's own chat bubble, above
 * their words. This module peels the leading blocks off so the caller can fold
 * them into a disclosure row and leave the typed text as the bubble's content.
 *
 * Collapse, not strip: the injected text is real and is occasionally exactly what
 * you need to explain why the model reacted to something you never said. It also
 * means a mis-peel is recoverable — the words are still one click away. The two
 * readers that STRIP instead (`stripLeadingBanners` in the mobile projection, the
 * conversation auto-titler) each render into a single line with no room for an
 * affordance; a scrollable timeline has room, and the web console already folds
 * machine text in a user turn twice over (`chat-task-context` in the Personal AI
 * chat, `InjectedContextRow` in this very panel).
 *
 * Three rules keep a malformed block from eating a real message — the failure
 * mode that would be strictly worse than the artifact this removes:
 *
 *  · The scan only ever consumes a PREFIX. It starts at the top of the message
 *    and stops at the first line that is not blank and not a complete banner, so
 *    a `[/Conversation context]` line inside the human's own prose is never even
 *    looked at (there is no opener above it to close).
 *  · A terminator must be the NAME-MATCHED `[/Name]` on its own line. Unlike the
 *    server-side stripper, which cuts at the last `[/` ANYWHERE in the text, an
 *    unrelated closing tag cannot end a block.
 *  · A block with no terminator (a truncated write) is not a banner at all: the
 *    scan stops there and everything from that line down stays the message. The
 *    artifact remains visible, which is the safe direction — losing the human's
 *    words is not.
 *
 * The FIRST matching terminator wins, deliberately. Taking the last one would let
 * a `[/Name]` line inside the human's typed text pull their whole message into the
 * collapsed block; taking the first can at worst end an injected block early and
 * leave part of the artifact on screen. Only one of those loses content.
 *
 * Not a security boundary. A human who opens their own message with `[note]` and
 * later writes `[/note]` gets their text folded into a disclosure row — the same
 * ambiguity the server-side stripper has always had, and here nothing is deleted.
 */

/** A bracket name longer than this is prose that happens to be bracketed. */
const MAX_NAME_LEN = 80;

/** `[Name]` alone on a line. No brackets inside, and not already a terminator. */
const OPENER = /^\[([^[\]/][^[\]]*)\]$/;

export interface InjectedBanner {
  /** Bracket name exactly as written, e.g. `Conversation context`. */
  name: string;
  /** Row label for the disclosure. */
  label: string;
  /** Everything between the two marker lines, blank edge lines removed. */
  body: string;
  /** The exact slice consumed, both marker lines included. Diagnostics + tests. */
  raw: string;
}

export interface BannerSplit {
  /** Peeled blocks, top-down in the order they were prepended. */
  banners: InjectedBanner[];
  /** What is left: the human's own text. `''` when the turn was only banners. */
  body: string;
}

/**
 * Human label for a banner name.
 *
 * Names the AUTHOR, because the whole defect was text appearing to be the user's.
 * An unknown kind still says who added it rather than guessing at its meaning.
 */
export function injectedBannerLabel(name: string): string {
  const n = name.trim();
  if (/^conversation context$/i.test(n)) return 'Context Walnut added';
  if (/^task context$/i.test(n)) return 'Task context Walnut added';
  return `${n} (added by Walnut)`;
}

/** Join lines with blank lines trimmed off both ends, inner shape untouched. */
function trimBlankEdges(lines: string[]): string {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b).join('\n');
}

/**
 * Split the leading `[Name]…[/Name]` blocks off a stored user message.
 *
 * Returns `null` when there is nothing to peel — including every malformed case —
 * which means "render exactly what you rendered before this existed".
 */
export function splitLeadingBanners(text: string): BannerSplit | null {
  if (!text || !text.includes('[')) return null;
  const lines = text.split('\n');
  const banners: InjectedBanner[] = [];
  let cursor = 0;

  for (;;) {
    let start = cursor;
    while (start < lines.length && lines[start].trim() === '') start++;
    if (start >= lines.length) break;

    const open = OPENER.exec(lines[start].trim());
    if (!open) break;
    const name = open[1].trim();
    // A name has to read like a name: some letters, and short.
    if (!name || name.length > MAX_NAME_LEN || !/[A-Za-z]/.test(name)) break;

    // Name-matched terminator, first occurrence, string equality (a name with
    // regex metacharacters is just a name).
    const closer = `[/${name}]`;
    let end = -1;
    for (let j = start + 1; j < lines.length; j++) {
      if (lines[j].trim() === closer) { end = j; break; }
    }
    if (end === -1) break; // truncated write — consume nothing from here down

    banners.push({
      name,
      label: injectedBannerLabel(name),
      body: trimBlankEdges(lines.slice(start + 1, end)),
      raw: lines.slice(start, end + 1).join('\n'),
    });
    cursor = end + 1;
  }

  if (banners.length === 0) return null;
  return { banners, body: trimBlankEdges(lines.slice(cursor)) };
}

/**
 * The human's own words in a stored turn: the typed text with any leading machine
 * block peeled off, `''` when the turn was nothing but blocks.
 *
 * For the surfaces that have no room to fold anything (one-line previews, counts).
 * They share this so a preview list and its badge count can never disagree about
 * which turns the human actually sent.
 */
export function typedUserText(text: string): string {
  return splitLeadingBanners(text)?.body ?? text;
}
