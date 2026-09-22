/**
 * Settings › Engines: which engine a new session starts on, then each
 * coding-agent engine's OWN settings (the ones its command-line config screen
 * edits), on the host where its sessions run.
 *
 * The default-engine picker at the top is the only control here that writes
 * WALNUT config (`defaults.engine`); everything below it edits files the engine
 * owns. It saves on pick — deliberately not through useAutoSave, so merely
 * opening this page can never write the config back.
 *
 * This section edits files the ENGINE owns, not Walnut config. The load and
 * save rules (a write answers with a fresh read that replaces the view, a late
 * answer for a host or engine the user already left never paints, a failed write
 * reverts only when the server vouches nothing was written) live in
 * `useEngineSettings`, shared with the composer's per-session popover; this page
 * is the `{ host }` target. What stays here is the page itself: the host and
 * engine pickers, and one rule about failure: a load that cannot answer (a
 * daemon too old, a host out of reach) renders the server's own sentence inside
 * this card with a Retry, never a blank panel, because an empty settings card
 * reads as "this engine has no settings".
 *
 * Which engines appear is data: the catalog row's `capabilities.settings`. The
 * compiled-in fallback catalog says false for every engine, so a cold page shows
 * tabs only once GET /api/engines has hydrated.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Config, SessionEngine } from '@open-walnut/core';
import { SettingsSection, SettingsEmpty, SettingsNotice, SettingsSubCard } from '../SettingsSection';
import { StatusIndicator } from '../inputs/StatusIndicator';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useEngineCatalog, useEngineCatalogHydration, type EngineCatalogEntry } from '@/hooks/useEngineCatalog';
import { useEngineSettings } from '@/hooks/useEngineSettings';
import { useHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import { envUncheckedSentence } from '@/utils/engine-settings-copy';
import { hostIndicatorStatus, hostStatusText } from '@/utils/host-connect';
import { LOCAL_HOST, type EngineSettingView } from '@/api/engine-settings';
import { EngineSettingRow } from './EngineSettingRows';
import {
  currentDefaultEngine, defaultEngineOptions, defaultEnginePickerReady, defaultEngineSave,
} from './default-engine-select';
import '@/styles/engine-settings.css';

const ENGINES_DESCRIPTION = "Which engine new sessions start on, and each engine's own settings (the ones its command-line config screen edits) on the host where your sessions run. Changes save automatically.";

/** The group that only the engine's interactive command reads, collapsed by default. */
const TERMINAL_GROUP_ID = 'terminal';

/**
 * How long a catalog with no settings-capable engine is treated as "still
 * loading". The fallback catalog reports none, so without this grace a cold page
 * flashes "no engine exposes its own settings" before hydration lands, which
 * reads as a verdict rather than a wait.
 */
const CATALOG_GRACE_MS = 1_500;

interface HostChoice {
  value: string;
  label: string;
}

/** Version as a person reads it: the first token of `binary --version`, `v`-prefixed. */
function availabilityText(entry: EngineCatalogEntry): string | null {
  if (!entry.availability.installed) return 'not installed';
  const version = entry.availability.version?.trim().split(/\s+/)[0];
  if (!version) return null;
  return version.startsWith('v') ? version : `v${version}`;
}

/**
 * One host button. Its own component because `useHostStatus` subscribes per host
 * and a pushed phase should re-render one button, not the whole section.
 *
 * The dot carries the verdict and the sentence lives in the tooltip: a phase
 * sentence ("Opening an SSH connection to …") does not fit in a tab, and the
 * local machine has no connect chain to report at all.
 */
function HostButton({ host, active, onPick }: { host: HostChoice; active: boolean; onPick: (value: string) => void }) {
  const isLocal = host.value === LOCAL_HOST;
  const status = useHostStatus(isLocal ? null : host.value);
  const hydration = useHostStatusHydration();
  const sentence = isLocal ? '' : hostStatusText(status, hydration);
  return (
    <button
      type="button"
      className={`engine-settings-choice${active ? ' is-active' : ''}`}
      aria-pressed={active}
      data-host={host.value}
      title={sentence ? `${host.label}: ${sentence}` : host.label}
      aria-label={sentence ? `${host.label}, ${sentence}` : host.label}
      onClick={() => onPick(host.value)}
    >
      <span className="engine-settings-choice-name">{host.label}</span>
      {!isLocal && <StatusIndicator status={hostIndicatorStatus(status, hydration)} text="" />}
    </button>
  );
}

export function EnginesSection({ config, onSave }: { config: Config; onSave: (partial: Partial<Config>) => Promise<void> }) {
  const catalog = useEngineCatalog();
  const catalogHydration = useEngineCatalogHydration();
  const engines = useMemo(() => catalog.filter((e) => e.capabilities.settings), [catalog]);

  // Default engine for new sessions. Its option list is the WHOLE catalog (minus
  // what isn't installed), not the settings-capable subset the tabs below use:
  // an engine can run sessions without exposing any settings of its own.
  const defaultEngine = currentDefaultEngine(config);
  const defaultOptions = useMemo(() => defaultEngineOptions(catalog, defaultEngine), [catalog, defaultEngine]);
  const defaultPickerReady = defaultEnginePickerReady(catalogHydration);
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const pickDefaultEngine = async (id: SessionEngine) => {
    if (id === defaultEngine) return;
    setSavingDefault(true);
    setDefaultError(null);
    try {
      await onSave(defaultEngineSave(config, id));
    } catch (err) {
      // The select keeps showing the SAVED value (it renders from config), so a
      // failed write must say so — otherwise the row silently snaps back.
      setDefaultError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDefault(false);
    }
  };

  const hosts = useMemo<HostChoice[]>(() => {
    const remote = Object.entries(config.hosts ?? {})
      .filter(([alias, def]) => alias !== LOCAL_HOST && def.enabled !== false)
      .map(([alias, def]) => ({ value: alias, label: def.label ?? alias }));
    return [{ value: LOCAL_HOST, label: 'This Mac' }, ...remote];
  }, [config.hosts]);

  const [engineId, setEngineId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string>(LOCAL_HOST);
  // A removed or disabled host (and an engine the catalog no longer carries)
  // falls back instead of leaving the body pinned to something unselectable.
  const activeEngine = engines.find((e) => e.id === engineId)
    ?? engines.find((e) => e.isDefault)
    ?? engines[0]
    ?? null;
  const engine = activeEngine?.id ?? null;
  const host = hosts.some((h) => h.value === hostId) ? hostId : LOCAL_HOST;

  const [catalogGrace, setCatalogGrace] = useState(true);
  // The load/save machinery (generation + abort per load, optimistic rows, the
  // late-answer rule, outcome-aware revert vs re-read) is shared with the
  // composer's per-session popover; this page is the `{ host }` target.
  const {
    view, loading, refreshing, loadError, banner, dismissBanner, savingKeys, onSet, onReset, reload,
  } = useEngineSettings(engine ?? undefined, { host }, engine !== null);

  useEffect(() => {
    if (engines.length > 0) return;
    const timer = setTimeout(() => setCatalogGrace(false), CATALOG_GRACE_MS);
    return () => clearTimeout(timer);
  }, [engines.length]);

  const renderRows = (items: EngineSettingView[]) => (
    <div className="settings-row-list engine-settings-rows">
      {items.map((item) => (
        <EngineSettingRow
          key={item.key}
          engine={engine ?? ''}
          item={item}
          files={view?.files ?? []}
          saving={savingKeys.includes(item.key)}
          onSet={onSet}
          onReset={onReset}
        />
      ))}
    </div>
  );

  const body = () => {
    if (engines.length === 0) {
      return catalogGrace
        ? <LoadingSpinner />
        : <SettingsEmpty>No engine on this machine keeps settings Walnut can edit yet.</SettingsEmpty>;
    }
    if (loading || refreshing) return <LoadingSpinner />;
    if (loadError) {
      return (
        <SettingsEmpty>
          {loadError.message}
          <button
            type="button"
            className="btn btn-sm engine-settings-retry"
            onClick={reload}
          >
            Retry
          </button>
        </SettingsEmpty>
      );
    }
    if (!view) return <SettingsEmpty>This engine reported no settings.</SettingsEmpty>;

    return (
      <>
        {view.note && <p className="engine-settings-note">{view.note}</p>}
        {/* The rows say when a variable overrides the file; on a host whose
            environment was not visible they cannot, and silence would read as
            "no override", so the gap is named once here. */}
        {!view.envChecked && (
          <p className="engine-settings-note engine-settings-env-unchecked" data-testid="engine-settings-env-unchecked">
            {envUncheckedSentence(hosts.find((h) => h.value === host)?.label ?? host)}
          </p>
        )}
        <div className="engine-settings-groups">
          {view.groups.map((group) => {
            if (group.items.length === 0) return null;
            if (group.id !== TERMINAL_GROUP_ID) {
              return (
                <SettingsSubCard key={group.id} title={group.title} description={group.help}>
                  {renderRows(group.items)}
                </SettingsSubCard>
              );
            }
            // Collapsed: nothing in here changes a Walnut session. The title is
            // the summary, so the card inside carries the help text only.
            return (
              <details key={group.id} className="settings-collapsible engine-settings-collapsible">
                <summary className="settings-collapsible-title">
                  {group.title} · {group.items.length} settings
                </summary>
                <div className="settings-collapsible-body">
                  <SettingsSubCard description={group.help}>
                    {renderRows(group.items)}
                  </SettingsSubCard>
                </div>
              </details>
            );
          })}
        </div>
        <div className="engine-settings-files">
          {view.files.map((file) => (
            <p key={file.id} className="engine-settings-file">
              Stored in <code>{file.path}</code>
              {!file.exists && ' (not created yet)'}
              {file.error && <span className="engine-settings-file-error">{file.error}</span>}
            </p>
          ))}
        </div>
      </>
    );
  };

  return (
    <SettingsSection
      id="engines"
      title="Engines"
      description={ENGINES_DESCRIPTION}
      banner={banner ? (
        <div data-testid="engine-settings-banner">
          <SettingsNotice kind="error" role="alert">
            {banner}
            <button
              type="button"
              className="engine-settings-banner-dismiss"
              aria-label="Dismiss"
              onClick={dismissBanner}
            >
              ×
            </button>
          </SettingsNotice>
        </div>
      ) : undefined}
    >
      {/* Always rendered, independent of the tabs below: this is about which
          engine RUNS a new session, which every engine does whether or not it
          exposes settings Walnut can edit. */}
      <SettingsSubCard>
        <div className="form-group">
          <label htmlFor="default-engine-select">Default engine for new sessions</label>
          <select
            id="default-engine-select"
            data-testid="default-engine-select"
            value={defaultEngine}
            disabled={savingDefault || !defaultPickerReady}
            onChange={(e) => { void pickDefaultEngine(e.target.value as SessionEngine); }}
            style={{ maxWidth: 260 }}
          >
            {defaultOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Used by Ask Walnut, AI actions, Inbox Triage runs and routines unless a session picks its own.
          </p>
          {defaultError && (
            <SettingsNotice kind="error" role="alert">{defaultError}</SettingsNotice>
          )}
        </div>
      </SettingsSubCard>

      {/* One host: nothing to choose, so no picker at all. */}
      {engines.length > 0 && hosts.length > 1 && (
        <div className="engine-settings-picker" data-testid="engine-settings-host" role="group" aria-label="Host">
          {hosts.map((h) => (
            <HostButton key={h.value} host={h} active={h.value === host} onPick={setHostId} />
          ))}
        </div>
      )}

      {engines.length > 0 && (
        <div className="engine-settings-picker engine-settings-tabs" role="group" aria-label="Engine">
          {engines.map((entry) => {
            const avail = host === LOCAL_HOST ? availabilityText(entry) : null;
            return (
              <button
                key={entry.id}
                type="button"
                className={`engine-settings-choice${entry.id === engine ? ' is-active' : ''}`}
                aria-pressed={entry.id === engine}
                data-testid={`engine-settings-tab-${entry.id}`}
                // Availability is about THIS machine, so a remote host tab makes
                // no claim about it; the reason stays reachable as a tooltip.
                title={host === LOCAL_HOST ? entry.availability.reason ?? undefined : undefined}
                onClick={() => setEngineId(entry.id)}
              >
                <span className="engine-settings-choice-name">{entry.displayName}</span>
                {avail && <span className="engine-settings-choice-note">{avail}</span>}
              </button>
            );
          })}
        </div>
      )}

      {body()}
    </SettingsSection>
  );
}
