/**
 * Settings > Phones & Cloud > Cloud companion, under the companion's own status:
 * whether it takes over while this Mac is away, and what it keeps. Only once a
 * companion is set up (CloudSection shows its children then), and only on the
 * Mac it would stand in for, never on the companion's own console.
 */
import type { Config } from '@open-walnut/core';
import { useIsReplicaServer } from '@/hooks/useServerRole';
import { BackupLeaderGroup } from './BackupLeaderGroup';
import { CompanionKeepGroup } from './CompanionKeepGroup';

export function CloudWayExtras({ config, onSave }: { config: Config; onSave: (partial: Partial<Config>) => Promise<void> }) {
  const replica = useIsReplicaServer();
  if (replica) return null;
  return (
    <div className="devices-way-panel" id="devices-way-panel-cloud" data-testid="devices-way-panel-cloud">
      <BackupLeaderGroup config={config} onSave={onSave} />
      {/* What the companion keeps: the same rows and defaults as a host's (Remote Hosts). */}
      <CompanionKeepGroup config={config} onSave={onSave} />
    </div>
  );
}
