/**
 * A button's key, shown while the session-switching modifier is held alone on Home (with the
 * column numbers, keyboard/held-hints.ts): "⌘N" under New task, "⌘W" under the current
 * column's close. It reads the command's key now (keyboard/commands.ts), the person's own if
 * they gave it one, and shows nothing for a command with no key.
 */
import { useMemo } from 'react';
import { chordLabel } from './chords';
import { chordsFor, type CommandId } from './commands';
import { useHeldHints } from './held-hints';
import { useShortcutOverrides } from './shortcut-overrides';
import { detectKeyEnv } from './shortcuts';
import '@/styles/keyboard-shortcuts.css';

export function ShortcutHint({ command }: { command: CommandId }) {
  const shown = useHeldHints();
  const env = useMemo(detectKeyEnv, []);
  const overrides = useShortcutOverrides(env);
  if (!shown) return null;
  const chord = chordsFor(command, env, overrides)[0];
  if (!chord) return null;
  return <kbd className="shortcut-hint" data-command={command} aria-hidden="true">{chordLabel(chord, env !== 'other')}</kbd>;
}
