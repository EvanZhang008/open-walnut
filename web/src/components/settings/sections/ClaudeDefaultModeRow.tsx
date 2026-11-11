import { useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { fetchEngineSettings, patchEngineSettings, engineSettingsWriteOutcome, type EngineSettingView } from '@/api/engine-settings';
import { SettingsRow } from '../SettingsSection';

/** Saves Claude Code's own setting, not a second Walnut default. */
export function ClaudeDefaultModeRow({ config }: { config: Config }) {
  const [host, setHost] = useState('__local__');
  const [item, setItem] = useState<EngineSettingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hostRef = useRef(host);
  hostRef.current = host;
  useEffect(() => {
    const controller = new AbortController();
    setItem(null); setError(undefined);
    fetchEngineSettings('claude', host, { signal: controller.signal }).then(view => {
      if (!controller.signal.aborted) setItem(view.groups.flatMap(g => g.items).find(i => i.key === 'permissions.defaultMode') ?? null);
    }).catch(err => { if (!controller.signal.aborted) setError(String(err.message ?? err)); });
    return () => controller.abort();
  }, [host]);
  const save = async (value: string) => {
    setBusy(true); setError(undefined);
    try {
      const view = await patchEngineSettings('claude', host, value === ''
        ? { unset: ['permissions.defaultMode'] } : { set: { 'permissions.defaultMode': value } });
      window.dispatchEvent(new Event('walnut:claude-default-mode-changed'));
      if (hostRef.current === host) setItem(view.groups.flatMap(g => g.items).find(i => i.key === 'permissions.defaultMode') ?? null);
    } catch (err) {
      if (hostRef.current !== host) return;
      setError(err instanceof Error ? err.message : String(err));
      // A timeout may have happened after the engine's file changed. Read it
      // again before claiming the old value still holds.
      if (engineSettingsWriteOutcome(err) !== 'not-written') {
        try {
          const view = await fetchEngineSettings('claude', host);
          if (hostRef.current === host) setItem(view.groups.flatMap(g => g.items).find(i => i.key === 'permissions.defaultMode') ?? null);
        } catch { /* Keep the last value shown; the error above says the write is unconfirmed. */ }
      }
    }
    finally { if (hostRef.current === host) setBusy(false); }
  };
  return <SettingsRow label="Claude Code default mode" htmlFor="claude-default-mode" error={error}
    help="New sessions follow Claude Code's own setting on the selected machine. Project settings can override it. With no saved mode, Walnut uses Auto when supported. A session can choose another mode."
    control={<span style={{ display: 'flex', gap: 8 }}>
      <select aria-label="Default mode host" className="settings-select" value={host} disabled={busy}
        onChange={e => setHost(e.target.value)}>
        <option value="__local__">This machine</option>
        {Object.keys(config.hosts ?? {}).map(id => <option key={id} value={id}>{id}</option>)}
      </select>
      <select id="claude-default-mode" data-testid="claude-default-mode" className="settings-select"
        disabled={busy || !item || !!item.invalid} value={item?.source === 'default' ? '' : String(item?.value ?? '')}
        onChange={e => void save(e.target.value)}>
        {/* Until the engine's file is read, the empty value means unknown, never "Not set". */}
        <option value="">{item ? 'Not set (Auto when supported)' : error ? 'Unavailable' : 'Loading…'}</option>
        {item && item.source !== 'default' && !item.options?.some(o => o.value === item.value) && <option value={String(item.value)}>{String(item.value)} (engine setting)</option>}
        {item?.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </span>} />;
}
