import { useEffect, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsGroup, SettingsLoadingRow, SettingsNotice, SettingsRow, SettingsSection } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { apiGet, apiPut } from '@/api/client';
import { useSerialSave, type OnSave } from './GeneralSection';

interface Props {
  config: Config;
  onSave: OnSave;
}

type HeartbeatBlock = NonNullable<Config['heartbeat']>;

/** The checklist editor: its own file (HEARTBEAT.md), saved on blur. */
function ChecklistRows() {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<{ content: string }>('/api/heartbeat/checklist')
      .then((r) => setContent(r.content))
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, []);
  // The file's own API; the field reports Saved / row errors itself.
  const field = useCommitField<string>(
    content,
    (v) => apiPut('/api/heartbeat/checklist', { content: v }).then(() => setContent(v)),
    { rowKey: 'heartbeat.checklist', kind: 'text', multiline: true },
  );
  if (loading) return <SettingsLoadingRow />;
  if (loadError) return <SettingsNotice kind="error" role="alert">Couldn&apos;t load the checklist: {loadError}</SettingsNotice>;
  return (
    <div className="settings-row settings-row-stacked settings-editor-row" data-wide="true">
      <label className="settings-row-label" htmlFor="heartbeat-editor">Items Walnut works through</label>
      <textarea
        id="heartbeat-editor"
        className="settings-textarea settings-editor"
        rows={10}
        spellCheck={false}
        placeholder={'# Heartbeat checklist\n- [ ] Check pipeline status\n- [ ] Review open PRs'}
        {...field.inputProps}
      />
      {field.error && <p className="settings-row-error settings-row-error-inline" role="alert">{field.error}</p>}
    </div>
  );
}

/** Walnut wakes on this schedule and works through HEARTBEAT.md. */
export function HeartbeatSection({ config, onSave }: Props) {
  const hb = config.heartbeat;
  const save = useSerialSave(config, onSave);
  const saveHeartbeat = (patch: Partial<HeartbeatBlock>, rowKey: string) =>
    save((c) => ({ heartbeat: { enabled: c.heartbeat?.enabled ?? false, every: c.heartbeat?.every ?? '30m', ...c.heartbeat, ...patch } as HeartbeatBlock }), { rowKey });
  const enabled = useOptimisticSetting<boolean>(
    hb?.enabled ?? false,
    (v) => saveHeartbeat({ enabled: v }, 'heartbeat.enabled'),
    { rowKey: 'heartbeat.enabled' },
  );
  const every = useCommitField<string>(
    hb?.every ?? '30m',
    (v) => saveHeartbeat({ every: v.trim() || '30m' }, 'heartbeat.every'),
    { rowKey: 'heartbeat.every', kind: 'text' },
  );
  const hours = useCommitField<string>(
    hb?.activeHours ?? '',
    (v) => saveHeartbeat({ activeHours: v.trim() || undefined }, 'heartbeat.hours'),
    { rowKey: 'heartbeat.hours', kind: 'text' },
  );
  const off = !enabled.value;

  return (
    <SettingsSection id="heartbeat" title="Heartbeat">
      <SettingsGroup>
        <SettingsRow label="Heartbeat" help="Walnut checks in on its own." htmlFor="hb-enabled" error={enabled.error}
          control={<ToggleSwitch id="hb-enabled" checked={enabled.value} busy={enabled.busy} onChange={enabled.set} />} />
        <SettingsRow indent disabled={off} label="Interval" help="A duration such as 30m or 1h." htmlFor="hb-every" error={every.error}
          data-testid="hb-every-row"
          control={<input id="hb-every" type="text" className="settings-input settings-input--number" placeholder="30m" disabled={off} {...every.inputProps} />} />
        <SettingsRow indent disabled={off} label="Active hours" help="Empty runs around the clock." htmlFor="hb-hours" error={hours.error}
          data-testid="hb-hours-row"
          control={<input id="hb-hours" type="text" className="settings-input settings-input--number" placeholder="08:00-22:00" disabled={off} {...hours.inputProps} />} />
      </SettingsGroup>
      <SettingsGroup heading="Checklist" footer={<>Stored in <code>HEARTBEAT.md</code>.</>} data-testid="heartbeat-checklist">
        <ChecklistRows />
      </SettingsGroup>
    </SettingsSection>
  );
}
