import { Link } from 'react-router-dom';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { useSerialSave, type OnSave } from './GeneralSection';
import { TriageRoutingRules } from './TriageRoutingRules';

interface Props {
  config: Config;
  onSave: OnSave;
}

/** Slack only: new mail goes to the mail router since 2026-11-14 (an old 'mail' is ignored). */
type TriageSource = 'slack';
type TriageMode = 'ask' | 'assist';
type TriageBlock = NonNullable<Config['triage']>;

/**
 * Every default here MUST match the server's reader (src/core/triage/config.ts).
 * Repeated rather than imported because `@open-walnut/core` maps to
 * src/core/types.ts alone. Opening the section never writes: every write is an
 * edit (a flip, a pick, or a committed text field).
 */
const DEFAULT_EVERY = '30m';
const DEFAULT_EVERY_MESSAGES = 20;
const ALL_SOURCES: TriageSource[] = ['slack'];
const DEFAULT_MODE: TriageMode = 'ask';
const DEFAULT_ACTIVE_HOURS = '08:00-22:00';
const SOURCE_LABELS: Record<TriageSource, string> = { slack: 'Slack' };

/**
 * Toggle one source, keeping the canonical order (pure, unit tested). A stored
 * source this build no longer knows (an old 'mail') is dropped on the next toggle.
 */
export function toggleSource(sources: readonly string[], source: TriageSource, on: boolean): TriageSource[] {
  return ALL_SOURCES.filter((s) => (s === source ? on : sources.includes(s)));
}

export function TriageSection({ config, onSave }: Props) {
  const t = config.triage;
  // Spread config.triage so a sibling key this section does NOT render
  // survives: updateConfig replaces the whole `triage` key.
  const save = useSerialSave(config, onSave);
  const saveTriage = (patch: Partial<TriageBlock>, rowKey: string) =>
    save((c) => ({ triage: { ...c.triage, ...patch } as TriageBlock }), { rowKey });

  const enabled = useOptimisticSetting<boolean>(t?.enabled ?? false, (v) => saveTriage({ enabled: v }, 'triage.enabled'), { rowKey: 'triage.enabled' });
  const sources = useOptimisticSetting<TriageSource[]>(t?.sources ?? ALL_SOURCES, (v) => saveTriage({ sources: v }, 'triage.sources'), { rowKey: 'triage.sources' });
  const mode = useOptimisticSetting<TriageMode>(t?.mode ?? DEFAULT_MODE, (v) => saveTriage({ mode: v }, 'triage.mode'), { rowKey: 'triage.mode' });
  const every = useCommitField<string>(
    t?.every ?? DEFAULT_EVERY,
    (v) => saveTriage({ every: v.trim() || DEFAULT_EVERY }, 'triage.every'),
    { rowKey: 'triage.every', kind: 'text' },
  );
  const messages = useCommitField<number | undefined>(
    t?.every_messages ?? DEFAULT_EVERY_MESSAGES,
    (v) => saveTriage({ every_messages: v ?? DEFAULT_EVERY_MESSAGES }, 'triage.every-messages'),
    { rowKey: 'triage.every-messages', kind: 'number' },
  );
  const hours = useCommitField<string>(
    t?.active_hours ?? DEFAULT_ACTIVE_HOURS,
    (v) => saveTriage({ active_hours: v.trim() }, 'triage.hours'),
    { rowKey: 'triage.hours', kind: 'text' },
  );
  const off = !enabled.value;

  // Cmd+S submits this form: commit whatever text is still being typed.
  const handleSubmit = async () => {
    await Promise.all([every.flush(), messages.flush(), hours.flush()]);
  };

  return (
    <SectionCard id="triage" title="Inbox Triage" onSave={handleSubmit} showSave={false}>
      {/* Since 2026-11-14 every mailbox is bound to a mail router, which triages each new mail itself. */}
      <p className="settings-row-help triage-mail-router-note" data-testid="triage-mail-router-note">
        New mail goes to the mail router, not here. <Link to="/org">Open Org</Link>
      </p>
      <SettingsGroup>
        <SettingsRow label="Inbox triage" help="Works through new Slack messages against your projects and tasks." htmlFor="inbox-triage-enabled"
          error={enabled.error}
          control={<ToggleSwitch id="inbox-triage-enabled" checked={enabled.value} busy={enabled.busy} onChange={enabled.set} />} />
        <SettingsRow indent disabled={off} label="Interval" help={'A duration such as 30m or 1h; at least 5m, and "0" turns it off.'}
          htmlFor="inbox-triage-every" error={every.error} data-testid="inbox-triage-every-row"
          control={<input id="inbox-triage-every" type="text" data-no-draft="autosave" className="settings-input settings-input--number" placeholder={DEFAULT_EVERY} disabled={off} {...every.inputProps} />} />
        <SettingsRow indent disabled={off} label="Or every" help="0 runs on the interval only." htmlFor="inbox-triage-every-messages"
          error={messages.error} data-testid="inbox-triage-messages-row"
          control={<NumberInput id="inbox-triage-every-messages" field={messages.inputProps} unit="messages" placeholder={String(DEFAULT_EVERY_MESSAGES)} min={0} disabled={off} />} />
        <SettingsRow indent disabled={off} label="Active hours" help="Empty runs around the clock." htmlFor="inbox-triage-hours"
          error={hours.error} data-testid="inbox-triage-hours-row"
          control={<input id="inbox-triage-hours" type="text" data-no-draft="autosave" className="settings-input settings-input--number" placeholder={DEFAULT_ACTIVE_HOURS} disabled={off} {...hours.inputProps} />} />
      </SettingsGroup>

      <SettingsGroup heading="Sources" className="settings-checklist" footer="With no source ticked, Inbox Triage does not run."
        disabled={off} data-testid="inbox-triage-sources">
        {ALL_SOURCES.map((source) => (
          <SettingsCheckbox
            key={source}
            data-testid={`inbox-triage-source-${source}`}
            checked={sources.value.includes(source)}
            disabled={off}
            label={SOURCE_LABELS[source]}
            onChange={(on) => sources.set(toggleSource(sources.value, source, on))}
          />
        ))}
        {sources.error && <p className="settings-row-error" role="alert">{sources.error}</p>}
      </SettingsGroup>

      <SettingsGroup heading="Actions">
        <SettingsRow disabled={off} label="Mode" help="Posting to Slack always needs your approval." error={mode.error}
          data-testid="inbox-triage-mode-row"
          control={
            <SegmentedControl<TriageMode>
              id="inbox-triage-mode"
              aria-label="Mode"
              value={mode.value}
              disabled={off}
              onChange={mode.set}
              options={[
                { value: 'ask', label: 'Ask', testId: 'inbox-triage-mode-ask', title: 'Hands items to their tasks, asks you about the rest' },
                { value: 'assist', label: 'Assist', testId: 'inbox-triage-mode-assist', title: 'May also update tasks' },
              ]}
            />
          } />
      </SettingsGroup>

      <TriageRoutingRules off={off} />
    </SectionCard>
  );
}
