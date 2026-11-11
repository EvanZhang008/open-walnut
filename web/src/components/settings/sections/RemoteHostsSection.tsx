/**
 * Settings > Remote Hosts. From the top: the header's "need a look" count and Add host (the one
 * way to add a host), the Overview (HostFleetOverview: the fleet as a dashboard, open by default:
 * its numbers, the diagram and a card per host; 2026-11-11, the user wanted the dashboard back
 * after the 11-07 list replaced it), Hosts (whatever Add host is making first, then This Mac, the
 * SSH hosts this editor saves to config.yaml, the machines that joined with a link, and the
 * companion's box), the copies waiting for a decision, and More settings, folded
 * (RemoteHostsMore: what belongs to the whole page). Each row is a HostRow: its
 * state in one line, at most one action, the rest in its More menu, Details in place (with the
 * host's own settings under "This host").
 *
 * Every row tells one store what it shows (host-list-store.ts); the Overview's numbers and
 * diagram and the header's count read it, so none of them disagrees with the list. The host settings every Details reads
 * are read once here (host-settings-data.tsx). Add host has one draft per way in: a second "An
 * SSH host" goes to the open draft's first empty field, and opening one way closes an untouched
 * draft of the other.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { hydrateHostStatus } from '@/hooks/useHostStatus';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import { ReplicaRemovalGroup } from './ReplicaRemovalGroup';
import { AddHostButton } from './AddHostMenu';
import { ADD_SSH_HOST_EVENT, JOIN_HOST_EVENT, openFirstRunHosts, takeAddSshRequest } from '@/api/first-run';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { RemoteHostSshRow } from './RemoteHostSshRow';
import { HostJoinClosed, HostJoinError, HostJoinLink, HostJoinMaking } from './HostJoinLink';
import { NetMachineRow } from './NetMachineRow';
import { FleetHostRow } from './FleetHostRow';
import { HostFleetOverview } from './HostFleetOverview';
import { HostNeedsLook, type LookAt } from './HostNeedsLook';
import { RemoteHostsMore } from './RemoteHostsMore';
import { liveInvite, useHostNetwork } from './useHostNetwork';
import { useHostFleet } from './useHostFleet';
import { useSshHostEditor } from './useSshHostEditor';
import { useHostRowLanding } from './useHostRowLanding';
import { useFocusKeeper } from './useFocusKeeper';
import { createRowStore, RowStoreProvider } from './host-list-store';
import { HostSettingsProvider } from './host-settings-data';
import { aliasPlaceholder, firstEmptyField, untouchedDraft } from './host-row-model';
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

export function RemoteHostsSection(props: Props) {
  const store = useMemo(createRowStore, []);
  return (
    <RowStoreProvider value={store}>
      <RemoteHostsBody {...props} store={store} />
    </RowStoreProvider>
  );
}

function RemoteHostsBody({ config, onSave, store }: Props & { store: ReturnType<typeof createRowStore> }) {
  const replica = useIsCloudReplica();
  const network = useHostNetwork(config.hosts);
  const machineName = useHostDisplayLabels();
  const netAliases = Object.fromEntries(Object.entries(config.hosts ?? {}).filter(([, h]) => h.transport === 'net').map(([alias]) => [alias, machineName(alias)]));
  const editor = useSshHostEditor({ config, onSave, netAliases });
  const fleet = useHostFleet();
  const { hosts, refusals, savedAliases, savedHosts, savedUnderCompanion } = editor;
  // A found row that is a joined machine shows once, as that machine (it is still saved).
  const twins = network.net?.twins ?? {};
  const machines = network.net?.machines ?? [];
  const relay = network.net?.relay ?? 'own';
  const hostLabels = Object.fromEntries(Object.entries(config.hosts ?? {}).map(([key, h]) => [key, h?.label?.trim() || (h.transport === 'net' ? machineName(key) : key)]));

  // Cold-read the connect status once; every change after this is a WS push.
  useEffect(() => { void hydrateHostStatus(); }, []);
  // The focus never falls to the page, whatever a press here took away (the pane, so the header's
  // actions in the sticky bar count too).
  const root = useRef<HTMLDivElement>(null);
  useFocusKeeper(() => root.current?.closest('.settings-pane') ?? root.current?.closest('.settings-card') ?? root.current);

  const asTwin = (h: HostEntry) => hiddenAsTwin(h, twins, refusals.get(h._key));
  const isUnsaved = (h: HostEntry) => h.savedAlias === undefined && !(h.alias && savedHosts.get(h.alias) === h.hostname);
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
  const orderKey = rowKeys.join('\n');
  useEffect(() => { store.setOrder(orderKey.split('\n')); }, [store, orderKey]);

  const land = useHostRowLanding({ hostsRef: editor.hostsRef, rowKeys, network, rowCount: hosts.length + machines.length });
  // Which host "need a look" showed last: kept here, as the header's controls move into the sticky bar.
  const [look, setLook] = useState<LookAt>({ at: null, showing: null, count: 0 });

  // The join card is untouched until the person copies, picks a system or opens its notes.
  const [joinTouched, setJoinTouched] = useState(false);
  const inviteId = network.invite?.id ?? null;
  useEffect(() => { setJoinTouched(false); }, [inviteId]);

  // Add host > An SSH host: a second press goes to the draft already open, at its first empty
  // field (2026-11-04 review: three presses left three drafts). An untouched join card closes
  // (its link keeps working, and the list says so).
  const addSshHost = () => {
    if (network.shown && !network.making && (network.inviteError || !joinTouched)) network.dismiss();
    const open = hosts.find((h) => isUnsaved(h) && !asTwin(h));
    if (open) {
      editor.setEditing(open._key);
      const refusal = refusals.get(open._key);
      land.ssh(open._key, firstEmptyField(open, !!refusal && refusalBlocks(open, refusal, savedUnderCompanion)));
      return;
    }
    land.ssh(editor.addHost()._key);
  };
  // First-run setup's "Add a machine that is not listed" (api/first-run.ts): a new SSH row
  // once this page is up, whether it was open already or mounts for it.
  const addSshRef = useRef(addSshHost);
  addSshRef.current = addSshHost;
  useEffect(() => {
    const take = () => { if (takeAddSshRequest()) addSshRef.current(); };
    take();
    window.addEventListener(ADD_SSH_HOST_EVENT, take);
    return () => window.removeEventListener(ADD_SSH_HOST_EVENT, take);
  }, []);
  // Add host > Join with a link: a draft nobody typed in goes; a link that still waits shows again.
  const joinWithLink = () => {
    for (const h of hosts) if (untouchedDraft(h)) editor.removeHost(h._key);
    land.join();
    void network.add();
  };
  // A row's "Join with a link" (a Mac that SSH cannot set up) opens the same join link.
  const joinRef = useRef(joinWithLink);
  joinRef.current = joinWithLink;
  useEffect(() => {
    const join = () => joinRef.current();
    window.addEventListener(JOIN_HOST_EVENT, join);
    return () => window.removeEventListener(JOIN_HOST_EVENT, join);
  }, []);
  // Close (or Escape) gives the focus back to Add host; a link that still works says so in its
  // place, read out as it appears (HostJoinClosed).
  const closeJoin = () => { network.dismiss(); land.after('add'); };

  const removeHost = (h: HostEntry) => {
    // A new row not saved yet (its Cancel, or Escape on an empty one) gives the focus back to Add
    // host, where it came from; a saved host's Remove gives it to the next row.
    land.after(editor.isNewRow(h) ? 'add' : land.nextRowAfter(`ssh:${h._key}`));
    editor.removeHost(h._key);
  };
  /** Whether it is gone: a failed removal keeps the row's question open (HostRow). */
  const removeMachine = async (host: string): Promise<boolean> => {
    const next = land.nextRowAfter(`net:${host}`);
    if (!(await network.remove(host))) return false;
    fleet.forget(host);
    land.after(next);
    return true;
  };

  // One host's Details open at a time; opening them reads the host again.
  const [details, setDetails] = useState<string | null>(null);
  const detailsOf = (rowKey: string, host: string) => ({
    detailsOpen: details === rowKey,
    onDetails: (open: boolean) => {
      setDetails(open ? rowKey : null);
      if (open) { fleet.refresh([host]); land.row(rowKey); } else land.after(`more:${rowKey}`);
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
        aliasShown={editor.aliasShown.has(host._key)}
        saved={savedAliases.has(host.alias) && !!host.hostname}
        hostShown={editor.hostShown.has(host._key)}
        adding={editor.committed.has(host._key) && editor.isNewRow(host) && !(savedAliases.has(host.alias) && !!host.hostname)}
        addError={editor.addError?.key === host._key ? editor.addError.text : null}
        aliasPlaceholder={aliasPlaceholder(new Set([...savedAliases, ...hosts.map((h) => h.alias)]))}
        card={fleet.card(host.alias)}
        now={fleet.now}
        boot={fleet.boot[host.alias]}
        onBootStart={() => fleet.bootStart(host.alias)}
        onEdit={editOf(host)}
        onField={(field, value) => editor.updateHost(host._key, field, value)}
        onKeep={(patch) => editor.updateKeep(host._key, patch)}
        onRemove={() => removeHost(host)}
        onTurnOn={() => editor.turnOn(host._key)}
        onHostnameLeft={() => editor.hostnameLeft(host._key)}
        onAliasLeft={() => editor.showAliasRefusal(host._key)}
        onAdd={() => editor.addNew(host._key)}
        connecting={editor.dialPending.has(host.alias) && editor.dialing.has(host.alias)}
        pressedAt={editor.dialing.get(host.alias)}
        askedAs={editor.askOf(host.alias)}
        answering={editor.answering?.alias === host.alias ? editor.answering.answer : null}
        answerError={editor.answerError?.alias === host.alias ? editor.answerError.text : null}
        onAnswer={(answer) => void editor.answerFound(host.alias, answer)}
      />
    );
  };

  const join = network.making ? <HostJoinMaking />
    : network.inviteError ? (
      <HostJoinError
        error={network.inviteError}
        liveLink={liveInvite(network.invite)}
        starting={network.starting}
        onRetry={joinWithLink}
        onStart={() => { land.join(); void network.start(); }}
        onShowOpen={() => { land.join(); void network.add(); }}
        onDone={closeJoin}
      />
    )
    : network.invite && network.shown ? (
      <HostJoinLink
        invite={network.invite}
        companion={network.net?.companion}
        relay={relay}
        making={network.making}
        onNewLink={() => { land.join(); void network.renew(); }}
        onDone={closeJoin}
        onTouched={() => setJoinTouched(true)}
      />
    )
    : network.invite ? (
      <HostJoinClosed
        invite={network.invite}
        cancelling={network.cancelling}
        error={network.cancelError}
        onCancel={() => void network.cancel()}
        onDone={() => { network.dismiss(); land.after('add'); }}
      />
    )
    : null;

  const empty = hosts.length === 0 && machines.length === 0 && !local && !network.invite && !network.inviteError && !network.making;
  return (
    <HostSettingsProvider hosts={config.hosts} labels={hostLabels} limits={editor.sessionLimits} onLimits={editor.setSessionLimits}>
      <SectionCard
        id="remote-hosts"
        title="Remote Hosts"
        onSave={() => editor.save(true)}
        showSave={false}
        actions={
          <span className="rh-header-actions">
            <HostNeedsLook look={look} onLook={setLook} onShow={land.showLook} />
            {/* The picker is the Mac's (the dialog that opens it renders nothing on the companion). */}
            <AddHostButton onJoin={joinWithLink} onSsh={addSshHost} onPick={replica ? undefined : openFirstRunHosts} />
          </span>
        }
      >
        <div ref={root} className="rh-page" data-testid="remote-hosts-page">
          <HostFleetOverview fleet={fleet} onPickRow={land.showHostRow} />
          <SettingsGroup heading="Hosts" data-testid="remote-hosts-list">
            {join}
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
          <ReplicaRemovalGroup only="host" labels={Object.fromEntries(Object.entries(hostLabels).map(([key, label]) => [`host:${key}`, label]))} />
          <RemoteHostsMore hostLabels={hostLabels} net={network.net} onNetChanged={() => void network.load()} />
        </div>
      </SectionCard>
    </HostSettingsProvider>
  );
}
