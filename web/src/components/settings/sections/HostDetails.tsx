/**
 * A host's Details, open in place under its row in Remote Hosts (HostRow.tsx `panel`): its last
 * reading (rings, the online timeline, sessions and spend, HostFleetVitals.tsx), every problem,
 * why it is not connected and what Claude Code needs there (RemoteHostDetail, with Check again
 * and the commands to copy), the full table, and what Walnut knows about it. The row keeps the
 * one action; nothing here repeats it.
 */
import type { FleetHost } from '@/api/hosts-fleet';
import { FleetFacts, FleetProblems, FleetVitals } from './HostFleetVitals';
import { RemoteHostDetail } from './RemoteHostStatus';
import { HostProfileDisclosure } from './HostProfileDisclosure';

export function HostDetails({ alias, name, card, now, linked, profile }: {
  alias: string;
  name: string;
  card?: FleetHost;
  now: number;
  /** A saved host Walnut dials (its status and readiness are read live); not one switched off. */
  linked: boolean;
  /** Show "What Walnut knows" (a saved SSH host). */
  profile: boolean;
}) {
  return (
    <div className="rh-details" data-testid="rh-details" data-host={alias} role="region" aria-label={`Details of ${name}`}>
      {card
        ? <FleetVitals host={card} now={now} />
        : <p className="rh-details-empty">Walnut has no reading of {name} yet: it reads a host once it connects.</p>}
      {card && <FleetProblems host={card} now={now} />}
      {linked && <RemoteHostDetail alias={alias} name={name} />}
      {card && <FleetFacts host={card} now={now} />}
      {profile && <HostProfileDisclosure alias={alias} name={name} />}
    </div>
  );
}
