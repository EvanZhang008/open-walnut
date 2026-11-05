/**
 * Whose words a message hint is (2026-11-01, the user: "it should be clear which is
 * built in which is user defined", and of a Reply language hint "is this global in
 * all people's Walnut or just me?"). Pure and shared with the web app
 * (`@open-walnut/hint-origin`), so Settings and the "what Walnut added" view say the
 * same thing:
 *   - a built-in hint's text is Walnut's, the same in every Walnut, except the part
 *     a setting of the user's fills in (`HINT_USER_SETTINGS`);
 *   - a custom hint (Settings, Add a hint) is all the user's own.
 * `tests/core/hints/hint-origin.test.ts` fails when a built-in starts carrying a
 * user's words this file does not mark.
 */

import { REPLY_LANGUAGE_LINES } from './reply-language-lines.js';

/** Every hint kind the registry defines (hint-registry.ts BUILT_IN), in its order. */
export const BUILT_IN_HINT_KINDS = ['question', 'rich-output', 'reply-language', 'voice-reply', 'object-context', 'user-away', 'brief', 'threads', 'threads-tidy', 'hand-on'] as const;

/** Walnut text that rides a message outside the registry (no switch in Settings). */
export const WALNUT_ONLY_KINDS = ['session-context', 'engine-switch', 'images', 'status-question-cut'] as const;

/** Walnut's own clause after the user's reply-language sentence. */
export const REPLY_LANGUAGE_SCOPE = 'This covers every line the user reads, the short progress lines between your tool calls included.';

const CORRECTION_HEAD = 'Correction: your last reply the user read';
const CORRECTION_TAIL = 'was not in his language. Write every line he reads in it from now on, '
  + 'also when the message you answer, a tool result or your own notes are in English.';

/** The line that leads the reply-language hint after a reply the user read broke it. */
export function replyLanguageCorrection(driftAt: string): string {
  const t = Date.parse(driftAt);
  const when = Number.isFinite(t) ? ` (the turn that ended ${new Date(t).toISOString().slice(11, 16)} UTC)` : '';
  return `${CORRECTION_HEAD}${when} ${CORRECTION_TAIL}`;
}

/** A built-in whose text holds a setting of the user's: which one, and where Settings shows it. */
export interface HintUserSetting {
  /** The setting's name in Settings. */
  label: string;
  /** Its row's anchor on the Settings page. */
  anchor: string;
  /** Its key under config `session`. */
  key: 'reply_language';
  /** The Walnut text sent after it, the same for everyone. */
  walnutText: string;
}

export const HINT_USER_SETTINGS: Readonly<Record<string, HintUserSetting>> = {
  'reply-language': { label: 'Reply language', anchor: 'session-reply-language', key: 'reply_language', walnutText: REPLY_LANGUAGE_SCOPE },
};

export function isBuiltInHintKind(kind: string): boolean {
  return (BUILT_IN_HINT_KINDS as readonly string[]).includes(kind) || (WALNUT_ONLY_KINDS as readonly string[]).includes(kind);
}

/** One stretch of a hint's text and whose words it is. */
export interface HintTextPart {
  text: string;
  from: 'walnut' | 'user';
  /** For the user's words of a built-in: the setting they come from. */
  setting?: string;
}

/**
 * A hint's text cut into Walnut's words and the user's, in order, joined back with
 * single spaces where the cut was. Read from the text the AI received, so an old
 * message shows the setting as it was then, not as it is now.
 */
export function hintTextParts(h: { kind: string; text: string }): HintTextPart[] {
  const text = h.text;
  if (!isBuiltInHintKind(h.kind)) return text ? [{ text, from: 'user' }] : [];
  const setting = HINT_USER_SETTINGS[h.kind];
  if (!setting) return text ? [{ text, from: 'walnut' }] : [];
  const parts: HintTextPart[] = [];
  let rest = text;
  // Walnut's lines in the user's language lead it (reply-language-lines.ts): the ask, then the correction.
  for (const pick of [(l: typeof REPLY_LANGUAGE_LINES[string]) => l.reply, (l: typeof REPLY_LANGUAGE_LINES[string]) => l.drifted]) {
    const line = Object.values(REPLY_LANGUAGE_LINES).map(pick).find((x) => rest.startsWith(`${x} `));
    if (line) { parts.push({ text: line, from: 'walnut' }); rest = rest.slice(line.length).trimStart(); }
  }
  if (rest.startsWith(CORRECTION_HEAD)) {
    const end = rest.indexOf(CORRECTION_TAIL);
    if (end >= 0) {
      parts.push({ text: rest.slice(0, end + CORRECTION_TAIL.length), from: 'walnut' });
      rest = rest.slice(end + CORRECTION_TAIL.length).trimStart();
    }
  }
  let tail = '';
  if (rest.endsWith(setting.walnutText)) {
    tail = setting.walnutText;
    rest = rest.slice(0, rest.length - tail.length).trimEnd();
  }
  if (rest) parts.push({ text: rest, from: 'user', setting: setting.label });
  if (tail) parts.push({ text: tail, from: 'walnut' });
  return parts;
}
