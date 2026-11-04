/**
 * Settings > Remote Hosts: how machines on the host network reach each other when they
 * cannot connect directly (api/hosts-net.ts `setNetRelay`, server: core/net/net-mac.ts
 * `setRelay`). With a cloud companion its relay is used; without one, public relays unless
 * the user picks No relay. Each choice says what it shares; the picked one carries a check in
 * the control column, so every row's words start at the rows' one inset.
 */
import { useState } from 'react';
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
  const host = relayHost(net.relays);
  const choices: Array<{ id: NetRelay; label: string; help: string; disabled?: boolean }> = [
    {
      id: 'own',
      label: 'Your relay',
      help: companion
        ? `On your cloud companion${host ? ` (${host})` : ''}. Only your machines use it.`
        : 'Pair a cloud companion first (Settings > Cloud Companion).',
      disabled: !companion,
    },
    {
      id: 'public',
      label: 'Public relays',
      help: "Run by n0, the company behind iroh. They pass on traffic they cannot read. They see your machines' internet addresses and which of them talk to each other, and n0's lookup service lists which relay each machine uses.",
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
      summary={current === 'own' && companion ? `Your relay${host ? `, on ${host}` : ''}` : picked?.label ?? 'Your relay'}
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
      {error && <SettingsRow state="error" data-testid="host-network-relay-error" label="Could not change the relay" error={error} />}
    </SettingsFoldGroup>
  );
}
