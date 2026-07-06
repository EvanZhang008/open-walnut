import { useState, useEffect, useMemo } from 'react';
import type {
  Routine, CreateRoutineInput, RoutineSchedule, RoutineExecutorRef,
  ExecutorInfo, ExecutorOptions, ExecutorFieldSpec,
} from '@/api/routines';
import { describeSchedule } from '@/utils/routine-format';

interface RoutineFormProps {
  /** Prefill from an AI draft or an existing routine (edit mode). */
  draft?: CreateRoutineInput;
  routine?: Routine;
  executors: ExecutorInfo[];
  options: ExecutorOptions;
  onSave: (input: CreateRoutineInput) => Promise<void>;
  onCancel: () => void;
}

// ── Trigger presets (Claude-cloud-app style segmented control) ──────────────

type TriggerPreset = 'once' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';

const PRESETS: Array<{ key: TriggerPreset; label: string }> = [
  { key: 'once', label: 'Once' },
  { key: 'hourly', label: 'Hourly' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekdays', label: 'Weekdays' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'custom', label: 'Custom' },
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface TriggerState {
  preset: TriggerPreset;
  time: string;          // "HH:MM" for daily/weekdays/weekly
  minute: number;        // for hourly (:MM)
  weeklyDay: number;     // 0-6 for weekly
  at: string;            // datetime-local for once
  customKind: 'cron' | 'every';
  expr: string;
  tz: string;
  everyMin: number;
}

const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function defaultTrigger(): TriggerState {
  return {
    preset: 'weekdays', time: '09:00', minute: 0, weeklyDay: 1, at: '',
    customKind: 'cron', expr: '0 9 * * 1-5', tz: localTz(), everyMin: 60,
  };
}

const pad = (n: number) => n.toString().padStart(2, '0');

/** Map an existing schedule back onto the closest preset (else Custom). */
function scheduleToTrigger(s: RoutineSchedule | undefined): TriggerState {
  const t = defaultTrigger();
  if (!s) return t;
  if (s.kind === 'at') {
    const d = new Date(s.at);
    t.preset = 'once';
    t.at = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return t;
  }
  if (s.kind === 'every') {
    t.preset = 'custom';
    t.customKind = 'every';
    t.everyMin = Math.max(1, Math.round(s.everyMs / 60_000));
    return t;
  }
  t.tz = s.tz ?? localTz();
  t.expr = s.expr;
  const m = s.expr.trim().match(/^(\d{1,2})\s+(\S+)\s+\*\s+\*\s+(\S+)$/);
  if (m) {
    const [, min, hour, dow] = m;
    if (hour === '*' && dow === '*') {
      t.preset = 'hourly'; t.minute = Number(min); return t;
    }
    if (/^\d{1,2}$/.test(hour)) {
      t.time = `${pad(Number(hour))}:${pad(Number(min))}`;
      if (dow === '*') { t.preset = 'daily'; return t; }
      if (dow === '1-5') { t.preset = 'weekdays'; return t; }
      if (/^\d$/.test(dow)) { t.preset = 'weekly'; t.weeklyDay = Number(dow); return t; }
    }
  }
  t.preset = 'custom';
  t.customKind = 'cron';
  return t;
}

function triggerToSchedule(t: TriggerState): RoutineSchedule | null {
  const tz = t.tz || localTz();
  if (t.preset === 'once') {
    if (!t.at) return null;
    return { kind: 'at', at: new Date(t.at).toISOString() };
  }
  if (t.preset === 'hourly') {
    return { kind: 'cron', expr: `${t.minute} * * * *`, tz };
  }
  if (t.preset === 'custom') {
    if (t.customKind === 'every') {
      if (!t.everyMin || t.everyMin <= 0) return null;
      return { kind: 'every', everyMs: t.everyMin * 60_000 };
    }
    if (!t.expr.trim()) return null;
    return { kind: 'cron', expr: t.expr.trim(), tz };
  }
  const [h, m] = t.time.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const dow = t.preset === 'daily' ? '*' : t.preset === 'weekdays' ? '1-5' : String(t.weeklyDay);
  return { kind: 'cron', expr: `${m} ${h} * * ${dow}`, tz };
}

/** Short tz name for the header line, e.g. "PDT". */
function tzAbbrev(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

// ── Form ─────────────────────────────────────────────────────────────────────

export function RoutineForm({ draft, routine, executors, options, onSave, onCancel }: RoutineFormProps) {
  const source: CreateRoutineInput | undefined = routine
    ? { name: routine.name, description: routine.description, schedule: routine.schedule, executor: routine.executor ?? { type: 'walnut-agent', config: {} } }
    : draft;

  const [name, setName] = useState(source?.name ?? '');
  const [trigger, setTrigger] = useState<TriggerState>(() => scheduleToTrigger(source?.schedule));
  const [executorType, setExecutorType] = useState(source?.executor?.type ?? 'walnut-agent');
  const [config, setConfig] = useState<Record<string, unknown>>(source?.executor?.config ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-prefill when a new draft arrives (user drafted again)
  useEffect(() => {
    if (!draft) return;
    setName(draft.name ?? '');
    setTrigger(scheduleToTrigger(draft.schedule));
    setExecutorType(draft.executor?.type ?? 'walnut-agent');
    setConfig(draft.executor?.config ?? {});
    setError(null);
  }, [draft]);

  // Close on Escape, like every other modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const executorInfo = executors.find((e) => e.type === executorType);
  const setField = (fieldName: string, value: unknown) =>
    setConfig((prev) => ({ ...prev, [fieldName]: value }));

  const schedule = useMemo(() => triggerToSchedule(trigger), [trigger]);
  const headerLine = useMemo(() => {
    if (!schedule) return 'Select a trigger';
    const abbr = schedule.kind === 'cron' ? tzAbbrev(schedule.tz ?? localTz()) : '';
    return `Runs ${describeSchedule(schedule).replace(/^./, (c) => c.toLowerCase())}${abbr ? ` ${abbr}` : ''}`;
  }, [schedule]);

  // Instructions + model are hoisted into the prominent top section; the
  // remaining executor fields (cwd, host, timeouts…) render under "Run with".
  const instructionsField = executorInfo?.configSchema.find((f) => f.name === 'instructions');
  const modelField = executorInfo?.configSchema.find((f) => f.name === 'model');
  const restFields = (executorInfo?.configSchema ?? []).filter((f) => f.name !== 'instructions' && f.name !== 'model');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (!schedule) { setError('A valid trigger is required'); return; }
    for (const f of executorInfo?.configSchema ?? []) {
      const v = config[f.name];
      if (f.required && (typeof v !== 'string' || !v.trim())) {
        setError(`${f.label} is required`);
        return;
      }
    }
    const executor: RoutineExecutorRef = { type: executorType, config: config as RoutineExecutorRef['config'] };
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), schedule, executor });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  function renderField(f: ExecutorFieldSpec) {
    const value = config[f.name];
    if (f.kind === 'textarea') {
      return (
        <textarea
          id={`routine-f-${f.name}`}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => setField(f.name, e.target.value)}
          placeholder={f.placeholder}
          rows={6}
          style={{ resize: 'vertical' }}
        />
      );
    }
    if (f.kind === 'select') {
      const opts = f.optionsKey === 'hosts' ? options.hosts : f.optionsKey === 'models' ? options.models : [];
      const defaultLabel = f.optionsKey === 'hosts' ? 'Local' : 'Default';
      return (
        <select
          id={`routine-f-${f.name}`}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => setField(f.name, e.target.value || undefined)}
        >
          <option value="">{defaultLabel}</option>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    if (f.kind === 'number') {
      return (
        <input
          id={`routine-f-${f.name}`}
          type="number"
          min="1"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => setField(f.name, e.target.value ? Number(e.target.value) : undefined)}
        />
      );
    }
    return (
      <input
        id={`routine-f-${f.name}`}
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => setField(f.name, e.target.value)}
        placeholder={f.placeholder}
        className={f.kind === 'path' ? 'font-mono' : undefined}
      />
    );
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal card routine-modal">
        <div className="routine-modal-header">
          <h3>{routine ? 'Edit routine' : 'New routine'}</h3>
          <button type="button" className="routine-modal-close" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          {error && <div className="cron-form-error">{error}</div>}

          <div className="form-group">
            <label htmlFor="routine-name">Name *</label>
            <input
              id="routine-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Briefing"
            />
          </div>

          {instructionsField && (
            <div className="form-group">
              <label htmlFor="routine-f-instructions">Instructions</label>
              <div className="routine-instructions-box">
                <textarea
                  id="routine-f-instructions"
                  value={typeof config.instructions === 'string' ? config.instructions : ''}
                  onChange={(e) => setField('instructions', e.target.value)}
                  placeholder={instructionsField.placeholder ?? 'What should this routine do each run?'}
                  rows={8}
                />
                {modelField && (
                  <div className="routine-instructions-footer">
                    <select
                      className="routine-model-select"
                      value={typeof config.model === 'string' ? config.model : ''}
                      onChange={(e) => setField('model', e.target.value || undefined)}
                      title="Model"
                    >
                      <option value="">Default model</option>
                      {options.models.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="form-group routine-trigger">
            <label>Select a trigger</label>
            <div className="routine-trigger-box">
              <div className="routine-trigger-header">
                <span className="routine-trigger-clock">🕐</span>
                <span>{headerLine}</span>
              </div>
              <div className="routine-trigger-presets" role="tablist">
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    role="tab"
                    aria-selected={trigger.preset === p.key}
                    className={`routine-trigger-preset${trigger.preset === p.key ? ' active' : ''}`}
                    onClick={() => setTrigger({ ...trigger, preset: p.key })}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {(trigger.preset === 'daily' || trigger.preset === 'weekdays' || trigger.preset === 'weekly') && (
                <div className="routine-trigger-row">
                  {trigger.preset === 'weekly' && (
                    <select
                      value={trigger.weeklyDay}
                      onChange={(e) => setTrigger({ ...trigger, weeklyDay: Number(e.target.value) })}
                      aria-label="Day of week"
                    >
                      {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                  )}
                  <span className="routine-trigger-at">At</span>
                  <input
                    type="time"
                    value={trigger.time}
                    onChange={(e) => setTrigger({ ...trigger, time: e.target.value })}
                    aria-label="Time"
                  />
                </div>
              )}

              {trigger.preset === 'hourly' && (
                <div className="routine-trigger-row">
                  <span className="routine-trigger-at">At minute</span>
                  <input
                    type="number" min="0" max="59" value={trigger.minute}
                    onChange={(e) => setTrigger({ ...trigger, minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
                    aria-label="Minute of the hour"
                    style={{ width: 72 }}
                  />
                </div>
              )}

              {trigger.preset === 'once' && (
                <div className="routine-trigger-row">
                  <span className="routine-trigger-at">At</span>
                  <input
                    type="datetime-local"
                    value={trigger.at}
                    onChange={(e) => setTrigger({ ...trigger, at: e.target.value })}
                    aria-label="Date and time"
                  />
                </div>
              )}

              {trigger.preset === 'custom' && (
                <div className="routine-trigger-custom">
                  <div className="routine-trigger-row">
                    <label className="cron-form-radio">
                      <input type="radio" name="routine-custom-kind" checked={trigger.customKind === 'cron'}
                        onChange={() => setTrigger({ ...trigger, customKind: 'cron' })} />
                      <span>Cron expression</span>
                    </label>
                    <label className="cron-form-radio">
                      <input type="radio" name="routine-custom-kind" checked={trigger.customKind === 'every'}
                        onChange={() => setTrigger({ ...trigger, customKind: 'every' })} />
                      <span>Interval</span>
                    </label>
                  </div>
                  {trigger.customKind === 'cron' ? (
                    <div className="form-row">
                      <div className="form-group">
                        <input type="text" className="font-mono" value={trigger.expr}
                          onChange={(e) => setTrigger({ ...trigger, expr: e.target.value })} placeholder="0 9 * * 1-5"
                          aria-label="Cron expression" />
                      </div>
                      <div className="form-group">
                        <input type="text" value={trigger.tz}
                          onChange={(e) => setTrigger({ ...trigger, tz: e.target.value })} placeholder="America/Los_Angeles"
                          aria-label="Timezone" />
                      </div>
                    </div>
                  ) : (
                    <div className="routine-trigger-row">
                      <span className="routine-trigger-at">Every</span>
                      <input type="number" min="1" value={trigger.everyMin}
                        onChange={(e) => setTrigger({ ...trigger, everyMin: Number(e.target.value) })}
                        aria-label="Interval minutes" style={{ width: 88 }} />
                      <span className="routine-trigger-at">minutes</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="form-group">
            <label>Run with</label>
            <div className="cron-form-radio-group">
              {executors.map((ex) => (
                <label key={ex.type} className="cron-form-radio" title={ex.description}>
                  <input type="radio" name="routine-executor" checked={executorType === ex.type}
                    onChange={() => setExecutorType(ex.type)} />
                  <span>{ex.label}</span>
                </label>
              ))}
            </div>
            {executorInfo && <p className="text-xs text-muted">{executorInfo.description}</p>}
          </div>
          {restFields.map((f) => (
            <div className="form-group" key={f.name}>
              <label htmlFor={`routine-f-${f.name}`}>{f.label}{f.required ? ' *' : ''}</label>
              {renderField(f)}
            </div>
          ))}

          <div className="form-actions">
            <button type="button" className="btn" onClick={onCancel} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : routine ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
