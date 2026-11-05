/**
 * Settings > Remote Hosts: how machines on the host network reach each other when they
 * cannot connect directly (api/hosts-net.ts `setNetRelay`, server: core/net/net-mac.ts
 * `setRelay`). With a cloud companion its relay is used; without one, public relays unless
 * the user picks No relay. Each choice says what it shares; the picked one carries a check in
 * the control column, so every row's words start at the rows' one inset. Without a companion a
 * real link goes to the page that pairs one (2026-11-04 review: "Settings > Cloud Companion" named
 * a page that is called Phones & Cloud, and was no link).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { setNetRelay, type NetOverview, type NetRelay } from '@/api/hosts-net';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';
import { SettingsRow } from '../SettingsSection';
import { SettingsFoldGroup } from '../SettingsFoldGroup';
import { CheckGlyph } from '../settings-glyphs';

function relayHost(relays: string[]): string | null {
  try { return relays[0] ? new URL(relays[0]).host : null } catch { return null }
}

export function HostNetworkRelay({ net, onChanged }: { net: NetOverview; onChanged: () => void }) {
  const [pending, setPending] = useState<NetRelay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const companion = net.companion !== false;
  const current: NetRelay = pending ?? net.relay ?? 'own';
  const relayAt = relayHost(net.relays);
  const choices: Array<{ id: NetRelay; label: string; help: string; disabled?: boolean }> = [
    {
      id: 'own',
      label: 'Your relay',
      help: companion
        ? `On your cloud companion${relayAt ? ` (${relayAt})` : ''}. Only your machines use it.`
        : 'On your cloud companion, once you pair one.',
      disabled: !companion,
    },
    {
      id: 'public',
      label: 'Public relays',
      help: "Shared relays run by n0, who make iroh, the network software Walnut uses. They pass on traffic they cannot read, but they see your machines' internet addresses and which of them talk to each other, and n0's lookup service lists which relay each machine uses.",
      disabled: companion,
    },
    {
      id: 'none',
      label: 'No relay',
      help: 'Only direct connections: machines on the same network, or one with an open address. Machines behind two home routers may not connect.',
      disabled: companion,
    },
  ];

  const pick = async (id: NetRelay) => {
    if (id === current || pending) return;
    setPending(id);
    setError(null);
    try {
      await setNetRelay(id);
    } catch (err) {
      const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      log.warn('host-network', 'relay change failed', { relay: id, error: msg });
      setError(msg);
    } finally {
      setPending(null);
      // Read back either way: a change that was saved but not applied yet shows as saved.
      onChanged();
    }
  };

  const picked = choices.find((c) => c.id === current);
  return (
    <SettingsFoldGroup
      id="rh-more-relay"
      heading="Relay"
      summary={current === 'own' && companion ? `Your relay${relayAt ? `, on ${relayAt}` : ''}` : picked?.label ?? 'Your relay'}
      // Machines that join through the companion come up on its relay, so it is the one used.
      footer={`When two machines that joined with a link cannot connect directly, their traffic goes through the relay picked here.${companion ? ' While a cloud companion is paired, your machines use its relay.' : ''}`}
      data-testid="host-network-relay"
    >
      <div role="radiogroup" aria-label="Relay" className="settings-addons-contents">
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={current === c.id}
            aria-disabled={c.disabled || undefined}
            disabled={c.disabled || (!!pending && pending !== c.id)}
            data-relay={c.id}
            className="settings-row settings-addons-choice rh-relay-choice"
            onClick={() => void pick(c.id)}
          >
            <span className="settings-row-copy">
              <span className="settings-row-label">{c.label}</span>
              <span className="settings-row-help">{c.help}</span>
            </span>
            <span className="settings-row-actions">
              <span className="rh-relay-check" aria-hidden="true">{current === c.id && <CheckGlyph size={14} />}</span>
            </span>
          </button>
        ))}
      </div>
      {!companion && (
        <SettingsRow
          label="Use your own relay"
          help={<>Pair a cloud companion in <Link className="settings-addons-link" to="/settings#cloud" data-testid="host-network-relay-pair">Phones &amp; Cloud</Link>, and your machines use its relay.</>}
        />
      )}
      {error && <SettingsRow state="error" data-testid="host-network-relay-error" label="Could not change the relay" error={error} />}
    </SettingsFoldGroup>
  );
}
