/**
 * Remote Hosts: the SSH hosts this page edits and saves to config.yaml (`hosts`, plus the
 * session limits that save with them). The rows are keyed by `_key`, never by alias
 * (remote-hosts-model.ts). Saves run on their own (useSettingsAutoSave); a refused alias or a
 * row typed half way holds the hosts back while the limits still save.
 *
 * A config that already says what the rows say (this editor's own save coming back) keeps
 * the rows as typed: rebuilding them would drop a comma typed in "Leave out folders" before
 * the save, and any draft row. So does the echo of ANY save sent and not read back yet (two
 * can be in flight: the first one's echo must not undo the typing the second one carries).
 * A real change from elsewhere rebuilds them, keeping the host being edited open.
 */
import { useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { COMPANION_ALIAS } from '@open-walnut/companion-keep';
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave';
import { answerFoundHost } from '@/api/hosts';
import {
  aliasRefusals, emptyHost, entriesToHosts, hostsFromConfig, normalizeHosts, normalizeLimits, refusalBlocksSave, type HostEntry,
} from './remote-hosts-model';

/** Saves sent and not yet read back: the echo of each keeps the rows as typed. */
const ECHOES_KEPT = 8;
/** How long a row whose save just landed says Saved. */
const SAVED_NOTE_MS = 3_000;

export function useSshHostEditor({ config, onSave, netAliases }: {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
  /** The joined machines' aliases (an SSH row may not take one), each with its shown name. */
  netAliases: Record<string, string>;
}) {
  // Hydrated on the first render so the auto-save fingerprint matches its baseline at mount.
  const [hosts, setHosts] = useState<HostEntry[]>(() => hostsFromConfig(config));
  /** The `_key` of the host whose fields are open. */
  const [editing, setEditing] = useState<number | null>(null);
  // Per-host concurrency caps (config.session_limits), keyed by the hosts' aliases (plus "local").
  const [sessionLimits, setSessionLimits] = useState<Record<string, string | number>>(config.session_limits ?? {});
  const [justSaved, setJustSaved] = useState<ReadonlySet<number>>(new Set());
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
      const next = hostsFromConfig(config);
      const open = prev.find((h) => h._key === editingRef.current);
      setHosts(next);
      if (open) setEditing(next.find((h) => h.alias === (open.savedAlias ?? open.alias))?._key ?? null);
    }
    setSessionLimits(config.session_limits ?? {});
  }, [config]);

  // Editing a found host that waits for the yes keeps it waiting: only Connect says yes
  // (src/core/hosts/found-hosts.ts), so a changed label never dials a host.
  const updateHost = <K extends keyof HostEntry>(key: number, field: K, value: HostEntry[K]) => {
    setHosts((prev) => prev.map((h) => (h._key === key ? { ...h, [field]: value } : h)));
  };
  const updateKeep = (key: number, patch: Partial<NonNullable<HostEntry['keep']>>) => {
    setHosts((prev) => prev.map((h) => (h._key === key ? { ...h, keep: { ...(h.keep ?? {}), ...patch } } : h)));
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
  };

  // An alias another host has, or none beside a hostname, is refused next to its field, and
  // nothing saves while one is (2026-11-04: a new row typed as devbox was saved OVER devbox).
  const savedAliases = new Set(Object.keys(config.hosts ?? {}));
  const savedUnderCompanion = !!config.hosts?.[COMPANION_ALIAS]?.hostname;
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

  const savedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (savedTimer.current !== null) window.clearTimeout(savedTimer.current); }, []);
  const save = async (pressed: boolean) => {
    if (held) {
      if (JSON.stringify(limits) !== JSON.stringify(savedLimits)) await onSave({ session_limits: limits });
      if (pressed) throw new Error(refused ? 'A host needs an alias of its own before it can be saved.' : 'Give the host being edited both an alias and a hostname, or remove it.');
      return;
    }
    const sent = entriesToHosts(hosts, savedAliases);
    // The rows this save writes for the first time: they say Saved once it lands.
    const fresh = hosts.filter((h) => !savedAliases.has(h.alias) && Object.hasOwn(sent, h.alias)).map((h) => h._key);
    sentHosts.current = [...sentHosts.current, JSON.stringify(normalizeHosts(sent))].slice(-ECHOES_KEPT);
    await onSave({ hosts: sent, session_limits: limits });
    if (fresh.length) {
      setJustSaved(new Set(fresh));
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => { savedTimer.current = null; setJustSaved(new Set()); }, SAVED_NOTE_MS);
    }
  };
  useSettingsAutoSave({
    current: JSON.stringify({ hosts: held ? baselineHosts : entriesToHosts(hosts, savedAliases), limits }),
    baseline: JSON.stringify({ hosts: baselineHosts, limits: savedLimits }),
    save: () => save(false),
  });

  return {
    hosts, hostsRef, editing, setEditing, updateHost, updateKeep, answerFound, answering, answerError, addHost, removeHost,
    savedAliases, savedUnderCompanion, refusals, justSaved, save, sessionLimits, setSessionLimits,
  };
}
