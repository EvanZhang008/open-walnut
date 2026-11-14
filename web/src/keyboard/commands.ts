/**
 * The shortcuts a person can change (Settings > Keyboard shortcuts): one table that the key
 * handlers, the shortcuts sheet, the Settings list and the hints shown while the modifier is
 * held all read, so none of them can name a key the others do not
 * (tests/web/keyboard-commands.test.ts).
 *
 * Each command has a default chord for each place (KeyEnv): a browser keeps Cmd+N, Cmd+W and
 * Cmd+1..9 on a Mac (Ctrl+ elsewhere) for its own windows and tabs and never hands them to a
 * page, so there the new commands take the session-switching modifier the place leaves free,
 * as Cmd+1..9 do (Ctrl in a Mac browser, Alt elsewhere). A person's own chord for a place is
 * kept in `ui.shortcuts[<place>][<command>]` (shortcut-overrides.ts).
 *
 * The other keys (the column jumps, Undo, Find, Esc...) stay fixed: they are a family or a
 * key every app shares. They are listed in shortcuts.ts, and a command can never take one.
 */
import { chordOf, normalizeChord } from './chords';
import type { KeyEnv } from './shortcuts';

export type CommandId =
  | 'task.new'
  | 'session.close'
  | 'panel.tasks'
  | 'task.search'
  | 'session.find'
  | 'session.new'
  | 'composer.focus'
  | 'task.completeNext';

export type CommandGroup = 'Sessions' | 'Tasks' | 'General';

export interface CommandDef {
  id: CommandId;
  label: string;
  group: CommandGroup;
  /** The chords it answers to by default, per place (several = each one works). */
  defaults: Record<KeyEnv, string[]>;
  /** Keys that do the same and cannot be changed (the task search's `/`), as the sheet shows them. */
  alsoKeys?: string[][];
  /** Where its key is handled, and a line only that handler has (the ratchet test reads it). */
  handler: { file: string; has: RegExp };
}

/** mod: Cmd on a Mac, Ctrl elsewhere. sw: the session-switching modifier (shortcuts.ts). */
const per = (key: string, how: 'mod' | 'sw'): Record<KeyEnv, string[]> => ({
  'mac-app': [`Cmd+${key}`],
  'mac-browser': [how === 'mod' ? `Cmd+${key}` : `Ctrl+${key}`],
  other: [how === 'mod' ? `Ctrl+${key}` : `Alt+${key}`],
});

export const COMMANDS: readonly CommandDef[] = [
  {
    id: 'session.close', label: 'Close the current session column', group: 'Sessions',
    defaults: per('W', 'sw'),
    handler: { file: 'pages/useHomeKeyboard.ts', has: /command === 'session\.close'/ },
  },
  {
    id: 'composer.focus', label: 'Type in the current session', group: 'Sessions',
    // The ordinary modifier works too where it differs (Cmd+I in a Mac browser).
    defaults: { 'mac-app': ['Cmd+I'], 'mac-browser': ['Ctrl+I', 'Cmd+I'], other: ['Alt+I', 'Ctrl+I'] },
    handler: { file: 'pages/useHomeKeyboard.ts', has: /command === 'composer\.focus'/ },
  },
  {
    id: 'session.find', label: 'Find a session', group: 'Sessions',
    defaults: per('Shift+O', 'mod'),
    handler: { file: 'pages/MainPage.tsx', has: /isCommand\(e, 'session\.find'\)/ },
  },
  {
    id: 'session.new', label: 'New session column', group: 'Sessions',
    defaults: per('Shift+Enter', 'mod'),
    handler: { file: 'pages/MainPage.tsx', has: /isCommand\(e, 'session\.new'\)/ },
  },
  {
    id: 'task.new', label: 'New task', group: 'Tasks',
    defaults: per('N', 'sw'),
    handler: { file: 'keyboard/KeyboardCommandsHost.tsx', has: /case 'task\.new':/ },
  },
  {
    id: 'task.completeNext', label: 'Complete the current task and go to the next one that needs you', group: 'Tasks',
    defaults: per('Shift+D', 'mod'),
    handler: { file: 'pages/useHomeKeyboard.ts', has: /command === 'task\.completeNext'/ },
  },
  {
    id: 'task.search', label: 'Search tasks', group: 'Tasks',
    defaults: per('K', 'mod'),
    alsoKeys: [['/']],
    handler: { file: 'components/tasks/TodoSearchBar.tsx', has: /isCommand\(e, 'task\.search'\)/ },
  },
  {
    id: 'panel.tasks', label: 'Show or hide the task panel', group: 'General',
    defaults: per('\\', 'sw'),
    handler: { file: 'keyboard/KeyboardCommandsHost.tsx', has: /case 'panel\.tasks':/ },
  },
];

export const COMMAND_IDS = COMMANDS.map((c) => c.id);

export function commandDef(id: CommandId): CommandDef {
  return COMMANDS.find((c) => c.id === id)!;
}

/**
 * Keys each place keeps for itself, which no command may take: the Mac app's menus
 * (desktop/main.swift; tests/web/keyboard-commands.test.ts reads them there) and the keys a
 * browser never hands to a page.
 */
export const RESERVED: Record<KeyEnv, readonly string[]> = {
  'mac-app': [
    'Cmd+Q', 'Cmd+H', 'Cmd+Alt+H', 'Cmd+M', 'Cmd+,', 'Cmd+Shift+W', 'Cmd+Z', 'Cmd+Shift+Z', 'Cmd+X', 'Cmd+C', 'Cmd+V',
    'Cmd+A', 'Cmd+R', 'Cmd+Shift+R', 'Cmd+B', 'Cmd+=', 'Cmd+-', 'Cmd+0', 'Cmd+Ctrl+Alt+D', 'Cmd+Ctrl+F', 'Cmd+Tab',
    'Cmd+Space',
  ],
  'mac-browser': [
    'Cmd+N', 'Cmd+Shift+N', 'Cmd+T', 'Cmd+Shift+T', 'Cmd+W', 'Cmd+Shift+W', 'Cmd+Q', 'Cmd+H', 'Cmd+M', 'Cmd+L',
    'Cmd+R', 'Cmd+Shift+R', 'Cmd+,', 'Cmd+Z', 'Cmd+Shift+Z', 'Cmd+X', 'Cmd+C', 'Cmd+V', 'Cmd+A', 'Cmd+P', 'Cmd+S',
    'Cmd+1', 'Cmd+2', 'Cmd+3', 'Cmd+4', 'Cmd+5', 'Cmd+6', 'Cmd+7', 'Cmd+8', 'Cmd+9', 'Cmd+Alt+I', 'Cmd+Alt+J', 'Cmd+Alt+C',
    'Cmd+Shift+[', 'Cmd+Shift+]', 'Cmd+Tab', 'Cmd+Space', 'Ctrl+Tab', 'Ctrl+Shift+Tab',
  ],
  other: [
    'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+W', 'Ctrl+Shift+W', 'Ctrl+Q', 'Ctrl+L', 'Ctrl+R',
    'Ctrl+Shift+R', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+X', 'Ctrl+C', 'Ctrl+V', 'Ctrl+A', 'Ctrl+P', 'Ctrl+S', 'Ctrl+Shift+I',
    'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9', 'Ctrl+Tab', 'Ctrl+Shift+Tab',
    'Alt+F4', 'Alt+Tab',
  ],
};

/** A person's own chords, for one place: command → chord ('' = no key). */
export type Overrides = Partial<Record<CommandId, string>>;

/** The chords a command answers to now. */
export function chordsFor(id: CommandId, env: KeyEnv, overrides: Overrides = {}): string[] {
  const own = overrides[id];
  if (own !== undefined) {
    const n = own ? normalizeChord(own) : null;
    return n ? [n] : [];
  }
  return commandDef(id).defaults[env];
}

/** Every chord to command, for one place. A chord two commands hold (a hand-edited config) goes to
 *  the first in the table, the same answer everywhere. */
export function bindings(env: KeyEnv, overrides: Overrides = {}): Map<string, CommandId> {
  const map = new Map<string, CommandId>();
  for (const c of COMMANDS) for (const ch of chordsFor(c.id, env, overrides)) if (!map.has(ch)) map.set(ch, c.id);
  return map;
}

/** The command a key press runs, if any. */
export function commandFor(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, env: KeyEnv, overrides: Overrides = {}): CommandId | null {
  const ch = chordOf(e);
  return ch ? bindings(env, overrides).get(ch) ?? null : null;
}
