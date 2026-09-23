import type { Config, TaskPriority } from '@open-walnut/core';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { useIntegrations } from '@/hooks/useIntegrations';
import { useShowPriority } from '@/hooks/useShowPriority';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { SmartTaskCreation } from './SmartTaskCreation';
import { useSerialSave, type OnSave } from './GeneralSection';

interface Props {
  config: Config;
  onSave: OnSave;
  onReload: () => Promise<void>;
}

export type TriageNotifyMode = 'off' | 'buffered' | 'realtime';

const NOTIFY_OPTIONS: { value: TriageNotifyMode; label: string; testId: string }[] = [
  { value: 'off', label: 'Off', testId: 'triage-notify-off' },
  { value: 'buffered', label: 'On heartbeat', testId: 'triage-notify-buffered' },
  { value: 'realtime', label: 'Right away', testId: 'triage-notify-realtime' },
];

/** Warning under Default project when the typed name is not a known project yet. */
export function unknownProjectWarning(value: string, loaded: boolean, isKnown: (n: string) => boolean): string | null {
  const name = value.trim();
  if (!name || !loaded || isKnown(name)) return null;
  return `No project named "${name}" yet; the next quick add creates it.`;
}

/** Server bound only: a negative debounce is treated as 0 by the triage hook. */
const atLeastZero = (v: number | undefined) => (v === undefined ? v : Math.max(0, v));

/**
 * Everything about tasks as tasks: where a new one lands, smart creation, and
 * how a finished session reports back onto its task.
 */
export function TasksSection({ config, onSave, onReload }: Props) {
  const integrations = useIntegrations();
  const projects = useProjectRegistry();
  // The app-wide store answers until config has the key (default hidden).
  const storeShowPriority = useShowPriority();
  const save = useSerialSave(config, onSave);
  const showPriority = useOptimisticSetting<boolean>(
    config.ui?.show_priority ?? storeShowPriority,
    (v) => save((c) => ({ ui: { ...(c.ui ?? {}), show_priority: v } }), { rowKey: 'tasks.show-priority' }),
    { rowKey: 'tasks.show-priority' },
  );
  const saveDefaults = (patch: Partial<NonNullable<Config['defaults']>>, rowKey: string) =>
    save((c) => ({ defaults: { ...(c.defaults ?? {}), ...patch } as Config['defaults'] }), { rowKey });
  const priority = useOptimisticSetting<TaskPriority>(
    config.defaults?.priority ?? 'none',
    (v) => saveDefaults({ priority: v }, 'tasks.default-priority'),
    { rowKey: 'tasks.default-priority' },
  );
  const platform = useOptimisticSetting<string>(
    config.defaults?.platform ?? 'local',
    (v) => saveDefaults({ platform: v }, 'tasks.platform'),
    { rowKey: 'tasks.platform' },
  );
  // Empty = Inbox. Never persist a literal "Inbox": that would create a real project.
  const project = useCommitField<string>(
    config.defaults?.project ?? '',
    (v) => saveDefaults({ project: v.trim() || undefined }, 'tasks.default-project'),
    { rowKey: 'tasks.default-project', kind: 'text' },
  );
  const saveTriage = (patch: Record<string, unknown>, rowKey: string) =>
    // Spread config.agent: updateConfig replaces the whole `agent` key.
    save((c) => ({ agent: { ...c.agent, triage: { ...c.agent?.triage, ...patch } } } as Partial<Config>), { rowKey });
  const notify = useOptimisticSetting<TriageNotifyMode>(
    config.agent?.triage?.notify_mode ?? 'off',
    (v) => saveTriage({ notify_mode: v }, 'tasks.triage-notify'),
    { rowKey: 'tasks.triage-notify' },
  );
  const debounce = useCommitField<number | undefined>(
    config.agent?.triage?.debounce_minutes,
    (v) => saveTriage({ debounce_minutes: v }, 'tasks.triage-debounce'),
    { rowKey: 'tasks.triage-debounce', kind: 'number', clamp: atLeastZero },
  );

  const projectWarning = unknownProjectWarning(project.inputProps.value, projects.loaded, projects.isKnownProject);

  return (
    <SettingsSection id="tasks" title="Tasks">
      <SettingsGroup>
        <SettingsRow
          label="Show task priority"
          help="Priority stays stored and sortable when hidden."
          htmlFor="settings-show-priority"
          error={showPriority.error}
          control={
            <ToggleSwitch
              id="settings-show-priority"
              checked={showPriority.value}
              busy={showPriority.busy}
              onChange={showPriority.set}
            />
          }
        />
        {/* Only meaningful while priority is drawn; otherwise it sets a field nothing shows. */}
        {showPriority.value && (
          <SettingsRow
            indent
            label="Default priority"
            htmlFor="settings-priority"
            error={priority.error}
            control={
              <select
                id="settings-priority"
                className="settings-select"
                value={priority.value}
                onChange={(e) => priority.set(e.target.value as TaskPriority)}
              >
                <option value="none">None (untriaged)</option>
                <option value="backlog">Backlog</option>
                <option value="important">Important</option>
                <option value="immediate">Immediate</option>
              </select>
            }
          />
        )}
        <SettingsRow
          label="Default project"
          help={projectWarning ?? 'Where new tasks land when none is given.'}
          state={projectWarning ? 'warning' : undefined}
          htmlFor="settings-project"
          error={project.error}
          data-testid="settings-default-project-row"
          control={
            <>
              <input
                id="settings-project"
                type="text"
                className="settings-input settings-input--short"
                placeholder="Inbox"
                list="settings-project-options"
                autoComplete="off"
                {...project.inputProps}
              />
              <datalist id="settings-project-options">
                {projects.projectNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </>
          }
        />
        <SettingsRow
          label="Quick add creates tasks in"
          help="Walnut is instant and never synced; a connected service creates the task there."
          htmlFor="settings-platform"
          error={platform.error}
          control={
            <select
              id="settings-platform"
              className="settings-select"
              value={platform.value}
              onChange={(e) => platform.set(e.target.value)}
            >
              <option value="local">Walnut (this device, instant)</option>
              {integrations.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          }
        />
      </SettingsGroup>

      <SmartTaskCreation config={config} onSave={onSave} onReload={onReload} />

      {/* A TASK concern (the task's note/phase and its notifications), merely
          triggered by a session turn; no summarizer agent runs. */}
      <SettingsGroup heading="After a session finishes" data-testid="tasks-after-session">
        <SettingsRow
          label="Tell Ask Walnut"
          help="The task summary always updates; this only decides whether chat hears about it."
          error={notify.error}
          control={
            <SegmentedControl<TriageNotifyMode>
              id="triage-notify-mode"
              aria-label="Tell Ask Walnut"
              value={notify.value}
              options={NOTIFY_OPTIONS}
              onChange={notify.set}
            />
          }
        />
        <SettingsRow
          label="Wait before summarizing"
          help="Turns inside this quiet window collapse into one summary; 0 summarizes every turn."
          htmlFor="triage-debounce"
          error={debounce.error}
          control={<NumberInput id="triage-debounce" field={debounce.inputProps} unit="minutes" placeholder="4" min={0} />}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
