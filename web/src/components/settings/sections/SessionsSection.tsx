import { useState, useEffect } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { NumberInput } from '../inputs/NumberInput';
import { KeyValueEditor } from '../inputs/KeyValueEditor';
import { ToggleSwitch } from '../inputs/ToggleSwitch';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function SessionsSection({ config, onSave }: Props) {
  const [idleTimeout, setIdleTimeout] = useState<number | undefined>(config.session?.idle_timeout_minutes ?? 30);
  const [maxIdle, setMaxIdle] = useState<number | undefined>(config.session?.max_idle);
  const [sessionLimits, setSessionLimits] = useState<Record<string, string | number>>(config.session_limits ?? {});
  const [sdkEnabled, setSdkEnabled] = useState(config.session_server?.enabled ?? false);
  const [sdkPort, setSdkPort] = useState<number | undefined>(config.session_server?.port ?? 7890);

  useEffect(() => {
    setIdleTimeout(config.session?.idle_timeout_minutes ?? 30);
    setMaxIdle(config.session?.max_idle);
    setSessionLimits(config.session_limits ?? {});
    setSdkEnabled(config.session_server?.enabled ?? false);
    setSdkPort(config.session_server?.port ?? 7890);
  }, [config]);

  const handleSave = async () => {
    // Convert limits to numbers
    const limits: Record<string, number> = {};
    for (const [k, v] of Object.entries(sessionLimits)) {
      limits[k] = typeof v === 'number' ? v : parseInt(v, 10) || 0;
    }

    await onSave({
      session: {
        idle_timeout_minutes: idleTimeout,
        max_idle: maxIdle,
      },
      session_limits: limits,
      session_server: {
        ...config.session_server,
        enabled: sdkEnabled,
        port: sdkPort,
      },
    });
  };

  return (
    <SectionCard id="sessions" title="Sessions" description="Claude Code session behavior and limits." onSave={handleSave}>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="idle-timeout">Idle Timeout</label>
          <NumberInput
            id="idle-timeout"
            value={idleTimeout}
            onChange={setIdleTimeout}
            suffix="minutes"
            placeholder="30"
            min={0}
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            0 = disable idle timeout.
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="max-idle">Max Idle Sessions</label>
          <NumberInput
            id="max-idle"
            value={maxIdle}
            onChange={setMaxIdle}
            placeholder="30"
            min={0}
          />
        </div>
      </div>

      <div className="form-group">
        <label>Session Limits (per host)</label>
        <p className="text-sm text-muted" style={{ margin: '-4px 0 4px' }}>
          Max concurrent sessions per host. Use &quot;local&quot; for local sessions.
        </p>
        <KeyValueEditor
          entries={sessionLimits}
          onChange={setSessionLimits}
          keyPlaceholder="Host alias (e.g., local)"
          valuePlaceholder="Max sessions"
          valueType="number"
        />
      </div>

      <div className="settings-divider" />

      <div className="form-group">
        <ToggleSwitch
          id="sdk-enabled"
          checked={sdkEnabled}
          onChange={setSdkEnabled}
          label="SDK Session Server"
        />
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          Use the Agent SDK server instead of CLI sessions.
        </p>
      </div>

      {sdkEnabled && (
        <div className="form-group">
          <label htmlFor="sdk-port">SDK Server Port</label>
          <NumberInput
            id="sdk-port"
            value={sdkPort}
            onChange={setSdkPort}
            placeholder="7890"
            min={1024}
            max={65535}
          />
        </div>
      )}
    </SectionCard>
  );
}
