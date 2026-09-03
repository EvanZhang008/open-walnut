import { useState, useEffect } from 'react';
import type { Config, TaskPriority } from '@open-walnut/core';
import { useAutoSave } from '@/hooks/useAutoSave';
import { SectionCard } from '../inputs/SectionCard';
import { NumberInput } from '../inputs/NumberInput';
import { useIntegrations } from '@/hooks/useIntegrations';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

type TriageNotifyMode = 'off' | 'buffered' | 'realtime';

/**
 * Everything about tasks as tasks: where a new one lands (defaults, quick-add
 * destination) and how a finished session reports back onto its task (Task
 * Summary). The defaults used to sit in General and the summary knobs in
 * "Tasks & Sessions", so the task story was split across two cards.
 */
export function TasksSection({ config, onSave }: Props) {
  const integrations = useIntegrations();
  const [defaultPriority, setDefaultPriority] = useState<TaskPriority>(config.defaults?.priority ?? 'none');
  const [defaultPlatform, setDefaultPlatform] = useState(config.defaults?.platform ?? 'local');
  const [defaultProject, setDefaultProject] = useState(config.defaults?.project ?? '');
  // Triage throttling (config.agent.triage)
  const [triageNotifyMode, setTriageNotifyMode] = useState<TriageNotifyMode>(config.agent?.triage?.notify_mode ?? 'off');
  const [triageDebounce, setTriageDebounce] = useState<number | undefined>(config.agent?.triage?.debounce_minutes ?? 4);

  useEffect(() => {
    setDefaultPriority(config.defaults?.priority ?? 'none');
    setDefaultPlatform(config.defaults?.platform ?? 'local');
    setDefaultProject(config.defaults?.project ?? '');
    setTriageNotifyMode(config.agent?.triage?.notify_mode ?? 'off');
    setTriageDebounce(config.agent?.triage?.debounce_minutes ?? 4);
  }, [config]);

  const handleSave = async () => {
    await onSave({
      defaults: {
        priority: defaultPriority,
        platform: defaultPlatform,
        // Empty = Inbox. Never persist a literal "Inbox" — that would create a real project.
        ...(defaultProject.trim() ? { project: defaultProject.trim() } : {}),
      },
      // Spread ...config.agent so sibling agent fields (main_provider, provider,
      // available_models, …) survive — updateConfig replaces the whole `agent` key.
      agent: {
        ...config.agent,
        triage: { notify_mode: triageNotifyMode, debounce_minutes: triageDebounce ?? 4 },
      },
    });
  };

  // Auto-save: write when local edits drift from the persisted config. The `baseline` is
  // recomputed from the config prop so a post-save refresh matches `current` and won't echo.
  useAutoSave({
    current: JSON.stringify({
      defaultPriority, defaultPlatform, defaultProject,
      triageNotifyMode, triageDebounce: triageDebounce ?? 4,
    }),
    baseline: JSON.stringify({
      defaultPriority: config.defaults?.priority ?? 'none',
      defaultPlatform: config.defaults?.platform ?? 'local',
      defaultProject: config.defaults?.project ?? '',
      triageNotifyMode: config.agent?.triage?.notify_mode ?? 'off',
      triageDebounce: config.agent?.triage?.debounce_minutes ?? 4,
    }),
    save: handleSave,
  });

  return (
    <SectionCard id="tasks" title="Tasks" description="Where new tasks land, and how a finished session reports back onto its task. Changes save automatically." onSave={handleSave} showSave={false}>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="settings-priority">Default Priority</label>
          <select
            id="settings-priority"
            value={defaultPriority}
            onChange={(e) => setDefaultPriority(e.target.value as TaskPriority)}
          >
            <option value="none">None (untriaged)</option>
            <option value="backlog">Backlog</option>
            <option value="important">Important</option>
            <option value="immediate">Immediate</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="settings-project">Default Project <span className="text-muted">(optional)</span></label>
          <input
            id="settings-project"
            type="text"
            value={defaultProject}
            onChange={(e) => setDefaultProject(e.target.value)}
            placeholder="Leave empty for Inbox"
          />
          <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
            Where new tasks land when no project is given. Empty means Inbox.
          </p>
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="settings-platform">Quick-add creates tasks in</label>
        <select
          id="settings-platform"
          value={defaultPlatform}
          onChange={(e) => setDefaultPlatform(e.target.value)}
        >
          <option value="local">Walnut (this device — instant)</option>
          {integrations.map((i) => (
            <option key={i.id} value={i.id}>{i.name}</option>
          ))}
        </select>
        <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
          Where &ldquo;Add to Focus&rdquo; puts a new task. Walnut is instant and never synced;
          pick a connected service to create new captures there instead.
        </p>
      </div>

      <div className="settings-divider" />

      {/* Task Summary — a TASK concern (updates the task's note/phase and decides task
          notifications), merely triggered by a session turn. The session itself
          writes the note (side_question self-report, ~free); phase/notify is a
          deterministic PHASE_SIGNAL lookup — no summarizer agent runs. */}
      <div className="form-group">
        <label style={{ fontWeight: 600 }}>Task Summary</label>
        <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
          After a session goes quiet, the session itself reports what it did — Walnut updates
          the task&rsquo;s summary and decides whether anything needs your attention.
        </p>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="triage-notify-mode">Notify Main Agent</label>
          <select
            id="triage-notify-mode"
            value={triageNotifyMode}
            onChange={(e) => setTriageNotifyMode(e.target.value as TriageNotifyMode)}
            style={{ maxWidth: 220 }}
          >
            <option value="off">Off — quiet (poll only)</option>
            <option value="buffered">Buffered — review on heartbeat</option>
            <option value="realtime">Realtime — notify immediately</option>
          </select>
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            The task summary is <strong>always</strong> updated. This only controls whether the
            main agent is woken to tell you about it. <strong>Off</strong> stays silent — the agent
            sees it next time it checks the task. <strong>Realtime</strong> is the most expensive
            (reads the whole conversation each time).
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="triage-debounce">Triage Debounce</label>
          <NumberInput
            id="triage-debounce"
            value={triageDebounce}
            onChange={setTriageDebounce}
            suffix="minutes"
            placeholder="4"
            min={0}
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Wait this long after the last turn before triaging, so a burst of back-and-forth
            collapses into one triage. 0 = triage on every turn.
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
