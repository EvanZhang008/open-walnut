/**
 * "Open from a browser": this server's tunnel and the codes that sign a browser
 * in (docs/plan/walnut-servers-everywhere.md, "Exposure"). Settings, Phones &
 * Cloud, on a primary.
 *
 *   Tunnel             which provider (the built-in command, or one a plugin added)
 *   <its options>      a tunnel name, say; saved on Enter or when the field loses focus
 *   Runs on            an always-on host the provider names, or this computer
 *                      (src/core/expose/placement.ts); shown only when there is a host to pick
 *   Open from anywhere the switch, with one sentence of state and Retry when it waits
 *   Address            the public address while connected
 *   Connect a phone    a QR code that opens Walnut on the phone, signed in, for each address
 *                      that reaches it (a host server's always-on tunnel first, then this
 *                      computer's); the link and the typed code fold under "Can't scan it?"
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
import { isDeviceCaller } from './device-caller';
import '@/styles/browser-access.css';

const PATH = '/api/expose';

/** One address the code opens Walnut at (POST /api/devices/browser-code `addresses`). */
interface SignInAddress {
  where: string;
  label: string;
  url: string;
  link: string;
  alwaysOn: boolean;
}

interface BrowserCode {
  code: string;
  expiresAt: number;
  addresses: SignInAddress[];
  /** The address shown, and its QR. A host's always-on server comes first: while this
   *  Mac sleeps, a phone signed in there still opens the copy that host keeps, and its
   *  task and note edits sync when the Mac wakes. */
  shown?: string;
  qr?: Record<string, string>;
}

const qrFor = (link: string) => QRCode.toDataURL(link, { errorCorrectionLevel: 'M', width: 220, margin: 2 }).catch(() => undefined);

export function BrowserAccessGroup() {
  // A browser signed in with a code is refused every code (403
  // person_at_this_machine): say where codes come from, no button.
  const [deviceCaller] = useState(isDeviceCaller);
  const [data, setData] = useState<ExposeResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refused option saves, by option: each shown under its option, whose box keeps what was typed,
  // until that option is saved or put back. No other write clears one, so the screen never shows a
  // typed value as if it were saved.
  const [optionErrors, setOptionErrors] = useState<Record<string, string>>({});
  const setOptionError = (key: string, message: string | null) =>
    setOptionErrors((prev) => {
      if (message === null && !(key in prev)) return prev;
      const next = { ...prev };
      if (message === null) delete next[key];
      else next[key] = message;
      return next;
    });
  const [options, setOptions] = useState<Record<string, string>>({});
  const [code, setCode] = useState<BrowserCode | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const readSeq = useRef(0);
  // Option fields the person is typing in: a poll must not overwrite them.
  const editing = useRef(new Set<string>());
  // What each option box last held as typed, read when a save answers: typing that went on while the
  // write was on its way is newer than what was saved, so it stays in its box.
  const typed = useRef<Record<string, string>>({});

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

  // A written change answers with the new state; the next poll fills in the rest. `optionKey` names the
  // option a save is for: it stays marked as being edited until the write succeeds, so a refused value
  // (400) is still in its box after the reload below, where the person can fix it instead of retyping it.
  // A success drops the mark only while the box still holds what was saved (the host form does the same).
  // A refusal stays under its option until that option saves; a write of anything else leaves it be.
  const write = async (body: { enabled?: boolean; provider?: string; options?: Record<string, string>; run_on?: string | null }, optionKey?: string) => {
    setBusy(true);
    setError(null);
    readSeq.current++;
    try {
      const res = await apiPut<{ status: ExposeStatus }>(PATH, body);
      if (optionKey) {
        if ((typed.current[optionKey] ?? '') === (body.options?.[optionKey] ?? '')) editing.current.delete(optionKey);
        setOptionError(optionKey, null);
      }
      setData((prev) => {
        if (!prev) return prev;
        const { run_on: runOn, ...rest } = body;
        const placed = runOn !== undefined && runOn !== null ? { runOn, placedOn: runOn } : {};
        return { ...prev, status: res.status, settings: { ...prev.settings, ...rest, ...placed, options: body.options ?? prev.settings.options } as ExposeResponse['settings'] };
      });
      void load();
    } catch (err) {
      log.warn('settings', 'tunnel setting not saved', { error: saveErrorMessage(err) });
      if (optionKey) setOptionError(optionKey, saveErrorMessage(err));
      else setError(saveErrorMessage(err));
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
      const res = await apiPost<{ code: string; expiresAt: number; link?: string; url?: string; addresses?: SignInAddress[] }>('/api/devices/browser-code');
      // An older server answers with one link and no list.
      const addresses = res.addresses ?? (res.link && res.url ? [{ where: 'this-computer', label: 'This computer', url: res.url, link: res.link, alwaysOn: false }] : []);
      const ordered = [...addresses.filter((a) => a.alwaysOn), ...addresses.filter((a) => !a.alwaysOn)];
      const qr: Record<string, string> = {};
      for (const a of ordered) {
        const data = await qrFor(a.link);
        if (data) qr[a.where] = data;
      }
      setCode({ code: res.code, expiresAt: res.expiresAt, addresses: ordered, shown: ordered[0]?.where, qr });
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
  const places = data.places ?? [];
  const placedOn = settings.placedOn ?? 'here';
  const placedHost = places.find((p) => p.id === placedOn && p.id !== 'here');
  const providerId = settings.provider ?? providers[0]?.id ?? null;
  const provider = providers.find((p) => p.id === providerId) ?? null;
  const line = describeExpose(status, provider?.title ?? 'the tunnel');
  const saveOption = (key: string) => {
    const value = options[key] ?? '';
    if ((settings.options[key] ?? '') === value) {
      // Put back as stored: nothing to write, and nothing refused any more.
      editing.current.delete(key);
      setOptionError(key, null);
      return;
    }
    void write({ options: { ...settings.options, [key]: value } }, key);
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
              error={optionErrors[option.key]}
              control={
                <input
                  id={`browser-access-option-${option.key}`}
                  type="text"
                  data-no-draft="autosave"
                  className="settings-input settings-input--short"
                  value={options[option.key] ?? ''}
                  placeholder={option.default}
                  spellCheck={false}
                  data-testid={`browser-access-option-${option.key}`}
                  onChange={(e) => {
                    editing.current.add(option.key);
                    const value = e.target.value;
                    typed.current[option.key] = value;
                    setOptions((prev) => ({ ...prev, [option.key]: value }));
                  }}
                  onBlur={() => saveOption(option.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveOption(option.key); } }}
                />
              }
            />
          ))}
          {places.length > 0 && (
            <SettingsRow
              label="Runs on"
              help={placedHost
                ? `${placedHost.label} stays on, so the address answers while this computer sleeps.`
                : 'The address answers while this computer is awake.'}
              data-testid="browser-access-runs-on"
              control={
                <SegmentedControl
                  aria-label="Runs on"
                  value={placedOn}
                  disabled={busy}
                  onChange={(v) => { if (v !== placedOn) void write({ run_on: v }); }}
                  options={places.map((p) => ({ value: p.id, label: p.label, testId: `browser-access-runs-on-${p.id}` }))}
                />
              }
            />
          )}
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
        label="Connect a phone"
        help={deviceCaller
          ? <span data-testid="browser-access-codes-elsewhere">Make sign-in codes on the computer Walnut runs on.</span>
          : "Scan a QR code with the phone's camera: Walnut opens there, signed in. It works once, within ten minutes; you can remove the phone later under Signed-in browsers."}
        error={codeError ?? undefined}
        control={deviceCaller ? undefined : (
          <SettingsButton variant="default" busy={codeBusy} busyLabel="Making..." onClick={() => { void makeCode(); }} data-testid="browser-access-make-code">
            {code ? 'New QR code' : 'Show QR code'}
          </SettingsButton>
        )}
      />
      {code && (() => {
        const address = code.addresses.find((a) => a.where === code.shown) ?? code.addresses[0];
        const qr = address ? code.qr?.[address.where] : undefined;
        const until = new Date(code.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return (
          <div className="settings-row settings-row-stacked browser-access-code-row" data-testid="browser-access-code">
            {!address ? (
              // No address a phone can reach: the code is all there is, typed into Walnut there.
              <>
                <span className="browser-access-code settings-addons-mono" data-testid="browser-access-code-value">{code.code}</span>
                <p className="settings-row-help">No address reaches this computer from outside yet: turn on Open from anywhere, or a host server. Meanwhile, type this code into Walnut on the other device; it works until {until}.</p>
              </>
            ) : (
              <>
                {code.addresses.length > 1 && (
                  <SegmentedControl
                    aria-label="Where the phone connects"
                    value={address.where}
                    onChange={(v) => setCode((prev) => (prev ? { ...prev, shown: v } : prev))}
                    options={code.addresses.map((a) => ({ value: a.where, label: a.alwaysOn ? `${a.label} (always on)` : a.label, testId: `browser-access-address-${a.where}` }))}
                  />
                )}
                {qr && <img className="browser-access-qr" src={qr} alt="QR code that opens Walnut on the phone, signed in" width={220} height={220} data-testid="browser-access-qr" />}
                <p className="settings-row-help" data-testid="browser-access-address-note">
                  {address.alwaysOn
                    ? `The phone connects through ${address.label}: while this computer sleeps, the phone still opens the copy kept on ${address.label}, and task and note edits sync when this computer wakes.`
                    : "The phone connects through this computer's own tunnel: it works while this computer is awake."}
                  {` Good until ${until}.`}
                </p>
                <details className="browser-access-manual" data-testid="browser-access-manual">
                  <summary>Can&apos;t scan it?</summary>
                  <span className="settings-addons-inline browser-access-link-row">
                    <code className="settings-addons-mono browser-access-link" data-testid="browser-access-link">{address.link.replace(/^https?:\/\//, '')}</code>
                    <CopyButton text={address.link} data-testid="browser-access-copy-link" />
                  </span>
                  <p className="settings-row-help">
                    Open that link on the phone, or open {address.url.replace(/^https?:\/\//, '').replace(/\/+$/, '')} and type <span className="browser-access-code-inline settings-addons-mono" data-testid="browser-access-code-value">{code.code}</span>.
                  </p>
                </details>
              </>
            )}
          </div>
        );
      })()}
    </SettingsGroup>
  );
}
