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
 * new row not saved yet. The session limits take a read only when nothing typed waits for its
 * save (limitsRead).
 *
 * Typed input is never lost (2026-11-04 review: a hostname typed with no alias was dropped when
 * the pane closed): a new row's alias follows its hostname until the person types one
 * (aliasFromHostname), and the rows not saved yet outlive the pane (ssh-draft-store.ts).
 *
 * A new row saves only when the person says so: Add and connect, or Enter in one of its fields
 * (2026-11-05 review: a half-typed "half" became a host, tagged Needs a look and counted, as soon
 * as the focus left Hostname for Add host's menu). That save dials it at once, so a new host reads
 * Connecting... and never "Not connected" before anyone tried it. A hostname that is no host ("not
 * a host!!") is refused under its field and never saved (parseHostInput); "sam@build7:2222" fills
 * User and Port when the field is left.
 */
import { useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { COMPANION_ALIAS } from '@open-walnut/companion-keep';
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave';
import { answerFoundHost } from '@/api/hosts';
import { seedHostStatus } from '@/hooks/useHostStatus';
import { runHostAction } from '@/utils/host-action-store';
import {
  aliasRefusals, emptyHost, entriesToHosts, hostsFromConfig, limitsRead, normalizeHosts, normalizeLimits, refusalBlocks, refusalBlocksSave, type HostEntry,
} from './remote-hosts-model';
import { aliasFromHostname, hostnameProblem, parseHostInput } from './host-row-model';
import { readSshDrafts, writeSshDrafts, type SavedHosts } from './ssh-draft-store';

/** Saves sent and not yet read back: the echo of each keeps the rows as typed. */
const ECHOES_KEPT = 8;
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
  // new rows kept from an earlier visit join at the top (still drafts: they save on Add and connect).
  const [hosts, setHosts] = useState<HostEntry[]>(() => [...hostsFromConfig(config), ...readSshDrafts(savedHostsOf(config))]);
  /** The `_key` of the host whose fields are open. */
  const [editing, setEditing] = useState<number | null>(null);
  // Per-host concurrency caps (config.session_limits), keyed by the hosts' aliases (plus "local").
  const [sessionLimits, setSessionLimits] = useState<Record<string, string | number>>(config.session_limits ?? {});
  /** New rows the person pressed Add and connect (or Enter) on: only those save. */
  const [committed, setCommitted] = useState<ReadonlySet<number>>(new Set());
  /** Rows whose empty-alias refusal is shown (left empty after typing, or a Save pressed). */
  const [aliasShown, setAliasShown] = useState<ReadonlySet<number>>(new Set());
  /** Rows whose hostname refusal is shown (the field left holding no host, or Add pressed). */
  const [hostShown, setHostShown] = useState<ReadonlySet<number>>(new Set());
  /** A new row's Add and connect that could not save, and why. */
  const [addError, setAddError] = useState<{ key: number; text: string } | null>(null);
  /** Hosts a Turn on or a found Connect asked to dial, and when (for "Connected."). */
  const [dialing, setDialing] = useState<ReadonlyMap<string, number>>(new Map());
  /** Of those, the ones whose dial waits for their save. */
  const dialAfterSave = useRef(new Set<string>());
  /** The last Turn on or Add and connect of each host, for the words of a failure after it. */
  const asks = useRef(new Map<string, { as: 'turn-on' | 'add'; at: number }>());
  /** The new rows this page saved (by key): saved, though they keep no savedAlias. */
  const savedKeys = useRef(new Set<number>());
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const sentHosts = useRef<string[]>([]);
  // The same for the session limits: the saves not seen back, what config.yaml said at the last
  // look, and what the boxes hold now (the effect below must not drop a value not saved yet).
  const sentLimits = useRef<string[]>([]);
  const seenLimits = useRef<string | null>(null);
  const limitsRef = useRef(sessionLimits);
  limitsRef.current = sessionLimits;
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
    const limitsIn = JSON.stringify(normalizeLimits(config.session_limits ?? {}));
    const read = limitsRead({ incoming: limitsIn, seen: seenLimits.current, shown: JSON.stringify(normalizeLimits(limitsRef.current)), sent: sentLimits.current });
    sentLimits.current = read.sent;
    seenLimits.current = limitsIn;
    if (read.take) setSessionLimits(config.session_limits ?? {});
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
    asks.current.set(h.alias, { as: 'turn-on', at: Date.now() });
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
    setCommitted((cur) => { if (!cur.has(key)) return cur; const next = new Set(cur); next.delete(key); return next; });
    setAddError((cur) => (cur?.key === key ? null : cur));
  };
  /** An empty alias left after typing in it says so under the field (never on tabbing in). */
  const showAliasRefusal = (key: number) => setAliasShown((cur) => (cur.has(key) ? cur : new Set(cur).add(key)));
  /**
   * The Hostname field was left: "sam@build7:2222" puts sam in User and 2222 in Port (when those
   * are empty or say the same), and a hostname that is no host says why under the field.
   */
  const hostnameLeft = (key: number) => {
    const h = hostsRef.current.find((x) => x._key === key);
    if (!h || !h.hostname.trim()) return;
    const parsed = parseHostInput(h.hostname);
    if (!parsed.ok) { setHostShown((cur) => (cur.has(key) ? cur : new Set(cur).add(key))); return; }
    const { host, user, port } = parsed.value;
    const userFits = !user || !h.user.trim() || h.user.trim() === user;
    const portFits = port === undefined || h.port === undefined || h.port === port;
    if (!userFits || !portFits || (host === h.hostname.trim() && !user && port === undefined)) return;
    updateHost(key, 'hostname', host);
    if (user) updateHost(key, 'user', user);
    if (port !== undefined) updateHost(key, 'port', port);
  };

  const blocked = (h: HostEntry) => refusalBlocks(h, refusals.get(h._key), savedUnderCompanion);
  // A row this page saved keeps no savedAlias (the rows stay as typed), so its key says it is saved.
  const isNewRow = (h: HostEntry) => h.savedAlias === undefined && !savedKeys.current.has(h._key);
  /** What a new row still needs before Add and connect can save it (the field to go to), or null. */
  const newRowNeeds = (h: HostEntry): 'hostname' | 'alias' | null =>
    !h.hostname.trim() || hostnameProblem(h.hostname) ? 'hostname' : !h.alias.trim() || blocked(h) ? 'alias' : null;
  // A new row is left out of every save until the person pressed Add and connect on it and it is
  // a host to write. The other hosts' changes save meanwhile (review: a half-typed new row, kept
  // across visits, held every other change back, unsaved, with nothing saying so).
  const draftWaits = (h: HostEntry) => isNewRow(h) && (!committed.has(h._key) || newRowNeeds(h) !== null);
  const toSend = () => entriesToHosts(hosts.filter((h) => !draftWaits(h)), savedAliases);
  // A saved row with an alias or a hostname but not both is mid-edit: saving then would drop it
  // from `hosts`, so clearing an alias to retype it deleted the host (Remove is the way to delete
  // one); a saved row whose alias is refused, or whose hostname is no host, holds them too. The
  // session limits still save.
  const held = hosts.some((h) => !isNewRow(h) && (!h.alias !== !h.hostname || blocked(h) || !!hostnameProblem(h.hostname)));
  const limits = normalizeLimits(sessionLimits);
  const savedLimits = normalizeLimits(config.session_limits ?? {});
  const baselineHosts = normalizeHosts(config.hosts);

  const save = async (pressed: boolean) => {
    const waiting = pressed && hosts.some((h) => isNewRow(h) && committed.has(h._key) && newRowNeeds(h) !== null);
    const limitsSent = JSON.stringify(limits);
    if (held || waiting) {
      if (limitsSent !== JSON.stringify(savedLimits)) {
        sentLimits.current = [...sentLimits.current, limitsSent].slice(-ECHOES_KEPT);
        await onSave({ session_limits: limits });
      }
      if (pressed) {
        setAliasShown(new Set(refusals.keys()));
        setHostShown(new Set(hosts.filter((h) => hostnameProblem(h.hostname)).map((h) => h._key)));
        throw new Error(refused ? 'A host needs an alias of its own before it can be saved.'
          : hosts.some((h) => hostnameProblem(h.hostname)) ? 'A hostname is not one Walnut can reach: fix it under its field.'
            : 'Give the host being edited both an alias and a hostname, or remove it.');
      }
      return;
    }
    const sent = toSend();
    // The rows this save writes for the first time: they say Saved once it lands.
    const fresh = hosts.filter((h) => !savedAliases.has(h.alias) && Object.hasOwn(sent, h.alias)).map((h) => h._key);
    sentHosts.current = [...sentHosts.current, JSON.stringify(normalizeHosts(sent))].slice(-ECHOES_KEPT);
    sentLimits.current = [...sentLimits.current, limitsSent].slice(-ECHOES_KEPT);
    try {
      await onSave({ hosts: sent, session_limits: limits });
    } catch (err) {
      // A new host whose save failed is a draft again, with the reason on its row; its dial waits.
      const added = hosts.filter((h) => isNewRow(h) && committed.has(h._key) && Object.hasOwn(sent, h.alias));
      if (added.length) {
        setCommitted((cur) => { const next = new Set(cur); for (const h of added) next.delete(h._key); return next; });
        for (const h of added) { dialAfterSave.current.delete(h.alias); markDialing(h.alias, false); }
        setAddError({ key: added[0]._key, text: `Not saved: ${err instanceof Error ? err.message : String(err)}` });
      }
      throw err;
    }
    if (fresh.length) {
      for (const k of fresh) savedKeys.current.add(k);
      // Saved: its alias is its own from now on, whatever its hostname becomes. The header's
      // "Saved" is the one receipt (2026-11-05 review: the row said "Saved." beside it).
      setHosts((prev) => prev.map((h) => (fresh.includes(h._key) ? { ...h, aliasAuto: false } : h)));
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
    current: JSON.stringify({ hosts: held ? baselineHosts : toSend(), limits }),
    baseline: JSON.stringify({ hosts: baselineHosts, limits: savedLimits }),
    save: () => save(false),
  });

  /**
   * Add and connect (or Enter) on a new row: the field it still needs takes the focus, with why
   * under it; else the row joins the next save (the autosave, a moment later, the page's one
   * save path), and once that lands Walnut dials it. Returns the field it still needs, or null.
   */
  const addNew = (key: number): 'hostname' | 'alias' | null => {
    const h = hostsRef.current.find((x) => x._key === key);
    if (!h || !isNewRow(h)) return null;
    const needs = newRowNeeds(h);
    setAddError((cur) => (cur?.key === key ? null : cur));
    if (needs === 'hostname') { setHostShown((cur) => new Set(cur).add(key)); return needs; }
    if (needs === 'alias') { showAliasRefusal(key); return needs; }
    setCommitted((cur) => new Set(cur).add(key));
    if (h.enabled) { asks.current.set(h.alias, { as: 'add', at: Date.now() }); dialAfterSave.current.add(h.alias); markDialing(h.alias, true); }
    return null;
  };

  return {
    hosts, hostsRef, isNewRow, editing, setEditing, updateHost, updateKeep, answerFound, answering, answerError, addHost, removeHost,
    savedAliases, savedHosts, savedUnderCompanion, refusals, save, sessionLimits, setSessionLimits,
    aliasShown, showAliasRefusal, hostShown, hostnameLeft, addNew, committed, addError, turnOn, dialing, dialPending: dialAfterSave.current,
    askOf: (alias: string) => asks.current.get(alias),
  };
}
