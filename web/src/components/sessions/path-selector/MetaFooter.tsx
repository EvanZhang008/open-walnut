/**
 * MetaFooter — task metadata controls in the session path selector footer.
 * Extracted from SessionPathSelector.tsx. `compact` renders a single dense row
 * (edit mode — give vertical space back to the path list).
 */
import { SESSION_MODELS } from '@open-walnut/core';
import { TIER_OPTIONS, TIER_COLORS, PRIORITY_OPTIONS } from '../task-meta-constants';
import type { QuickStartTaskMeta } from '../SessionPathSelector';
import { useHostModelCatalog } from '@/hooks/useModelCatalog';

interface Props {
  meta: QuickStartTaskMeta;
  onChange: (updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
  compact: boolean;
  /** Host the session will spawn on (null/undefined = local; drives which
   *  host's model catalog fills the dropdown). */
  host?: string | null;
}

/** Model dropdown rows: the host's last-known CLI catalog (values = full
 *  provider IDs, sent verbatim to spawn) — falling back to the static registry
 *  only when this host has never produced a catalog. The catalog 'default' row
 *  is folded into the Auto option (Auto = no --model = CLI default). */
function useModelOptions(host?: string | null): Array<{ value: string; label: string }> {
  const catalog = useHostModelCatalog(host);
  if (catalog) {
    return catalog.models
      .filter((m) => m.value !== 'default' && !m.disabled)
      .map((m) => ({ value: m.value, label: m.displayName }));
  }
  return SESSION_MODELS.map((sm) => ({ value: sm.id, label: sm.label }));
}

/** Segmented Claude | Codex engine toggle. Codex is ACP-backed and local-only
 *  for now, so the toggle is disabled (pinned to Claude) on remote host tabs. */
function EngineToggle({ meta, onChange, host }: Pick<Props, 'meta' | 'onChange' | 'host'>) {
  const remoteHost = !!host && host !== '__local__';
  // On a remote host tab the session WILL launch as Claude (quick-start drops a
  // stale codex flag), so the highlight must say Claude even if meta.engine is
  // still 'codex' from a local tab — active state mirrors effective behavior.
  const effectiveCodex = meta.engine === 'codex' && !remoteHost;
  return (
    <div className="sps-engine-toggle" role="group" aria-label="Coding agent engine">
      <button
        type="button"
        className={`sps-engine-btn${!effectiveCodex ? ' active' : ''}`}
        onClick={() => onChange(m => ({ ...m, engine: undefined }))}
        title="Claude Code (native)"
      >
        Claude
      </button>
      <button
        type="button"
        className={`sps-engine-btn${effectiveCodex ? ' active' : ''}`}
        disabled={remoteHost}
        onClick={() => onChange(m => ({ ...m, engine: 'codex', model: undefined }))}
        title={remoteHost ? 'Codex sessions are local-only for now' : 'Codex (via ACP)'}
      >
        Codex
      </button>
    </div>
  );
}

export function MetaFooter({ meta, onChange, compact, host }: Props) {
  const modelOptions = useModelOptions(host);
  // A previously-picked model that isn't in the current host's rows (host tab
  // switched, catalog updated) still renders — selected, clearly marked — so
  // the <select> never silently shows Auto while meta.model is set.
  const orphanModel = meta.model && !modelOptions.some((o) => o.value === meta.model)
    ? meta.model : null;
  // Codex models come from ACP capability discovery at session start — there is
  // no pre-start catalog, so the Claude model dropdown is hidden, not emulated.
  // Remote tabs run Claude regardless (codex is local-only), so show the select.
  const isCodex = meta.engine === 'codex' && !(host && host !== '__local__');
  return (
    <div className={`sps-meta-footer${compact ? ' compact' : ''}`}>
      <div className="sps-meta-row">
        <button
          type="button"
          className={`sps-meta-toggle${meta.starred ? ' active' : ''}`}
          onClick={() => onChange(m => ({ ...m, starred: !m.starred }))}
          title="Star this task"
        >
          <span className="sps-meta-toggle-icon">{meta.starred ? '★' : '☆'}</span>
          {!compact && <span>Star</span>}
        </button>
        <button
          type="button"
          className={`sps-meta-toggle${meta.needs_attention ? ' active attention' : ''}`}
          onClick={() => onChange(m => ({ ...m, needs_attention: !m.needs_attention }))}
          title="Flag as needs attention"
        >
          <span className="sps-meta-toggle-icon">●</span>
          {!compact && <span>Needs attention</span>}
        </button>
        {compact && (
          <>
            <div className="sps-meta-tier-options">
              {TIER_OPTIONS.map(t => (
                <button
                  key={t.value}
                  type="button"
                  className={`sps-tier-btn${meta.pinTier === t.value ? ' active' : ''}`}
                  style={{ color: TIER_COLORS[t.value] }}
                  onClick={() => onChange(m => ({ ...m, pinTier: m.pinTier === t.value ? undefined : t.value }))}
                  title={t.label}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="sps-meta-priority-options">
              {PRIORITY_OPTIONS.map(p => (
                <button
                  key={p.value}
                  type="button"
                  className={`badge badge-${p.value}${meta.priority === p.value ? ' badge-active' : ''} badge-clickable`}
                  onClick={() => onChange(m => ({ ...m, priority: p.value }))}
                  title={p.label}
                >
                  {p.icon}
                </button>
              ))}
            </div>
            {!isCodex && (
              <select
                className="sps-meta-model-select"
                value={meta.model ?? ''}
                onChange={(e) => onChange(m => ({ ...m, model: e.target.value || undefined }))}
                title="Session model — Auto lets Claude/config pick the default"
              >
                <option value="">Auto</option>
                {modelOptions.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
                {orphanModel && <option value={orphanModel}>{orphanModel} (not in this host's catalog)</option>}
              </select>
            )}
            <EngineToggle meta={meta} onChange={onChange} host={host} />
          </>
        )}
      </div>

      {!compact && (
        <>
          <div className="sps-meta-row">
            <span className="sps-meta-label">Pin to</span>
            <div className="sps-meta-tier-options">
              {TIER_OPTIONS.map(t => (
                <button
                  key={t.value}
                  type="button"
                  className={`sps-tier-btn${meta.pinTier === t.value ? ' active' : ''}`}
                  style={{ color: TIER_COLORS[t.value] }}
                  onClick={() => onChange(m => ({ ...m, pinTier: m.pinTier === t.value ? undefined : t.value }))}
                  title={t.label}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="sps-meta-row">
            <span className="sps-meta-label">Priority</span>
            <div className="sps-meta-priority-options">
              {PRIORITY_OPTIONS.map(p => (
                <button
                  key={p.value}
                  type="button"
                  className={`badge badge-${p.value}${meta.priority === p.value ? ' badge-active' : ''} badge-clickable`}
                  onClick={() => onChange(m => ({ ...m, priority: p.value }))}
                  title={p.label}
                >
                  {p.icon}
                </button>
              ))}
            </div>
          </div>

          <div className="sps-meta-row">
            <span className="sps-meta-label">Engine</span>
            <EngineToggle meta={meta} onChange={onChange} host={host} />
          </div>

          {!isCodex && (
            <div className="sps-meta-row">
              <span className="sps-meta-label">Model</span>
              <select
                className="sps-meta-model-select"
                value={meta.model ?? ''}
                onChange={(e) => onChange(m => ({ ...m, model: e.target.value || undefined }))}
                title="Session model — Auto lets Claude/config pick the default"
              >
                <option value="">Auto</option>
                {modelOptions.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
                {orphanModel && <option value={orphanModel}>{orphanModel} (not in this host's catalog)</option>}
              </select>
            </div>
          )}
        </>
      )}
    </div>
  );
}
