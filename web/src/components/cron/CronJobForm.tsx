import { useState, useEffect } from 'react';
import type { CronJob, CronAction, CreateCronJobInput, UpdateCronJobInput, CronSchedule, CronPayload, CronDelivery, InitProcessor } from '@/api/cron';
import { fetchCronActions } from '@/api/cron';

interface CronJobFormProps {
  job?: CronJob; // undefined = create mode, defined = edit mode
  onSave: (input: CreateCronJobInput | UpdateCronJobInput) => Promise<void>;
  onCancel: () => void;
}

type ScheduleKind = 'at' | 'every' | 'cron';
type IntervalUnit = 'minutes' | 'hours';

export function CronJobForm({ job, onSave, onCancel }: CronJobFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Schedule
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('every');
  const [atValue, setAtValue] = useState('');
  const [everyValue, setEveryValue] = useState(10);
  const [everyUnit, setEveryUnit] = useState<IntervalUnit>('minutes');
  const [cronExpr, setCronExpr] = useState('');
  const [cronTz, setCronTz] = useState('');

  // Session target & payload
  const [sessionTarget, setSessionTarget] = useState<'main' | 'isolated'>('main');
  const [systemEventText, setSystemEventText] = useState('');
  const [agentMessage, setAgentMessage] = useState('');

  // Init processor
  const [hasInitProcessor, setHasInitProcessor] = useState(false);
  const [ipActionId, setIpActionId] = useState('');
  const [ipParams, setIpParams] = useState('');
  const [ipInvokeAgent, setIpInvokeAgent] = useState(true);
  const [ipTargetAgent, setIpTargetAgent] = useState('');
  const [ipTargetAgentModel, setIpTargetAgentModel] = useState('');
  const [availableActions, setAvailableActions] = useState<CronAction[]>([]);

  // Wake mode & delivery
  const [wakeMode, setWakeMode] = useState<'now' | 'next-cycle'>('next-cycle');
  const [deliveryMode, setDeliveryMode] = useState<'none' | 'announce'>('none');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch available actions on mount
  useEffect(() => {
    fetchCronActions().then(setAvailableActions).catch((err) => console.warn('Failed to fetch cron actions:', err));
  }, []);

  // Populate from existing job in edit mode
  useEffect(() => {
    if (!job) return;
    setName(job.name);
    setDescription(job.description ?? '');
    setSessionTarget(job.sessionTarget);
    setWakeMode(job.wakeMode);
    setDeliveryMode(job.delivery?.mode ?? 'none');

    // Schedule
    const s = job.schedule;
    setScheduleKind(s.kind);
    if (s.kind === 'at') {
      // Convert ISO string to datetime-local format
      const d = new Date(s.at);
      const pad = (n: number) => n.toString().padStart(2, '0');
      setAtValue(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    } else if (s.kind === 'every') {
      if (s.everyMs >= 3_600_000) {
        setEveryValue(Math.round(s.everyMs / 3_600_000));
        setEveryUnit('hours');
      } else {
        setEveryValue(Math.round(s.everyMs / 60_000));
        setEveryUnit('minutes');
      }
    } else if (s.kind === 'cron') {
      setCronExpr(s.expr);
      setCronTz(s.tz ?? '');
    }

    // Init processor
    if (job.initProcessor) {
      setHasInitProcessor(true);
      setIpActionId(job.initProcessor.actionId);
      setIpParams(job.initProcessor.params ? JSON.stringify(job.initProcessor.params, null, 2) : '');
      setIpInvokeAgent(job.initProcessor.invokeAgent !== false);
      setIpTargetAgent(job.initProcessor.targetAgent ?? '');
      setIpTargetAgentModel(job.initProcessor.targetAgentModel ?? '');
    }

    // Payload
    const p = job.payload;
    if (p.kind === 'systemEvent') {
      setSystemEventText(p.text);
    } else if (p.kind === 'agentTurn') {
      setAgentMessage(p.message);
    }
  }, [job]);

  function buildSchedule(): CronSchedule {
    switch (scheduleKind) {
      case 'at':
        return { kind: 'at', at: new Date(atValue).toISOString() };
      case 'every': {
        const multiplier = everyUnit === 'hours' ? 3_600_000 : 60_000;
        return { kind: 'every', everyMs: everyValue * multiplier };
      }
      case 'cron':
        return cronTz ? { kind: 'cron', expr: cronExpr, tz: cronTz } : { kind: 'cron', expr: cronExpr };
    }
  }

  function buildPayload(): CronPayload {
    if (sessionTarget === 'main') {
      return { kind: 'systemEvent', text: systemEventText };
    }
    return { kind: 'agentTurn', message: agentMessage };
  }

  function buildInitProcessor(): InitProcessor | undefined {
    if (!hasInitProcessor || !ipActionId) return undefined;
    const ip: InitProcessor = { actionId: ipActionId };
    if (ipParams.trim()) {
      try { ip.params = JSON.parse(ipParams); } catch { /* ignore parse error */ }
    }
    if (!ipInvokeAgent) ip.invokeAgent = false;
    if (ipTargetAgent.trim()) ip.targetAgent = ipTargetAgent.trim();
    if (ipTargetAgentModel.trim()) ip.targetAgentModel = ipTargetAgentModel.trim();
    return ip;
  }

  function buildDelivery(): CronDelivery | undefined {
    if (sessionTarget === 'main') return undefined;
    return { mode: deliveryMode };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    // Validate schedule inputs
    if (scheduleKind === 'at' && !atValue) {
      setError('Date/time is required for "at" schedule');
      return;
    }
    if (scheduleKind === 'every' && everyValue <= 0) {
      setError('Interval must be greater than 0');
      return;
    }
    if (scheduleKind === 'cron' && !cronExpr.trim()) {
      setError('Cron expression is required');
      return;
    }

    // Validate init processor
    if (hasInitProcessor && !ipActionId) {
      setError('Action is required when init processor is enabled');
      return;
    }
    if (hasInitProcessor && ipParams.trim()) {
      try {
        JSON.parse(ipParams);
      } catch {
        setError('Init processor params must be valid JSON');
        return;
      }
    }

    // Validate payload (skip if processor handles everything via targetAgent)
    const processorHandlesAll = hasInitProcessor && (ipTargetAgent.trim() || !ipInvokeAgent);
    if (!processorHandlesAll) {
      if (sessionTarget === 'main' && !systemEventText.trim()) {
        setError('System event text is required');
        return;
      }
      if (sessionTarget === 'isolated' && !agentMessage.trim()) {
        setError('Agent prompt is required');
        return;
      }
    }

    setSaving(true);
    setError(null);

    // When processor handles everything, use isolated + placeholder payload
    const effectiveSessionTarget = processorHandlesAll ? 'isolated' : sessionTarget;
    const effectivePayload: CronPayload = processorHandlesAll
      ? { kind: 'agentTurn', message: '(init processor output)' }
      : buildPayload();

    const input: CreateCronJobInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      schedule: buildSchedule(),
      sessionTarget: effectiveSessionTarget,
      wakeMode,
      initProcessor: buildInitProcessor(),
      payload: effectivePayload,
      delivery: processorHandlesAll ? undefined : buildDelivery(),
    };

    try {
      await onSave(input);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cron-form card">
      <h3 className="cron-form-title">{job ? 'Edit Job' : 'New Scheduled Job'}</h3>
      <form onSubmit={handleSubmit}>
        {error && <div className="cron-form-error">{error}</div>}

        <div className="cron-form-section">
          <div className="form-group">
            <label htmlFor="cron-name">Name</label>
            <input
              id="cron-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. MS To-Do Sync"
            />
          </div>
          <div className="form-group">
            <label htmlFor="cron-desc">Description (optional)</label>
            <input
              id="cron-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this job do?"
            />
          </div>
        </div>

        {(availableActions.length > 0 || hasInitProcessor) && (
          <div className="cron-form-section">
            <div className="form-group">
              <label className="cron-form-checkbox">
                <input
                  type="checkbox"
                  checked={hasInitProcessor}
                  onChange={(e) => setHasInitProcessor(e.target.checked)}
                />
                <span>Init Processor (run action before payload)</span>
              </label>
            </div>

            {hasInitProcessor && (
              <>
                <div className="form-group">
                  <label htmlFor="cron-ip-action">Action</label>
                  <select
                    id="cron-ip-action"
                    value={ipActionId}
                    onChange={(e) => setIpActionId(e.target.value)}
                  >
                    <option value="">Select an action...</option>
                    {availableActions.map((a) => (
                      <option key={a.id} value={a.id}>{a.id} — {a.description}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="cron-ip-params">Params (JSON, optional)</label>
                  <textarea
                    id="cron-ip-params"
                    value={ipParams}
                    onChange={(e) => setIpParams(e.target.value)}
                    placeholder='{}'
                    rows={2}
                    className="font-mono"
                    style={{ resize: 'vertical' }}
                  />
                </div>
                <div className="form-group">
                  <label className="cron-form-checkbox">
                    <input
                      type="checkbox"
                      checked={ipInvokeAgent}
                      onChange={(e) => setIpInvokeAgent(e.target.checked)}
                    />
                    <span>Pipe output to agent</span>
                  </label>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="cron-ip-target">Target Agent (optional)</label>
                    <input
                      id="cron-ip-target"
                      type="text"
                      value={ipTargetAgent}
                      onChange={(e) => setIpTargetAgent(e.target.value)}
                      placeholder="e.g. life-tracker"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="cron-ip-model">Model Override (optional)</label>
                    <input
                      id="cron-ip-model"
                      type="text"
                      value={ipTargetAgentModel}
                      onChange={(e) => setIpTargetAgentModel(e.target.value)}
                      placeholder="e.g. haiku"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <div className="cron-form-section">
          <div className="form-group">
            <label>Schedule</label>
            <div className="cron-form-radio-group">
              <label className="cron-form-radio">
                <input type="radio" name="schedKind" value="every" checked={scheduleKind === 'every'} onChange={() => setScheduleKind('every')} />
                <span>Every interval</span>
              </label>
              <label className="cron-form-radio">
                <input type="radio" name="schedKind" value="at" checked={scheduleKind === 'at'} onChange={() => setScheduleKind('at')} />
                <span>At specific time</span>
              </label>
              <label className="cron-form-radio">
                <input type="radio" name="schedKind" value="cron" checked={scheduleKind === 'cron'} onChange={() => setScheduleKind('cron')} />
                <span>Cron expression</span>
              </label>
            </div>
          </div>

          {scheduleKind === 'at' && (
            <div className="form-group">
              <label htmlFor="cron-at">Date &amp; Time</label>
              <input
                id="cron-at"
                type="datetime-local"
                value={atValue}
                onChange={(e) => setAtValue(e.target.value)}
              />
            </div>
          )}

          {scheduleKind === 'every' && (
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="cron-every-val">Interval</label>
                <input
                  id="cron-every-val"
                  type="number"
                  min="1"
                  value={everyValue}
                  onChange={(e) => setEveryValue(Number(e.target.value))}
                />
              </div>
              <div className="form-group">
                <label htmlFor="cron-every-unit">Unit</label>
                <select
                  id="cron-every-unit"
                  value={everyUnit}
                  onChange={(e) => setEveryUnit(e.target.value as IntervalUnit)}
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                </select>
              </div>
            </div>
          )}

          {scheduleKind === 'cron' && (
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="cron-expr">Expression</label>
                <input
                  id="cron-expr"
                  type="text"
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="*/5 * * * *"
                  className="font-mono"
                />
              </div>
              <div className="form-group">
                <label htmlFor="cron-tz">Timezone (optional)</label>
                <input
                  id="cron-tz"
                  type="text"
                  value={cronTz}
                  onChange={(e) => setCronTz(e.target.value)}
                  placeholder="America/New_York"
                />
              </div>
            </div>
          )}
        </div>

        {/* Hide session target when processor handles everything */}
        {!(hasInitProcessor && (ipTargetAgent.trim() || !ipInvokeAgent)) && (
        <div className="cron-form-section">
          <div className="form-group">
            <label>Session Target</label>
            <div className="cron-form-radio-group">
              <label className="cron-form-radio">
                <input type="radio" name="target" value="main" checked={sessionTarget === 'main'} onChange={() => setSessionTarget('main')} />
                <span>Main agent (system event)</span>
              </label>
              <label className="cron-form-radio">
                <input type="radio" name="target" value="isolated" checked={sessionTarget === 'isolated'} onChange={() => setSessionTarget('isolated')} />
                <span>Isolated session (agent turn)</span>
              </label>
            </div>
          </div>

          {sessionTarget === 'main' && (
            <div className="form-group">
              <label htmlFor="cron-event-text">System Event Text</label>
              <input
                id="cron-event-text"
                type="text"
                value={systemEventText}
                onChange={(e) => setSystemEventText(e.target.value)}
                placeholder="e.g. sync-tasks"
              />
            </div>
          )}

          {sessionTarget === 'isolated' && (
            <>
              <div className="form-group">
                <label htmlFor="cron-agent-msg">Agent Prompt</label>
                <textarea
                  id="cron-agent-msg"
                  value={agentMessage}
                  onChange={(e) => setAgentMessage(e.target.value)}
                  placeholder="What should the agent do?"
                  rows={3}
                  style={{ resize: 'vertical' }}
                />
              </div>
              <div className="form-group">
                <label>Delivery</label>
                <div className="cron-form-radio-group">
                  <label className="cron-form-radio">
                    <input type="radio" name="delivery" value="none" checked={deliveryMode === 'none'} onChange={() => setDeliveryMode('none')} />
                    <span>None</span>
                  </label>
                  <label className="cron-form-radio">
                    <input type="radio" name="delivery" value="announce" checked={deliveryMode === 'announce'} onChange={() => setDeliveryMode('announce')} />
                    <span>Announce</span>
                  </label>
                </div>
              </div>
            </>
          )}
        </div>
        )}

        <div className="cron-form-section">
          <div className="form-group">
            <label>Wake Mode</label>
            <div className="cron-form-radio-group">
              <label className="cron-form-radio">
                <input type="radio" name="wake" value="next-cycle" checked={wakeMode === 'next-cycle'} onChange={() => setWakeMode('next-cycle')} />
                <span>Next cycle (wait for scheduled time)</span>
              </label>
              <label className="cron-form-radio">
                <input type="radio" name="wake" value="now" checked={wakeMode === 'now'} onChange={() => setWakeMode('now')} />
                <span>Now (run immediately on creation)</span>
              </label>
            </div>
          </div>
        </div>

        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : job ? 'Update' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
