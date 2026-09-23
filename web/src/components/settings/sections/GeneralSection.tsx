import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { useTheme, type ThemePreference } from '@/hooks/useTheme';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useSessionPanelMode, type SessionPanelMode } from '@/hooks/useSessionPanelMode';
import { UI_ONLY_CATEGORIES, setShowUiOnlyCategory, type UiOnlyCategory } from '@/hooks/useDeveloperSettings';
import '@/styles/settings-sections-configure.css';

export type SaveOpts = { rowKey?: string };
export type OnSave = (partial: Partial<Config>, opts?: SaveOpts) => Promise<void>;
export type BuildPatch = (config: Config) => Partial<Config>;

/**
 * One queue for every row write in these panes. saveSection diffs a partial
 * against the config the page rendered and lays it over a fresh read, so two
 * writes in flight at once lose the first (the second's fresh read predates
 * it). Each job builds its partial from the config current when it RUNS, so
 * the partial and saveSection's base are always the same snapshot.
 *
 * A job also waits for the previous save's refreshed config to RENDER (at most
 * REFRESH_WAIT_MS): a save resolves once its refresh is set, not drawn, and a
 * partial built from the older render drops a switch flipped back to the value
 * that render showed (a double click the server then kept at the first click).
 * "Rendered" means the page now shows a different config object than the one
 * the save was built on, so a render that lands before the save settles (WebKit
 * can run it first) never costs a wait, and a render delayed by a busy main
 * thread is still waited for. A flag reset by the next render was not enough:
 * under load the 300ms cap it needed expired first and the flip back was lost.
 */
const REFRESH_WAIT_MS = 3000;
let writeQueue: Promise<unknown> = Promise.resolve();
/** The config the last finished save was built on, until a newer one renders. */
let savedOn: Config | null = null;
let onRefreshRendered: (() => void) | null = null;

function refreshRendered(current: () => Config): Promise<void> {
  if (!savedOn || current() !== savedOn) {
    savedOn = null;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      onRefreshRendered = null;
      savedOn = null;
      resolve();
    };
    const timer = setTimeout(done, REFRESH_WAIT_MS);
    onRefreshRendered = done;
  });
}

const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useSerialSave(config: Config, onSave: OnSave) {
  const ref = useRef(config);
  ref.current = config;
  useCommitEffect(() => {
    if (savedOn && config !== savedOn) onRefreshRendered?.();
  }, [config]);
  return useCallback((build: BuildPatch, opts?: SaveOpts): Promise<void> => {
    const run = writeQueue
      .then(() => refreshRendered(() => ref.current))
      .then(async () => {
        const base = ref.current;
        await onSave(build(base), opts);
        savedOn = base;
      });
    writeQueue = run.catch(() => undefined);
    return run;
  }, [onSave]);
}

// Each segment also carries `theme-picker-btn`: shared test helpers (draft, mail, plugin
// update) switch the theme through that class, so it stays as a hook with no styling.
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const PANEL_OPTIONS: { value: SessionPanelMode; label: string }[] = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5' },
  { value: 'auto', label: 'Auto' },
];

/** Settings copy for the chat notification switches (the hook's labels serve the chat). */
export const CHAT_NOTIFICATION_COPY: Record<UiOnlyCategory, { label: string; help: string }> = {
  triage: { label: 'Session triage results', help: 'Session triage analysis.' },
  session: { label: 'Session results', help: 'Summaries of finished sessions.' },
  subagent: { label: 'Subagent results', help: 'Results from embedded subagents.' },
  heartbeat: { label: 'Heartbeat all clear', help: 'Routine check-ins when nothing needs you; issues always show.' },
};

/** config.developer key for a chat notification category. */
export function developerKeyFor(category: UiOnlyCategory): string {
  return `show_ui_only_${category.replace(/-/g, '_')}`;
}

type DeveloperBlock = NonNullable<Config['developer']>;

function isPanelMode(v: unknown): v is SessionPanelMode {
  return typeof v === 'string' && PANEL_OPTIONS.some((o) => o.value === v);
}

interface Props {
  config: Config;
  onSave: OnSave;
}

function ChatNotificationRow({ category, config, save }: { category: UiOnlyCategory; config: Config; save: ReturnType<typeof useSerialSave> }) {
  const key = developerKeyFor(category);
  const def = UI_ONLY_CATEGORIES.find((c) => c.key === category)?.defaultOn ?? false;
  const stored = (config.developer as Record<string, boolean | undefined> | undefined)?.[key];
  const rowKey = `general.notify.${category}`;
  const setting = useOptimisticSetting<boolean>(
    stored ?? def,
    async (v) => {
      await save((c) => ({ developer: { ...(c.developer ?? {}), [key]: v } as DeveloperBlock }), { rowKey });
      // This window's chat reads the local mirror; keep it in step with config.
      setShowUiOnlyCategory(category, v);
    },
    { rowKey },
  );
  const id = `settings-notify-${category}`;
  const copy = CHAT_NOTIFICATION_COPY[category];
  return (
    <SettingsRow
      label={copy.label}
      help={copy.help}
      htmlFor={id}
      error={setting.error}
      data-testid={`settings-notify-row-${category}`}
      control={<ToggleSwitch id={id} checked={setting.value} busy={setting.busy} onChange={setting.set} />}
    />
  );
}

/**
 * Appearance and the person. Appearance and Focus bar are browser prefs (local
 * storage, no config write) that ui-prefs sync copies to every window of this
 * Walnut, so their help says so; every other row is a config row via onSave.
 */
export function GeneralSection({ config, onSave }: Props) {
  const { theme, setTheme } = useTheme();
  const focusBar = useFocusBarContext();
  const { mode: panelMode } = useSessionPanelMode();
  const save = useSerialSave(config, onSave);

  const configuredPanels = config.ui?.session_panels;
  const panels = useOptimisticSetting<SessionPanelMode>(
    isPanelMode(configuredPanels) ? configuredPanels : panelMode,
    (m) => save((c) => ({ ui: { ...(c.ui ?? {}), session_panels: m } }), { rowKey: 'general.session-panels' }),
    { rowKey: 'general.session-panels' },
  );

  const name = useCommitField<string>(
    config.user?.name ?? '',
    (v) => save((c) => ({ user: { ...(c.user ?? {}), name: v } }), { rowKey: 'general.name' }),
    { rowKey: 'general.name', kind: 'text' },
  );

  return (
    <SettingsSection id="general" title="General">
      <SettingsGroup>
        <SettingsRow
          label="Appearance"
          // True to ui-prefs-sync: saved for every window, which reads it on its next load (N16).
          help="Applies here now, and to other windows when they next open."
          data-testid="settings-appearance-row"
          control={
            <SegmentedControl
              id="settings-theme"
              aria-label="Appearance"
              value={theme}
              options={THEME_OPTIONS.map((o) => ({ ...o, testId: `settings-theme-${o.value}`, className: 'theme-picker-btn' }))}
              onChange={setTheme}
            />
          }
        />
        <SettingsRow
          label="Focus bar"
          help="Pinned task dock at the bottom; other windows follow when they next open."
          htmlFor="settings-focus-bar"
          data-testid="settings-focus-bar-row"
          control={
            <ToggleSwitch id="settings-focus-bar" checked={focusBar.visible} onChange={focusBar.setVisible} />
          }
        />
        <SettingsRow
          label="Session panels"
          help="How many sessions sit side by side; Auto fits the window width."
          error={panels.error}
          data-testid="settings-session-panels-row"
          control={
            <SegmentedControl
              id="settings-session-panels"
              aria-label="Session panels"
              value={panels.value}
              options={PANEL_OPTIONS.map((o) => ({ ...o, testId: `settings-panels-${o.value}` }))}
              onChange={panels.set}
            />
          }
        />
        <SettingsRow
          label="Your name"
          help="How Walnut addresses you."
          htmlFor="settings-name"
          error={name.error}
          control={
            <input
              id="settings-name"
              type="text"
              className="settings-input settings-input--short"
              placeholder="Your name"
              {...name.inputProps}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup heading="Chat notifications" footer="Background notifications that appear in chat.">
        {UI_ONLY_CATEGORIES.map((cat) => (
          <ChatNotificationRow key={cat.key} category={cat.key} config={config} save={save} />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
