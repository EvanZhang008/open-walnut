/**
 * A host's Details, open in place under its row in Remote Hosts (HostRow.tsx `panel`). Each fact
 * once (2026-11-04 review: the System line showed twice with two CPU counts, the reboot warning
 * three times, sessions, spend and the online bar twice, and one problem had two fixes):
 *
 *   its reading       one System line (the probe's, with Probe again, on a saved SSH host), the
 *                     rings, the one online bar, sessions and spend (HostFleetVitals.tsx)
 *   problems          the ones its row does not already name
 *   not connected     why, and what Claude Code needs there (RemoteHostDetail): the row's own
 *                     button is the fix; the command by hand is behind "Install by hand"
 *   facts             what is left: can do, up for, online over the week, connection, helper
 *   This host         its own settings (HostThisPart.tsx)
 *   What Walnut knows its kind, its note, its tools and folders (a saved SSH host)
 */
import type { ReactNode } from 'react';
import type { FleetHost } from '@/api/hosts-fleet';
import { useHostStatus } from '@/hooks/useHostStatus';
import { isLive, problemsOf, systemLine } from './host-fleet-dashboard-model';
import { FleetFacts, FleetProblems, FleetVitals, type SystemLine } from './HostFleetVitals';
import { RemoteHostDetail } from './RemoteHostStatus';
import { HostProfileDisclosure, profileSystemLine, useHostProfile } from './HostProfileDisclosure';
import { HostThisPart } from './HostThisPart';
import { rowProblemKey } from './useLinkedHostRow';

export type HostKind = 'local' | 'ssh' | 'net' | 'fleet';

interface Props {
  alias: string;
  name: string;
  card?: FleetHost;
  now: number;
  /** A saved host Walnut dials (its status and readiness are read live); not one switched off. */
  linked: boolean;
  /** Show "What Walnut knows" and probe it (a saved SSH host). */
  profile?: boolean;
  kind: HostKind;
}

export function HostDetails(props: Props) {
  return props.profile ? <WithProfile {...props} /> : <DetailsBody {...props} />;
}

function WithProfile(props: Props) {
  const hp = useHostProfile(props.alias);
  const system = profileSystemLine(hp, props.card ? systemLine(props.card) : 'Not probed yet.');
  return <DetailsBody {...props} system={system} profileBlock={<HostProfileDisclosure hp={hp} alias={props.alias} name={props.name} />} />;
}

function DetailsBody({ alias, name, card, now, linked, kind, system, profileBlock }: Props & { system?: SystemLine; profileBlock?: ReactNode }) {
  const status = useHostStatus(alias);
  const local = kind === 'local';
  // The problem the row already names is not said again here (a row with no live status names
  // its reading's first one: FleetHostRow.tsx).
  const skip = !card ? null
    : local || kind === 'fleet' ? (isLive(card) ? problemsOf(card, now).find((p) => p.tone === 'warn' || p.tone === 'bad')?.key ?? null : null)
    : rowProblemKey(card, now, status);
  const host = local ? '__local__' : alias;
  return (
    <div className="rh-details" data-testid="rh-details" data-host={alias} role="region" aria-label={`Details of ${name}`}>
      {card
        ? <FleetVitals host={card} now={now} system={system} />
        : (
          <>
            {system && (
              <div className="hf-card-sys-row">
                <p className="hf-card-sys" data-testid="host-fleet-system"><span data-testid="host-system-line">{system.text}</span></p>
                {system.action}
              </div>
            )}
            {system?.meta && <p className="hf-card-meta">{system.meta}</p>}
            <p className="rh-details-empty">Walnut has no reading of {name} yet: it reads a host once it connects.</p>
          </>
        )}
      {card && <FleetProblems host={card} now={now} skip={skip} />}
      {linked && !local && <RemoteHostDetail alias={alias} name={name} />}
      {card && <FleetFacts host={card} now={now} />}
      <HostThisPart
        host={host}
        name={name}
        // Any host the fleet reads takes a limit, the companion's box included (session_limits is
        // keyed by host; review: the old list offered it, this part did not).
        limitKey={local ? 'local' : alias}
        server={kind === 'ssh' || kind === 'net'}
        secrets={kind !== 'fleet'}
      />
      {profileBlock}
    </div>
  );
}
