import { useEffect, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SecretInput } from '../inputs/SecretInput';
import { useAutoSave } from '@/hooks/useAutoSave';
import { log } from '@/utils/log';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
  onReload: () => Promise<void>;
}

/** Defaults mirror src/core/decision/jev-client.ts — repeated, not imported
 *  (see the TriageSection note: a drifted baseline makes opening Settings
 *  write config back). */
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const OPENROUTER_MODEL = 'typesafe/jev-1.13';

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; ms: number; model: string }
  | { kind: 'fail'; error: string };

/**
 * Jev's own settings: key, endpoint, model, a live test. Rendered only when
 * Smart task creation is set to use Jev, so it never owns WHICH decisions Jev
 * answers (that is the parent's radio, jev.decisions) and never writes them.
 */
export function JevSettings({ config, onSave, onReload }: Props) {
  const [endpoint, setEndpoint] = useState(config.jev?.endpoint ?? '');
  const [model, setModel] = useState(config.jev?.model ?? '');
  const [keyDraft, setKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  // Three key states: Jev-specific override > shared OpenRouter provider
  // credential (only meaningful when the effective endpoint IS OpenRouter) > none.
  const ownKey = Boolean(config.jev?.api_key);
  const effectiveEndpoint = (endpoint.trim() || config.jev?.endpoint || DEFAULT_ENDPOINT);
  const onOpenRouter = effectiveEndpoint.startsWith('https://openrouter.ai/');
  const sharedKey = !ownKey && onOpenRouter && Boolean(config.providers?.openrouter?.api_key);
  const keyConfigured = ownKey || sharedKey;

  // Keyed on the two saved VALUES, not on the config object: this form mounts
  // the moment the runner radio flips to Jev, and that radio's own save
  // refreshes config a beat later. Re-syncing on any refresh wiped whatever was
  // typed in between (caught by settings-smart-task-creation.spec.ts).
  const savedEndpoint = config.jev?.endpoint ?? '';
  const savedModel = config.jev?.model ?? '';
  useEffect(() => { setEndpoint(savedEndpoint); }, [savedEndpoint]);
  useEffect(() => { setModel(savedModel); }, [savedModel]);

  const handleSave = async () => {
    await onSave({
      // Spread ...config.jev so api_key (a ${file:} ref this form never renders)
      // and decisions (the parent's radio) survive: updateConfig replaces the
      // whole `jev` key.
      jev: {
        ...config.jev,
        ...(endpoint.trim() ? { endpoint: endpoint.trim() } : { endpoint: undefined }),
        ...(model.trim() ? { model: model.trim() } : { model: undefined }),
      },
    });
  };

  useAutoSave({
    current: JSON.stringify({ endpoint: endpoint.trim(), model: model.trim() }),
    baseline: JSON.stringify({
      endpoint: (config.jev?.endpoint ?? '').trim(),
      model: (config.jev?.model ?? '').trim(),
    }),
    save: handleSave,
  });

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key) return;
    setKeyBusy(true);
    try {
      const res = await fetch('/api/jev/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setKeyDraft('');
      await onReload();
    } catch (err) {
      log.error('settings', 'jev key save failed', { error: err instanceof Error ? err.message : String(err) });
      alert(`Saving the key failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setKeyBusy(false);
    }
  };

  const removeKey = async () => {
    if (!confirm('Remove the stored Jev API key? Smart task creation then uses the default engine until a key is saved again.')) return;
    setKeyBusy(true);
    try {
      await fetch('/api/jev/key', { method: 'DELETE' });
      await onReload();
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

  return (
    <div data-testid="jev-settings">
      <div className="form-group">
        <label htmlFor="jev-key">Jev API key</label>
        {keyConfigured ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="text-sm" data-testid="jev-key-status">
              {ownKey
                ? <>Saved. It lives in <code>secrets/</code> and is never synced.</>
                : <>Using the OpenRouter key saved under <a href="#providers">Advanced</a>.</>}
            </span>
            {ownKey && (
              <button type="button" className="btn btn-sm" onClick={removeKey} disabled={keyBusy}>Remove</button>
            )}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, maxWidth: 520 }}>
              <SecretInput
                id="jev-key"
                value={keyDraft}
                onChange={setKeyDraft}
                placeholder="sk-or-… (OpenRouter) or a TypeSafe key"
              />
              <button type="button" className="btn btn-sm btn-primary" onClick={saveKey} disabled={keyBusy || !keyDraft.trim()}>
                Save key
              </button>
            </div>
            <p className="text-sm" style={{ marginTop: 4, color: 'var(--warning, #b45309)' }} data-testid="jev-no-key">
              No key yet, so the default engine answers until you save one.
            </p>
          </>
        )}
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="jev-endpoint">Endpoint</label>
          <input
            id="jev-endpoint"
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={DEFAULT_ENDPOINT}
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Empty = TypeSafe first-party. OpenRouter: <code>{OPENROUTER_ENDPOINT}</code>
          </p>
        </div>
        <div className="form-group">
          <label htmlFor="jev-model">Model</label>
          <input
            id="jev-model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={DEFAULT_MODEL}
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Empty = <code>{DEFAULT_MODEL}</code>. OpenRouter: <code>{OPENROUTER_MODEL}</code>
          </p>
        </div>
      </div>

      <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="btn btn-sm" onClick={runTest} disabled={test.kind === 'running'} data-testid="jev-test">
          {test.kind === 'running' ? 'Testing…' : 'Test connection'}
        </button>
        {test.kind === 'ok' && (
          <span className="text-sm" style={{ color: 'var(--success, #16a34a)' }} data-testid="jev-test-ok">
            ✓ {test.ms} ms · {test.model}
          </span>
        )}
        {test.kind === 'fail' && (
          <span className="text-sm" style={{ color: 'var(--danger, #dc2626)' }} data-testid="jev-test-fail">
            ✗ {test.error}
          </span>
        )}
      </div>
    </div>
  );
}
