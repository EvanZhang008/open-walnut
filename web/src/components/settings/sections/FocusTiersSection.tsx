/**
 * FocusTiersSection — Settings CRUD card for custom pinned-task tiers.
 *
 * Self-contained (no config/onSave props): talks straight to the
 * /api/focus/tiers registry. The four built-ins render as read-only rows so
 * the section shows the FULL tier lineup, not just the editable tail.
 */

import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import { SettingsSection, SettingsNotice } from '../SettingsSection';
import { useEvent } from '@/hooks/useWebSocket';
import {
  fetchCustomTiers,
  createCustomTier,
  renameCustomTier,
  deleteCustomTier,
  type CustomTierDef,
} from '@/api/focus';
import {
  ICON_TIER_FOCUS,
  ICON_TIER_SATELLITE,
  ICON_TIER_BACKLOG,
  ICON_TIER_WAIT,
  ICON_TIER_CUSTOM,
} from '@/components/common/Icons';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/hooks/useConfirm';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';

const BUILTIN_ROWS = [
  { id: 'focus', label: 'Focus', icon: ICON_TIER_FOCUS },
  { id: 'satellite', label: 'Satellite', icon: ICON_TIER_SATELLITE },
  { id: 'backlog', label: 'Backlog', icon: ICON_TIER_BACKLOG },
  { id: 'wait', label: 'Wait', icon: ICON_TIER_WAIT },
] as const;

/** Server-enforced too; mirrored here so the input can't even type past it. */
const LABEL_MAX = 40;

export function FocusTiersSection() {
  const confirm = useConfirm();
  const [tiers, setTiers] = useState<CustomTierDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  // Escape cancels the inline edit; the input's blur then fires and must not commit.
  const editCancelledRef = useRef(false);
  // Pinned-task counts per tier — for the delete confirm's "N tasks move back".
  // Safe hook: absent (isolated render) the dialog just says "Its tasks".
  const customTierIds = useFocusBarContextSafe()?.customTierIds;

  useEffect(() => {
    fetchCustomTiers()
      .then((r) => setTiers(r.tiers))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load tiers'))
      .finally(() => setLoading(false));
  }, []);

  // Another client's tier CRUD emits config:changed{focus_tiers} — refetch so
  // this list matches the kebab menus on the same screen (those go through
  // FocusBarContext, which already refetches on the same event).
  useEvent('config:changed', (data: unknown) => {
    if ((data as { key?: string } | null)?.key !== 'focus_tiers') return;
    fetchCustomTiers().then((r) => setTiers(r.tiers)).catch(() => {});
  });

  const handleAdd = async () => {
    const label = newLabel.trim();
    if (!label || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await createCustomTier(label);
      setTiers(res.tiers);
      setNewLabel('');
    } catch (err) {
      // Server rejections (duplicate label, tier cap) arrive as {error} → message.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (tier: CustomTierDef) => {
    editCancelledRef.current = false;
    setEditingId(tier.id);
    setEditValue(tier.label);
    setError(null);
    setNotice(null);
  };

  // Enter commits and unmounts the input, whose blur handler then calls
  // commitRename AGAIN before the first PUT resolves — dedupe with a ref.
  const renameInFlightRef = useRef(false);
  const commitRename = async (id: string) => {
    if (editCancelledRef.current || renameInFlightRef.current) return;
    const label = editValue.trim();
    const current = tiers.find((t) => t.id === id);
    setEditingId(null);
    if (!current || !label || label === current.label) return;
    renameInFlightRef.current = true;
    try {
      const res = await renameCustomTier(id, label);
      setTiers(res.tiers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      renameInFlightRef.current = false;
    }
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>, id: string) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitRename(id);
    } else if (e.key === 'Escape') {
      editCancelledRef.current = true;
      setEditingId(null);
    }
  };

  const handleDelete = async (tier: CustomTierDef) => {
    if (busy) return;
    const count = customTierIds?.[tier.id]?.length;
    const taskPhrase = count === undefined
      ? 'Its tasks move back to Satellite.'
      : `Its ${count} task${count === 1 ? '' : 's'} move back to Satellite.`;
    if (!(await confirm({
      title: `Delete tier "${tier.label}"?`,
      message: taskPhrase,
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await deleteCustomTier(tier.id);
      setTiers(res.tiers);
      setNotice(res.moved > 0 ? `${res.moved} task${res.moved === 1 ? '' : 's'} moved to Satellite` : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      id="focus-tiers"
      title="Focus Tiers"
      description="Custom pinned-task tiers shown alongside Focus / Satellite / Backlog / Wait."
    >
      {loading ? <LoadingSpinner /> : (
        <>
          <ul className="focus-tiers-list">
            {BUILTIN_ROWS.map((b) => (
              <li key={b.id} className="focus-tiers-row">
                <span className={`focus-tiers-icon todo-tier-icon-${b.id}`}>{b.icon}</span>
                <span className="focus-tiers-label">{b.label}</span>
                <span className="focus-tiers-tag">Built-in</span>
              </li>
            ))}
            {tiers.map((t) => (
              <li key={t.id} className="focus-tiers-row">
                <span className="focus-tiers-icon todo-tier-icon-custom">{ICON_TIER_CUSTOM}</span>
                {editingId === t.id ? (
                  <input
                    className="focus-tiers-edit-input"
                    value={editValue}
                    maxLength={LABEL_MAX}
                    autoFocus
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => handleEditKeyDown(e, t.id)}
                    onBlur={() => void commitRename(t.id)}
                  />
                ) : (
                  <button
                    type="button"
                    className="focus-tiers-label focus-tiers-label-editable"
                    title="Click to rename"
                    onClick={() => startEdit(t)}
                  >
                    {t.label}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-danger-outline"
                  onClick={() => void handleDelete(t)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>

          {tiers.length === 0 && (
            <p className="text-sm text-muted" style={{ margin: '4px 0 8px' }}>
              No custom tiers yet — add one (e.g. Icebox).
            </p>
          )}

          <div className="focus-tiers-add-row">
            <input
              type="text"
              value={newLabel}
              maxLength={LABEL_MAX}
              placeholder="New tier name (e.g. Icebox)"
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !newLabel.trim()}
              onClick={() => void handleAdd()}
            >
              {busy ? 'Adding…' : 'Add tier'}
            </button>
          </div>

          {error && <SettingsNotice kind="error">Error: {error}</SettingsNotice>}
          {notice && <SettingsNotice kind="success">{notice}</SettingsNotice>}
        </>
      )}
    </SettingsSection>
  );
}
