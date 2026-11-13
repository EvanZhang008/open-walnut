/**
 * The app's keyboard shortcuts: one table that the key handlers match against and the
 * shortcuts sheet (ShortcutsHelp.tsx) lists, so the sheet can never name a key that does
 * nothing (tests/web/keyboard-shortcuts.test.ts).
 *
 * Where a browser keeps a chord for itself it never reaches the page: Cmd+1..9 and
 * Cmd+Shift+[ / ] switch tabs in Chrome and Safari on a Mac, and Ctrl+1..9 does on Windows
 * and Linux. So the session-switching chords take the modifier the place leaves free:
 * Cmd in the Mac app (its menus take neither), Ctrl in a Mac browser, Alt elsewhere.
 *
 * The shortcuts a person can change (New task, Close the current column, ...) live in
 * commands.ts; the sheet lists them in the chords they answer to now.
 */
import { isMacPlatform } from '@/hooks/usePanelKeyRouter';
import { MAX_PANELS } from '@/hooks/session-panel-limits';
import { chordKeys } from './chords';
import { chordsFor, commandDef, type CommandId, type Overrides } from './commands';

const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

export type KeyEnv = 'mac-app' | 'mac-browser' | 'other';

export function detectKeyEnv(): KeyEnv {
  if (!isMacPlatform()) return 'other';
  // The Mac app's web view carries its own message handlers (desktop/main.swift).
  const handlers = (window as unknown as { webkit?: { messageHandlers?: Record<string, unknown> } }).webkit?.messageHandlers;
  return handlers && ('walnutUpdate' in handlers || 'walnutChrome' in handlers) ? 'mac-app' : 'mac-browser';
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

/** The ordinary command modifier: Cmd on a Mac, Ctrl elsewhere, alone. */
function modOnly(e: KeyLike, env: KeyEnv): boolean {
  if (e.altKey) return false;
  return env === 'other' ? e.ctrlKey && !e.metaKey : e.metaKey && !e.ctrlKey;
}

/** The session-switching modifier for this place (see the header), alone. */
function switchMod(e: KeyLike, env: KeyEnv): boolean {
  switch (env) {
    case 'mac-app': return e.metaKey && !e.ctrlKey && !e.altKey;
    case 'mac-browser': return e.ctrlKey && !e.metaKey && !e.altKey;
    default: return e.altKey && !e.ctrlKey && !e.metaKey;
  }
}

/** mod+1..9 → 1..9; anything else → 0. Reads the physical key, so a layout or Alt's
 *  special characters (Option+1 types ¡ on a Mac) do not change it. */
export function jumpIndex(e: KeyLike, env: KeyEnv): number {
  if (e.shiftKey || !switchMod(e, env)) return 0;
  const m = /^Digit([1-9])$/.exec(e.code) ?? /^([1-9])$/.exec(e.key);
  return m ? Number(m[1]) : 0;
}

/** mod+shift+[ → -1, mod+shift+] → 1. */
export function cycleDir(e: KeyLike, env: KeyEnv): -1 | 0 | 1 {
  if (!e.shiftKey || !switchMod(e, env)) return 0;
  if (e.code === 'BracketLeft' || e.key === '[' || e.key === '{') return -1;
  if (e.code === 'BracketRight' || e.key === ']' || e.key === '}') return 1;
  return 0;
}

/** `?` (outside a text box) or mod+/ (anywhere). */
export function isHelpChord(e: KeyLike, env: KeyEnv, typing: boolean): boolean {
  if (modOnly(e, env) && !e.shiftKey && (e.code === 'Slash' || e.key === '/')) return true;
  return !typing && e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** Is the modifier that shows the column numbers held alone? */
export function isJumpHintModifier(e: KeyLike, env: KeyEnv): boolean {
  if (e.shiftKey) return false;
  switch (env) {
    case 'mac-app': return e.key === 'Meta' && e.metaKey && !e.ctrlKey && !e.altKey;
    case 'mac-browser': return e.key === 'Control' && e.ctrlKey && !e.metaKey && !e.altKey;
    default: return e.key === 'Alt' && e.altKey && !e.ctrlKey && !e.metaKey;
  }
}

// ── The sheet ──

export interface ShortcutRow {
  id: string;
  /** A row for a command a person can change (commands.ts). */
  command?: CommandId;
  /** Each entry is one chord as its keys, e.g. ['⌘', '⇧', 'D']; several = alternatives. */
  keys: string[][];
  label: string;
  /** Word between alternatives: 'to' for a range, '/' for a pair, 'or' by default. */
  sep?: string;
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

function names(env: KeyEnv) {
  const mac = env !== 'other';
  return {
    mod: mac ? '⌘' : 'Ctrl',
    shift: mac ? '⇧' : 'Shift',
    sw: env === 'mac-app' ? '⌘' : env === 'mac-browser' ? '⌃' : 'Alt',
    enter: mac ? '↩' : 'Enter',
  };
}

/** The keys the column number badges show: "⌘1". */
export function jumpBadgeLabel(n: number, env: KeyEnv): string {
  const k = names(env).sw;
  return env === 'other' ? `${k}+${n}` : `${k}${n}`;
}

function commandRow(id: CommandId, env: KeyEnv, overrides: Overrides): ShortcutRow {
  const c = commandDef(id);
  const keys = [...chordsFor(id, env, overrides).map((ch) => chordKeys(ch, env !== 'other')), ...(c.alsoKeys ?? [])];
  return { id, command: id, keys, label: c.label };
}

/** The sheet, in the keys of `env`; a command row in the chord the person gave it (`overrides`). */
export function shortcutGroups(env: KeyEnv, overrides: Overrides = {}): ShortcutGroup[] {
  const k = names(env);
  const cmd = (id: CommandId) => commandRow(id, env, overrides);
  return [
    {
      title: 'Sessions',
      rows: [
        // As many as the strip can hold (Settings > General > Session panels).
        { id: 'session.jump', keys: [[k.sw, '1'], [k.sw, String(MAX_PANELS)]], label: `Go to the 1st to ${ORDINAL[MAX_PANELS]} session column`, sep: 'to' },
        { id: 'session.last', keys: [[k.sw, '9']], label: 'Go to the last session column' },
        { id: 'session.numbers', keys: [[k.sw]], label: 'Hold to show each column\'s number and the keys of the buttons' },
        { id: 'session.cycle', keys: [[k.sw, k.shift, '['], [k.sw, k.shift, ']']], label: 'Previous / next session column', sep: '/' },
        cmd('session.close'),
        cmd('composer.focus'),
        cmd('session.find'),
        cmd('session.new'),
        { id: 'session.drawer', keys: [[k.mod, k.shift, 'E']], label: 'Show or hide the questions drawer' },
      ],
    },
    {
      title: 'Tasks',
      rows: [
        cmd('task.new'),
        cmd('task.completeNext'),
        { id: 'undo', keys: [[k.mod, 'Z']], label: 'Undo the last task action (for 5 seconds)' },
        cmd('task.search'),
        { id: 'task.filter', keys: [['F']], label: 'Filter the task list' },
      ],
    },
    {
      title: 'General',
      rows: [
        cmd('panel.tasks'),
        { id: 'page.find', keys: [[k.mod, 'F']], label: 'Find on the page' },
        { id: 'help', keys: [['?'], [k.mod, '/']], label: 'Show these shortcuts' },
        { id: 'escape', keys: [['Esc']], label: 'Close a menu or dialog, or clear the selected task' },
      ],
    },
  ];
}

/** The fixed rows' chords (every one a command may not take), with the row's words. */
export function fixedChords(env: KeyEnv): Map<string, string> {
  const sw = env === 'mac-app' ? 'Cmd' : env === 'mac-browser' ? 'Ctrl' : 'Alt';
  const mod = env === 'other' ? 'Ctrl' : 'Cmd';
  const rows = new Map(shortcutGroups(env).flatMap((g) => g.rows).map((r) => [r.id, r.label]));
  const out = new Map<string, string>();
  for (let n = 1; n <= 9; n++) out.set(`${sw}+${n}`, rows.get(n === 9 ? 'session.last' : 'session.jump')!);
  out.set(`${sw}+Shift+[`, rows.get('session.cycle')!);
  out.set(`${sw}+Shift+]`, rows.get('session.cycle')!);
  out.set(`${mod}+Shift+E`, rows.get('session.drawer')!);
  out.set(`${mod}+Z`, rows.get('undo')!);
  out.set(`${mod}+F`, rows.get('page.find')!);
  out.set(`${mod}+/`, rows.get('help')!);
  return out;
}

/** A note under the sheet for a browser, where some chords differ from the Mac app's. */
export function envNote(env: KeyEnv): string | null {
  if (env === 'mac-browser') return 'In a browser, session switching uses ⌃ (Control): the browser keeps ⌘1 to ⌘9 for its tabs. The Mac app uses ⌘.';
  if (env === 'other') return 'Session switching uses Alt: the browser keeps Ctrl+1 to Ctrl+9 for its tabs.';
  return null;
}
