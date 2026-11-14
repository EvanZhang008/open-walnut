/**
 * Settings > Keyboard shortcuts: every shortcut the app has, from the same table the keys and
 * the shortcuts sheet use (keyboard/shortcuts.ts, keyboard/commands.ts). A command's key can
 * change: Change, then press the new keys. A key that something else holds (another command, a
 * fixed key, the Mac app's menus or the browser) is refused and says who has it. Reset puts one
 * back, Reset all every one. The keys are this place's (the Mac app, a Mac browser,
 * elsewhere): each place keeps its own, since a browser keeps keys the app does not.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import { chordLabel, chordOf } from '@/keyboard/chords';
import { commandDef, type CommandId } from '@/keyboard/commands';
import { detectKeyEnv, shortcutGroups, type KeyEnv, type ShortcutRow } from '@/keyboard/shortcuts';
import { resetCommandChord, setCommandChord, useShortcutOverrides } from '@/keyboard/shortcut-overrides';
import { ShortcutKeys } from '@/keyboard/ShortcutKeys';
import '@/styles/keyboard-shortcuts.css';

const PLACE: Record<KeyEnv, string> = {
  'mac-app': 'the Mac app',
  'mac-browser': 'a browser on a Mac',
  other: 'this browser',
};

function Keys({ row }: { row: ShortcutRow }) {
  return row.keys.length === 0 ? <span className="shortcuts-settings-none">No key</span> : <ShortcutKeys row={row} />;
}

export function KeyboardShortcutsSection() {
  const env = useMemo(detectKeyEnv, []);
  const overrides = useShortcutOverrides(env);
  const groups = useMemo(() => shortcutGroups(env, overrides), [env, overrides]);
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [errors, setErrors] = useState<Partial<Record<CommandId, string>>>({});
  const changed = Object.keys(overrides).length > 0;

  const setError = useLeanCallback((id: CommandId, why: string | null) => {
    setErrors((prev) => { const next = { ...prev }; if (why) next[id] = why; else delete next[id]; return next; });
  }, []);

  // While a row listens, the next key press is its new key, and nothing else sees it.
  useEffect(() => {
    if (!recording) return;
    const id = recording;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { setRecording(null); return; }
      // A modifier on its own: wait for the key that goes with it.
      if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') return;
      const chord = chordOf(e);
      if (!chord) { setRecording(null); setError(id, 'That key cannot be a shortcut. Try a letter, a digit or a sign with ⌘, ⌃ or ⌥.'); return; }
      setRecording(null);
      void setCommandChord(id, chord, env).then((why) => setError(id, why)).catch(() => setError(id, 'The key could not be saved. Try again.'));
    };
    const onUp = (e: KeyboardEvent) => { e.stopImmediatePropagation(); };
    const stop = () => setRecording(null);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', stop);
    };
  }, [recording, env, setError]);

  const reset = (id?: CommandId) => {
    setRecording(null);
    void resetCommandChord(env, id).then((why) => {
      if (id) setError(id, why); else setErrors({});
    }).catch(() => { if (id) setError(id, 'The key could not be reset. Try again.'); });
  };

  return (
    <SettingsSection
      id="shortcuts"
      className="shortcuts-settings"
      title="Keyboard shortcuts"
      description={`The keys for ${PLACE[env]}. A browser keeps some keys for its own tabs and windows, so each place has its own.`}
      actions={changed ? (
        <button type="button" className="settings-button settings-button-default" data-testid="shortcuts-reset-all" onClick={() => reset()}>
          Reset all
        </button>
      ) : undefined}
    >
      {groups.map((g) => (
        <SettingsGroup key={g.title} heading={g.title} data-testid={`shortcuts-group-${g.title.toLowerCase()}`}>
          {g.rows.map((row) => {
            const id = row.command;
            if (!id) {
              return (
                <SettingsRow key={row.id} label={row.label} help="Fixed" data-shortcut={row.id} control={<Keys row={row} />} />
              );
            }
            const listening = recording === id;
            const own = overrides[id] !== undefined;
            const why = errors[id];
            return (
              <SettingsRow
                key={row.id}
                label={row.label}
                help={listening ? 'Press the new keys. Esc keeps the old ones.' : own ? `Default: ${defaultLabel(id, env)}` : undefined}
                error={why}
                data-shortcut={row.id}
                data-listening={listening ? 'true' : undefined}
                control={
                  <span className="shortcuts-settings-control">
                    {listening ? <span className="shortcuts-settings-listening" aria-live="polite">Press keys…</span> : <Keys row={row} />}
                    <button
                      type="button"
                      className="settings-button settings-button-default"
                      data-testid={`shortcut-change-${id}`}
                      aria-label={`Change the key for ${row.label}`}
                      onClick={() => { setError(id, null); setRecording(listening ? null : id); }}
                    >
                      {listening ? 'Cancel' : 'Change'}
                    </button>
                    {own && !listening && (
                      <button
                        type="button"
                        className="settings-button settings-button-default"
                        data-testid={`shortcut-reset-${id}`}
                        aria-label={`Reset the key for ${row.label}`}
                        onClick={() => reset(id)}
                      >
                        Reset
                      </button>
                    )}
                  </span>
                }
              />
            );
          })}
        </SettingsGroup>
      ))}
    </SettingsSection>
  );
}

function defaultLabel(id: CommandId, env: KeyEnv): string {
  return commandDef(id).defaults[env].map((ch) => chordLabel(ch, env !== 'other')).join(' or ');
}
