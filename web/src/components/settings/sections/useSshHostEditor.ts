/**
 * Remote Hosts: the SSH hosts this page edits and saves to config.yaml (`hosts`, plus the
 * session limits that save with them). The rows are keyed by `_key`, never by alias
 * (remote-hosts-model.ts). Saves run on their own (useSettingsAutoSave). A new row is left out
 * of them until it is a host to write, while every other change saves; a SAVED row with a
 * refused alias or typed half way holds the hosts back (saving then would drop it), while the
 * limits still save.
 *
 * A config that already says what the rows say (this editor's own save coming back) keeps
 * the rows as typed: rebuilding them would drop a comma typed in "Leave out folders" before
 * the save, and any draft row. So does the echo of ANY save sent and not read back yet (two
 * can be in flight: the first one's echo must not undo the typing the second one carries).
 * A real change from elsewhere rebuilds them, keeping the host being edited open and every
 * new row not saved yet.
 *
 * Typed input is never lost (2026-11-04 review: a hostname typed with no alias was dropped when
 * the pane closed): a new row's alias follows its hostname until the person types one
 * (aliasFromHostname), it saves once the Hostname field is left (never a half-typed hostname),
 * and the rows not saved yet outlive the pane (ssh-draft-store.ts).
 */
import { useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { COMPANION_ALIAS } from '@open-walnut/companion-keep';
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave';
import { answerFoundHost } from '@/api/hosts';
import { seedHostStatus } from '@/hooks/useHostStatus';
import { runHostAction } from '@/utils/host-action-store';
import {
  aliasRefusals, emptyHost, entriesToHosts, hostsFromConfig, normalizeHosts, normalizeLimits, refusalBlocks, refusalBlocksSave, type HostEntry,
} from './remote-hosts-model';
import { aliasFromHostname } from './host-row-model';
import { readSshDrafts, writeSshDrafts, type SavedHosts } from './ssh-draft-store';

/** Saves sent and not yet read back: the echo of each keeps the rows as typed. */
const ECHOES_KEPT = 8;
/** How long a row whose save just landed says Saved. */
const SAVED_NOTE_MS = 3_000;
/** A Turn on or a found host's Connect reads as "Connecting..." until its dial starts, at most this long. */
const DIAL_WAIT_MS = 30_000;

const savedHostsOf = (config: Config): SavedHosts => new Map(Object.entries(config.hosts ?? {}).filter(([, h]) => h.transport !== 'net').map(([a, h]) => [a, h.hostname]));

export function useSshHostEditor({ config, onSave, netAliases }: {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
  /** The joined machines' aliases (an SSH row may not take one), each with its shown name. */
  netAliases: Record<string, string>;
}) {
  // Hydrated on the first render so the auto-save fingerprint matches its baseline at mount; the
  // new rows kept from an earlier visit join at the top.
  const restored = useRef<number[]>([]);
  const [hosts, setHosts] = useState<HostEntry[]>(() => {
    const kept = readSshDrafts(savedHostsOf(config));
    restored.current = kept.map((h) => h._key);
    return [...hostsFromConfig(config), ...kept];
  });
  /** The `_key` of the host whose fields are open. */
  const [editing, setEditing] = useState<number | null>(null);
  // Per-host concurrency caps (config.session_limits), keyed by the hosts' aliases (plus "local").
  const [sessionLimits, setSessionLimits] = useState<Record<string, string | number>>(config.session_limits ?? {});
  const [justSaved, setJustSaved] = useState<ReadonlySet<number>>(new Set());
  /** A new row whose Hostname field holds the focus: it saves once that field is left. */
  const [typing, setTyping] = useState<number | null>(null);
  /** Rows whose empty-alias refusal is shown (left empty after typing, or a Save pressed). */
  const [aliasShown, setAliasShown] = useState<ReadonlySet<number>>(new Set());
  /** Hosts a Turn on or a found Connect asked to dial, and when (for "Connected."). */
  const [dialing, setDialing] = useState<ReadonlyMap<string, number>>(new Map());
  /** Of those, the ones whose dial waits for their save. */
  const dialAfterSave = useRef(new Set<string>());
  /** The new rows this page saved (by key): saved, though they keep no savedAlias. */
  const savedKeys = useRef(new Set<number>());
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const editingRef = useRef(editing);
  editingRef.current = editing;

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
      // A new row not saved yet stays (it is nobody else's change to drop).
      const saved = savedHostsOf(config);
      const drafts = prev.filter((h) => h.savedAlias === undefined && !(h.alias && saved.get(h.alias) === h.hostname));
      const next = [...hostsFromConfig(config), ...drafts];
      const open = prev.find((h) => h._key === editingRef.current);
      setHosts(next);
      if (open) setEditing(open.savedAlias === undefined && drafts.includes(open) ? open._key : next.find((h) => h.alias === (open.savedAlias ?? open.alias))?._key ?? null);
    }
    setSessionLimits(config.session_limits ?? {});
  }, [config]);

  // An alias another host has, or none beside a hostname, is refused next to its field, and
  // a refused row is never written (2026-11-04: a new row typed as devbox was saved OVER devbox).
  const savedAliases = new Set(Object.keys(config.hosts ?? {}));
  const savedHosts = savedHostsOf(config);
  const savedUnderCompanion = !!config.hosts?.[COMPANION_ALIAS]?.hostname;
  const refusals = aliasRefusals(hosts, { savedUnderCompanion, netAliases, saved: savedAliases });
  const refused = refusalBlocksSave(hosts, refusals, savedUnderCompanion);

  // The rows not saved yet outlive the pane; one that saved or was cancelled is no longer kept.
  const draftsJson = JSON.stringify(hosts.filter((h) => h.savedAlias === undefined));
  const savedJson = JSON.stringify([...savedHosts]);
  useEffect(() => { writeSshDrafts(hostsRef.current, savedHostsOf(config)); }, [draftsJson, savedJson]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A new row's alias follows its hostname until someone types one; typing in Alias ends that. */
  const updateHost = <K extends keyof HostEntry>(key: number, field: K, value: HostEntry[K]) => {
    setHosts((prev) => prev.map((h) => {
      if (h._key !== key) return h;
      const next: HostEntry = { ...h, [field]: value };
      if (field === 'alias') next.aliasAuto = false;
      if (field === 'hostname' && h.savedAlias === undefined && !savedHosts.has(h.alias) && (h.aliasAuto || !h.alias)) {
        const taken = new Set([...savedAliases, ...Object.keys(netAliases), ...prev.filter((o) => o._key !== key).map((o) => o.alias), COMPANION_ALIAS].filter(Boolean));
        next.alias = aliasFromHostname(String(value), taken);
        next.aliasAuto = true;
      }
      return next;
    }));
  };
  const updateKeep = (key: number, patch: Partial<NonNullable<HostEntry['keep']>>) => {
    setHosts((prev) => prev.map((h) => (h._key === key ? { ...h, keep: { ...(h.keep ?? {}), ...patch } } : h)));
  };

  const dialTimers = useRef(new Map<string, number>());
  useEffect(() => () => { for (const t of dialTimers.current.values()) window.clearTimeout(t); }, []);
  const markDialing = (alias: string, on: boolean) => {
    setDialing((cur) => {
      const next = new Map(cur);
      if (on) next.set(alias, Date.now()); else next.delete(alias);
      return next;
    });
    const t = dialTimers.current.get(alias);
    if (t !== undefined) window.clearTimeout(t);
    if (on) dialTimers.current.set(alias, window.setTimeout(() => { dialAfterSave.current.delete(alias); markDialing(alias, false); }, DIAL_WAIT_MS));
  };

  // Connect / Not now on a found host: the server writes the answer (and dials on a yes); the
  // row takes it at once and says Connecting... until the dial answers (2026-11-04 review:
  // Connect turned the row into "Not connected" with a second Connect now).
  const [answering, setAnswering] = useState<{ alias: string; answer: 'yes' | 'not_now' } | null>(null);
  const [answerError, setAnswerError] = useState<{ alias: string; text: string } | null>(null);
  const answerFound = async (alias: string, answer: 'yes' | 'not_now') => {
    setAnswering({ alias, answer });
    setAnswerError(null);
    if (answer === 'yes') markDialing(alias, true);
    try {
      const r = await answerFoundHost(alias, answer);
      seedHostStatus(r.status);
      setHosts((prev) => prev.map((h) => (h.alias === alias ? { ...h, connect: answer, enabled: answer === 'yes' } : h)));
    } catch (err) {
      setAnswerError({ alias, text: err instanceof Error ? err.message : String(err) });
      if (answer === 'yes') markDialing(alias, false);
    } finally {
      setAnswering(null);
    }
  };

  /** Turn on: saved on, then dialed once the save landed (the server dials no host it has off). */
  const turnOn = (key: number) => {
    const h = hostsRef.current.find((x) => x._key === key);
    if (!h) return;
    updateHost(key, 'enabled', true);
    dialAfterSave.current.add(h.alias);
    markDialing(h.alias, true);
  };

  /** A new row (at the top of the list, with its fields open). */
  const addHost = (): HostEntry => {
    const h = emptyHost();
    setHosts((prev) => [...prev, h]);
    setEditing(h._key);
    return h;
  };
  const removeHost = (key: number) => {
    setHosts((prev) => prev.filter((h) => h._key !== key));
    setEditing((cur) => (cur === key ? null : cur));
    if (typing === key) setTyping(null);
  };
  /** An empty alias left after typing in it says so under the field (never on tabbing in). */
  const showAliasRefusal = (key: number) => setAliasShown((cur) => (cur.has(key) ? cur : new Set(cur).add(key)));

  const blocked = (h: HostEntry) => refusalBlocks(h, refusals.get(h._key), savedUnderCompanion);
  // A row this page saved keeps no savedAlias (the rows stay as typed), so its key says it is saved.
  const isNewRow = (h: HostEntry) => h.savedAlias === undefined && !savedKeys.current.has(h._key);
  // A new row is left out of a save until it is a host to write: both fields, an alias of its
  // own, and its Hostname field left ("build7.exa" is no host to dial) unless Save was pressed.
  // The other hosts' changes save meanwhile (review: a half-typed new row, kept across visits,
  // held every other change back, unsaved, with nothing saying so).
  const draftWaits = (h: HostEntry, pressed: boolean) => isNewRow(h) && (
    !h.alias || !h.hostname || blocked(h) || (!pressed && h._key === typing && savedHosts.get(h.alias) !== h.hostname));
  const toSend = (pressed: boolean) => entriesToHosts(hosts.filter((h) => !draftWaits(h, pressed)), savedAliases);
  // A saved row with an alias or a hostname but not both is mid-edit: saving then would drop it
  // from `hosts`, so clearing an alias to retype it deleted the host (Remove is the way to delete
  // one); a saved row whose alias is refused holds them too. The session limits still save.
  const held = hosts.some((h) => !isNewRow(h) && (!h.alias !== !h.hostname || blocked(h)));
  const limits = normalizeLimits(sessionLimits);
  const savedLimits = normalizeLimits(config.session_limits ?? {});
  const baselineHosts = normalizeHosts(config.hosts);

  const savedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (savedTimer.current !== null) window.clearTimeout(savedTimer.current); }, []);
  const save = async (pressed: boolean) => {
    const waiting = pressed && hosts.some((h) => draftWaits(h, true));
    if (held || waiting) {
      if (JSON.stringify(limits) !== JSON.stringify(savedLimits)) await onSave({ session_limits: limits });
      if (pressed) {
        setAliasShown(new Set(refusals.keys()));
        throw new Error(refused ? 'A host needs an alias of its own before it can be saved.' : 'Give the host being edited both an alias and a hostname, or remove it.');
      }
      return;
    }
    const sent = toSend(pressed);
    // The rows this save writes for the first time: they say Saved once it lands.
    const fresh = hosts.filter((h) => !savedAliases.has(h.alias) && Object.hasOwn(sent, h.alias)).map((h) => h._key);
    sentHosts.current = [...sentHosts.current, JSON.stringify(normalizeHosts(sent))].slice(-ECHOES_KEPT);
    await onSave({ hosts: sent, session_limits: limits });
    if (fresh.length) {
      for (const k of fresh) savedKeys.current.add(k);
      // Saved: its alias is its own from now on, whatever its hostname becomes.
      setHosts((prev) => prev.map((h) => (fresh.includes(h._key) ? { ...h, aliasAuto: false } : h)));
      setJustSaved(new Set(fresh));
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => { savedTimer.current = null; setJustSaved(new Set()); }, SAVED_NOTE_MS);
    }
    for (const alias of [...dialAfterSave.current]) {
      if (!sent[alias]?.enabled) continue;
      dialAfterSave.current.delete(alias);
      // Re-marked, so the row reads the dial (its Retry's busy state) from here on.
      markDialing(alias, true);
      void runHostAction(alias, 'retry');
    }
  };
  useSettingsAutoSave({
    current: JSON.stringify({ hosts: held ? baselineHosts : toSend(false), limits }),
    baseline: JSON.stringify({ hosts: baselineHosts, limits: savedLimits }),
    save: () => save(false),
  });
  // A new row kept from an earlier visit saves now (the autosave never writes on a pane's mount).
  const restoredSaved = useRef(false);
  useEffect(() => {
    if (restoredSaved.current || !restored.current.length) return;
    restoredSaved.current = true;
    if (!held && JSON.stringify(toSend(false)) !== JSON.stringify(baselineHosts)) void save(false).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    hosts, hostsRef, isNewRow, editing, setEditing, updateHost, updateKeep, answerFound, answering, answerError, addHost, removeHost,
    savedAliases, savedHosts, savedUnderCompanion, refusals, justSaved, save, sessionLimits, setSessionLimits,
    typing, setTyping, aliasShown, showAliasRefusal, turnOn, dialing, dialPending: dialAfterSave.current,
  };
}
