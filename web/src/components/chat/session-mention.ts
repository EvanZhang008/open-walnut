/**
 * Session mention ("@<session> message") — pure logic.
 *
 * Mirrors Claude Code's direct-member-message convention: a message whose FIRST
 * character is "@" followed by a name and a space is a direct message to that
 * peer, not to the current session (Claude Code parses `^@([\w-]+)\s+(.+)$` in
 * its input box; verified against the 2.1.240 binary). Walnut inserts the
 * 8-char session id prefix as the name — the server's
 * resolveSessionByIdOrPrefix resolves it back (409 on ambiguity, so a routed
 * send can never silently reach the wrong session).
 *
 * The trigger and the directive are deliberately narrow:
 *  - trigger only at input position 0 (mid-text "@" stays a file reference),
 *  - query with "/" or a leading "?" belongs to the file popup (@path, @? recents),
 *  - the directive ref must look like an id prefix (4+ word chars) — "@Makefile
 *    fix this" parses but then fails prefix resolution and falls through to a
 *    normal send, so file refs and literal "@" text are never mis-routed.
 */

import type { PaletteItem } from './CommandPalette';

export interface SessionMentionCandidate {
  /** Full session id (routing key). */
  id: string;
  title: string;
  host: string;
  status: string;
}

/** Palette row shown for one session candidate. */
export interface SessionPaletteItem extends PaletteItem {
  sessionId: string;
}

/** Trailing palette row that switches the popup to the file browser. */
export const BROWSE_FILES_ITEM: PaletteItem = {
  name: 'Browse files…',
  description: 'Reference a file instead (@path); @? lists recent folders',
  source: 'control',
};

/**
 * Should typing "@<query>" at `atIndex` open the SESSION picker (vs the file
 * popup)? Line start only; a path-looking or recents query goes to files.
 */
export function shouldTriggerSessionMention(atIndex: number, query: string): boolean {
  if (atIndex !== 0) return false;
  if (query.includes('/')) return false;
  if (query.startsWith('?')) return false;
  return true;
}

/**
 * Parse a leading session directive: `@<ref> <body>`. Returns null when the
 * text can't be one (no leading @, no space, or a ref that can't be an id
 * prefix). A non-null result still needs server-side prefix resolution.
 */
export function parseSessionDirective(text: string): { ref: string; body: string } | null {
  const m = text.match(/^@([\w-]{4,})\s+([\s\S]+)$/);
  if (!m) return null;
  const body = m[2].trim();
  if (!body) return null;
  return { ref: m[1], body };
}

/** The token inserted into the composer for a picked session. */
export function formatSessionRef(id: string): string {
  return `@${id.slice(0, 8)} `;
}

export function sessionToPaletteItem(s: SessionMentionCandidate): SessionPaletteItem {
  const host = s.host && s.host !== '__local__' ? s.host : 'local';
  return {
    name: s.id.slice(0, 8),
    description: `${s.title || '(untitled)'} — ${host} · ${s.status}`,
    source: 'session',
    sessionId: s.id,
  };
}
