import { useState, useEffect } from 'react';
import type {
  Routine, CreateRoutineInput, RoutineSchedule, RoutineExecutorRef,
  ExecutorInfo, ExecutorOptions, ExecutorFieldSpec,
} from '@/api/routines';

interface RoutineFormProps {
  /** Prefill from an AI draft or an existing routine (edit mode). */
  draft?: CreateRoutineInput;
  routine?: Routine;
  executors: ExecutorInfo[];
  options: ExecutorOptions;
  onSave: (input: CreateRoutineInput) => Promise<void>;
  onCancel: () => void;
}

type ScheduleKind = 'cron' | 'every' | 'at';

function scheduleToState(s: RoutineSchedule | undefined) {
  if (!s) return { kind: 'cron' as ScheduleKind, expr: '0 9 * * 1-5', tz: Intl.DateTimeFormat().resolvedOptions().timeZone, everyMin: 60, at: '' };
  if (s.kind === 'cron') return { kind: 'cron' as ScheduleKind, expr: s.expr, tz: s.tz ?? '', everyMin: 60, at: '' };
  if (s.kind === 'every') return { kind: 'every' as ScheduleKind, expr: '', tz: '', everyMin: Math.max(1, Math.round(s.everyMs / 60_000)), at: '' };
  const d = new Date(s.at);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { kind: 'at' as ScheduleKind, expr: '', tz: '', everyMin: 60, at: local };
}

export function RoutineForm({ draft, routine, executors, options, onSave, onCancel }: RoutineFormProps) {
  const source: CreateRoutineInput | undefined = routine
    ? { name: routine.name, description: routine.description, schedule: routine.schedule, executor: routine.executor ?? { type: 'walnut-agent', config: {} } }
    : draft;

  const [name, setName] = useState(source?.name ?? '');
  const [sched, setSched] = useState(() => scheduleToState(source?.schedule));
  const [executorType, setExecutorType] = useState(source?.executor?.type ?? 'walnut-agent');
  const [config, setConfig] = useState<Record<string, unknown>>(source?.executor?.config ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-prefill when a new draft arrives (user drafted again)
  useEffect(() => {
    if (!draft) return;
    setName(draft.name ?? '');
    setSched(scheduleToState(draft.schedule));
    setExecutorType(draft.executor?.type ?? 'walnut-agent');
    setConfig(draft.executor?.config ?? {});
    setError(null);
  }, [draft]);

  const executorInfo = executors.find((e) => e.type === executorType);
  const setField = (fieldName: string, value: unknown) =>
    setConfig((prev) => ({ ...prev, [fieldName]: value }));

  function buildSchedule(): RoutineSchedule | null {
    if (sched.kind === 'cron') {
      if (!sched.expr.trim()) return null;
      return sched.tz ? { kind: 'cron', expr: sched.expr.trim(), tz: sched.tz } : { kind: 'cron', expr: sched.expr.trim() };
    }
    if (sched.kind === 'every') {
      if (!sched.everyMin || sched.everyMin <= 0) return null;
      return { kind: 'every', everyMs: sched.everyMin * 60_000 };
    }
    if (!sched.at) return null;
    return { kind: 'at', at: new Date(sched.at).toISOString() };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    const schedule = buildSchedule();
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
    <div className="cron-form card routine-form">
      <h3 className="cron-form-title">{routine ? 'Edit Routine' : 'New Routine'}</h3>
      <form onSubmit={handleSubmit}>
        {error && <div className="cron-form-error">{error}</div>}

        <div className="cron-form-section">
          <div className="form-group">
            <label htmlFor="routine-name">Name</label>
            <input
              id="routine-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekday PR summary"
            />
          </div>
        </div>

        <div className="cron-form-section">
          <div className="form-group">
            <label>Trigger</label>
            <div className="cron-form-radio-group">
              {(['cron', 'every', 'at'] as const).map((k) => (
                <label key={k} className="cron-form-radio">
                  <input type="radio" name="routine-sched" checked={sched.kind === k} onChange={() => setSched({ ...sched, kind: k })} />
                  <span>{k === 'cron' ? 'Schedule' : k === 'every' ? 'Interval' : 'One time'}</span>
                </label>
              ))}
            </div>
          </div>
          {sched.kind === 'cron' && (
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="routine-expr">Cron expression</label>
                <input id="routine-expr" type="text" className="font-mono" value={sched.expr}
                  onChange={(e) => setSched({ ...sched, expr: e.target.value })} placeholder="0 9 * * 1-5" />
              </div>
              <div className="form-group">
                <label htmlFor="routine-tz">Timezone</label>
                <input id="routine-tz" type="text" value={sched.tz}
                  onChange={(e) => setSched({ ...sched, tz: e.target.value })} placeholder="America/Los_Angeles" />
              </div>
            </div>
          )}
          {sched.kind === 'every' && (
            <div className="form-group">
              <label htmlFor="routine-every">Every (minutes)</label>
              <input id="routine-every" type="number" min="1" value={sched.everyMin}
                onChange={(e) => setSched({ ...sched, everyMin: Number(e.target.value) })} />
            </div>
          )}
          {sched.kind === 'at' && (
            <div className="form-group">
              <label htmlFor="routine-at">Date &amp; time</label>
              <input id="routine-at" type="datetime-local" value={sched.at}
                onChange={(e) => setSched({ ...sched, at: e.target.value })} />
            </div>
          )}
        </div>

        <div className="cron-form-section">
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
          {(executorInfo?.configSchema ?? []).map((f) => (
            <div className="form-group" key={f.name}>
              <label htmlFor={`routine-f-${f.name}`}>{f.label}{f.required ? ' *' : ''}</label>
              {renderField(f)}
            </div>
          ))}
        </div>

        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : routine ? 'Update' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
