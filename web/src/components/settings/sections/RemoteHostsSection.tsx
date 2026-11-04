/**
 * Settings > Remote Hosts: ONE list of every machine Walnut runs work on (2026-11-04 review: the
 * same host showed in five groups and the list started below the fold). From the top: one
 * summary line for the whole fleet (HostSummaryLine), Hosts (whatever Add host is making
 * first, then This Mac, the SSH hosts this editor saves to config.yaml, the machines that
 * joined with a link, and the companion's box), the network map, folded, the copies waiting
 * for a decision, and More settings, folded (RemoteHostsMore). Each row is a HostRow: its
 * state in one line, at most one action, the rest in its More menu, Details in place.
 * Add host in the header is the one way to add a host.
 */
import { useState, useEffect } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsFold } from '../SettingsFold';
import { hydrateHostStatus } from '@/hooks/useHostStatus';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import { ReplicaRemovalGroup } from './ReplicaRemovalGroup';
import { AddHostButton } from './AddHostMenu';
import { RemoteHostSshRow } from './RemoteHostSshRow';
import { HostJoinError, HostJoinLink, HostJoinMaking } from './HostJoinLink';
import { NetMachineRow } from './NetMachineRow';
import { FleetHostRow } from './FleetHostRow';
import { HostSummaryLine } from './HostSummaryLine';
import { HostFleetTopology } from './HostFleetTopology';
import { RemoteHostsMore } from './RemoteHostsMore';
import { useHostNetwork } from './useHostNetwork';
import { useHostFleet } from './useHostFleet';
import { useSshHostEditor } from './useSshHostEditor';
import { useHostRowLanding } from './useHostRowLanding';
import { aliasPlaceholder, untouchedDraft } from './host-row-model';
import { hiddenAsTwin, refusalBlocks, type HostEntry } from './remote-hosts-model';
import '@/styles/settings-sections-addons.css';
import '@/styles/host-picker-settings.css';
import '@/styles/host-status.css';
import '@/styles/host-fleet.css';
import '@/styles/remote-hosts.css';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function RemoteHostsSection({ config, onSave }: Props) {
  const network = useHostNetwork(config.hosts);
  const machineName = useHostDisplayLabels();
  const netAliases = Object.fromEntries(Object.entries(config.hosts ?? {}).filter(([, h]) => h.transport === 'net').map(([alias]) => [alias, machineName(alias)]));
  const editor = useSshHostEditor({ config, onSave, netAliases });
  const fleet = useHostFleet();
  const { hosts, refusals, savedAliases, savedUnderCompanion } = editor;
  // A found row that is a joined machine shows once, as that machine (it is still saved).
  const twins = network.net?.twins ?? {};
  const machines = network.net?.machines ?? [];
  const relay = network.net?.relay ?? 'own';
  const hostLabels = Object.fromEntries(Object.entries(config.hosts ?? {}).map(([key, h]) => [key, h?.label?.trim() || (h.transport === 'net' ? machineName(key) : key)]));

  // Cold-read the connect status once; every change after this is a WS push.
  useEffect(() => { void hydrateHostStatus(); }, []);

  const asTwin = (h: HostEntry) => hiddenAsTwin(h, twins, refusals.get(h._key));
  const drafts = hosts.filter((h) => h.savedAlias === undefined && !asTwin(h));
  const savedRows = hosts.filter((h) => h.savedAlias !== undefined && !asTwin(h));
  const local = fleet.shown.find((h) => h.local);
  const rowHosts = new Set([...hosts.map((h) => h.alias), ...machines.map((m) => m.host)]);
  const others = fleet.shown.filter((h) => !h.local && !rowHosts.has(h.host));
  // The rows in the order shown; after a Remove, focus goes to the next one (or Add host).
  const rowKeys = [
    ...drafts.map((h) => `ssh:${h._key}`), ...(local ? [`fleet:${local.host}`] : []), ...savedRows.map((h) => `ssh:${h._key}`),
    ...machines.map((m) => `net:${m.host}`), ...others.map((h) => `fleet:${h.host}`),
  ];

  const land = useHostRowLanding({ hostsRef: editor.hostsRef, rowKeys, network, rowCount: hosts.length + machines.length });

  // Add host > An SSH host: a second press goes to the empty one already open (2026-11-04
  // review: two presses made "Host 5" and "Host 6").
  const addSshHost = () => {
    const open = hosts.find(untouchedDraft);
    if (open) editor.setEditing(open._key);
    land.ssh((open ?? editor.addHost())._key);
  };
  const joinWithLink = () => { land.join(); void network.add(); };

  const removeHost = (h: HostEntry) => {
    // An empty row nobody typed in gives the focus back to Add host, where it came from.
    land.after(untouchedDraft(h) ? 'add' : land.nextRowAfter(`ssh:${h._key}`));
    editor.removeHost(h._key);
  };
  const removeMachine = async (host: string) => {
    const next = land.nextRowAfter(`net:${host}`);
    if (await network.remove(host)) { fleet.forget(host); land.after(next); }
  };

  // One host's Details open at a time; opening them reads the host again.
  const [details, setDetails] = useState<string | null>(null);
  const detailsOf = (rowKey: string, host: string) => ({
    detailsOpen: details === rowKey,
    onDetails: (open: boolean) => {
      setDetails(open ? rowKey : null);
      if (open) { fleet.refresh([host]); land.row(rowKey); }
    },
  });
  const editOf = (h: HostEntry) => (open: boolean) => {
    editor.setEditing(open ? h._key : null);
    if (open) land.ssh(h._key); else land.after(`more:ssh:${h._key}`);
  };

  const sshRow = (host: HostEntry) => {
    const idx = hosts.indexOf(host);
    const refusal = refusals.get(host._key) ?? null;
    return (
      <RemoteHostSshRow
        key={host._key}
        host={host}
        idx={idx}
        editing={editor.editing === host._key}
        {...detailsOf(`ssh:${host._key}`, host.alias)}
        refusal={refusal}
        blocking={refusalBlocks(host, refusal ?? undefined, savedUnderCompanion)}
        saved={savedAliases.has(host.alias) && !!host.hostname}
        justSaved={editor.justSaved.has(host._key)}
        aliasPlaceholder={aliasPlaceholder(new Set([...savedAliases, ...hosts.map((h) => h.alias)]))}
        card={fleet.card(host.alias)}
        now={fleet.now}
        boot={fleet.boot[host.alias]}
        onBootStart={() => fleet.bootStart(host.alias)}
        onEdit={editOf(host)}
        onField={(field, value) => editor.updateHost(host._key, field, value)}
        onKeep={(patch) => editor.updateKeep(host._key, patch)}
        onRemove={() => removeHost(host)}
        answering={editor.answering?.alias === host.alias ? editor.answering.answer : null}
        answerError={editor.answerError?.alias === host.alias ? editor.answerError.text : null}
        onAnswer={(answer) => void editor.answerFound(host.alias, answer)}
      />
    );
  };

  const empty = hosts.length === 0 && machines.length === 0 && !local && !network.invite && !network.inviteError && !network.making;
  return (
    <SectionCard
      id="remote-hosts"
      title="Remote Hosts"
      onSave={() => editor.save(true)}
      showSave={false}
      actions={<AddHostButton onJoin={joinWithLink} onSsh={addSshHost} />}
    >
      <HostSummaryLine fleet={fleet} onNeedsLook={land.firstNeedingLook} />
      <SettingsGroup heading="Hosts" data-testid="remote-hosts-list">
        {network.making && <HostJoinMaking />}
        {!network.making && network.invite && (
          <HostJoinLink invite={network.invite} companion={network.net?.companion} relay={relay} making={network.making} onNewLink={joinWithLink} onDone={() => { network.dismiss(); land.after('add'); }} />
        )}
        {!network.making && network.inviteError && (
          <HostJoinError error={network.inviteError} onRetry={joinWithLink} onDone={() => { network.dismiss(); land.after('add'); }} />
        )}
        {drafts.map(sshRow)}
        {local && <FleetHostRow card={local} now={fleet.now} {...detailsOf(`fleet:${local.host}`, local.host)} boot={fleet.boot[local.host]} onBootStart={() => fleet.bootStart(local.host)} />}
        {savedRows.map(sshRow)}
        {machines.map((m) => (
          <NetMachineRow
            key={m.host}
            machine={m}
            name={machineName(m.host)}
            relay={relay}
            error={network.removeError[m.host]}
            card={fleet.card(m.host)}
            now={fleet.now}
            {...detailsOf(`net:${m.host}`, m.host)}
            onRemove={() => removeMachine(m.host)}
          />
        ))}
        {others.map((h) => (
          <FleetHostRow key={h.host} card={h} now={fleet.now} {...detailsOf(`fleet:${h.host}`, h.host)} boot={fleet.boot[h.host]} onBootStart={() => fleet.bootStart(h.host)} />
        ))}
        {empty && <SettingsRow label="No remote hosts yet." help="Add host, at the top of the page, adds one." />}
        {network.loadError && !network.net && <SettingsRow state="warning" label="Could not read the machines that joined with a link" help={network.loadError} />}
        {network.net?.error && <SettingsRow state="warning" data-testid="host-network-sync-error" label="Machines that joined with a link" help={network.net.error} />}
      </SettingsGroup>
      {fleet.shown.length > 1 && (
        <SettingsFold id="remote-hosts-map" label="Network map" summary="How this Mac reaches each host." data-testid="remote-hosts-map">
          <div className="hf-panel hf-topo-panel">
            <HostFleetTopology hosts={fleet.shown} onPick={land.showHostRow} />
          </div>
        </SettingsFold>
      )}
      <ReplicaRemovalGroup only="host" labels={Object.fromEntries(Object.entries(hostLabels).map(([key, label]) => [`host:${key}`, label]))} />
      <RemoteHostsMore
        hosts={config.hosts}
        hostLabels={hostLabels}
        net={network.net}
        onNetChanged={() => void network.load()}
        limits={editor.sessionLimits}
        onLimits={editor.setSessionLimits}
      />
    </SectionCard>
  );
}
