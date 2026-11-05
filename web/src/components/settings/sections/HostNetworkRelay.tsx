/**
 * Settings > Remote Hosts, More settings > Relay: how machines on the host network reach each
 * other when they cannot connect directly (api/hosts-net.ts `setNetRelay`, server:
 * core/net/net-mac.ts `setRelay`). With a cloud companion its relay is used; without one, public
 * relays unless the user picks No relay, and your own relay is said once, as the link to the page
 * that pairs one (Phones & Cloud). Each choice says in plain words what it shares; who runs the
 * public relays is one line further, on request (2026-11-05 reviews: the choice read as jargon).
 * The picked one carries a check in the control column, so every row's words start at one inset.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { setNetRelay, type NetOverview, type NetRelay } from '@/api/hosts-net';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { CheckGlyph, ChevronGlyph } from '../settings-glyphs';

function relayHost(relays: string[]): string | null {
  try { return relays[0] ? new URL(relays[0]).host : null } catch { return null }
}

export function HostNetworkRelay({ net, onChanged }: { net: NetOverview; onChanged: () => void }) {
  const [pending, setPending] = useState<NetRelay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [about, setAbout] = useState(false);
  const companion = net.companion !== false;
  const current: NetRelay = pending ?? net.relay ?? 'own';
  const relayAt = relayHost(net.relays);
  // With a companion its relay is the one used (the others are shown, off); without one, your own
  // relay is not a choice yet, so it is said once, as the way to get one (2026-11-05 reviews: a
  // greyed "Your relay" choice and a "Use your own relay" row said the same thing twice).
  const choices: Array<{ id: NetRelay; label: string; help: string; disabled?: boolean }> = [
    ...(companion ? [{ id: 'own' as const, label: 'Your relay', help: `On your cloud companion${relayAt ? ` (${relayAt})` : ''}. Only your machines use it.` }] : []),
    {
      id: 'public',
      label: 'Public relays',
      help: 'A free public service passes the traffic on when two of your machines cannot reach each other directly. It cannot read it, but it sees which of your machines talk.',
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

  return (
    <SettingsGroup
      heading="Relay"
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
          label="Your own relay"
          data-testid="host-network-relay-own"
          help={<>Pair a cloud companion in <Link className="settings-addons-link" to="/settings#cloud" data-testid="host-network-relay-pair">Phones &amp; Cloud</Link>, and only your machines use its relay.</>}
        />
      )}
      <SettingsRow
        label={
          <button type="button" className="rh-join-more" aria-expanded={about} data-testid="host-network-relay-about" onClick={() => setAbout(!about)}>
            <ChevronGlyph size={10} className="settings-disclosure-chevron" />
            Who runs the public relays
          </button>
        }
        help={about ? "n0, the makers of iroh, the network software Walnut uses. Their relays see your machines' internet addresses and which of them talk to each other, and their lookup service lists which relay each machine uses." : undefined}
      />
      {error && <SettingsRow state="error" data-testid="host-network-relay-error" label="Could not change the relay" error={error} />}
    </SettingsGroup>
  );
}
