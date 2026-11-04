/**
 * Settings > Remote Hosts. The page answers, in order: which machines Walnut runs work on, is
 * each one OK (and if not, the one thing to press), and how to add another. From the top: the
 * Overview (HostFleetGroup), Hosts (ONE list: the SSH hosts this editor saves to config.yaml and
 * the machines that joined with a link, a join link in use first), the copies waiting for a
 * decision, and More settings, folded (RemoteHostsMore). Add host in the header is the one way
 * to add a host.
 */
import { useState, useEffect, useRef } from 'react';
import type { Config } from '@open-walnut/core';
import { COMPANION_ALIAS } from '@open-walnut/companion-keep';
import { SectionCard } from '../inputs/SectionCard';
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { hydrateHostStatus } from '@/hooks/useHostStatus';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import { answerFoundHost } from '@/api/hosts';
import { useLocation, useNavigate } from 'react-router-dom';
import { flashHostsOf, hostRowId, useHostSettingsFocus } from '@/utils/host-settings-nav';
import { landOnRow } from '@/utils/scroll-land';
import { flashOnce, focusLanded } from '@/utils/focus-landed';
import { HostFleetGroup } from './HostFleetGroup';
import { ReplicaRemovalGroup } from './ReplicaRemovalGroup';
import { CopyHostDiagnosticsButton, DiagnosticsFallback, useCopyDiagnostics } from '../CopyDiagnostics';
import { hasStatusHosts } from '../diagnostics-copy';
import { AddHostButton } from './AddHostMenu';
import { RemoteHostSshRow } from './RemoteHostSshRow';
import { HostJoinLink } from './HostJoinLink';
import { NetMachineRow } from './NetMachineRow';
import { RemoteHostsMore } from './RemoteHostsMore';
import { useHostNetwork } from './useHostNetwork';
import {
  aliasRefusals, emptyHost, entriesToHosts, hiddenAsTwin, hostsFromConfig, normalizeHosts, normalizeLimits, refusalBlocks, refusalBlocksSave, type HostEntry,
} from './remote-hosts-model';
import '@/styles/settings-sections-addons.css';
import '@/styles/host-picker-settings.css';
import '@/styles/remote-hosts.css';

const FLASH_MS = 1500;
/** Each 'Open Settings' request flashes its row once, even across remounts. */
let flashedNonce = 0;
const JOIN_COPY = '[data-testid="host-network-copy"], [data-testid="host-network-windows-link-copy"], [data-testid="host-network-windows-copy"]';
/** Saves sent and not yet read back: the echo of each keeps the rows as typed. */
const ECHOES_KEPT = 8;

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

type Landing = { kind: 'ssh'; key: number } | { kind: 'join' };

export function RemoteHostsSection({ config, onSave }: Props) {
  // Hydrated on the first render so the auto-save fingerprint matches its baseline at mount.
  const [hosts, setHosts] = useState<HostEntry[]>(() => hostsFromConfig(config));
  const network = useHostNetwork(config.hosts);
  // A found row that is a joined machine shows once, as that machine (it is still saved).
  const twins = network.net?.twins ?? {};
  const machines = network.net?.machines ?? [];
  const machineName = useHostDisplayLabels();
  /** The `_key` of the host whose fields are open. */
  const [expanded, setExpanded] = useState<number | null>(null);
  // Per-host concurrency caps (config.session_limits), keyed by the hosts' aliases (plus "local").
  const [sessionLimits, setSessionLimits] = useState<Record<string, string | number>>(config.session_limits ?? {});
  // Diagnostics cover SAVED, enabled hosts (the server's listStatusHosts), never a draft row.
  const hostCopy = useCopyDiagnostics('hosts');
  const hostLabels = Object.fromEntries(Object.entries(config.hosts ?? {}).map(([key, h]) => [key, h?.label?.trim() || key]));

  // Cold-read the connect status once; every change after this is a WS push.
  useEffect(() => { void hydrateHostStatus(); }, []);

  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // A config that already says what the rows say (this editor's own save coming back) keeps
  // the rows as typed: rebuilding them would drop a comma typed in "Leave out folders" before
  // the save, and any draft row. So does the echo of ANY save sent and not read back yet (two
  // can be in flight: the first one's echo must not undo the typing the second one carries).
  // A real change from elsewhere rebuilds them, keeping the host being edited open.
  const sentHosts = useRef<string[]>([]);
  // The hosts config.yaml had at the last look: a config change about something else (the
  // session limits saving on their own, another pane) never touches the rows.
  const seenHosts = useRef<string | null>(null);
  useEffect(() => {
    const incoming = JSON.stringify(normalizeHosts(config.hosts));
    const moved = seenHosts.current !== null && seenHosts.current !== incoming;
    seenHosts.current = incoming;
    const at = sentHosts.current.indexOf(incoming);
    if (at >= 0) sentHosts.current.splice(0, at + 1);
    const prev = hostsRef.current;
    if (moved && at < 0 && JSON.stringify(entriesToHosts(prev)) !== incoming) {
      const next = hostsFromConfig(config);
      const open = prev.find((h) => h._key === expandedRef.current);
      setHosts(next);
      if (open) setExpanded(next.find((h) => h.alias === (open.savedAlias ?? open.alias))?._key ?? null);
    }
    setSessionLimits(config.session_limits ?? {});
  }, [config]);

  // Editing a found host that waits for the yes keeps it waiting: only Connect says yes
  // (src/core/hosts/found-hosts.ts), so a changed label never dials a host.
  const updateHost = <K extends keyof HostEntry>(key: number, field: K, value: HostEntry[K]) => {
    setHosts((prev) => prev.map((h) => (h._key === key ? { ...h, [field]: value } : h)));
  };

  // Connect / Not now on a found host: the server writes the answer (and dials on a yes);
  // the row takes it at once, and the config that comes back says the same.
  const [answering, setAnswering] = useState<{ alias: string; answer: 'yes' | 'not_now' } | null>(null);
  const [answerError, setAnswerError] = useState<{ alias: string; text: string } | null>(null);
  const answerFound = async (alias: string, answer: 'yes' | 'not_now') => {
    setAnswering({ alias, answer });
    setAnswerError(null);
    try {
      await answerFoundHost(alias, answer);
      setHosts((prev) => prev.map((h) => (h.alias === alias ? { ...h, connect: answer, enabled: answer === 'yes' } : h)));
    } catch (err) {
      setAnswerError({ alias, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setAnswering(null);
    }
  };

  // Whatever a press made or showed lands in view, flashes once and holds focus with its ring
  // (2026-11-04: Add host appended a row off screen, so a press looked like nothing happened).
  const [landing, setLanding] = useState<Landing | null>(null);
  const landRef = useRef<(() => void) | null>(null);
  const addSshHost = () => {
    const h = emptyHost();
    setHosts((prev) => [...prev, h]);
    setExpanded(h._key);
    setLanding({ kind: 'ssh', key: h._key });
  };
  const joinWithLink = () => { void network.add().then(() => setLanding({ kind: 'join' })); };
  // Once, the frame after the press (never again on later typing). The focus moves only while
  // nobody put it elsewhere since: 2026-11-04, a late landing took it from the Hostname box
  // mid-typing and the rest of the hostname went into Alias.
  useEffect(() => {
    if (!landing) return;
    const raf = requestAnimationFrame(() => {
      setLanding(null);
      const row = landing.kind === 'ssh'
        ? document.querySelector<HTMLElement>(`[data-row-key="ssh:${landing.key}"]`)
        : document.querySelector<HTMLElement>('[data-testid="host-network-invite"], [data-testid="host-network-invite-error"]');
      if (!row) return;
      landRef.current?.();
      landRef.current = landOnRow(row, { focus: false });
      flashOnce(row);
      const active = document.activeElement;
      const free = !active || active === document.body || !!active.closest('[data-testid="remote-hosts-add"], .rh-add-menu');
      if (!free) return;
      const idx = landing.kind === 'ssh' ? hostsRef.current.findIndex((h) => h._key === landing.key) : -1;
      focusLanded(landing.kind === 'ssh' ? document.getElementById(`rh-alias-${idx}`) : row.querySelector<HTMLElement>(JOIN_COPY) ?? row);
    });
    return () => cancelAnimationFrame(raf);
  }, [landing]);

  // An alias another host has, or none beside a hostname, is refused next to its field, and
  // nothing saves while one is (2026-11-04: a new row typed as devbox was saved OVER devbox).
  const savedAliases = new Set(Object.keys(config.hosts ?? {}));
  const savedUnderCompanion = !!config.hosts?.[COMPANION_ALIAS]?.hostname;
  const netAliases = Object.fromEntries(Object.entries(config.hosts ?? {}).filter(([, h]) => h.transport === 'net').map(([alias]) => [alias, machineName(alias)]));
  const refusals = aliasRefusals(hosts, { savedUnderCompanion, netAliases, saved: savedAliases });
  const refused = refusalBlocksSave(hosts, refusals, savedUnderCompanion);
  // A row with an alias or a hostname but not both is mid-edit: saving then would drop it from
  // `hosts`, so clearing an alias to retype it deleted the host. Remove is the way to delete one.
  const midEdit = hosts.some((h) => !h.alias !== !h.hostname);
  // While the hosts are held, the session limits still save on their own.
  const held = refused || midEdit;
  const limits = normalizeLimits(sessionLimits);
  const savedLimits = normalizeLimits(config.session_limits ?? {});
  const baselineHosts = normalizeHosts(config.hosts);

  const save = async (pressed: boolean) => {
    if (held) {
      if (JSON.stringify(limits) !== JSON.stringify(savedLimits)) await onSave({ session_limits: limits });
      if (pressed) throw new Error(refused ? 'A host needs an alias of its own before it can be saved.' : 'Give the host being edited both an alias and a hostname, or remove it.');
      return;
    }
    const sent = entriesToHosts(hosts, savedAliases);
    sentHosts.current = [...sentHosts.current, JSON.stringify(normalizeHosts(sent))].slice(-ECHOES_KEPT);
    await onSave({ hosts: sent, session_limits: limits });
  };
  useSettingsAutoSave({
    current: JSON.stringify({ hosts: held ? baselineHosts : entriesToHosts(hosts, savedAliases), limits }),
    baseline: JSON.stringify({ hosts: baselineHosts, limits: savedLimits }),
    save: () => save(false),
  });
  const asTwin = (h: HostEntry) => hiddenAsTwin(h, twins, refusals.get(h._key));

  // The rows in the order shown; after a Remove, focus goes to the next one (or Add host).
  const rowKeys = [...hosts.filter((h) => !asTwin(h)).map((h) => `ssh:${h._key}`), ...machines.map((m) => `net:${m.host}`)];
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  const nextRowAfter = (key: string) => {
    const at = rowKeys.indexOf(key);
    return rowKeys[at + 1] ?? rowKeys[at - 1] ?? 'add';
  };
  useEffect(() => {
    if (!focusAfter) return;
    const raf = requestAnimationFrame(() => {
      const el = focusAfter === 'add'
        ? document.querySelector<HTMLElement>('[data-testid="remote-hosts-add"]')
        : document.querySelector<HTMLElement>(`[data-row-key="${focusAfter}"]`);
      focusLanded(el);
      setFocusAfter(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [focusAfter]);
  const removeHost = (key: number) => {
    const next = nextRowAfter(`ssh:${key}`);
    setHosts((prev) => prev.filter((h) => h._key !== key));
    setExpanded(null);
    setFocusAfter(next);
  };
  const removeMachine = async (host: string) => {
    const next = nextRowAfter(`net:${host}`);
    if (await network.remove(host)) setFocusAfter(next);
  };

  // 'Open Settings' from a banner row, the picker or an error bar: scroll to that host's row
  // and flash it, on every request (a nonce, not the hash: the same hash twice fires nothing).
  const focus = useHostSettingsFocus();
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!focus.alias || focus.nonce <= flashedNonce) return;
    const nonce = focus.nonce;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(hostRowId(focus.alias!));
      if (!el) return;
      flashedNonce = nonce;
      // Upper part of the pane, held through late layout, focus on the row (N3-2).
      landRef.current?.();
      landRef.current = landOnRow(el);
      el.classList.remove('rh-row-flash');
      void el.offsetWidth; // restart the animation for a second request
      el.classList.add('rh-row-flash');
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => el.classList.remove('rh-row-flash'), FLASH_MS);
    });
    return () => cancelAnimationFrame(raf);
  }, [focus.nonce, focus.alias, hosts.length, machines.length]);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); landRef.current?.(); }, []);

  // 'and N more' on the banner: the rows its cap hid each flash once, the first scrolls into
  // view. The state is used once, then replaced away, so a reload does not flash again.
  const location = useLocation();
  const navigate = useNavigate();
  const flashKey = flashHostsOf(location.state).join('\n');
  useEffect(() => {
    if (!flashKey || hosts.length === 0) return;
    const raf = requestAnimationFrame(() => {
      const els = flashKey.split('\n').map((a) => document.getElementById(hostRowId(a))).filter((el): el is HTMLElement => !!el);
      if (els[0]) { landRef.current?.(); landRef.current = landOnRow(els[0], { focus: false }); }
      for (const el of els) flashOnce(el);
      navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: null });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashKey, hosts.length]);

  // A node of the Overview's diagram: its host's row in Hosts, in view and flashed.
  const showHostRow = (host: string): boolean => {
    const row = document.getElementById(hostRowId(host));
    if (!row) return false;
    landRef.current?.();
    landRef.current = landOnRow(row, { focus: false });
    flashOnce(row);
    focusLanded(row);
    return true;
  };

  const shownSsh = hosts.filter((h) => !asTwin(h));
  const empty = shownSsh.length === 0 && machines.length === 0 && !network.invite && !network.inviteError;
  const relay = network.net?.relay ?? 'own';
  return (
    <SectionCard
      id="remote-hosts"
      title="Remote Hosts"
      onSave={() => save(true)}
      showSave={false}
      actions={<>{hasStatusHosts(config) && <CopyHostDiagnosticsButton copy={hostCopy} />}<AddHostButton onJoin={joinWithLink} onSsh={addSshHost} /></>}
    >
      <DiagnosticsFallback copy={hostCopy} testId="remote-hosts-diagnostics-fallback" />
      <HostFleetGroup onPickHost={showHostRow} />
      <SettingsGroup heading="Hosts" data-testid="remote-hosts-list">
        {network.invite && (
          <HostJoinLink invite={network.invite} companion={network.net?.companion} relay={relay} making={network.making} onNewLink={joinWithLink} />
        )}
        {network.inviteError && <SettingsRow state="error" data-testid="host-network-invite-error" label="Could not make a link" error={network.inviteError} />}
        {empty && <SettingsRow label="No remote hosts yet." help="Add host, at the top of the page, adds one." />}
        {hosts.map((host, idx) => (asTwin(host) ? null : (
          <RemoteHostSshRow
            key={host._key}
            host={host}
            idx={idx}
            open={expanded === host._key}
            refusal={refusals.get(host._key) ?? null}
            blocking={refusalBlocks(host, refusals.get(host._key), savedUnderCompanion)}
            saved={savedAliases.has(host.alias) && !!host.hostname}
            onToggle={() => setExpanded(expanded === host._key ? null : host._key)}
            onField={(field, value) => updateHost(host._key, field, value)}
            onKeep={(patch) => setHosts((prev) => prev.map((h) => (h._key === host._key ? { ...h, keep: { ...(h.keep ?? {}), ...patch } } : h)))}
            onRemove={() => removeHost(host._key)}
            answering={answering?.alias === host.alias ? answering.answer : null}
            answerError={answerError?.alias === host.alias ? answerError.text : null}
            onAnswer={(answer) => void answerFound(host.alias, answer)}
          />
        )))}
        {machines.map((m) => (
          <NetMachineRow key={m.host} machine={m} name={machineName(m.host)} relay={relay} error={network.removeError[m.host]} onRemove={() => removeMachine(m.host)} />
        ))}
        {network.loadError && !network.net && <SettingsRow state="warning" label="Could not read the machines that joined with a link" help={network.loadError} />}
        {network.net?.error && <SettingsRow state="warning" data-testid="host-network-sync-error" label="Machines that joined with a link" help={network.net.error} />}
      </SettingsGroup>
      <ReplicaRemovalGroup
        only="host"
        labels={Object.fromEntries(Object.entries(config.hosts ?? {}).map(([key, h]) => [`host:${key}`, h?.label?.trim() || key]))}
      />
      <RemoteHostsMore
        hosts={config.hosts}
        hostLabels={hostLabels}
        net={network.net}
        onNetChanged={() => void network.load()}
        limits={sessionLimits}
        onLimits={setSessionLimits}
      />
    </SectionCard>
  );
}
