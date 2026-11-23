/**
 * The engine's API key in "<Engine> sign-in" (EngineSignInGroup): ONE row for every machine, as
 * the setting is one (config `engines.<id>.env`, the overlay every session of the engine gets on
 * every host). Not set: a masked field and Save; set: Remove. A host row's "Use a <key> instead"
 * brings the person here (`focusNonce`): the row comes into view, points itself out and takes the
 * focus. Only a person changes it (the route refuses a session or a browser under automation).
 */
import { useEffect, useRef, useState } from 'react';
import { SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { NoticeStatus } from '@/components/common/NoticeCard';
import { log } from '@/utils/log';
import { removeEngineApiKey, saveEngineApiKey } from '@/api/engine-sign-in';
import { ENGINE_SIGN_IN_UI, refusalCode, refusalWords, signInKeyRowId, type SignInEngine } from './engine-sign-in-model';

export function EngineApiKeyRow({ engine, set, host, onChanged, focusNonce }: {
  engine: SignInEngine;
  /** The key is saved in Walnut's settings. */
  set: boolean;
  /** A host whose status comes back with the answer (the first one listed). */
  host: string;
  onChanged: () => void;
  focusNonce: number;
}) {
  const ui = ENGINE_SIGN_IN_UI[engine];
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // Brought here from a host's "Use a key instead": into view, pointed out once, focused.
  useEffect(() => {
    if (!focusNonce || !box.current) return;
    box.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.current.classList.remove('settings-anchor-flash');
    void box.current.offsetWidth;
    box.current.classList.add('settings-anchor-flash');
    const t = window.setTimeout(() => box.current?.classList.remove('settings-anchor-flash'), 1300);
    field.current?.focus({ preventScroll: true });
    return () => window.clearTimeout(t);
  }, [focusNonce]);

  const write = async (what: 'save' | 'remove') => {
    setBusy(what);
    setError(null);
    try {
      if (what === 'save') await saveEngineApiKey(engine, key.trim(), host);
      else await removeEngineApiKey(engine, host);
      log.info('settings', what === 'save' ? 'engine api key saved' : 'engine api key removed', { engine });
      setKey('');
      onChanged();
    } catch (err) {
      log.warn('settings', 'engine api key change refused', { engine, step: what, code: refusalCode(err) });
      setError(refusalWords(err, 'key', 'this machine'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-addons-rows" id={signInKeyRowId(engine)} ref={box} data-testid="engine-sign-in-key-row" data-set={set ? 'true' : 'false'}>
      <SettingsRow
        label={ui.keyName}
        help={set
          ? <NoticeStatus tone="ok" title={`Every machine's ${ui.name} sessions sign in with it.`}>Set, used on every machine</NoticeStatus>
          : <NoticeStatus tone="muted" title={`Only ${ui.name} uses it, on every machine.`}>Not set</NoticeStatus>}
        error={error}
        control={set
          ? <SettingsButton onClick={() => void write('remove')} busy={busy === 'remove'} busyLabel="Removing..." data-testid="engine-sign-in-remove-key">Remove</SettingsButton>
          : (
            <span className="settings-control-cluster">
              <input
                ref={field}
                className="settings-input settings-input--short"
                type="password"
                aria-label={ui.keyName}
                autoComplete="off"
                spellCheck={false}
                data-no-draft="secret"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) void write('save'); }}
                data-testid="engine-sign-in-key"
              />
              <SettingsButton variant="primary" disabled={!key.trim()} busy={busy === 'save'} busyLabel="Saving..."
                onClick={() => void write('save')} data-testid="engine-sign-in-save-key">Save</SettingsButton>
            </span>
          )}
      />
    </div>
  );
}
