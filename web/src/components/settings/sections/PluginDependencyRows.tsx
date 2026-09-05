/**
 * The dependency half of Settings → Plugins: the copy that says what a row is waiting
 * for, and the ONE action that can do something about it.
 *
 * Its own file because the store section owns the fetching and this owns the wording,
 * and because the wording is where the honesty lives:
 *
 *   - A row never gets a button that cannot work. `example` sources are installed by hand
 *     with `walnut-plugin link`, and a dependency nothing can supply gets copy only.
 *   - "Install Alpha…" ASKS. It opens the consent list (every source URL it would add)
 *     instead of cloning on the first click, because the catalog that names those URLs is
 *     a user-writable file and one click must never be enough to run someone's code.
 *   - "Turn on Alpha" is the only one-click action here: no new code arrives, it is the
 *     same switch the row above has, and it is only offered where the plugin manager
 *     would actually accept the activation.
 *   - Every label uses the plugin's display name, and every test id carries the ROW it
 *     belongs to, since two rows can wait on the same plugin.
 */
import type { ReactNode } from 'react';

export interface DependencySource {
  kind: 'builtin' | 'git' | 'npm' | 'example';
  url?: string;
  ref?: string;
  spec?: string;
  path?: string;
}

/** Mirrors PluginDependencyPlanItem in src/core/plugins/plugin-catalog.ts. */
export interface DependencyPlanItem {
  id: string;
  range: string;
  resolvable: 'installed' | 'catalog' | 'none';
  source?: DependencySource;
  /** The version that IS here and does not fit the range. */
  found?: string;
}

/** Mirrors MissingDependency in src/core/plugins/plugin-manager.ts. */
export interface MissingDependencyView {
  id: string;
  range: string;
  found?: string;
  reason: string;
  note: string;
}

/** `walnut-plugin link examples/plugins/alpha` — the only way an example arrives. */
export function linkCommandFor(item: DependencyPlanItem): string {
  return `walnut-plugin link ${item.source?.path ?? item.id}`;
}

/** Where an install would pull it from, in the user's terms. */
export function sourceLabel(source?: DependencySource): string {
  if (!source) return 'this machine';
  if (source.kind === 'npm') return `npm ${source.spec ?? ''}`.trim();
  if (source.kind === 'git') return source.url ?? 'a git repository';
  if (source.kind === 'example') return source.path ?? 'this checkout';
  return 'Walnut itself';
}

/** The busy key one dependency action owns, so a second click cannot start a second one. */
export function dependencyBusyKey(rowId: string, dependencyId: string): string {
  return `dep:${rowId}:${dependencyId}`;
}

/**
 * `Alpha ^2 (found 1.2.0)` — the version only where it is the PROBLEM. Printing "(found
 * 1.0.0)" for a plugin that is merely switched off reads as a version complaint about a
 * version that is fine.
 */
function headline(name: string, range: string, found?: string): string {
  return `${name} ${range}${found ? ` (found ${found})` : ''}`;
}

interface ActionProps {
  rowId: string;
  busyKey: string | null;
  copiedKey: string | null;
  nameFor(pluginId: string): string;
  onInstall(item: DependencyPlanItem): void;
  onTurnOn(item: DependencyPlanItem): void;
  onCopy(text: string, key: string): void;
}

/** The one action a plan item allows, or nothing at all. */
function DependencyAction({
  item,
  rowId,
  busyKey,
  copiedKey,
  nameFor,
  onInstall,
  onTurnOn,
  onCopy,
}: ActionProps & { item: DependencyPlanItem }): ReactNode {
  if (item.resolvable === 'catalog' && item.source?.kind === 'example') {
    const command = linkCommandFor(item);
    const key = `dep-link:${rowId}:${item.id}`;
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        data-testid={`plugin-dependency-copy-${rowId}-${item.id}`}
        onClick={() => onCopy(command, key)}
      >
        {copiedKey === key ? 'Copied ✓' : `Copy: ${command}`}
      </button>
    );
  }
  if (item.resolvable === 'catalog') {
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        data-testid={`plugin-dependency-install-${rowId}-${item.id}`}
        onClick={() => onInstall(item)}
      >
        Install {nameFor(item.id)}…
      </button>
    );
  }
  if (item.resolvable === 'installed') {
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={busyKey === dependencyBusyKey(rowId, item.id)}
        data-testid={`plugin-dependency-turn-on-${rowId}-${item.id}`}
        onClick={() => onTurnOn(item)}
      >
        {busyKey === dependencyBusyKey(rowId, item.id)
          ? 'Turning on…'
          : `Turn on ${nameFor(item.id)}`}
      </button>
    );
  }
  return null;
}

/**
 * An installed row that is blocked: one line per dependency naming it and why, plus
 * whatever can fix it. The note comes from the server (it knows whether the version is
 * wrong, the plugin is off, or the pair is in a cycle); the compact form is the fallback
 * for a plan item the loader has no note for.
 */
export function PluginDependencyNeeds({
  missing,
  plan,
  ...actions
}: ActionProps & { missing?: MissingDependencyView[]; plan?: DependencyPlanItem[] }) {
  const notes = new Map((missing ?? []).map((dep) => [dep.id, dep]));
  // Every dependency gets a line: the ones with a plan first, then anything the loader
  // reported that the plan had nothing to say about.
  const items: DependencyPlanItem[] = [
    ...(plan ?? []),
    ...(missing ?? [])
      .filter((dep) => !(plan ?? []).some((item) => item.id === dep.id))
      .map((dep) => ({ id: dep.id, range: dep.range, resolvable: 'none' as const })),
  ];
  if (items.length === 0) return null;
  return (
    <div
      className="plugin-store-why"
      data-testid={`plugin-dependency-needs-${actions.rowId}`}
      style={{ display: 'grid', gap: 4 }}
    >
      {items.map((item) => {
        const note = notes.get(item.id);
        // A version this range cannot accept is the one case where the version belongs in
        // the headline; `inactive` says "turned off", which is not a version story.
        const found = note?.reason === 'version' || note?.reason === 'unversioned'
          ? note.found
          : item.found;
        return (
          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>Needs {headline(actions.nameFor(item.id), item.range, found)}</span>
            {note && <span className="text-xs text-muted">· {note.note}</span>}
            <DependencyAction item={item} {...actions} />
          </div>
        );
      })}
    </div>
  );
}

/** An available row: what installing it would ALSO pull in, before anything is added. */
export function PluginAlsoNeeds({
  rowId,
  plan,
  blockedBy,
  nameFor,
}: {
  rowId: string;
  plan?: DependencyPlanItem[];
  blockedBy?: string[];
  nameFor(pluginId: string): string;
}) {
  if (!plan?.length) return null;
  const blocked = new Set(blockedBy ?? []);
  return (
    <span className="plugin-store-why" data-testid={`plugin-also-needs-${rowId}`}>
      {/* The range is noise until it is the problem: name the plugin, and add the range
          plus the version in the way only when a copy that is HERE cannot satisfy it. */}
      Also needs: {plan.map((item) => (item.found
        ? `${nameFor(item.id)} ${item.range} (have ${item.found})`
        : nameFor(item.id))).join(', ')}
      {plan.filter((item) => blocked.has(item.id)).map((item) => (
        <span key={item.id} className="text-xs text-muted" style={{ marginLeft: 6 }}>
          {item.resolvable === 'none'
            ? `${nameFor(item.id)} cannot be installed from here`
            : `${nameFor(item.id)} lives in this checkout: run ${linkCommandFor(item)}`}
        </span>
      ))}
    </span>
  );
}

/**
 * The consent list. Every dependency that would be installed, with the exact source it
 * would come from, and one button that names them all.
 *
 * This IS the trust step for dependencies (the store's per-install tick covers the source
 * the user typed, not the ones a catalog file names), so it is the only path from a row to
 * an install, and nothing here has been installed yet.
 */
export function PluginPendingDependencies({
  plan,
  busy,
  nameFor,
  onInstall,
  onDismiss,
}: {
  plan: DependencyPlanItem[];
  busy: boolean;
  nameFor(pluginId: string): string;
  onInstall(): void;
  onDismiss(): void;
}) {
  const actionable = plan.filter((item) => item.resolvable !== 'none'
    && !(item.resolvable === 'catalog' && item.source?.kind === 'example'));
  return (
    <div
      className="settings-collapsible"
      data-testid="plugin-pending-dependencies"
      style={{ padding: '10px 12px', display: 'grid', gap: 6 }}
    >
      <strong>Also install: {plan.map((item) => nameFor(item.id)).join(', ')}</strong>
      {plan.map((item) => (
        <span key={item.id} className="text-xs text-muted">
          {nameFor(item.id)} {item.range} · {sourceLabel(item.source)}
          {item.resolvable === 'none' ? ' · not available here' : ''}
          {item.resolvable === 'catalog' && item.source?.kind === 'example'
            ? ` · install it with ${linkCommandFor(item)}`
            : ''}
        </span>
      ))}
      <span className="text-xs text-muted">
        Their code runs inside Walnut with the same access as any plugin you install.
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        {actionable.length > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            data-testid="plugin-pending-dependencies-install"
            onClick={onInstall}
          >
            {busy ? 'Installing…' : `Install ${actionable.map((item) => nameFor(item.id)).join(', ')}`}
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="plugin-pending-dependencies-dismiss"
          onClick={onDismiss}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/**
 * Turning off a plugin others run on. Inline under the row rather than a modal: the
 * question is about THIS row, and the list it has to show can grow.
 *
 * Cancel leaves everything exactly as it was, which is why the refusal happens on the
 * server before any config write.
 */
export function PluginCascadeConfirm({
  name,
  dependents,
  busy,
  onConfirm,
  onCancel,
}: {
  name: string;
  dependents: string[];
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const one = dependents.length === 1;
  return (
    <div className="plugin-store-config" data-testid="plugin-cascade-ask" style={{ display: 'grid', gap: 6 }}>
      <strong>{one ? '1 plugin runs' : `${dependents.length} plugins run`} on {name}</strong>
      <span className="text-xs text-muted">
        {dependents.join(', ')} {one ? 'stops' : 'stop'} working until {name} is back on.
        {one ? ' It is' : ' They are'} not switched off: turning {name} on again brings
        {one ? ' it' : ' them'} back.
      </span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {/* Same metrics as the Cancel next to it. `.btn-danger-outline` is declared after
            `.btn-sm` in globals.css, so adding the class would lose; inline wins. */}
        <button
          type="button"
          className="btn-danger-outline"
          style={{ padding: '4px 10px', fontSize: 12 }}
          disabled={busy}
          data-testid="plugin-cascade-confirm"
          onClick={onConfirm}
        >
          {busy ? 'Turning off…' : `Turn off ${name} anyway`}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="plugin-cascade-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
