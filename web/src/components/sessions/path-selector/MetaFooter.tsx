/**
 * MetaFooter — task metadata controls in the session path selector footer.
 * Extracted from SessionPathSelector.tsx. `compact` renders a single dense row
 * (edit mode — give vertical space back to the path list).
 */
import { SESSION_MODELS } from '@open-walnut/core';
import { TIER_OPTIONS, TIER_COLORS, PRIORITY_OPTIONS } from '../task-meta-constants';
import type { QuickStartTaskMeta } from '../SessionPathSelector';

interface Props {
  meta: QuickStartTaskMeta;
  onChange: (updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
  compact: boolean;
}

export function MetaFooter({ meta, onChange, compact }: Props) {
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
            <select
              className="sps-meta-model-select"
              value={meta.model ?? ''}
              onChange={(e) => onChange(m => ({ ...m, model: e.target.value || undefined }))}
              title="Session model — Auto lets Claude/config pick the default"
            >
              <option value="">Auto</option>
              {SESSION_MODELS.map(sm => (
                <option key={sm.id} value={sm.id}>{sm.label}</option>
              ))}
            </select>
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
            <span className="sps-meta-label">Model</span>
            <select
              className="sps-meta-model-select"
              value={meta.model ?? ''}
              onChange={(e) => onChange(m => ({ ...m, model: e.target.value || undefined }))}
              title="Session model — Auto lets Claude/config pick the default"
            >
              <option value="">Auto</option>
              {SESSION_MODELS.map(sm => (
                <option key={sm.id} value={sm.id}>{sm.label}</option>
              ))}
            </select>
          </div>
        </>
      )}
    </div>
  );
}
