/**
 * Settings, Engines: which engine a new session starts on, then each
 * coding-agent engine's OWN settings (the ones its command-line config screen
 * edits), on the host where its sessions run.
 *
 * The default-engine picker at the top is the only control here that writes
 * WALNUT config (`defaults.engine`); everything below it edits files the engine
 * owns. It saves on pick: deliberately not through useAutoSave, so merely
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
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Config, SessionEngine } from '@open-walnut/core';
import {
  SettingsDisclosure, SettingsEmpty, SettingsGroup, SettingsLoadingRow, SettingsNotice, SettingsRow, SettingsSection, SettingsTag,
} from '../SettingsSection';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { SettingsButton } from '../inputs/SettingsButton';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { CloseGlyph } from '../settings-glyphs';
import { useEngineCatalog, useEngineCatalogHydration, type EngineCatalogEntry } from '@/hooks/useEngineCatalog';
import { useEngineSettings } from '@/hooks/useEngineSettings';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import { envUncheckedSentence } from '@/utils/engine-settings-copy';
import { hostIndicatorStatus, hostStatusText } from '@/utils/host-connect';
import { LOCAL_HOST, type EngineSettingView } from '@/api/engine-settings';
import { EngineSettingRow, firstSentence as firstSentenceOf } from './EngineSettingRows';
import {
  currentDefaultEngine, defaultEngineOptions, defaultEnginePickerReady, defaultEngineSave,
} from './default-engine-select';
import { useSerialSave, type OnSave } from './GeneralSection';
import { resolveMainProvider } from './main-provider';
import { CodeText } from './code-text';
import { categorizeSettings } from './engine-setting-categories';
import '@/styles/engine-settings.css';
import '@/styles/settings-engines-grid.css';

/** Segmented up to this many choices, a select beyond it. */
const MAX_SEGMENTS = 5;
/** A group longer than this splits into chunks so no box runs past a screen. */
const MAX_GROUP_ROWS = 10;

/** The group that only the engine's interactive command reads, collapsed by default. */
const TERMINAL_GROUP_ID = 'terminal';

/**
 * How long a catalog with no settings-capable engine is treated as "still
 * loading". The fallback catalog reports none, so without this grace a cold page
 * flashes "no engine exposes its own settings" before hydration lands.
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
 * Whose setting a row is, as the settings page names it elsewhere: the Claude
 * engine is "Claude Code" (the CLI it runs), so a bare model row reads
 * `Claude Code model` (pure, unit tested).
 */
export function engineOwnerName(id: string | undefined, displayName: string | undefined): string | undefined {
  return id === 'claude' ? 'Claude Code' : displayName;
}

/** The engine is "Claude Code" wherever it is named, never bare "Claude" (N30). */
export function engineName(label: string): string {
  return label.replace(/^Claude\b(?! Code)/, 'Claude Code');
}

/** "user settings" -> "User settings": labels start with a capital (N12). */
export function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * Split a long group into chunks of at most `max` rows, balanced so a group
 * never ends in a lone leftover row (11 is 6 + 5, not 10 + 1; N12). Pure.
 */
export function chunkRows<T>(items: readonly T[], max = MAX_GROUP_ROWS): T[][] {
  if (items.length === 0) return [];
  const n = Math.ceil(items.length / max);
  const size = Math.ceil(items.length / n);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The status tag word for a host indicator (pure, unit tested). */
export function hostTagOf(kind: 'connected' | 'error' | 'unknown' | 'testing'): { text: string; tone: 'success' | 'warning' | 'neutral' } {
  if (kind === 'connected') return { text: 'Reachable', tone: 'success' };
  if (kind === 'error') return { text: 'Offline', tone: 'warning' };
  return { text: 'Checking', tone: 'neutral' };
}

/**
 * One host's status tag. Its own component because `useHostStatus` subscribes
 * per host and a pushed phase should re-render one tag, not the whole section.
 * The local machine has no connect chain, so it is always reachable.
 */
function HostStatusTag({ host }: { host: HostChoice }) {
  const isLocal = host.value === LOCAL_HOST;
  const status = useHostStatus(isLocal ? null : host.value);
  const hydration = useHostStatusHydration();
  const tag = isLocal ? hostTagOf('connected') : hostTagOf(hostIndicatorStatus(status, hydration));
  const sentence = isLocal ? 'This machine.' : hostStatusText(status, hydration);
  return (
    <span data-host={host.value} data-testid={`engine-settings-host-status-${host.value}`}>
      <SettingsTag tone={tag.tone} title={`${host.label}: ${sentence}`}>{tag.text}</SettingsTag>
    </span>
  );
}

export function EnginesSection({ config, onSave }: { config: Config; onSave: OnSave }) {
  const catalog = useEngineCatalog();
  const { health } = useSystemHealth();
  const catalogHydration = useEngineCatalogHydration();
  const engines = useMemo(() => catalog.filter((e) => e.capabilities.settings), [catalog]);

  // Default engine for new sessions. Its option list is the WHOLE catalog (minus
  // what isn't installed), not the settings-capable subset the tabs below use.
  const savedDefault = currentDefaultEngine(config);
  const save = useSerialSave(config, onSave);
  const defaultPick = useOptimisticSetting<SessionEngine>(
    savedDefault,
    (id) => save((c) => defaultEngineSave(c, id), { rowKey: 'engines.default-engine' }),
    { rowKey: 'engines.default-engine' },
  );
  const defaultEngine = defaultPick.value;
  const defaultOptions = useMemo(() => defaultEngineOptions(catalog, savedDefault), [catalog, savedDefault]);
  const defaultPickerReady = defaultEnginePickerReady(catalogHydration);
  const provider = config.agent?.main_provider ?? health.mainProvider;
  const usesApi = resolveMainProvider(provider, config.providers).kind !== 'cli';
  const smallJobs = usesApi ? (
    <>Small background jobs use an API instead (<a href="#providers">Advanced</a>).</>
  ) : defaultEngine !== 'claude' ? 'Small background jobs stay on Claude Code.' : null;

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
  const hostLabel = hosts.find((h) => h.value === host)?.label ?? host;

  const [catalogGrace, setCatalogGrace] = useState(true);
  // The load/save machinery is shared with the composer's per-session popover;
  // this page is the `{ host }` target.
  const {
    view, loading, refreshing, loadError, banner, dismissBanner, savingKeys, onSet, onReset, reload,
  } = useEngineSettings(engine ?? undefined, { host }, engine !== null);

  useEffect(() => {
    if (engines.length > 0) return;
    const timer = setTimeout(() => setCatalogGrace(false), CATALOG_GRACE_MS);
    return () => clearTimeout(timer);
  }, [engines.length]);

  const renderRows = (items: EngineSettingView[], indent = false) =>
    items.map((item) => (
      <EngineSettingRow
        key={item.key}
        variant="pane"
        indent={indent}
        engineLabel={engineOwnerName(activeEngine?.id, activeEngine?.displayName)}
        engine={engine ?? ''}
        item={item}
        files={view?.files ?? []}
        saving={savingKeys.includes(item.key)}
        onSet={onSet}
        onReset={onReset}
      />
    ));

  const body = () => {
    if (engines.length === 0) {
      return catalogGrace
        ? <SettingsGroup><SettingsLoadingRow /></SettingsGroup>
        : <SettingsGroup><SettingsEmpty>No engine on this machine keeps settings Walnut can edit yet.</SettingsEmpty></SettingsGroup>;
    }
    if (loading || refreshing) return <SettingsGroup><SettingsLoadingRow /></SettingsGroup>;
    if (loadError) {
      return (
        <SettingsNotice
          kind="warn"
          role="alert"
          action={<SettingsButton className="engine-settings-retry" onClick={reload}>Retry</SettingsButton>}
        >
          {loadError.message}
        </SettingsNotice>
      );
    }
    if (!view) return <SettingsGroup><SettingsEmpty>This engine reported no settings.</SettingsEmpty></SettingsGroup>;

    return (
      <>
        {/* The rows say when a variable overrides the file; on a host whose
            environment was not visible they cannot, so the gap is named once. */}
        {!view.envChecked && (
          <div data-testid="engine-settings-env-unchecked">
            <SettingsNotice kind="warn">{envUncheckedSentence(hostLabel)}</SettingsNotice>
          </div>
        )}
        <div className="engine-settings-groups">
          {view.groups.map((group) => {
            if (group.items.length === 0) return null;
            if (group.id !== TERMINAL_GROUP_ID) {
              // A long group splits by topic, each with a real heading (N3-02);
              // a topic past 10 rows keeps one box with a break every 10.
              return categorizeSettings(group.id, sentenceCase(group.title), group.items, MAX_GROUP_ROWS).map((cat, i) => (
                <SettingsGroup
                  key={`${group.id}-${cat.id}`}
                  heading={cat.title}
                  footer={i === 0 && group.help ? <CodeText text={firstSentenceOf(group.help)} /> : undefined}
                  data-testid={i === 0 ? `engine-settings-group-${group.id}` : undefined}
                >
                  <div className="engine-settings-grid">
                    {chunkRows(cat.items).map((chunk, j) => (
                      <Fragment key={j}>
                        {j > 0 && <div className="engine-settings-chunk-break" role="presentation" />}
                        {renderRows(chunk)}
                      </Fragment>
                    ))}
                  </div>
                </SettingsGroup>
              ));
            }
            // Collapsed: nothing in here changes a Walnut session.
            return (
              <SettingsGroup key={group.id} data-testid={`engine-settings-group-${group.id}`}>
                <SettingsDisclosure
                  id={`engines-${group.id}`}
                  label={sentenceCase(group.title)}
                  help={group.help ? <CodeText text={firstSentenceOf(group.help)} /> : undefined}
                  summary={`${group.items.length} settings`}
                >
                  {/* Indented children, a break every 10 rows (N12). */}
                  <div className="engine-settings-grid">
                    {chunkRows(group.items).map((chunk, i) => (
                      <Fragment key={i}>
                        {i > 0 && <div className="engine-settings-chunk-break" role="presentation" />}
                        {renderRows(chunk, true)}
                      </Fragment>
                    ))}
                  </div>
                </SettingsDisclosure>
              </SettingsGroup>
            );
          })}
        </div>
        <SettingsGroup heading="Files" data-testid="engine-settings-files">
          {view.files.map((file) => (
            <SettingsRow
              key={file.id}
              className="engine-settings-file"
              data-file-id={file.id}
              label={sentenceCase(file.label)}
              help={<code className="settings-mono-value" title={file.path}>{file.path}</code>}
              error={file.error ? <span className="engine-settings-file-error">{file.error}</span> : undefined}
              control={!file.exists ? <SettingsTag>Not created yet</SettingsTag> : undefined}
            />
          ))}
        </SettingsGroup>
      </>
    );
  };

  const engineControl = engines.length > 0 && (
    <SegmentedControl<string>
      aria-label="Engine"
      value={engine ?? ''}
      onChange={setEngineId}
      options={engines.map((entry) => {
        const avail = host === LOCAL_HOST ? availabilityText(entry) : null;
        const reason = host === LOCAL_HOST ? entry.availability.reason ?? undefined : undefined;
        return {
          value: entry.id,
          label: engineName(entry.displayName),
          testId: `engine-settings-tab-${entry.id}`,
          title: [avail, reason].filter(Boolean).join(', ') || undefined,
        };
      })}
    />
  );

  // The picked host's status sits beside the picker, never as a second list of
  // the same hosts (N12).
  const hostControl = hosts.length <= MAX_SEGMENTS ? (
    <span className="settings-control-cluster">
      <HostStatusTag host={hosts.find((h) => h.value === host) ?? hosts[0]} />
      <SegmentedControl<string>
        aria-label="Host"
        value={host}
        onChange={setHostId}
        options={hosts.map((h) => ({ value: h.value, label: h.label, testId: `engine-settings-host-${h.value}` }))}
      />
    </span>
  ) : (
    <span className="settings-control-cluster">
      <select className="settings-select" aria-label="Host" value={host} onChange={(e) => setHostId(e.target.value)}>
        {hosts.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
      </select>
      <HostStatusTag host={hosts.find((h) => h.value === host) ?? hosts[0]} />
    </span>
  );

  const defaultControl = defaultOptions.length <= MAX_SEGMENTS ? (
    <span data-testid="default-engine-select" data-value={defaultEngine}>
      <SegmentedControl<SessionEngine>
        id="default-engine-select"
        aria-label="Default engine"
        value={defaultEngine}
        disabled={!defaultPickerReady}
        onChange={defaultPick.set}
        options={defaultOptions.map((o) => ({ value: o.id, label: engineName(o.label), testId: `default-engine-option-${o.id}` }))}
      />
    </span>
  ) : (
    <select
      id="default-engine-select"
      data-testid="default-engine-select"
      className="settings-select"
      value={defaultEngine}
      disabled={!defaultPickerReady}
      onChange={(e) => defaultPick.set(e.target.value as SessionEngine)}
    >
      {defaultOptions.map((option) => (
        <option key={option.id} value={option.id}>{engineName(option.label)}</option>
      ))}
    </select>
  );

  return (
    <SettingsSection
      id="engines"
      title="Engines"
      banner={banner ? (
        <div data-testid="engine-settings-banner">
          <SettingsNotice
            kind="error"
            role="alert"
            action={
              <button type="button" className="engine-settings-banner-dismiss" aria-label="Dismiss" onClick={dismissBanner}>
                <CloseGlyph size={12} />
              </button>
            }
          >
            {banner}
          </SettingsNotice>
        </div>
      ) : undefined}
    >
      {/* Always rendered: which engine RUNS a new session, whether or not that
          engine exposes settings Walnut can edit. */}
      <SettingsGroup>
        <SettingsRow
          label="Default engine"
          help={<span data-testid="default-engine-used-for">Everything Walnut starts uses it; a session can still pick its own.</span>}
          error={defaultPick.error}
          data-testid="default-engine-row"
          control={defaultControl}
        >
          {smallJobs && <span className="settings-help-warning" data-testid="default-engine-small-jobs">{smallJobs}</span>}
        </SettingsRow>
      </SettingsGroup>

      {engines.length > 0 && (
        <SettingsGroup
          data-testid="engine-settings-pickers"
          // The engine's own note (where its keys are saved) is this group's
          // footer: one sentence, paths in code, the whole note on hover (N12).
          footer={view?.note ? (
            <span className="engine-settings-note" title={view.note} data-testid="engine-settings-note">
              <CodeText text={firstSentenceOf(view.note)} />
            </span>
          ) : undefined}
        >
          <SettingsRow label="Engine" data-testid="engine-settings-tabs" control={engineControl} />
          {hosts.length > 1 && (
            <SettingsRow label="Host" data-testid="engine-settings-host" control={hostControl} />
          )}
        </SettingsGroup>
      )}

      {body()}
    </SettingsSection>
  );
}
