/**
 * Settings → Plugins, the two pieces that are about SOURCES rather than plugin rows:
 *
 *   - `UpdatesHead`: the Installed header's right half (one "Checked 3 min ago" for the
 *     whole list, Retry, Check now).
 *   - `PluginSourcesGroup`: the Sources list under the plugins. A source is not a plugin
 *     (one repo can carry several), and it is the source that gets updated or removed, so
 *     it keeps its own cards. Same chip, same row key and ONE Update per slug page-wide as
 *     the Installed rows, so scrolling down never lands on an older design.
 *
 * Split out of PluginStoreSection.tsx to keep that file about the plugin rows.
 */
import { useEffect, useState } from 'react';
import type { UsePluginUpdates } from '@/hooks/usePluginUpdates';
import { PluginUpdateChip } from '../PluginUpdateChip';
import { PluginUpdateButton } from '../PluginUpdateButton';
import { PluginUpdateFeedback } from '../PluginUpdateFeedback';
import { PluginProvenanceFlyout } from '../PluginProvenanceFlyout';
import { timeAgo } from '@/utils/time';
import { resolveRowState, sourceShortLabel, updateButtonMode, type Feedback } from '../plugin-update-view';
import { sourceRowKey } from '../plugin-update-types';

/** One plugin dir inside a source, as GET /api/plugin-sources reports it. */
export interface StorePlugin {
  dir: string;
  id: string | null;
  name: string | null;
  version: string | null;
  error?: string;
  status: 'loaded' | 'needs-config' | 'needs-dependency' | 'unsupported' | 'duplicate' | 'error' | 'pending-restart';
}

/** One installed source (git repo or npm package), as GET /api/plugin-sources reports it. */
export interface PluginSource {
  slug: string;
  kind?: 'git' | 'npm';
  type?: 'npm';
  url?: string;
  ref?: string;
  spec?: string;
  resolved?: string;
  packageName?: string;
  version?: string;
  integrity?: string;
  enabled: boolean;
  cloned: boolean;
  lastSha?: string;
  lastSyncedAt?: string;
  lastError?: string;
  plugins: StorePlugin[];
  /** What the source carried the last time its files were here; set only while `cloned` is false. */
  lastKnownPlugins?: Array<{ id: string; name: string | null }>;
  shareSnippet?: string;
}

export const STATUS_LABELS: Record<StorePlugin['status'], { label: string; className: string }> = {
  loaded: { label: 'active', className: 'badge badge-done' },
  'needs-config': { label: 'needs setup', className: 'badge badge-important' },
  'needs-dependency': { label: 'needs another plugin', className: 'badge badge-important' },
  unsupported: { label: 'needs newer Walnut', className: 'badge badge-none' },
  duplicate: { label: 'shadowed', className: 'badge badge-none' },
  error: { label: 'invalid', className: 'badge badge-immediate' },
  'pending-restart': { label: 'restart to activate', className: 'badge badge-important' },
};

/** The four Provenance rows of a git or npm source: full URL, installed ref, integrity, id. */
export function sourceProvenance(
  slug: string,
  kind: 'git' | 'npm',
  source: PluginSource | undefined,
  fallback?: { url?: string; spec?: string },
): { url: string; installedAt?: string; integrity?: string; id: string } {
  const version = source?.version ?? (source?.resolved ? source.resolved.slice(source.resolved.lastIndexOf('@') + 1) : undefined);
  const installedAt = kind === 'npm'
    ? (version ? `v${version}` : undefined)
    : (source?.lastSha ? source.lastSha.slice(0, 7) : undefined);
  return {
    url: source?.url ?? source?.spec ?? fallback?.url ?? fallback?.spec ?? '',
    ...(installedAt ? { installedAt } : {}),
    ...(source?.integrity ? { integrity: source.integrity } : {}),
    id: slug,
  };
}

const OFFLINE_TITLE = 'You are offline. Check again when you are back online.';

/**
 * The Installed header's right half: ONE time for the whole list plus Check now.
 *
 * The time is the max `checkedAt` over rows, so a single row's re-check moves it too, and
 * the sentence never carries a number of rows: the title already says how many are
 * installed, and a request count would read as a different number of plugins.
 * `slowLoad` is the first GET still in flight after 3 s; a fast load shows nothing busy.
 * `onCheckAll` is the section's wrapper (it also clears every row's feedback line).
 */
export function UpdatesHead({ updates, slowLoad, onCheckAll }: {
  updates: UsePluginUpdates;
  slowLoad: boolean;
  onCheckAll: () => void;
}) {
  // Re-render every 30 s so "3 min ago" keeps up without any request.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const ago = updates.checkedAt ? timeAgo(updates.checkedAt, { long: true }) : null;
  const lastChecked = ago ? `last checked ${ago}` : 'not checked yet';
  const checking = updates.refreshing || (slowLoad && !updates.loaded);
  let text: string;
  let retry = false;
  if (updates.offline) text = `Offline · ${lastChecked}`;
  else if (updates.error) { text = 'Could not check'; retry = true; }
  else if (checking) text = 'Checking for updates…';
  // Before the first GET answers the header says nothing: "Not checked yet" is the SERVER's
  // answer (checkedAt null), not the client's not-having-asked (N8). A load past 3 s is
  // covered by `checking` above.
  else if (!updates.loaded) text = '';
  else if (updates.allNetworkFailed) text = `Remote not reachable · ${lastChecked}`;
  else if (!ago) text = 'Not checked yet';
  else if (updates.failed > 0) text = `Checked ${ago} · ${updates.failed} of ${updates.attempted} could not be reached`;
  else text = `Checked ${ago}`;
  return (
    <div className="plugin-store-updates-head" data-loaded={updates.loaded ? 'true' : 'false'}>
      <span data-testid="plugin-updates-checked-at" aria-live="polite">{text}</span>
      {/* After a failed GET the ONE verb is Retry: a second "Check now" next to it would be the
          same request under a second name (N9). */}
      {retry ? (
        <>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="btn-link btn-sm"
            data-testid="plugin-updates-retry"
            onClick={() => updates.retry()}
          >
            Retry
          </button>
        </>
      ) : (
        <>
          {text ? <span aria-hidden="true">·</span> : null}
          <button
            type="button"
            className="btn-link btn-sm"
            data-testid="plugin-updates-check-now"
            disabled={checking || updates.offline}
            title={updates.offline ? OFFLINE_TITLE : undefined}
            onClick={onCheckAll}
          >
            Check now
          </button>
        </>
      )}
    </div>
  );
}

export interface PluginSourcesGroupProps {
  sources: PluginSource[];
  /** Slugs an Installed row already carries: that row owns the Update verb, the card does not. */
  ownedSlugs: ReadonlySet<string>;
  updates: UsePluginUpdates;
  /** The section's busy key ('add' | plugin id | source slug). */
  busy: string | null;
  copiedKey: string | null;
  feedback: Record<string, Feedback>;
  onCopy: (text: string, key: string) => void;
  onUpdate: (slug: string, kind: 'git' | 'npm', feedbackId: string) => void;
  onRemove: (slug: string) => void;
  setRowFeedback: (rowId: string, next: Feedback | null) => void;
}

export function PluginSourcesGroup(props: PluginSourcesGroupProps) {
  const { sources, ownedSlugs, updates, busy, copiedKey, feedback } = props;
  if (sources.length === 0) return null;
  return (
    <div className="plugin-store-group plugin-sources-group" data-testid="plugin-store-sources">
      <div className="plugin-store-group-head">
        <h4 className="settings-subcard-title">Sources</h4>
        <span className="plugin-store-count">{sources.length}</span>
      </div>
      {sources.map((source) => {
        // The Installed row owns the verbs (Update AND Remove, N3-17) while a plugin from
        // this source is loaded; the card offers Restore / Update / Remove only when no row
        // does (missing, failed load). Copy share snippet is the card's own verb.
        const rowId = `source-${source.slug}`;
        const rowKey = sourceRowKey(source.slug);
        const kind: 'git' | 'npm' = source.kind === 'npm' || source.type === 'npm' ? 'npm' : 'git';
        const updateRow = updates.rows[rowKey];
        const owned = ownedSlugs.has(source.slug);
        const state = resolveRowState({ known: updateRow?.state, loaded: updates.loaded, refreshing: updates.refreshing });
        const rowBusy = updates.busy[rowKey];
        const buttonMode = owned ? { render: false as const } : updateButtonMode(state, rowBusy);
        // A source whose clone is gone still has a name: the plugins it carried last time
        // (server memo), never the slug, which belongs in the Provenance flyout (N2-3).
        const known = source.plugins.length > 0 ? source.plugins : (source.lastKnownPlugins ?? []);
        const names = known.map((plugin) => plugin.name ?? plugin.id).filter((name): name is string => Boolean(name));
        const title = names.length > 0 ? names.join(', ') : source.slug;
        // A source carrying ONE plugin folds that plugin's version and status into the
        // title row instead of repeating its name on a list of one (N16).
        const only = source.cloned && source.plugins.length === 1 ? source.plugins[0] : null;
        const onlyStatus = only ? (STATUS_LABELS[only.status] ?? STATUS_LABELS.error) : null;
        return (
          <div
            key={`${kind}:${source.slug}:${source.spec ?? source.url ?? ''}`}
            className="settings-collapsible plugin-store-source"
            data-testid={`plugin-source-${source.slug}`}
            style={{ padding: '10px 12px' }}
          >
            {/* The same two clusters as an Installed row (spec 6.2, N2-2, N3-15): a copy column
                (title line with badges and chip, then the origin line) and an actions cluster
                that never splits and drops UNDER the copy, flush right, when the two no longer
                fit side by side. No GIT / NPM badge: the origin line already says `git ·`,
                and the badge was what pushed the chip onto a second line at 1280 (N3-10). */}
            <div className="plugin-store-source-head">
              <div className="plugin-store-source-copy">
                <div className="plugin-store-source-title">
                  <strong>{title}</strong>
                  {onlyStatus && <span className={onlyStatus.className} data-testid={`plugin-source-status-${source.slug}`}>{onlyStatus.label}</span>}
                  {only?.version && <span className="plugin-store-version">v{only.version}</span>}
                  <PluginUpdateChip
                    rowId={rowId}
                    state={state}
                    checkedAt={updateRow?.checkedAt ?? null}
                    busy={rowBusy}
                    transient={updateRow?.transient}
                    toRef={updateRow?.target?.toRef}
                    offline={updates.offline}
                    updateElsewhere={owned}
                    onCheck={() => {
                      props.setRowFeedback(rowId, null);
                      void updates.checkRow(rowKey, { kind: 'source', slug: source.slug });
                    }}
                  />
                </div>
                <div className="text-xs text-muted plugin-store-origin">
                  {sourceShortLabel(source)}
                  <PluginProvenanceFlyout
                    rowId={rowId}
                    kind="source"
                    rows={sourceProvenance(source.slug, kind, source)}
                    checkedAt={updateRow?.checkedAt ?? null}
                  />
                </div>
              </div>
              <div className="plugin-store-source-actions">
                {source.shareSnippet && (
                  <button type="button" className="btn btn-sm" onClick={() => props.onCopy(source.shareSnippet!, source.slug)}>
                    {copiedKey === source.slug ? 'Copied' : 'Copy share snippet'}
                  </button>
                )}
                {buttonMode.render && (
                  <PluginUpdateButton
                    rowId={rowId}
                    mode={buttonMode}
                    onClick={() => props.onUpdate(source.slug, kind, rowId)}
                  />
                )}
                {!owned && (
                  <button type="button" className="btn-danger-outline btn-sm" disabled={busy === source.slug} onClick={() => props.onRemove(source.slug)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
            <PluginUpdateFeedback rowId={rowId} feedback={feedback[rowId]} />
            {source.lastError && (
              <p className="text-xs" style={{ color: 'var(--priority-immediate)', marginTop: 4 }}>{source.lastError}</p>
            )}
            {/* Not cloned: the chip says "Not installed here" and Restore is the verb. One
                plugin: its facts are on the title row already, only its error is left. */}
            {!source.cloned ? null : only ? (
              only.error ? <p className="text-xs text-muted" style={{ marginTop: 4 }}>{only.error}</p> : null
            ) : source.plugins.length === 0 ? (
              <p className="text-xs text-muted" style={{ marginTop: 6 }}>
                No plugins found in this {kind === 'npm' ? 'package' : 'repo'}.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
                {source.plugins.map((plugin) => {
                  const status = STATUS_LABELS[plugin.status] ?? STATUS_LABELS.error;
                  return (
                    <li key={plugin.dir} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                      <span>{plugin.name ?? plugin.id ?? 'unnamed'}</span>
                      {plugin.version && <span className="text-xs text-muted">v{plugin.version}</span>}
                      <span className={status.className}>{status.label}</span>
                      {plugin.error && <span className="text-xs text-muted">{plugin.error}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
