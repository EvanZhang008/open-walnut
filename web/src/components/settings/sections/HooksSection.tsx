import { useState, useEffect, useCallback } from 'react';
import { fetchHooks, patchHook, type HookInfo, type HookSetting } from '@/api/hooks';
import { SettingsSection, SettingsEmpty } from '../SettingsSection';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch';
import { NumberInput } from '@/components/settings/inputs/NumberInput';
import { log } from '@/utils/log';

const HOOKS_DESCRIPTION = 'Everything Walnut does automatically, in one place: session lifecycle, task phase transitions, cron fires, and daemon policies.';

const ACTION_ICON: Record<string, string> = {
  send_message_to_session: '\u{1F4AC}',
  inject_message: '\u{1F4AC}',
  notify: '\u{1F514}',
  run_agent: '\u{1F916}',
  log: '\u{1F4DD}',
  handler: '⚙️',
  deny_permission: '\u{1F6AB}',
};

const RUNTIME_GROUPS: Array<{ key: string; title: string; subtitle: string; match: (h: HookInfo) => boolean }> = [
  {
    key: 'walnut',
    title: 'Walnut hooks',
    subtitle: 'Dispatched on session, task, and cron events',
    match: (h) => h.runtime === 'walnut' && h.source !== 'inline',
  },
  {
    key: 'inline',
    title: 'Inline interventions',
    subtitle: 'Enforced inside the session reader (not dispatchable, listed for visibility)',
    match: (h) => h.runtime === 'walnut' && h.source === 'inline',
  },
  {
    key: 'daemon',
    title: 'Daemon policies',
    subtitle: 'Enforced by the session daemon — changes take effect after a daemon restart',
    match: (h) => h.runtime === 'daemon',
  },
];

/**
 * Editable knobs a hook declares (HookInfo.settings). Rendered from the
 * descriptor, so a new knob on any hook needs no code here.
 *
 * Commits on blur / Enter rather than per keystroke: each write hits config.yaml
 * and (for daemon policies) is announced as "needs a daemon restart", so firing
 * one per typed digit would be both wasteful and confusing.
 */
function HookSettings({
  hook, onCommit,
}: {
  hook: HookInfo;
  onCommit: (h: HookInfo, key: string, value: number | boolean) => void;
}) {
  const settings = hook.settings ?? [];
  // Local draft so typing isn't fought by the server value mid-edit.
  const [draft, setDraft] = useState<Record<string, number | boolean>>({});
  useEffect(() => { setDraft({}); }, [hook.settings]);
  if (settings.length === 0) return null;

  const valueOf = (s: HookSetting) => (draft[s.key] !== undefined ? draft[s.key] : s.value);

  const commit = (s: HookSetting) => {
    const next = draft[s.key];
    if (next === undefined || next === s.value) return;
    onCommit(hook, s.key, next);
  };

  return (
    <div className="hook-card-settings">
      {settings.map((s) => (
        <div key={s.key} className="hook-card-setting">
          <label className="hook-card-setting-label" htmlFor={`hook-setting-${hook.id}-${s.key}`}>
            {s.label}
          </label>
          {s.type === 'boolean' ? (
            <ToggleSwitch
              id={`hook-setting-${hook.id}-${s.key}`}
              checked={valueOf(s) === true}
              onChange={(v) => onCommit(hook, s.key, v)}
            />
          ) : (
            <NumberInput
              id={`hook-setting-${hook.id}-${s.key}`}
              value={typeof valueOf(s) === 'number' ? (valueOf(s) as number) : undefined}
              onChange={(v) => setDraft((prev) => ({
                // Clearing the field must not write `undefined` — fall back to
                // the declared default so config never holds a null knob.
                ...prev, [s.key]: v === undefined ? (s.default as number) : v,
              }))}
              onBlur={() => commit(s)}
              onEnter={() => commit(s)}
              suffix={s.unit}
              placeholder={String(s.default)}
              min={s.min}
              max={s.max}
            />
          )}
          {s.help && <p className="hook-card-setting-help">{s.help}</p>}
        </div>
      ))}
    </div>
  );
}

function HookCard({ hook, onToggle, onSettingCommit }: {
  hook: HookInfo;
  onToggle: (h: HookInfo, enabled: boolean) => void;
  onSettingCommit: (h: HookInfo, key: string, value: number | boolean) => void;
}) {
  const toggleable = hook.mutable !== 'readonly';
  return (
    <div className={`hook-card${hook.enabled ? '' : ' hook-card-disabled'}`}>
      <div className="hook-card-header">
        <span className="hook-card-icon">{ACTION_ICON[hook.actionType ?? ''] ?? '⚡'}</span>
        <span className="hook-card-name">{hook.name}</span>
        <span className={`hook-card-badge hook-card-badge-${hook.source}`}>{hook.source}</span>
        <span className="hook-card-priority" title="Priority (lower = runs first)">#{hook.priority}</span>
        {toggleable ? (
          <ToggleSwitch
            id={`hook-toggle-${hook.id}`}
            checked={hook.enabled}
            onChange={(v) => onToggle(hook, v)}
          />
        ) : (
          <span className="hook-card-readonly" title={hook.note ?? 'Not toggleable'}>always on</span>
        )}
      </div>

      {hook.description && <p className="hook-card-description">{hook.description}</p>}

      <div className="hook-card-details">
        {hook.on.length > 0 && (
          <div className="hook-card-detail">
            <span className="hook-card-detail-label">Fires on</span>
            <span className="hook-card-detail-value hook-card-phase">{hook.on.join(', ')}</span>
          </div>
        )}
        {hook.actionDetail && (
          <div className="hook-card-detail">
            <span className="hook-card-detail-label">Action</span>
            <span className="hook-card-detail-value">{hook.actionDetail}</span>
          </div>
        )}
        {hook.conditions.length > 0 && (
          <div className="hook-card-detail">
            <span className="hook-card-detail-label">Conditions</span>
            <span className="hook-card-detail-value">{hook.conditions.join(' · ')}</span>
          </div>
        )}
        {hook.configPath && (
          <div className="hook-card-detail">
            <span className="hook-card-detail-label">Config</span>
            <span className="hook-card-detail-value"><code>{hook.configPath}</code></span>
          </div>
        )}
      </div>

      {/* Knobs only while the hook is ON — showing tuning for something that
          isn't running reads as "configured and active" when it isn't. */}
      {hook.enabled && <HookSettings hook={hook} onCommit={onSettingCommit} />}

      {hook.note && <p className="hook-card-note">{hook.note}</p>}
    </div>
  );
}

export function HooksSection() {
  const [hooks, setHooks] = useState<HookInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchHooks()
      .then(setHooks)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load hooks'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const onToggle = useCallback((hook: HookInfo, enabled: boolean) => {
    // Optimistic flip; reload reconciles.
    setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, enabled } : h)));
    patchHook(hook.id, { enabled })
      .then((result) => {
        if (result.requiresDaemonRestart) {
          setBanner(`"${hook.name}" updated — takes effect after the session daemon restarts.`);
        }
        reload();
      })
      .catch((err) => {
        log.warn('settings', 'hook toggle failed', { hookId: hook.id, error: String(err) });
        setBanner(`Failed to update "${hook.name}": ${err instanceof Error ? err.message : String(err)}`);
        reload();
      });
  }, [reload]);

  const onSettingCommit = useCallback((hook: HookInfo, key: string, value: number | boolean) => {
    // Optimistic: reflect the new value immediately, reload reconciles.
    setHooks((prev) => prev.map((h) => (h.id === hook.id
      ? { ...h, settings: h.settings?.map((s) => (s.key === key ? { ...s, value } : s)) }
      : h)));
    patchHook(hook.id, { settings: { [key]: value } })
      .then((result) => {
        if (result.requiresDaemonRestart) {
          setBanner(`"${hook.name}" updated — takes effect after the session daemon restarts.`);
        }
        reload();
      })
      .catch((err) => {
        log.warn('settings', 'hook setting update failed', { hookId: hook.id, key, error: String(err) });
        setBanner(`Failed to update "${hook.name}": ${err instanceof Error ? err.message : String(err)}`);
        reload();
      });
  }, [reload]);

  // Loading and error used to render a BARE <div id="hooks">, so the content sat
  // outside the card frame and the page visibly reflowed once it arrived. Same
  // shell in all three states.
  if (loading) {
    return (
      <SettingsSection id="hooks" title="Hooks" description={HOOKS_DESCRIPTION}>
        <LoadingSpinner />
      </SettingsSection>
    );
  }
  if (error) {
    return (
      <SettingsSection id="hooks" title="Hooks" description={HOOKS_DESCRIPTION}>
        <SettingsEmpty>Error: {error}</SettingsEmpty>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      id="hooks"
      title="Hooks"
      description={HOOKS_DESCRIPTION}
      banner={banner ? (
        <div className="hook-banner" role="status">
          {banner}
          <button type="button" className="hook-banner-dismiss" onClick={() => setBanner(null)}>{'×'}</button>
        </div>
      ) : undefined}
    >
      {RUNTIME_GROUPS.map((group) => {
        const groupHooks = hooks.filter(group.match);
        if (groupHooks.length === 0) return null;
        return (
          <div key={group.key} className="hook-group">
            <h4 className="hook-group-title">{group.title}</h4>
            <p className="hook-group-subtitle">{group.subtitle}</p>
            <div className="hooks-list">
              {groupHooks.map((hook) => (
                <HookCard
                  key={hook.id}
                  hook={hook}
                  onToggle={onToggle}
                  onSettingCommit={onSettingCommit}
                />
              ))}
            </div>
          </div>
        );
      })}

      <p className="text-sm text-muted" style={{ marginTop: 24 }}>
        Declare your own hooks in <code>config.yaml</code> under <code>hooks.defs</code> (declarative actions),
        or drop <code>.mjs</code> files in <code>~/.open-walnut/hooks/</code> (code hooks).
      </p>
    </SettingsSection>
  );
}
