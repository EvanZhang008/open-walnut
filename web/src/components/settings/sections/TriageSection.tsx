import { useState, useEffect } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useAutoSave } from '@/hooks/useAutoSave';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

type TriageSource = 'mail' | 'slack';
type TriageMode = 'ask' | 'assist';

/**
 * Inbox Triage: how often Walnut works through a batch of new mail and Slack.
 *
 * Every default here MUST match the server's reader (src/core/triage/config.ts).
 * They are repeated rather than imported because `@open-walnut/core` maps to
 * src/core/types.ts alone — and if they drift, the auto-save baseline differs
 * from the rendered value and merely OPENING Settings writes the config back
 * (the SessionsSection pitfall).
 */
const DEFAULT_EVERY = '30m';
const DEFAULT_EVERY_MESSAGES = 20;
const ALL_SOURCES: TriageSource[] = ['mail', 'slack'];
const DEFAULT_SOURCES: TriageSource[] = ALL_SOURCES;
const DEFAULT_MODE: TriageMode = 'ask';
const DEFAULT_ACTIVE_HOURS = '08:00-22:00';

const SOURCE_LABELS: Record<TriageSource, string> = { mail: 'Mail', slack: 'Slack' };

export function TriageSection({ config, onSave }: Props) {
  const [enabled, setEnabled] = useState(config.triage?.enabled ?? false);
  const [every, setEvery] = useState(config.triage?.every ?? DEFAULT_EVERY);
  const [everyMessages, setEveryMessages] = useState<number | undefined>(
    config.triage?.every_messages ?? DEFAULT_EVERY_MESSAGES,
  );
  const [sources, setSources] = useState<TriageSource[]>(config.triage?.sources ?? DEFAULT_SOURCES);
  const [mode, setMode] = useState<TriageMode>(config.triage?.mode ?? DEFAULT_MODE);
  const [autoMarkRead, setAutoMarkRead] = useState(config.triage?.auto_mark_read ?? false);
  const [activeHours, setActiveHours] = useState(config.triage?.active_hours ?? DEFAULT_ACTIVE_HOURS);

  useEffect(() => {
    setEnabled(config.triage?.enabled ?? false);
    setEvery(config.triage?.every ?? DEFAULT_EVERY);
    setEveryMessages(config.triage?.every_messages ?? DEFAULT_EVERY_MESSAGES);
    setSources(config.triage?.sources ?? DEFAULT_SOURCES);
    setMode(config.triage?.mode ?? DEFAULT_MODE);
    setAutoMarkRead(config.triage?.auto_mark_read ?? false);
    setActiveHours(config.triage?.active_hours ?? DEFAULT_ACTIVE_HOURS);
  }, [config]);

  const handleSave = async () => {
    await onSave({
      // Spread ...config.triage so a sibling triage key this section does NOT
      // render survives — updateConfig replaces the whole `triage` key.
      triage: {
        ...config.triage,
        enabled,
        every: every || DEFAULT_EVERY,
        every_messages: everyMessages ?? DEFAULT_EVERY_MESSAGES,
        sources,
        mode,
        auto_mark_read: autoMarkRead,
        active_hours: activeHours,
      },
    });
  };

  useAutoSave({
    current: JSON.stringify({
      enabled, every: every || DEFAULT_EVERY,
      everyMessages: everyMessages ?? DEFAULT_EVERY_MESSAGES,
      sources, mode, autoMarkRead, activeHours,
    }),
    baseline: JSON.stringify({
      enabled: config.triage?.enabled ?? false,
      every: config.triage?.every ?? DEFAULT_EVERY,
      everyMessages: config.triage?.every_messages ?? DEFAULT_EVERY_MESSAGES,
      sources: config.triage?.sources ?? DEFAULT_SOURCES,
      mode: config.triage?.mode ?? DEFAULT_MODE,
      autoMarkRead: config.triage?.auto_mark_read ?? false,
      activeHours: config.triage?.active_hours ?? DEFAULT_ACTIVE_HOURS,
    }),
    save: handleSave,
  });

  // Rebuilt from ALL_SOURCES, not appended to: a canonical order means ticking a
  // box off and back on does not look like a change to the auto-save comparison.
  const toggleSource = (source: TriageSource) => {
    setSources((prev) => ALL_SOURCES.filter((s) => (s === source ? !prev.includes(s) : prev.includes(s))));
  };

  return (
    <SectionCard
      id="triage"
      title="Inbox Triage"
      description="Walnut works through each batch of new mail and Slack, matches it to your projects and tasks, keeps the tracking notes true, and asks you about decisions. Changes save automatically."
      onSave={handleSave}
      showSave={false}
    >
      <div className="form-group">
        <ToggleSwitch
          id="inbox-triage-enabled"
          checked={enabled}
          onChange={setEnabled}
          label="Enable Inbox Triage"
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="inbox-triage-every">Interval</label>
          <input
            id="inbox-triage-every"
            type="text"
            value={every}
            onChange={(e) => setEvery(e.target.value)}
            placeholder={DEFAULT_EVERY}
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Duration string: &quot;30m&quot;, &quot;1h&quot;. Minimum 5m; &quot;0&quot; turns triage off.
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="inbox-triage-every-messages">Or every</label>
          <NumberInput
            id="inbox-triage-every-messages"
            value={everyMessages}
            onChange={setEveryMessages}
            suffix="new items"
            placeholder={String(DEFAULT_EVERY_MESSAGES)}
            min={0}
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            0 = only run on the interval.
          </p>
        </div>
      </div>

      <div className="form-group">
        <label>Sources</label>
        <div style={{ display: 'flex', gap: 16, marginTop: 2 }}>
          {ALL_SOURCES.map((source) => (
            <label
              key={source}
              style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13 }}
            >
              <input
                type="checkbox"
                data-testid={`inbox-triage-source-${source}`}
                checked={sources.includes(source)}
                onChange={() => toggleSource(source)}
              />
              {SOURCE_LABELS[source]}
            </label>
          ))}
        </div>
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          With neither ticked, only the interval triggers a batch.
        </p>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="inbox-triage-mode">Mode</label>
          <select
            id="inbox-triage-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as TriageMode)}
            style={{ maxWidth: 260 }}
          >
            <option value="ask">Ask — only notes, then ask you</option>
            <option value="assist">Assist — may also file tasks and unsubscribe</option>
          </select>
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Sending mail and posting to Slack always need your approval.
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="inbox-triage-hours">Active Hours</label>
          <input
            id="inbox-triage-hours"
            type="text"
            value={activeHours}
            onChange={(e) => setActiveHours(e.target.value)}
            placeholder={DEFAULT_ACTIVE_HOURS}
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Empty = runs 24/7.
          </p>
        </div>
      </div>

      <div className="form-group">
        <ToggleSwitch
          id="inbox-triage-auto-mark-read"
          checked={autoMarkRead}
          onChange={setAutoMarkRead}
          label="Let Assist mode mark triaged mail as read"
        />
      </div>
    </SectionCard>
  );
}
