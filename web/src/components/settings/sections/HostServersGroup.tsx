/**
 * "Walnut on this host", in a host's Details under "This host" (HostThisPart.tsx;
 * docs/plan/walnut-servers-everywhere.md, "A server on a host"): a switch that keeps a Walnut
 * running there, one sentence of state, Update to this build (a running Walnut on an older build)
 * or Start again (one that stopped on an error), what it keeps a copy of (folded behind one line),
 * and, while it is on, its own tunnel (which provider, its options, the switch, its address, and
 * Restart tunnel). The host that carries this computer's tunnel (Phones & Cloud, Open from a
 * browser, Runs on) shows that one instead, and its switch stays on: Runs on is where it moves.
 *
 * 2026-11-04 review: this sat under More settings as "Walnut on a host", away from the host, and
 * its tunnel's "Retry" read like the row's SSH "Retry". The state comes from the page's one read
 * (host-settings-data.tsx).
 */
import { useState } from 'react';
import { SettingsDisclosure, SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { CopyButton } from '../inputs/CopyButton';
import { apiPost } from '@/api/client';
import { describeExpose, optionFits } from './cloud/browser-access-status';
import { copiesSummary, describeHostServer } from './host-servers-status';
import { ReplicaCopyRows } from './ReplicaCopyRows';
import { useHostSettings } from './host-settings-data';
import '@/styles/browser-access.css';

const PATH = '/api/host-servers';

export function HostServerPart({ hostKey }: { hostKey: string }) {
  const ctx = useHostSettings();
  // Which button's press the host's write is: only that one says Updating... or Restarting...;
  // a switch flipped on the same host keeps the others still (review: a "Kept on this host" switch
  // made the retry button read Updating...).
  const [pressed, setPressed] = useState<'retry' | 'tunnel' | null>(null);
  const s = ctx?.servers;
  const host = s?.data?.hosts.find((h) => h.hostKey === hostKey);
  if (!s || !s.data || !host) return null;
  const { busy, errors, optionErrors, setOptionError, call, write, drafts, setDrafts } = s;
  const providers = s.data.providers;
  const line = describeHostServer(host);
  const on = host.settings.enabled;
  const exposeSettings = host.settings.expose;
  const providerId = exposeSettings.provider ?? providers[0]?.id ?? null;
  const provider = providers.find((p) => p.id === providerId) ?? null;
  const tunnel = host.view?.server?.expose ?? null;
  const tunnelLine = describeExpose(tunnel, provider?.title ?? 'the tunnel');
  const draft = drafts[host.hostKey] ?? {};
  const optionValue = (key: string) => draft[key] ?? exposeSettings.options[key] ?? '';
  // The typed value stays in its box until the save succeeds, so a refused one (400) can be fixed.
  // Dropped only while the box still holds what was saved: typing on during the write is kept.
  const dropDraft = (key: string, saved: string) =>
    setDrafts((prev) => {
      if (prev[host.hostKey]?.[key] !== saved) return prev;
      const next = { ...prev[host.hostKey] };
      delete next[key];
      return { ...prev, [host.hostKey]: next };
    });
  const saveOption = (key: string) => {
    const value = draft[key];
    if (value === undefined) return;
    // Put back as stored: nothing to write, and nothing refused any more.
    if ((exposeSettings.options[key] ?? '') === value) { dropDraft(key, value); setOptionError(host.hostKey, key, null); return; }
    void write(host.hostKey, { expose: { options: { ...exposeSettings.options, [key]: value } } }, key)
      .then((saved) => { if (saved) dropDraft(key, value); });
  };
  const running = host.view?.phase === 'running';
  const carries = host.settings.carriesTunnel === true;
  const hostBusy = busy === host.hostKey;
  const pressing = (what: 'retry' | 'tunnel') => hostBusy && pressed === what;
  // A running Walnut on an older build: the retry starts this computer's build.
  const update = running && !!host.view?.notice;
  const address = running && tunnel?.state === 'connected' && tunnel.url ? (
    <SettingsRow
      indent
      label="Address"
      help={<a className="settings-addons-link browser-access-url" href={tunnel.url} target="_blank" rel="noopener noreferrer" data-testid={`host-server-url-${host.hostKey}`}>{tunnel.url.replace(/^https?:\/\//, '')}</a>}
      control={<CopyButton text={tunnel.url} variant="default" data-testid={`host-server-copy-url-${host.hostKey}`} />}
    />
  ) : null;

  return (
    <div className="rh-host-server-part" data-testid="host-server-part" data-host={host.hostKey}>
      <SettingsRow
        data-testid={`host-server-${host.hostKey}`}
        data-phase={on ? host.view?.phase ?? 'unknown' : 'off'}
        label="Walnut on this host"
        // No htmlFor: a click on the row's words must not start or stop its server (2026-11-02,
        // the same trap turned a sync check on). The switch has its own aria-label.
        help={
          <span className="browser-access-state" data-testid={`host-server-state-${host.hostKey}`}>
            <span className="browser-access-dot" data-dot={on ? line.dot : 'off'} aria-hidden="true" />
            <span>{on ? line.text : 'Off: no Walnut runs there, so a browser there cannot open Walnut while your Mac is away.'}</span>
          </span>
        }
        error={errors[host.hostKey]}
        control={
          <span className="settings-addons-inline">
            {on && line.retry && (
              <SettingsButton
                variant="text"
                holdFocus
                busy={pressing('retry')}
                disabled={hostBusy && !pressing('retry')}
                busyLabel={update ? 'Updating...' : 'Starting...'}
                reserve={['Update to this build', 'Start it again']}
                onClick={() => { setPressed('retry'); void call(host.hostKey, () => apiPost(`${PATH}/${encodeURIComponent(host.hostKey)}/retry`)); }}
                data-testid={`host-server-retry-${host.hostKey}`}
              >
                {update ? 'Update to this build' : 'Start it again'}
              </SettingsButton>
            )}
            <ToggleSwitch
              id={`host-server-enabled-${host.hostKey}`}
              checked={on}
              disabled={carries}
              busy={hostBusy}
              aria-label={`Run Walnut on ${host.label}`}
              data-testid={`host-server-enabled-${host.hostKey}`}
              onChange={(v) => { void write(host.hostKey, { enabled: v }); }}
            />
          </span>
        }
      />
      {/* The replica is every host's program since D13; 'host-server' is the rollback, which keeps no copies. */}
      {/* Eleven switches folded behind one line that says how many are on (2026-11-04 review). */}
      {on && host.settings.program !== 'host-server' && host.settings.copies && (
        <SettingsDisclosure
          id={`host-server-copies-${host.hostKey}`}
          indent
          label="Kept on this host"
          help="What this host still shows while your Mac sleeps."
          summary={copiesSummary(host.settings.copies)}
          data-testid={`host-server-copies-toggle-${host.hostKey}`}
        >
          <div className="host-server-copies" data-testid={`host-server-copies-${host.hostKey}`}>
            <ReplicaCopyRows
              idOf={(key) => `host-server-copy-${host.hostKey}-${key}`}
              copies={host.settings.copies}
              busy={hostBusy}
              heading={false}
              help="What this host still shows while your Mac sleeps."
              onChange={(patch) => { void write(host.hostKey, { copies: patch }); }}
            />
          </div>
        </SettingsDisclosure>
      )}
      {on && carries && (
        <>
          <SettingsRow
            indent
            label="Open from anywhere"
            help={
              <span className="browser-access-state" data-testid={`host-server-tunnel-state-${host.hostKey}`}>
                <span className="browser-access-dot" data-dot={running ? tunnelLine.dot : 'pending'} aria-hidden="true" />
                <span>Runs this computer&apos;s tunnel: change it in Phones &amp; Cloud, Open from a browser.</span>
              </span>
            }
            data-testid={`host-server-carries-${host.hostKey}`}
          />
          {address}
        </>
      )}
      {on && !carries && (providers.length === 0 ? (
        <SettingsRow indent label="Open from anywhere" help="No tunnel is set up for hosts: add a tunnel plugin under Apps." data-testid={`host-server-no-provider-${host.hostKey}`} />
      ) : (
        <>
          {providers.length > 1 && (
            <SettingsRow
              indent
              label="Tunnel"
              help={provider?.description}
              control={
                <SegmentedControl
                  aria-label={`Tunnel on ${host.label}`}
                  value={providerId ?? ''}
                  disabled={hostBusy}
                  onChange={(v) => { void write(host.hostKey, { expose: { provider: v } }); }}
                  options={providers.map((p) => ({ value: p.id, label: p.title, testId: `host-server-provider-${host.hostKey}-${p.id}` }))}
                />
              }
            />
          )}
          {(provider?.options ?? []).filter((option) => !option.hidden || !optionFits(option, exposeSettings.options[option.key])).map((option) => (
            <SettingsRow
              indent
              key={option.key}
              label={option.label}
              htmlFor={`host-server-option-${host.hostKey}-${option.key}`}
              help={option.help}
              error={optionErrors[host.hostKey]?.[option.key]}
              control={
                <input
                  id={`host-server-option-${host.hostKey}-${option.key}`}
                  type="text"
                  data-no-draft="autosave"
                  className="settings-input settings-input--short"
                  value={optionValue(option.key)}
                  placeholder={option.default}
                  spellCheck={false}
                  data-testid={`host-server-option-${host.hostKey}-${option.key}`}
                  onChange={(e) => {
                    const value = e.target.value;
                    setDrafts((prev) => ({ ...prev, [host.hostKey]: { ...(prev[host.hostKey] ?? {}), [option.key]: value } }));
                  }}
                  onBlur={() => saveOption(option.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveOption(option.key); } }}
                />
              }
            />
          ))}
          <SettingsRow
            indent
            label="Open from anywhere"
            htmlFor={`host-server-expose-${host.hostKey}`}
            help={
              <span className="browser-access-state" data-testid={`host-server-tunnel-state-${host.hostKey}`}>
                <span className="browser-access-dot" data-dot={running ? tunnelLine.dot : 'pending'} aria-hidden="true" />
                <span>{exposeSettings.blocked ?? (running ? tunnelLine.text : `${provider?.title ?? 'The tunnel'} starts on the host once Walnut runs there.`)}</span>
              </span>
            }
            control={
              <span className="settings-addons-inline">
                {running && exposeSettings.enabled && tunnelLine.retry && (
                  <SettingsButton
                    variant="text"
                    holdFocus
                    busy={pressing('tunnel')}
                    disabled={hostBusy && !pressing('tunnel')}
                    busyLabel="Restarting..."
                    reserve={['Restart tunnel', 'Restarting...']}
                    onClick={() => { setPressed('tunnel'); void call(host.hostKey, () => apiPost(`${PATH}/${encodeURIComponent(host.hostKey)}/expose/retry`)); }}
                    data-testid={`host-server-tunnel-retry-${host.hostKey}`}
                  >
                    Restart tunnel
                  </SettingsButton>
                )}
                <ToggleSwitch
                  id={`host-server-expose-${host.hostKey}`}
                  checked={exposeSettings.enabled}
                  busy={hostBusy}
                  aria-label={`Open Walnut on ${host.label} from anywhere`}
                  data-testid={`host-server-expose-${host.hostKey}`}
                  onChange={(v) => { void write(host.hostKey, { expose: { enabled: v, ...(providerId ? { provider: providerId } : {}) } }); }}
                />
              </span>
            }
          />
          {address}
        </>
      ))}
      {on && <p className="rh-this-host-note">A browser opening it signs in with a code (Phones &amp; Cloud, Open from a browser).</p>}
    </div>
  );
}
