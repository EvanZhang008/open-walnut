import { useState, type ReactNode } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsRow } from '../SettingsSection';
import { SecretInput } from '../inputs/SecretInput';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { useCommitField } from '../inputs/useCommitField';
import { couldntSave } from '../inputs/useOptimisticSetting';
import { saveErrorMessage, useSettingsSaved } from '../settings-pane-context';
import { AlertGlyph, CheckGlyph } from '../settings-glyphs';
import { log } from '@/utils/log';
import { useSerialSave, type OnSave } from './GeneralSection';

interface Props {
  config: Config;
  onSave: OnSave;
  onReload: () => Promise<void>;
}

/** Defaults mirror src/core/decision/jev-client.ts; repeated, not imported
 *  (see the TriageSection note: a drifted baseline makes opening Settings
 *  write config back). */
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';

export type JevTestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; ms: number; model: string }
  | { kind: 'fail'; error: string };

/** The Connection row's result line (pure, unit tested). */
export function jevTestText(state: JevTestState): string | null {
  if (state.kind === 'ok') return `Connected in ${Math.round(state.ms)} ms`;
  if (state.kind === 'fail') return plainJevError(state.error);
  return null;
}

/** Server wording people should never read (`api_key`, "not configured") in plain words (N3-27). Pure. */
export function plainJevError(error: string): string {
  if (/not configured|api_key|missing or unresolvable/i.test(error)) return 'Add an API key first.';
  return `Couldn't connect: ${error}`;
}

async function jevKeyRequest(method: 'POST' | 'DELETE', key?: string): Promise<void> {
  const res = await fetch('/api/jev/key', {
    method,
    ...(key !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }
      : {}),
  });
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? `HTTP ${res.status}`);
}

/**
 * Jev's own rows (indented under `Uses` in Smart task creation): key,
 * endpoint, model, a live test. Never owns WHICH decisions Jev answers (that
 * is the parent's `Uses` control, jev.decisions) and never writes them.
 */
export function JevSettings({ config, onSave, onReload }: Props) {
  const [keyDraft, setKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [test, setTest] = useState<JevTestState>({ kind: 'idle' });
  // A saved key offers Replace next to Remove (N29): Replace opens the field in place.
  const [replacing, setReplacing] = useState(false);
  const { track } = useSettingsSaved();
  const save = useSerialSave(config, onSave);

  const endpoint = useCommitField<string>(
    config.jev?.endpoint ?? '',
    (v) => save((c) => ({ jev: { ...c.jev, endpoint: v.trim() || undefined } }), { rowKey: 'tasks.jev-endpoint' }),
    { rowKey: 'tasks.jev-endpoint', kind: 'text' },
  );
  const model = useCommitField<string>(
    config.jev?.model ?? '',
    (v) => save((c) => ({ jev: { ...c.jev, model: v.trim() || undefined } }), { rowKey: 'tasks.jev-model' }),
    { rowKey: 'tasks.jev-model', kind: 'text' },
  );

  // Three key states: Jev-specific key > shared OpenRouter provider key (only
  // meaningful when the effective endpoint IS OpenRouter) > none.
  const ownKey = Boolean(config.jev?.api_key);
  const effectiveEndpoint = endpoint.inputProps.value.trim() || config.jev?.endpoint || DEFAULT_ENDPOINT;
  const onOpenRouter = effectiveEndpoint.startsWith('https://openrouter.ai/');
  const sharedKey = !ownKey && onOpenRouter && Boolean(config.providers?.openrouter?.api_key);

  const keyWrite = async (method: 'POST' | 'DELETE', key?: string) => {
    setKeyBusy(true);
    setKeyError(null);
    try {
      await track(jevKeyRequest(method, key), 'tasks.jev-key');
      if (method === 'POST') { setKeyDraft(''); setReplacing(false); }
      await onReload();
    } catch (err) {
      const message = saveErrorMessage(err);
      log.error('settings', 'jev key write failed', { method, error: message });
      setKeyError(couldntSave(message));
    } finally {
      setKeyBusy(false);
    }
  };

  const runTest = async () => {
    setTest({ kind: 'running' });
    try {
      const res = await fetch('/api/jev/test', { method: 'POST' });
      const data = await res.json();
      setTest(data.ok
        ? { kind: 'ok', ms: data.ms, model: data.model }
        : { kind: 'fail', error: data.error ?? 'unknown error' });
    } catch (err) {
      setTest({ kind: 'fail', error: err instanceof Error ? err.message : String(err) });
    }
  };

  let keyHelp: ReactNode = null;
  let keyControl: ReactNode;
  const keyEntry = (
    <span className="settings-control-cluster">
      <SecretInput id="jev-key" value={keyDraft} onChange={setKeyDraft} placeholder="API key" />
      {replacing && (
        <SettingsButton variant="text" data-testid="jev-key-replace-cancel" onClick={() => { setReplacing(false); setKeyDraft(''); }}>
          Cancel
        </SettingsButton>
      )}
      <SettingsButton
        variant="primary"
        busy={keyBusy}
        busyLabel="Saving..."
        disabled={!keyDraft.trim()}
        title={keyDraft.trim() ? undefined : 'Paste a key first.'}
        onClick={() => void keyWrite('POST', keyDraft.trim())}
        data-testid="jev-key-save"
      >
        Save key
      </SettingsButton>
    </span>
  );
  if (ownKey && replacing) {
    keyControl = keyEntry;
  } else if (ownKey) {
    keyControl = (
      <span className="settings-control-cluster">
        <span className="settings-secret-saved-text" data-testid="jev-key-status">Saved in secrets, never synced.</span>
        <SettingsButton variant="text" data-testid="jev-key-replace" disabled={keyBusy} onClick={() => setReplacing(true)}>
          Replace
        </SettingsButton>
        <InlineConfirmButton data-testid="jev-key-remove" disabled={keyBusy} onConfirm={() => keyWrite('DELETE')} />
      </span>
    );
  } else if (sharedKey) {
    keyHelp = (
      <span data-testid="jev-key-status">
        Uses the OpenRouter key saved under <a href="#providers">Advanced</a>.
      </span>
    );
  } else {
    keyHelp = <span data-testid="jev-no-key">No key yet, so Walnut&apos;s usual model answers until you save one.</span>;
    keyControl = keyEntry;
  }

  const testText = jevTestText(test);
  const hasKey = ownKey || sharedKey;
  return (
    <div className="settings-rows-contents" data-testid="jev-settings">
      <SettingsRow
        indent
        label="API key"
        htmlFor={ownKey || sharedKey ? undefined : 'jev-key'}
        help={keyHelp}
        state={!ownKey && !sharedKey ? 'warning' : undefined}
        error={keyError}
        control={keyControl}
      />
      <SettingsRow
        indent
        wide
        label="Endpoint"
        help="Empty uses the first-party endpoint."
        htmlFor="jev-endpoint"
        error={endpoint.error}
        control={
          <input
            id="jev-endpoint"
            type="text"
            className="settings-input settings-input--long settings-input--mono"
            placeholder={DEFAULT_ENDPOINT}
            spellCheck={false}
            {...endpoint.inputProps}
          />
        }
      />
      <SettingsRow
        indent
        label="Jev model"
        help="Empty uses the latest model."
        htmlFor="jev-model"
        error={model.error}
        control={
          <input
            id="jev-model"
            type="text"
            className="settings-input settings-input--short settings-input--mono"
            placeholder={DEFAULT_MODEL}
            spellCheck={false}
            {...model.inputProps}
          />
        }
      />
      <SettingsRow
        indent
        label="Connection"
        // One help line in every state, so a result never grows the row (N3-27).
        help={!testText ? (hasKey ? 'Sends one short request to the endpoint.' : 'Add an API key first.') : (
          <span
            className="settings-test-result"
            data-kind={test.kind}
            data-testid={test.kind === 'ok' ? 'jev-test-ok' : 'jev-test-fail'}
            title={test.kind === 'ok' ? test.model : undefined}
            role={test.kind === 'fail' ? 'alert' : undefined}
          >
            {test.kind === 'ok' ? <CheckGlyph size={12} /> : <AlertGlyph size={12} />}
            {testText}
          </span>
        )}
        control={
          <SettingsButton
            busy={test.kind === 'running'}
            busyLabel="Testing..."
            disabled={!hasKey}
            title={hasKey ? undefined : 'Add an API key first.'}
            onClick={() => void runTest()}
            data-testid="jev-test"
          >
            Test connection
          </SettingsButton>
        }
      />
    </div>
  );
}
