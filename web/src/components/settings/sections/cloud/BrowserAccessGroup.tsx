/**
 * "Open from a browser": this server's tunnel and the codes that sign a browser
 * in (docs/plan/walnut-servers-everywhere.md, "Exposure"). Settings, Phones &
 * Cloud, on a primary.
 *
 *   Tunnel             which provider (the built-in command, or one a plugin added)
 *   <its options>      a tunnel name, say; saved on Enter or when the field loses focus
 *   Open from anywhere the switch, with one sentence of state and Retry when it waits
 *   Address            the public address while connected
 *   Sign in a browser  a code for one browser, with its link and QR when connected
 *
 * State comes from GET /api/expose, every 3s while the tunnel is moving or waits
 * on the person and every 30s once settled, never while the tab is hidden.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { apiGet, apiPost, apiPut } from '@/api/client';
import { log } from '@/utils/log';
import { SettingsEmpty, SettingsGroup, SettingsRow } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { ToggleSwitch } from '../../inputs/ToggleSwitch';
import { SegmentedControl } from '../../inputs/SegmentedControl';
import { CopyButton } from '../../inputs/CopyButton';
import { saveErrorMessage } from '../../settings-pane-context';
import { describeExpose, exposePollMs, type ExposeResponse, type ExposeStatus } from './browser-access-status';
import '@/styles/browser-access.css';

const PATH = '/api/expose';

interface BrowserCode {
  code: string;
  expiresAt: number;
  link?: string;
  qr?: string;
}

export function BrowserAccessGroup() {
  const [data, setData] = useState<ExposeResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<Record<string, string>>({});
  const [code, setCode] = useState<BrowserCode | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const readSeq = useRef(0);
  // Option fields the person is typing in: a poll must not overwrite them.
  const editing = useRef(new Set<string>());

  const apply = useCallback((next: ExposeResponse) => {
    setData(next);
    setOptions((prev) => {
      const merged = { ...next.settings.options };
      for (const key of editing.current) merged[key] = prev[key] ?? merged[key] ?? '';
      return merged;
    });
  }, []);

  const load = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const res = await apiGet<ExposeResponse>(PATH, undefined, { timeoutMs: 10_000, quietStatuses: [404] });
      if (seq !== readSeq.current) return;
      apply(res);
      setLoadFailed(false);
    } catch (err) {
      if (seq !== readSeq.current) return;
      log.warn('settings', 'tunnel state read failed', { error: String(err) });
      setLoadFailed(true);
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);

  const interval = exposePollMs(data?.status ?? null);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) void load(); }, interval);
    return () => clearInterval(timer);
  }, [interval, load]);

  // A written change answers with the new state; the next poll fills in the rest.
  const write = async (body: { enabled?: boolean; provider?: string; options?: Record<string, string> }) => {
    setBusy(true);
    setError(null);
    readSeq.current++;
    try {
      const res = await apiPut<{ status: ExposeStatus }>(PATH, body);
      setData((prev) => (prev ? { ...prev, status: res.status, settings: { ...prev.settings, ...body, options: body.options ?? prev.settings.options } as ExposeResponse['settings'] } : prev));
      void load();
    } catch (err) {
      log.warn('settings', 'tunnel setting not saved', { error: saveErrorMessage(err) });
      setError(saveErrorMessage(err));
      void load();
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    try {
      const res = await apiPost<{ status: ExposeStatus }>(`${PATH}/retry`);
      setData((prev) => (prev ? { ...prev, status: res.status } : prev));
    } catch (err) {
      setError(saveErrorMessage(err));
    }
  };

  const makeCode = async () => {
    setCodeBusy(true);
    setCodeError(null);
    try {
      const res = await apiPost<{ code: string; expiresAt: number; link?: string }>('/api/devices/browser-code');
      const qr = res.link
        ? await QRCode.toDataURL(res.link, { errorCorrectionLevel: 'M', width: 220, margin: 2 }).catch(() => undefined)
        : undefined;
      setCode({ ...res, ...(qr ? { qr } : {}) });
    } catch (err) {
      setCodeError(saveErrorMessage(err));
    } finally {
      setCodeBusy(false);
    }
  };

  // A code is good for ten minutes: drop it from the screen when it runs out.
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(() => setCode(null), Math.max(0, code.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [code]);

  if (!data) {
    return (
      <SettingsGroup heading="Open from a browser" data-testid="browser-access">
        <SettingsEmpty>{loadFailed ? "Couldn't read the tunnel state." : 'Loading...'}</SettingsEmpty>
      </SettingsGroup>
    );
  }

  const { status, providers, settings } = data;
  const providerId = settings.provider ?? providers[0]?.id ?? null;
  const provider = providers.find((p) => p.id === providerId) ?? null;
  const line = describeExpose(status, provider?.title ?? 'the tunnel');
  const saveOption = (key: string) => {
    editing.current.delete(key);
    const value = options[key] ?? '';
    if ((settings.options[key] ?? '') === value) return;
    void write({ options: { ...settings.options, [key]: value } });
  };

  return (
    <SettingsGroup heading="Open from a browser" data-testid="browser-access">
      {providers.length === 0 ? (
        <SettingsRow
          label="Tunnel"
          help="No tunnel is set up; add a tunnel plugin, or set expose.command in config.yaml."
          data-testid="browser-access-no-provider"
        />
      ) : (
        <>
          {providers.length > 1 && (
            <SettingsRow
              label="Tunnel"
              help={provider?.description}
              control={
                <SegmentedControl
                  aria-label="Tunnel"
                  value={providerId ?? ''}
                  disabled={busy}
                  onChange={(v) => { void write({ provider: v }); }}
                  options={providers.map((p) => ({ value: p.id, label: p.title, testId: `browser-access-provider-${p.id}` }))}
                />
              }
            />
          )}
          {(provider?.options ?? []).map((option) => (
            <SettingsRow
              key={option.key}
              label={option.label}
              htmlFor={`browser-access-option-${option.key}`}
              help={option.help}
              control={
                <input
                  id={`browser-access-option-${option.key}`}
                  type="text"
                  className="settings-input settings-input--short"
                  value={options[option.key] ?? ''}
                  placeholder={option.default}
                  spellCheck={false}
                  data-testid={`browser-access-option-${option.key}`}
                  onChange={(e) => {
                    editing.current.add(option.key);
                    const value = e.target.value;
                    setOptions((prev) => ({ ...prev, [option.key]: value }));
                  }}
                  onBlur={() => saveOption(option.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveOption(option.key); } }}
                />
              }
            />
          ))}
          <SettingsRow
            label="Open from anywhere"
            htmlFor="browser-access-enabled"
            help={
              <span className="browser-access-state" data-state={status.enabled ? status.state : 'off'} data-testid="browser-access-state">
                <span className="browser-access-dot" data-dot={line.dot} aria-hidden="true" />
                <span>{line.text}</span>
              </span>
            }
            error={error ?? undefined}
            control={
              <span className="settings-addons-inline">
                {status.enabled && line.retry && (
                  <SettingsButton variant="text" onClick={() => { void retry(); }} data-testid="browser-access-retry">Retry</SettingsButton>
                )}
                <ToggleSwitch
                  id="browser-access-enabled"
                  checked={settings.enabled}
                  busy={busy}
                  data-testid="browser-access-enabled"
                  onChange={(v) => { void write({ enabled: v, ...(providerId ? { provider: providerId } : {}) }); }}
                />
              </span>
            }
          />
          {status.state === 'connected' && status.url && (
            <SettingsRow
              label="Address"
              help={<a className="settings-addons-link browser-access-url" href={status.url} target="_blank" rel="noopener noreferrer" data-testid="browser-access-url">{status.url.replace(/^https?:\/\//, '')}</a>}
              control={<CopyButton text={status.url} data-testid="browser-access-copy-url" />}
            />
          )}
        </>
      )}
      <SettingsRow
        label="Sign in a browser"
        help="A code lets one browser in, once, within ten minutes; you can remove it later under Paired phones, Other entries."
        error={codeError ?? undefined}
        control={
          <SettingsButton variant="default" busy={codeBusy} busyLabel="Making..." onClick={() => { void makeCode(); }} data-testid="browser-access-make-code">
            {code ? 'New code' : 'Make a code'}
          </SettingsButton>
        }
      />
      {code && (
        <div className="settings-row settings-row-stacked browser-access-code-row" data-testid="browser-access-code">
          <span className="browser-access-code settings-addons-mono" data-testid="browser-access-code-value">{code.code}</span>
          <p className="settings-row-help">
            Enter it in Walnut on the other browser; it works until {new Date(code.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
          </p>
          {code.link && (
            <>
              {code.qr && <img className="browser-access-qr" src={code.qr} alt="QR code that opens Walnut and signs that browser in" width={180} height={180} />}
              <span className="settings-addons-inline browser-access-link-row">
                <code className="settings-addons-mono browser-access-link" data-testid="browser-access-link">{code.link.replace(/^https?:\/\//, '')}</code>
                <CopyButton text={code.link} data-testid="browser-access-copy-link" />
              </span>
            </>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}
