import { useState, useEffect } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { apiGet, apiPut } from '@/api/client';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function HeartbeatSection({ config, onSave }: Props) {
  const [enabled, setEnabled] = useState(config.heartbeat?.enabled ?? false);
  const [every, setEvery] = useState(config.heartbeat?.every ?? '30m');
  const [activeHours, setActiveHours] = useState(config.heartbeat?.activeHours ?? '');

  // Checklist state (separate API)
  const [checklist, setChecklist] = useState('');
  const [clLoading, setClLoading] = useState(true);
  const [clSaving, setClSaving] = useState(false);
  const [clSuccess, setClSuccess] = useState(false);
  const [clError, setClError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(config.heartbeat?.enabled ?? false);
    setEvery(config.heartbeat?.every ?? '30m');
    setActiveHours(config.heartbeat?.activeHours ?? '');
  }, [config]);

  useEffect(() => {
    apiGet<{ content: string }>('/api/heartbeat/checklist')
      .then((r) => setChecklist(r.content))
      .catch((e: Error) => setClError(e.message))
      .finally(() => setClLoading(false));
  }, []);

  const handleSave = async () => {
    await onSave({
      heartbeat: {
        enabled,
        every: every || '30m',
        activeHours: activeHours || undefined,
      },
    });
  };

  const handleChecklistSave = async () => {
    setClSaving(true);
    setClError(null);
    setClSuccess(false);
    try {
      await apiPut('/api/heartbeat/checklist', { content: checklist });
      setClSuccess(true);
      setTimeout(() => setClSuccess(false), 3000);
    } catch (err) {
      setClError((err as Error).message);
    } finally {
      setClSaving(false);
    }
  };

  return (
    <SectionCard id="heartbeat" title="Heartbeat" description="Periodic AI self-check system." onSave={handleSave}>
      <div className="form-group">
        <ToggleSwitch id="hb-enabled" checked={enabled} onChange={setEnabled} label="Enable Heartbeat" />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="hb-every">Interval</label>
          <input
            id="hb-every"
            type="text"
            value={every}
            onChange={(e) => setEvery(e.target.value)}
            placeholder="30m"
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Duration string: &quot;30m&quot;, &quot;1h&quot;, etc.
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="hb-hours">Active Hours</label>
          <input
            id="hb-hours"
            type="text"
            value={activeHours}
            onChange={(e) => setActiveHours(e.target.value)}
            placeholder="08:00-22:00"
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Empty = runs 24/7.
          </p>
        </div>
      </div>

      <div className="settings-divider" />

      <div className="form-group">
        <label htmlFor="heartbeat-editor">Checklist (HEARTBEAT.md)</label>
        <p className="text-sm text-muted" style={{ margin: '-4px 0 4px' }}>
          The AI reads this periodically and acts on unchecked items.
        </p>
        {clLoading ? (
          <div className="text-sm text-muted">Loading checklist...</div>
        ) : (
          <>
            <textarea
              id="heartbeat-editor"
              value={checklist}
              onChange={(e) => setChecklist(e.target.value)}
              rows={10}
              className="settings-textarea"
              placeholder="# Heartbeat Checklist&#10;- [ ] Check pipeline status&#10;- [ ] Review open PRs"
            />
            {clError && <div className="text-sm" style={{ color: 'var(--error)', marginTop: 4 }}>Error: {clError}</div>}
            {clSuccess && <div className="text-sm" style={{ color: 'var(--success)', marginTop: 4 }}>Checklist saved.</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={clSaving}
                onClick={handleChecklistSave}
              >
                {clSaving ? 'Saving...' : 'Save Checklist'}
              </button>
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}
