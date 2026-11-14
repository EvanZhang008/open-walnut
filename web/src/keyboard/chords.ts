/**
 * A key chord as one string, the form Settings stores and the key handlers compare:
 * modifiers in a fixed order, then one key, joined by "+", e.g. "Cmd+Shift+O", "Alt+N",
 * "Cmd+\\". A letter or digit is the one the key types (`key`), as the Mac's menus and the
 * browsers read it, so ⌘Z is Undo on an AZERTY keyboard too (where that key sits where QWERTY's
 * W does). The physical key (`code`) answers instead when what it types is no plain letter or
 * digit: with Alt (Option+N types a dead key on a Mac), with Shift on a digit, on a non-Latin
 * layout, and for the punctuation keys.
 */

export type Modifier = 'Cmd' | 'Ctrl' | 'Alt' | 'Shift';
const ORDER: readonly Modifier[] = ['Cmd', 'Ctrl', 'Alt', 'Shift'];

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

/** Physical keys a chord may end in, by `code`, with the name the chord uses. */
const NAMED: Record<string, string> = {
  Enter: 'Enter', NumpadEnter: 'Enter', Backslash: '\\', Slash: '/', BracketLeft: '[', BracketRight: ']',
  Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', Backquote: '`',
  Space: 'Space', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Escape: 'Esc',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

function keyName(e: KeyLike): string | null {
  if (!e.altKey && /^[a-z0-9]$/i.test(e.key)) return e.key.toUpperCase();
  const m = /^Key([A-Z])$/.exec(e.code) ?? /^Digit([0-9])$/.exec(e.code) ?? /^(F[0-9]{1,2})$/.exec(e.code);
  if (m) return m[1]!;
  if (NAMED[e.code]) return NAMED[e.code]!;
  // No `code` (a synthetic event): fall back to the key itself.
  if (!e.code && e.key && e.key.length === 1 && /[a-z0-9]/i.test(e.key)) return e.key.toUpperCase();
  if (!e.code && e.key === 'Enter') return 'Enter';
  return null;
}

/** The chord a key press makes, or null for a modifier pressed alone (or a key no chord uses). */
export function chordOf(e: KeyLike): string | null {
  const key = keyName(e);
  if (!key) return null;
  const mods: Modifier[] = [];
  if (e.metaKey) mods.push('Cmd');
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

/** The same chord written any way ("shift+cmd+o") in the stored form ("Cmd+Shift+O"). */
export function normalizeChord(chord: string): string | null {
  const parts = chord.split('+').map((p) => p.trim()).filter(Boolean);
  // "Cmd++" (the + key) never comes up: Equal is the key, "=" its name.
  if (parts.length === 0) return null;
  const key = parts.pop()!;
  const mods = new Set<Modifier>();
  for (const p of parts) {
    const m = ORDER.find((o) => o.toLowerCase() === p.toLowerCase());
    if (!m) return null;
    mods.add(m);
  }
  const k = key.length === 1 ? key.toUpperCase() : key;
  return [...ORDER.filter((o) => mods.has(o)), k].join('+');
}

export function chordParts(chord: string): { mods: Modifier[]; key: string } {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  return { mods: parts as Modifier[], key };
}

/** A chord needs Cmd, Ctrl or Alt: a letter alone, or Shift with one, is typing. */
export function hasCommandModifier(chord: string): boolean {
  const { mods } = chordParts(chord);
  return mods.includes('Cmd') || mods.includes('Ctrl') || mods.includes('Alt');
}

const MAC_GLYPH: Record<Modifier, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' };
const KEY_LABEL: Record<string, string> = { Enter: '↩', Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: '⌫', Delete: '⌦', Tab: '⇥' };

/** The chord as the keys a person reads: ['⌘', 'N'] on a Mac, ['Ctrl', 'N'] elsewhere. */
export function chordKeys(chord: string, mac: boolean): string[] {
  const { mods, key } = chordParts(chord);
  // The sheet's own order, ⌘ first (⌘⇧D), as its fixed rows write it.
  if (mac) return [...ORDER.filter((m) => mods.includes(m)).map((m) => MAC_GLYPH[m]), KEY_LABEL[key] ?? key];
  return [...ORDER.filter((m) => mods.includes(m)).map((m) => (m === 'Cmd' ? 'Win' : m)), key === 'Enter' ? 'Enter' : key];
}

/** One label: "⌘N" on a Mac, "Ctrl+N" elsewhere. */
export function chordLabel(chord: string, mac: boolean): string {
  return chordKeys(chord, mac).join(mac ? '' : '+');
}
