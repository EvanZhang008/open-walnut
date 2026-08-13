import { useState, useEffect, useCallback } from 'react';
import { fetchHooks, patchHook, type HookInfo } from '@/api/hooks';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch';
import { log } from '@/utils/log';

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

function HookCard({ hook, onToggle }: { hook: HookInfo; onToggle: (h: HookInfo, enabled: boolean) => void }) {
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

  if (loading) return <div id="hooks"><LoadingSpinner /></div>;
  if (error) return <div id="hooks"><div className="empty-state"><p>Error: {error}</p></div></div>;

  return (
    <div id="hooks" className="card settings-section settings-section-wide">
      <h3 className="settings-section-title">Hooks</h3>
      <p className="settings-section-subtitle">
        Everything Walnut does automatically — session lifecycle, task phase transitions, cron fires, and daemon policies — in one place
      </p>

      {banner && (
        <div className="hook-banner" role="status">
          {banner}
          <button type="button" className="hook-banner-dismiss" onClick={() => setBanner(null)}>{'×'}</button>
        </div>
      )}

      {RUNTIME_GROUPS.map((group) => {
        const groupHooks = hooks.filter(group.match);
        if (groupHooks.length === 0) return null;
        return (
          <div key={group.key} className="hook-group">
            <h4 className="hook-group-title">{group.title}</h4>
            <p className="hook-group-subtitle">{group.subtitle}</p>
            <div className="hooks-list">
              {groupHooks.map((hook) => (
                <HookCard key={hook.id} hook={hook} onToggle={onToggle} />
              ))}
            </div>
          </div>
        );
      })}

      <p className="text-sm text-muted" style={{ marginTop: 24 }}>
        Declare your own hooks in <code>config.yaml</code> under <code>hooks.defs</code> (declarative actions),
        or drop <code>.mjs</code> files in <code>~/.open-walnut/hooks/</code> (code hooks).
      </p>
    </div>
  );
}
