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


/** Every hint kind the registry defines (hint-registry.ts BUILT_IN), in its order. */
export const BUILT_IN_HINT_KINDS = ['question', 'rich-output', 'reply-language', 'voice-reply', 'object-context', 'user-away', 'brief', 'threads', 'threads-tidy', 'hand-on'] as const;

/** Walnut text that rides a message outside the registry (no switch in Settings). */
export const WALNUT_ONLY_KINDS = ['session-context', 'engine-switch', 'images', 'status-question-cut'] as const;

/**
 * Walnut's own words after the user's reply-language sentence, on the message after a turn the user
 * read broke it (hints/reply-language-drift.ts); the language itself is a line of the system prompt.
 */
export const REPLY_LANGUAGE_DRIFT_TAIL = 'Your last reply the user read was not in this language. Write every line the user reads in it, '
  + 'the short progress lines between tool calls and what you send to other tasks included, also when the message you answer or a tool result is in English.';

/** A built-in whose text holds a setting of the user's: which one, and where Settings shows it. */
export interface HintUserSetting {
  /** The setting's name in Settings. */
  label: string;
  /** Its row's anchor on the Settings page. */
  anchor: string;
  /** Its key under config `session`. */
  key: string;
  /** The Walnut text sent after it, the same for everyone. */
  walnutText: string;
}

export const HINT_USER_SETTINGS: Readonly<Record<string, HintUserSetting>> = {
  'reply-language': { label: 'Reply language', anchor: 'session-reply-language', key: 'reply_language', walnutText: REPLY_LANGUAGE_DRIFT_TAIL },
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
  let tail = '';
  // Walnut's words run from its fixed text to the end (a quote of the session's own line may follow it).
  const at = rest.lastIndexOf(setting.walnutText);
  if (at >= 0) {
    tail = rest.slice(at);
    rest = rest.slice(0, at).trimEnd();
  }
  if (rest) parts.push({ text: rest, from: 'user', setting: setting.label });
  if (tail) parts.push({ text: tail, from: 'walnut' });
  return parts;
}
