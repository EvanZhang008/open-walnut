/**
 * Settings → Plugins: the whole life of a plugin on one surface.
 *
 * Discover → install → turn on/off → configure → update → remove. Before this it was
 * three places: the store listed SOURCES you had installed (so a builtin plugin was
 * invisible here), Integrations held the config forms, and nothing in the UI could
 * turn a plugin off at all — the only way was a POST from a terminal.
 *
 * Three lists, in the order someone actually needs them:
 *
 *   1. Installed — every discovered plugin, builtin or external or dev-linked, with
 *      its real state (on / off / needs setup / failed / restart to activate), a
 *      switch, and Configure right there.
 *   2. Available — catalog entries not on this machine. A `builtin` one only needs
 *      turning on; a `git`/`npm` one PREFILLS the install form below (it never
 *      installs by itself); an `example` one lives in this checkout, so it shows the
 *      `walnut-plugin link` command instead of a button that could not work.
 *   3. Install from a git repo or an npm package — the free-form input, unchanged,
 *      for anything the catalog does not know.
 *
 * Installing a plugin gives it full access to Walnut and this machine, so the trust
 * checkbox stays a per-install stop: the Add button is disabled until it is ticked and
 * it resets after every successful add. Prefilling from the catalog does NOT pre-tick
 * it — a curated listing is not the user's consent.
 *
 * Turning a plugin off persists: the disable route writes `plugins.<id>.enabled: false`
 * to config.yaml (integration-loader.disableLoadedPlugin), so it stays off across a
 * restart, and turning it on writes `enabled: true` before reloading it.
 *
 * Update status (linked checkouts, git and npm sources) comes from ONE batch request
 * through `usePluginUpdates`, never from the registry: every updatable row carries a
 * chip on its title line, Update is the only verb and appears only when there is
 * something to do, results land on the row as a feedback line, and the checkout's
 * path, branch and sha live in the Provenance flyout rather than in the row copy.
 * Built-in rows take no part in any of it.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsSection, SettingsRow, SettingsSubCard, SettingsEmpty, SettingsNotice } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { PluginConfigCards } from './PluginConfigCards';
import { PluginSourcesGroup, UpdatesHead, sourceProvenance, type PluginSource } from './PluginSourcesGroup';
import {
  dependencyBusyKey,
  PluginAlsoNeeds,
  PluginCascadeConfirm,
  PluginDependencyNeeds,
  PluginPendingDependencies,
  type DependencyPlanItem,
  type MissingDependencyView,
} from './PluginDependencyRows';
import { PluginAppControls } from '../PluginAppControls';
import { PluginConnectionPanel, CONNECTION_BADGE, type ConnectionReport } from '../PluginConnectionPanel';
import { BuildPluginCard } from '../BuildPluginCard';
// Deliberately NOT '@/plugins/hooks': that module reaches the plugin loader, which
// reaches every view a plugin may mount (NotesPage, CalendarPage, SessionPanel …).
// Importing it here would pull that whole graph into anything that touches the
// settings registry. `plugin:runtime-changed` is the same signal, one WS event away.
import { useEvent } from '@/hooks/useWebSocket';
import { PLUGINS_CHANGED_EVENT, emitPluginsChanged } from '@/utils/plugin-events';
import { coalesceRefresh, type CoalescedRefresh } from '@/utils/coalesce-refresh';
import { usePluginUpdates } from '@/hooks/usePluginUpdates';
import { PluginUpdateChip } from '../PluginUpdateChip';
import { PluginUpdateButton } from '../PluginUpdateButton';
import { PluginUpdateFeedback } from '../PluginUpdateFeedback';
import { PluginProvenanceFlyout } from '../PluginProvenanceFlyout';
import {
  CLOUD_LINKED_NOTE,
  failureFeedback,
  resolveRowState,
  sourceShortLabel,
  successFeedback,
  updateButtonMode,
  type Feedback,
} from '../plugin-update-view';
import { RESTART_PENDING_STATE, sourceRowKey, type UpdateState, type UpdateStatusRow } from '../plugin-update-types';
import '@/styles/plugin-store.css';

/** Mirrors PluginRegistryRow in src/core/plugins/plugin-catalog.ts. */
interface RegistryRow {
  id: string;
  name: string;
  description?: string;
  adds?: string[];
  homepage?: string;
  docs?: string;
  source: {
    /** `local`: a plain folder under the plugins dir that no source owns; nothing can update it. */
    kind: 'builtin' | 'git' | 'npm' | 'example' | 'linked' | 'local';
    url?: string;
    ref?: string;
    spec?: string;
    /** example: repo-relative dir. linked: the absolute plugin dir the link points at. */
    path?: string;
    /** linked only. */
    checkout?: string;
    branch?: string;
    sha?: string;
    remote?: string;
    dirty?: boolean;
    /** linked only: `checkout` with the home directory folded to `~` by the server. */
    checkoutDisplay?: string;
  };
  /** linked only: the registry's checkout scan ran out of budget before this row. */
  linkedScanSkipped?: boolean;
  installed: boolean;
  status: 'active' | 'disabled' | 'needs-config' | 'needs-dependency' | 'unsupported' | 'failed' | 'quarantined' | 'pending-restart' | 'available';
  state?: string;
  version?: string;
  builtin: boolean;
  capabilities?: string[];
  missingConfig?: string[];
  /** Which other plugins hold this row back, and what could be done about each. */
  missingDependencies?: MissingDependencyView[];
  dependencyPlan?: DependencyPlanItem[];
  blockedBy?: string[];
  reason?: string;
  error?: string;
  configurable: boolean;
  catalog: boolean;
  sourceSlug?: string;
  toggleable: boolean;
}

interface RegistryResponse {
  rows: RegistryRow[];
  installedCount: number;
  availableCount: number;
  sourcesUnavailable?: boolean;
  cloud?: boolean;
  /** The server's home directory, for folding checkout paths to `~` on the client. */
  homeDir?: string;
}

/** Only rows from one of these origins have an update state; built-in rows never do. */
const UPDATABLE_KINDS = new Set<RegistryRow['source']['kind']>(['linked', 'git', 'npm']);

/**
 * Rows that get an update chip: a linked checkout, a store source, or a plain folder the
 * registry's linked scan never reached (it may be a link; only a check can tell, C30). A
 * built-in and a plain `local` folder the scan DID reach have nothing to update from, so
 * they get no chip at all: a chip whose click can never answer is a dead control.
 */
const isUpdatableRow = (row: RegistryRow): boolean =>
  UPDATABLE_KINDS.has(row.source.kind) || row.linkedScanSkipped === true;

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

/** A git remote the local git can clone; anything else is treated as an npm spec. */
function looksLikeGitUrl(value: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)/.test(value);
}

/** One word per state, and the same word everywhere it appears. */
const ROW_STATUS: Record<RegistryRow['status'], { label: string; className: string }> = {
  active: { label: 'on', className: 'badge badge-done' },
  disabled: { label: 'off', className: 'badge badge-none' },
  'needs-config': { label: 'needs setup', className: 'badge badge-important' },
  'needs-dependency': { label: 'needs another plugin', className: 'badge badge-important' },
  unsupported: { label: 'needs newer Walnut', className: 'badge badge-none' },
  failed: { label: 'failed', className: 'badge badge-immediate' },
  quarantined: { label: 'quarantined', className: 'badge badge-immediate' },
  'pending-restart': { label: 'restart to activate', className: 'badge badge-important' },
  available: { label: 'not installed', className: 'badge badge-none' },
};
/** A state this build has no word for: say so, never assert "off" about it. */
const UNKNOWN_ROW_STATUS = { label: 'unknown', className: 'badge badge-none' };

/**
 * Where an installed plugin came from, in the user's terms: `Built in`, `Linked`,
 * `Local folder`, `git · host/owner/repo`, `npm · @acme/plugin`. Never a path, a slug or
 * a bare URL: the Provenance flyout next to it carries those.
 */
function originLabel(row: RegistryRow, source: PluginSource | undefined): string {
  if (row.builtin) return 'Built in';
  // What the plugin ADDS (`· sync`, `· adds Task sync`) is appended by the caller from the
  // manifest; the label names only where the code comes from.
  if (row.source.kind === 'linked') return 'Linked';
  if (row.source.kind === 'local') return 'Local folder';
  if (source) return sourceShortLabel(source);
  return sourceShortLabel({ kind: row.source.kind === 'npm' ? 'npm' : 'git', url: row.source.url, spec: row.source.spec });
}

/** The state a source's update row would carry from the server's `updated` answer. */
function updatedState(body: Record<string, unknown>): UpdateState {
  const state = body.state as UpdateState | undefined;
  if (state && typeof state.kind === 'string') return state;
  return { kind: 'current' };
}

/**
 * The state a 409 refusal proves: the server just saw the checkout dirty or diverged, so
 * the chip may say so before the next check. Falls back to the body's own counts.
 */
function refusedState(body: Record<string, unknown>): UpdateState | null {
  const state = body.state as UpdateState | undefined;
  if (state && (state.kind === 'dirty' || state.kind === 'diverged')) return state;
  if (body.code === 'dirty') return { kind: 'dirty', behind: typeof body.behind === 'number' ? body.behind : null };
  if (body.code === 'diverged') {
    return {
      kind: 'diverged',
      behind: typeof body.behind === 'number' ? body.behind : 1,
      ahead: typeof body.ahead === 'number' ? body.ahead : 1,
    };
  }
  return null;
}

/**
 * The home directory the flyout folds to `~`. The registry may say it outright; failing
 * that, a server-shortened `checkoutDisplay` (`~/code/x` for `/home/me/code/x`) implies it,
 * which also survives a realpath'd checkout under a symlinked home.
 */
function homeDirFor(source: RegistryRow['source'], homeDir: string | undefined): string | undefined {
  if (homeDir) return homeDir;
  const full = source.checkout ?? source.path;
  const display = source.checkoutDisplay;
  if (!full || !display || !display.startsWith('~')) return undefined;
  const tail = display.slice(1);
  return full.endsWith(tail) ? full.slice(0, full.length - tail.length) : undefined;
}

export function PluginStoreSection({ config, onSave }: Props) {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [sources, setSources] = useState<PluginSource[]>([]);
  const [url, setUrl] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // 'add' | plugin id | source slug
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);
  // Account links, by plugin id: which rows have one, and their latest state
  // (the row badge reads it; the panel under the row keeps it fresh).
  const [connections, setConnections] = useState<Record<string, ConnectionReport>>({});
  // What the last Update on a row said, keyed by row id (a plugin id, or `source-<slug>`
  // for a Sources card). Inline because it answers a question asked on that row; it never
  // expires on a timer (a collapsing line would move the row under the pointer), only the
  // row's next action, Check now, or leaving the section replaces it.
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  // Turning off a plugin others run on is refused (409) until the user has seen the list.
  const [cascadeAsk, setCascadeAsk] = useState<{ target: { id: string; name: string }; dependents: string[] } | null>(null);
  // What an install (or a blocked row's "Install…") turned out to need, and where to ask.
  // Nothing has been installed for it yet: this list IS the question.
  const [pending, setPending] = useState<
    { slug: string; plan: DependencyPlanItem[]; rowId?: string } | null
  >(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // One read at a time: a second call while one is in flight shares it. StrictMode mounts the
  // effect twice in development, which used to issue the registry GET twice in the same
  // millisecond (N3-18); a mid-flight change still gets its own read through the coalescer.
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const run = refreshOnce().finally(() => { refreshInFlight.current = null; });
    refreshInFlight.current = run;
    return run;
  }, []);
  async function refreshOnce() {
    // Independent reads: a plugin-sources (or connections) failure must not blank the plugin list.
    const [registryRes, sourcesRes, connectionsRes] = await Promise.allSettled([
      fetch('/api/plugin-runtime/registry'),
      fetch('/api/plugin-sources'),
      fetch('/api/integrations/connections'),
    ]);
    if (registryRes.status === 'fulfilled' && registryRes.value.ok) {
      try { setRegistry(await registryRes.value.json()); } catch { /* keep the last list */ }
    }
    if (sourcesRes.status === 'fulfilled' && sourcesRes.value.ok) {
      try { setSources(await sourcesRes.value.json()); } catch { /* keep the last list */ }
    }
    if (connectionsRes.status === 'fulfilled' && connectionsRes.value.ok) {
      try {
        const body = await connectionsRes.value.json() as { connections?: ConnectionReport[] };
        setConnections(Object.fromEntries((body.connections ?? []).map((c) => [c.pluginId, c])));
      } catch { /* keep the last map */ }
    }
  }

  // Every "reload the lists" signal (an action here, the plugins-changed event, a WS
  // runtime-changed per reloaded plugin) goes through ONE coalescer, so an Update costs one
  // registry read and one sources read, not four of each (N2-10).
  const coalesced = useRef<CoalescedRefresh | null>(null);
  if (!coalesced.current) coalesced.current = coalesceRefresh(refresh);
  const requestRefresh = useCallback(() => coalesced.current!.request(), []);

  const onConnectionReport = useCallback((report: ConnectionReport) => {
    setConnections((prev) => ({ ...prev, [report.pluginId]: report }));
  }, []);

  useEffect(() => {
    void refresh();
    // Refetch when a plugin config save activates a plugin, or when the store itself
    // changed something, so a status badge flips without a page reload.
    const onChanged = () => void requestRefresh();
    window.addEventListener(PLUGINS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(PLUGINS_CHANGED_EVENT, onChanged);
      coalesced.current?.cancel();
    };
  }, [refresh, requestRefresh]);

  // A change made anywhere else — another tab, the author CLI, a soft reload after an
  // install — arrives as this event, so the list is never stale-but-confident.
  useEvent('plugin:runtime-changed', () => { void requestRefresh(); });

  /** A plugin's display name. Ids belong in URLs, not in sentences a person reads. */
  const nameOf = (pluginId: string) =>
    registry?.rows.find((row) => row.id === pluginId)?.name ?? pluginId;

  // ── Update status ──
  // One GET for every updatable row, fired when the section MOUNTS, in parallel with the
  // registry read rather than serialised behind it (N3-18): it is cheap and cached, and the
  // chips settle as soon as the rows render. The hook owns caching, polling, offline and
  // re-check timing; built-in rows never take part.
  const updatable = (registry?.rows ?? []).filter((row) => row.installed && isUpdatableRow(row));
  const updates = usePluginUpdates();
  // The header says "Checking for updates…" only when the first GET is genuinely slow
  // (3 s); a normal load swaps the pending chips in without ever looking busy.
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    if (updates.loaded || updatable.length === 0) { setSlowLoad(false); return; }
    const timer = setTimeout(() => setSlowLoad(true), 3_000);
    return () => clearTimeout(timer);
  }, [updates.loaded, updatable.length]);
  /**
   * A row that IS (or may be) a linked checkout. When the registry's scan ran out of budget
   * it never looked at this row, so `source.kind` reads `local` with no slug;
   * `linkedScanSkipped` is the only trace, and the linked check route is the one that can
   * find out (C30).
   */
  const isLinkedRow = (row: RegistryRow): boolean => row.source.kind === 'linked' || row.linkedScanSkipped === true;

  /**
   * The update row shared by every plugin from one checkout, or one source's row. A linked
   * row the server has not keyed yet (its checkout scan was skipped) gets a private key so
   * a click on its chip can still check it; the real shared key takes over on the next GET.
   */
  const rowKeyFor = (row: RegistryRow): string | undefined =>
    updates.rowKeyOf[row.id]
      ?? (row.sourceSlug ? sourceRowKey(row.sourceSlug) : undefined)
      ?? (isLinkedRow(row) ? `linked:${row.id}` : undefined);

  /**
   * `undefined` is the pending placeholder (first GET not back yet); a row the server is
   * still checking shows Checking; once the batch is over, a row it has no entry for is
   * `unchecked`, with the scan-budget note when the registry admits it skipped this checkout.
   */
  const stateFor = (row: RegistryRow, rowKey: string | undefined): UpdateState | undefined => resolveRowState({
    known: rowKey ? updates.rows[rowKey]?.state : undefined,
    loaded: updates.loaded,
    refreshing: updates.refreshing,
    scanSkipped: row.linkedScanSkipped === true,
  });

  /** Display names of the OTHER installed plugins served from the same checkout (N3-4). */
  const siblingNamesOf = (row: RegistryRow, rowKey: string | undefined): string[] => {
    if (!rowKey || !isLinkedRow(row)) return [];
    return installed
      .filter((other) => other.id !== row.id && isLinkedRow(other) && rowKeyFor(other) === rowKey)
      .map((other) => other.name)
      .sort((a, b) => a.localeCompare(b));
  };

  const setRowFeedback = (rowId: string, next: Feedback | null) => {
    setFeedback((prev) => {
      const copy = { ...prev };
      if (next) copy[rowId] = next; else delete copy[rowId];
      return copy;
    });
  };

  /**
   * Rows whose Update was pressed and is still running. Busy is per row KEY (siblings of
   * one checkout share it), but the `Updating…` label belongs to the pressed row only.
   */
  const [pressedRows, setPressedRows] = useState<Record<string, true>>({});
  const markPressed = (rowId: string, on: boolean) => {
    setPressedRows((prev) => {
      if (on ? prev[rowId] : !prev[rowId]) return prev;
      const copy = { ...prev };
      if (on) copy[rowId] = true; else delete copy[rowId];
      return copy;
    });
  };

  /** Header Check now: every row's feedback goes with it, the chips flip to Checking. */
  const checkAll = () => {
    setFeedback({});
    void updates.checkAll();
  };

  /** Chip click: re-check ONE row (and its checkout siblings, which share the row key). */
  const checkRow = (rowKey: string, row: RegistryRow, feedbackId: string) => {
    setRowFeedback(feedbackId, null);
    const target = isLinkedRow(row)
      ? { kind: 'linked' as const, pluginId: row.id }
      : { kind: 'source' as const, slug: row.sourceSlug ?? rowKey.replace(/^source:/, '') };
    void updates.checkRow(rowKey, target);
  };

  const handleAdd = async () => {
    const value = url.trim();
    if (!value || !trusted) return;
    setBusy('add');
    setError(null);
    setNotice(null);
    try {
      // A share snippet is JSON and a git remote has a scheme; everything else
      // goes to the npm path so the error message is about the right thing.
      const isSnippet = value.startsWith('{');
      const payload = isSnippet || looksLikeGitUrl(value) ? { url: value } : { spec: value };
      const res = await fetch('/api/plugin-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setUrl('');
      setTrusted(false); // trust is granted per install, never sticky
      const count = body.plugins?.length ?? 0;
      const what = body.resolved ? ` (${body.resolved})` : '';
      // Only this source was installed. Anything its plugins need is a second question.
      const plan = (body.pendingDependencies ?? []) as DependencyPlanItem[];
      setPending(plan.length > 0 && body.slug ? { slug: body.slug as string, plan } : null);
      setNotice(count > 0
        ? `Added${what}: found ${count} plugin${count === 1 ? '' : 's'}. New plugins are active now; use Configure on a row that needs setup.`
        : `Added${what}, but no plugins found (no manifest.json at the root or in top-level folders).`);
      // The new row needs a chip without a click: one passive GET now (the server checks
      // the new source in the background and the hook polls until it settles).
      updates.reload();
      emitPluginsChanged();
      await requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Update (or Restore) one source. The result lands on the row that was pressed as a
   * feedback line, and the shared update row flips so every chip for this slug (the
   * Installed row and the Sources card) agrees. A restart is said ONCE, on the row: the
   * badge already reads RESTART TO ACTIVATE, so there is no page banner for it.
   */
  const handleUpdate = async (slug: string, kind: 'git' | 'npm', feedbackId: string) => {
    const rowKey = sourceRowKey(slug);
    updates.setBusy(rowKey, 'updating');
    markPressed(feedbackId, true);
    setRowFeedback(feedbackId, null);
    setError(null);
    try {
      const res = await fetch(`/api/plugin-sources/${encodeURIComponent(slug)}/update`, { method: 'POST' });
      const body = await res.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
      if (!res.ok) {
        setRowFeedback(feedbackId, failureFeedback(res.status, body, `HTTP ${res.status}`));
        return;
      }
      // Feedback, chip and button flip in ONE render (N2-6): the row state and the end of
      // busy are set together as the POST resolves, and the list reload runs after.
      setRowFeedback(feedbackId, successFeedback(kind, body, nameOf));
      const checkedAt = typeof body.checkedAt === 'string' ? body.checkedAt : new Date().toISOString();
      const previous: UpdateStatusRow | undefined = updates.rows[rowKey];
      updates.applyRow(rowKey, { ...previous, state: updatedState(body), checkedAt }, checkedAt);
      updates.setBusy(rowKey, null);
      markPressed(feedbackId, false);
      // A Restore brings a row back into the list; the rowKeyOf map has to learn it.
      if (previous?.state.kind === 'missing') updates.reload();
      if (body.updated) emitPluginsChanged();
      await requestRefresh();
    } catch (err) {
      setRowFeedback(feedbackId, failureFeedback(0, null, err instanceof Error ? err.message : String(err)));
    } finally {
      updates.setBusy(rowKey, null);
      markPressed(feedbackId, false);
    }
  };

  /**
   * Fast-forward a linked checkout and reload what runs from it. Refused with 409 when the
   * tree is dirty or the branch has diverged: the chip takes that state (the server just
   * saw it) and the row says why in one sentence; neither is an error to retry. Siblings
   * from the same checkout share the row key, so their chips flip together, but only the
   * pressed row gets the feedback line.
   */
  const handleLinkedUpdate = async (row: RegistryRow, rowKey: string) => {
    updates.setBusy(rowKey, 'updating');
    markPressed(row.id, true);
    setRowFeedback(row.id, null);
    setError(null);
    const stamp = (body: Record<string, unknown>) =>
      typeof body.checkedAt === 'string' ? body.checkedAt : new Date().toISOString();
    try {
      const res = await fetch(`/api/plugin-runtime/${encodeURIComponent(row.id)}/linked/update`, { method: 'POST' });
      const body = await res.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
      if (!res.ok) {
        setRowFeedback(row.id, failureFeedback(res.status, body, `HTTP ${res.status}`));
        // Any other failure leaves the chip exactly as it was: nothing was changed.
        const refused = res.status === 409 ? refusedState(body) : null;
        if (refused) {
          const checkedAt = stamp(body);
          updates.applyRow(rowKey, { ...updates.rows[rowKey], state: refused, checkedAt }, checkedAt);
        }
        return;
      }
      // One render for feedback, chip and button (N2-6); the reload of the lists follows.
      setRowFeedback(row.id, successFeedback('linked', body, nameOf));
      const checkedAt = stamp(body);
      updates.applyRow(rowKey, { ...updates.rows[rowKey], state: updatedState(body), checkedAt }, checkedAt);
      updates.setBusy(rowKey, null);
      markPressed(row.id, false);
      if (((body.reloaded ?? []) as string[]).length > 0) emitPluginsChanged();
      await requestRefresh();
    } catch (err) {
      setRowFeedback(row.id, failureFeedback(0, null, err instanceof Error ? err.message : String(err)));
    } finally {
      updates.setBusy(rowKey, null);
      markPressed(row.id, false);
    }
  };

  const handleRemove = async (slug: string) => {
    setBusy(slug);
    setError(null);
    try {
      const res = await fetch(`/api/plugin-sources/${slug}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.restartRequired) setRestartNeeded(true);
      updates.reload();
      emitPluginsChanged();
      await requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * ON goes through `reload` and OFF through `disable` — both write the `enabled`
   * flag to config.yaml first, which is what makes the switch survive a restart.
   *
   * OFF can be refused with 409 `has-dependents` while other plugins run on this one.
   * That is not an error to show: it is a question, so it opens the confirmation under
   * the row and the same call is repeated with `cascade` once the user agrees.
   */
  const handleToggle = async (
    row: { id: string; name: string },
    next: boolean,
    { cascade = false, busyKey }: { cascade?: boolean; busyKey?: string } = {},
  ) => {
    // A dependency's "Turn on" lives on ANOTHER row, so it owns its own busy key and only
    // that button goes disabled for the round trip.
    setBusy(busyKey ?? row.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/plugin-runtime/${encodeURIComponent(row.id)}/${next ? 'reload' : 'disable'}`,
        cascade
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cascade: true }) }
          : { method: 'POST' },
      );
      const body = await res.json().catch(() => ({} as { error?: string; code?: string; dependents?: string[] }));
      if (res.status === 409 && body.code === 'has-dependents') {
        setCascadeAsk({ target: row, dependents: body.dependents ?? [] });
        return;
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setCascadeAsk(null);
      setNotice(next
        ? `${row.name} is on.`
        : cascade
          ? `${row.name} is off, and everything that runs on it is waiting for it. Turn it back on and they come back.`
          : `${row.name} is off. It stays off until you turn it back on.`);
      emitPluginsChanged();
      await requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Install the dependencies of one source, AFTER the consent list was shown. Never
   * called straight from a row's button: the panel that lists the source URLs is the only
   * caller, because a catalog entry is not the user's consent to run its code.
   */
  const installDependencies = async (slug: string, busyKey: string) => {
    setBusy(busyKey);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/plugin-sources/${encodeURIComponent(slug)}/dependencies`, { method: 'POST' });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const added = (body.installed ?? []) as Array<{ id: string; action?: string }>;
      const skipped = (body.skipped ?? []) as Array<
        { id: string; reason: string; command?: string; state?: string; error?: string }
      >;
      setPending(null);
      setNotice([
        added.length > 0
          ? `Installed ${added.map((entry) => nameOf(entry.id)).join(', ')}.`
          : 'Nothing was installed.',
        ...skipped.map((entry) => entry.command
          ? `${nameOf(entry.id)} has to be linked by hand: ${entry.command}`
          : `${nameOf(entry.id)} was skipped (${entry.error ?? entry.state ?? entry.reason}).`),
      ].join(' '));
      emitPluginsChanged();
      await requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** Turn on a dependency that is already on this machine: the same path as its switch. */
  const turnOnDependency = (rowId: string, item: DependencyPlanItem) => handleToggle(
    { id: item.id, name: nameOf(item.id) },
    true,
    { busyKey: dependencyBusyKey(rowId, item.id) },
  );

  const handleClearQuarantine = async (row: RegistryRow) => {
    setBusy(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/plugin-runtime/${encodeURIComponent(row.id)}/clear-quarantine`, { method: 'POST' });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      emitPluginsChanged();
      await requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** Catalog → the existing install form. Trust is deliberately NOT pre-ticked. */
  const prefillSource = (source: RegistryRow['source'] | undefined, label: string) => {
    setUrl(source?.kind === 'npm' ? source.spec ?? label : source?.url ?? '');
    setError(null);
    setNotice(`Ready to install ${label}. Tick the trust box, then press Add.`);
    urlInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    urlInputRef.current?.focus();
  };

  const prefillInstall = (row: RegistryRow) => prefillSource(row.source, row.name);

  const copy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedSlug(key);
    setTimeout(() => setCopiedSlug(null), 2000);
  };

  const rows = registry?.rows ?? [];
  const installed = rows.filter((row) => row.installed);
  // Slugs whose Installed row owns the Update verb. A source whose files are gone
  // (`missing`) is not owned: its row may still be loaded from memory, but the thing to
  // restore is the source, so the Sources card carries Restore (N2-3).
  const ownedSlugs = new Set(installed
    .map((row) => row.sourceSlug)
    .filter((slug): slug is string => Boolean(slug) && updates.rows[sourceRowKey(slug!)]?.state.kind !== 'missing'));
  const available = rows.filter((row) => !row.installed);

  return (
    <SettingsSection
      id="plugin-store"
      title="Plugins"
      description="Everything installed on this machine, what each one adds, and a switch for each. Install more from a git repository or an npm package."
    >
      {/* Only Remove needs a page-level word: no row survives to carry the badge. An
          update says "restart" on its own row (feedback + RESTART TO ACTIVATE), once. */}
      {restartNeeded && (
        <SettingsNotice kind="warn">Restart Walnut to finish removing that plugin&apos;s code.</SettingsNotice>
      )}
      {error && <SettingsNotice kind="error">{error}</SettingsNotice>}
      {notice && <SettingsNotice kind="success">{notice}</SettingsNotice>}

      {/* This section is the start point for everything plugin-shaped, and the
          simplest way in leads: describe a plugin, click, and a session builds it. */}
      <BuildPluginCard />

      {/* ── Installed ── */}
      <div className="plugin-store-group plugin-store-installed" data-testid="plugin-store-installed">
        <div className="plugin-store-group-head">
          <h4 className="settings-subcard-title">Installed</h4>
          <span className="plugin-store-count">{installed.length}</span>
          {/* Only when something here CAN be updated: a list of built-ins has no
              "Not checked yet" to report. */}
          {updatable.length > 0 && <UpdatesHead updates={updates} slowLoad={slowLoad} onCheckAll={checkAll} />}
        </div>
        {installed.length === 0 ? (
          <SettingsEmpty>
            {registry ? 'No plugins on this machine yet.' : 'Loading plugins…'}
          </SettingsEmpty>
        ) : (
          <div className="settings-row-list">
            {installed.map((row) => {
              const status = ROW_STATUS[row.status] ?? UNKNOWN_ROW_STATUS;
              // A plugin whose files an update replaced is STILL running its old code: the
              // switch stays on next to the RESTART TO ACTIVATE badge (N7).
              const isOn = row.status === 'active' || row.state === RESTART_PENDING_STATE;
              // Never auto-open. In a LIST, expanding an eight-field form on mount
              // buries every row under it — the row already says NEEDS SETUP, names
              // the missing field, and offers Configure.
              const open = configuring === row.id;
              const connection = connections[row.id];
              // Only when the account needs the human: a healthy link says so on
              // the panel below, not as a second "on" badge in the title.
              const connectionBadge = connection && connection.state !== 'connected'
                ? CONNECTION_BADGE[connection.state] : null;
              // Update status: one shared row per checkout or source; built-ins have none.
              const isUpdatable = isUpdatableRow(row);
              const rowKey = isUpdatable ? rowKeyFor(row) : undefined;
              const updateRow = rowKey ? updates.rows[rowKey] : undefined;
              const updateState = isUpdatable ? stateFor(row, rowKey) : undefined;
              const rowBusy = rowKey ? updates.busy[rowKey] : undefined;
              const updating = rowBusy === 'updating';
              // A replica reads the Mac's checkouts and cannot touch them: static chip, no verbs.
              const cloudLinked = Boolean(registry?.cloud) && row.source.kind === 'linked';
              const source = row.sourceSlug ? sources.find((entry) => entry.slug === row.sourceSlug) : undefined;
              const sourceKind: 'git' | 'npm' = row.source.kind === 'npm' || source?.kind === 'npm' ? 'npm' : 'git';
              // A source whose clone is gone (`missing`) is restored from its Sources card,
              // which owns Restore; this row keeps the chip and reserves the button's space.
              const buttonMode = isUpdatable && !cloudLinked && updateState?.kind !== 'missing'
                ? updateButtonMode(updateState, rowBusy, Boolean(pressedRows[row.id]), { siblingNames: siblingNamesOf(row, rowKey) })
                : { render: false as const };
              return (
                <div key={row.id} className="plugin-store-entry">
                  <SettingsRow
                    data-testid={`plugin-row-${row.id}`}
                    data-plugin-status={row.status}
                    actions={(
                      <>
                        {row.configurable && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            data-testid={`plugin-configure-${row.id}`}
                            disabled={updating}
                            onClick={() => setConfiguring(open ? null : row.id)}
                          >
                            {open ? 'Done' : 'Configure'}
                          </button>
                        )}
                        {row.status === 'quarantined' && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy === row.id}
                            onClick={() => void handleClearQuarantine(row)}
                          >
                            Clear quarantine
                          </button>
                        )}
                        {/* The ONE update verb. Rendered only when there is something to do
                            (available, missing), or disabled with its reason when a local
                            state blocks it; an up-to-date row shows nothing here, the chip
                            already answered. Remove and the switch stay live while it runs:
                            updating is not deleting. */}
                        {isUpdatable && !cloudLinked && (
                          <PluginUpdateButton
                            rowId={row.id}
                            mode={buttonMode}
                            onClick={() => (isLinkedRow(row) && rowKey
                              ? void handleLinkedUpdate(row, rowKey)
                              : void handleUpdate(row.sourceSlug!, sourceKind, row.id))}
                          />
                        )}
                        {row.sourceSlug && (
                          <button
                            type="button"
                            className="btn-danger-outline btn-sm"
                            disabled={busy === row.sourceSlug}
                            onClick={() => void handleRemove(row.sourceSlug!)}
                          >
                            Remove
                          </button>
                        )}
                        {/* needs-config, needs-dependency, unsupported and quarantined are
                            refused by the plugin manager itself, so a switch would flip straight back.
                            Those rows carry their reason in the copy on the left and
                            whatever action can actually help on the right, so nothing
                            is repeated here. */}
                        {row.toggleable && (
                          <ToggleSwitch
                            id={`plugin-toggle-${row.id}`}
                            checked={isOn}
                            onChange={(next) => void handleToggle(row, next)}
                          />
                        )}
                      </>
                    )}
                  >
                    <strong>
                      {row.name}
                      <span className={status.className}>{status.label}</span>
                      {connectionBadge && (
                        <span className={connectionBadge.className} data-testid={`plugin-row-connection-${row.id}`}>
                          {connectionBadge.label}
                        </span>
                      )}
                      {row.version && <span className="plugin-store-version">v{row.version}</span>}
                      {/* "Is it current?" sits on the title line next to "is it running?":
                          the eye scans titles, and the two badges are styled apart (solid
                          pill vs outline chip). Pending until the first GET answers. */}
                      {isUpdatable && (
                        <PluginUpdateChip
                          rowId={row.id}
                          state={updateState}
                          checkedAt={updateRow?.checkedAt ?? null}
                          busy={rowBusy}
                          transient={updateRow?.transient}
                          toRef={updateRow?.target?.toRef}
                          offline={updates.offline}
                          isStatic={cloudLinked}
                          staticTitle={cloudLinked ? CLOUD_LINKED_NOTE : undefined}
                          onCheck={rowKey && !cloudLinked ? () => checkRow(rowKey, row, row.id) : undefined}
                        />
                      )}
                    </strong>
                    {row.description && <span>{row.description}</span>}
                    <span className="plugin-store-origin">
                      {originLabel(row, source)}
                      {row.adds?.length ? ` · adds ${row.adds.join(', ')}` : ''}
                      {!row.adds?.length && row.capabilities?.length ? ` · ${row.capabilities.join(', ')}` : ''}
                      {/* Where the code really runs from, one click away and never inline:
                          a path, a branch and a sha are answers to a question rarely asked. */}
                      {row.source.kind === 'linked' && (
                        <PluginProvenanceFlyout
                          rowId={row.id}
                          kind="linked"
                          rows={{
                            checkout: row.source.checkout ?? row.source.path ?? '',
                            branch: row.source.branch ?? 'HEAD',
                            sha: row.source.sha ?? '',
                            remote: row.source.remote,
                          }}
                          homeDir={homeDirFor(row.source, registry?.homeDir)}
                          checkedAt={updateRow?.checkedAt ?? null}
                        />
                      )}
                      {row.source.kind !== 'linked' && row.sourceSlug && (
                        <PluginProvenanceFlyout
                          rowId={row.id}
                          kind="source"
                          rows={sourceProvenance(row.sourceSlug, sourceKind, source, row.source)}
                          checkedAt={updateRow?.checkedAt ?? null}
                        />
                      )}
                    </span>
                    {/* The result of the row's last action. Nothing here at rest: no fourth line. */}
                    {isUpdatable && (
                      <PluginUpdateFeedback rowId={row.id} feedback={feedback[row.id]} />
                    )}
                    {/* A blocked row says which plugin it waits for and offers the one
                        thing that can fix it; every other non-active row keeps the
                        server's own sentence. */}
                    {row.status === 'needs-dependency' ? (
                      <PluginDependencyNeeds
                        rowId={row.id}
                        missing={row.missingDependencies}
                        plan={row.dependencyPlan}
                        busyKey={busy}
                        copiedKey={copiedSlug}
                        nameFor={nameOf}
                        // "Install…" ASKS: it opens the consent list for this source (every
                        // URL it would add) instead of cloning on one click. Without a
                        // source of its own, the row falls back to the ordinary install
                        // form, which still has its own trust tick.
                        onInstall={(item) => {
                          if (row.sourceSlug) {
                            setError(null);
                            setNotice(null);
                            setPending({ slug: row.sourceSlug, plan: row.dependencyPlan ?? [], rowId: row.id });
                          } else prefillSource(item.source as RegistryRow['source'], nameOf(item.id));
                        }}
                        onTurnOn={(item) => void turnOnDependency(row.id, item)}
                        onCopy={copy}
                      />
                    ) : row.status !== 'active' && (row.reason || row.error) ? (
                      <span className="plugin-store-why">{row.error ?? row.reason}</span>
                    ) : null}
                  </SettingsRow>
                  {/* Names sorted for reading: the server returns teardown order, which is
                      the reverse of the order a list of names wants to be in. */}
                  {cascadeAsk?.target.id === row.id && (
                    <PluginCascadeConfirm
                      name={row.name}
                      dependents={cascadeAsk.dependents.map(nameOf).sort((a, b) => a.localeCompare(b))}
                      busy={busy === row.id}
                      onConfirm={() => void handleToggle(row, false, { cascade: true })}
                      onCancel={() => setCascadeAsk(null)}
                    />
                  )}
                  {/* The consent list for THIS row's dependencies, where the question was
                      asked. Same component the install form uses. */}
                  {pending?.rowId === row.id && (
                    <div className="plugin-store-config">
                      <PluginPendingDependencies
                        plan={pending.plan}
                        busy={busy === `pending:${pending.slug}`}
                        nameFor={nameOf}
                        onInstall={() => void installDependencies(pending.slug, `pending:${pending.slug}`)}
                        onDismiss={() => setPending(null)}
                      />
                    </div>
                  )}
                  {/* The plugin's app entries live HERE, on the plugin itself —
                      an app is not a separate thing to manage on another panel. */}
                  <PluginAppControls pluginId={row.id} />
                  {/* The account link lives on the row too, always visible: whether
                      the credential is alive is the first thing to check when sync
                      looks off, and it must not hide behind Configure. */}
                  {connection && isOn && (
                    <PluginConnectionPanel pluginId={row.id} initial={connection} onReport={onConnectionReport} />
                  )}
                  {open && row.configurable && (
                    <div className="plugin-store-config" data-testid={`plugin-config-${row.id}`}>
                      <PluginConfigCards config={config} onSave={onSave} onlyIds={[row.id]} bare />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Available ── */}
      {available.length > 0 && (
        <div className="plugin-store-group" data-testid="plugin-store-available">
          <div className="plugin-store-group-head">
            <h4 className="settings-subcard-title">Available</h4>
            <span className="plugin-store-count">{available.length}</span>
          </div>
          <div className="settings-row-list">
            {available.map((row) => (
              <SettingsRow
                key={row.id}
                data-testid={`plugin-row-${row.id}`}
                data-plugin-status={row.status}
                actions={(
                  <>
                    {row.homepage && (
                      <a
                        className="btn btn-secondary btn-sm"
                        href={row.homepage}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Read more
                      </a>
                    )}
                    {(row.source.kind === 'git' || row.source.kind === 'npm') && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        data-testid={`plugin-install-${row.id}`}
                        onClick={() => prefillInstall(row)}
                      >
                        Install…
                      </button>
                    )}
                    {row.source.kind === 'example' && row.source.path && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => copy(`walnut-plugin link ${row.source.path}`, `example:${row.id}`)}
                      >
                        {copiedSlug === `example:${row.id}` ? 'Copied ✓' : 'Copy link command'}
                      </button>
                    )}
                  </>
                )}
              >
                <strong>
                  {row.name}
                  <span className={ROW_STATUS.available.className}>{ROW_STATUS.available.label}</span>
                </strong>
                {row.description && <span>{row.description}</span>}
                <span>
                  {row.source.kind === 'builtin'
                    ? 'Ships with Walnut, but not present in this build'
                    : row.source.kind === 'example'
                      ? `In this checkout at ${row.source.path} · install it with walnut-plugin link`
                      : row.source.kind === 'npm'
                        ? `npm · ${row.source.spec ?? row.id}`
                        : `git · ${row.source.url ?? ''}`}
                  {row.adds?.length ? ` · adds ${row.adds.join(', ')}` : ''}
                </span>
                {/* What installing it would ALSO pull in, before anything is added. */}
                <PluginAlsoNeeds
                  rowId={row.id}
                  plan={row.dependencyPlan}
                  blockedBy={row.blockedBy}
                  nameFor={nameOf}
                />
              </SettingsRow>
            ))}
          </div>
        </div>
      )}

      {/* ── The free-form install path, for anything the catalog does not list ── */}
      <SettingsSubCard
        title="Install from a git repository or an npm package"
        description="A repo can hold one plugin (manifest.json at the root) or several (one folder per plugin); an npm package holds one, at its root."
      >
        <div className="form-group">
          <label htmlFor="plugin-source-url">Git URL or npm package</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="plugin-source-url"
              ref={urlInputRef}
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
              placeholder="git URL, npm package (name, name@1.2.3, @scope/name), or a teammate's share snippet"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy === 'add' || !url.trim() || !trusted}
              onClick={() => void handleAdd()}
            >
              {busy === 'add' ? 'Installing…' : 'Add'}
            </button>
          </div>
          <p className="text-xs text-muted" style={{ marginTop: 2 }}>
            Git uses your machine&apos;s git (ssh keys / credential helpers), so any remote your shell can clone works.
            npm disables lifecycle scripts, pins an exact version, and verifies the installed tarball receipt.
            Neither kind ever updates itself: you press Update.
          </p>
          {/* Its own class because `.form-group label` UPPERCASES everything, and this
              is the one sentence on the page that has to be read, not skimmed. */}
          <label
            htmlFor="plugin-trust-confirm"
            className="text-xs plugin-trust-label"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 6 }}
          >
            <input
              id="plugin-trust-confirm"
              data-testid="plugin-trust-confirm"
              type="checkbox"
              checked={trusted}
              onChange={e => setTrusted(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              I trust this source. Its code runs inside Walnut with full access to my tasks, notes,
              credentials and this machine.
            </span>
          </label>
          {/* Phase two of the install: the plugin that just arrived needs another one.
              This list names every source it would add, and it is the consent for them —
              nothing is installed until the button below is pressed. */}
          {pending && !pending.rowId && (
            <div style={{ marginTop: 10 }}>
              <PluginPendingDependencies
                plan={pending.plan}
                busy={busy === `pending:${pending.slug}`}
                nameFor={nameOf}
                onInstall={() => void installDependencies(pending.slug, `pending:${pending.slug}`)}
                onDismiss={() => setPending(null)}
              />
            </div>
          )}
        </div>
      </SettingsSubCard>

      {/* ── Sources ── a source is not a plugin: one repo can carry several, and it is the
          source that gets updated or removed, so it keeps its own list below the plugins. */}
      <PluginSourcesGroup
        sources={sources}
        ownedSlugs={ownedSlugs}
        updates={updates}
        busy={busy}
        copiedKey={copiedSlug}
        feedback={feedback}
        onCopy={copy}
        onUpdate={(slug, kind, feedbackId) => void handleUpdate(slug, kind, feedbackId)}
        onRemove={(slug) => void handleRemove(slug)}
        setRowFeedback={setRowFeedback}
      />

      {registry?.sourcesUnavailable && !registry.cloud && (
        <p className="text-xs text-muted">
          Could not read the installed-source list, so Update and Remove are unavailable on this view.
        </p>
      )}
      {registry?.cloud && (
        <p className="text-xs text-muted">
          Read from your Mac over the bridge. Installing and removing plugin sources happens on the Mac.
        </p>
      )}

    </SettingsSection>
  );
}
