/**
 * MetaFooter — task metadata controls in the session path selector footer.
 * The primary row keeps launch-critical choices visible — model + engine (as ONE
 * pair; see EngineToggle) and the pin tier (which tier column the new task lands
 * in, changed often enough that burying it cost a click every launch) — while
 * rarer metadata (dates, unread, priority) lives in an upward-opening More menu.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SESSION_MODELS } from '@open-walnut/core';
import { PRIORITY_OPTIONS, DEFAULT_META } from '../task-meta-constants';
import type { QuickStartTaskMeta } from '../SessionPathSelector';
import { DatePicker } from '@/components/common/DatePicker';
import { PinTierPicker } from '@/components/common/PinTierPicker';
import { useHostModelCatalog } from '@/hooks/useModelCatalog';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import {
  engineEntry,
  engineLockReason,
  engineTitle,
  normalizeEngine,
  resolveEngineForHost,
} from '@/utils/engines';
import { formatModelName } from '@/hooks/useSessionUsage';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { sortByModelStrength } from '@/utils/model-strength-order';
import { catalogRowLabel } from '../ModelPicker';

interface Props {
  meta: QuickStartTaskMeta;
  onChange: (updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
  compact: boolean;
  /** Host the session will spawn on (null/undefined = local; drives which
   *  host's model catalog fills the dropdown). */
  host?: string | null;
  /** Render the row WITHOUT the model select AND without the engine toggle, for a
   *  surface that shows the model somewhere else (the draft column puts it in the
   *  composer, mirroring a real session where the model pill lives in the mode
   *  bar). The provider is part of that control there, so it leaves with it.
   *  Default false — every other caller keeps both in the primary row. */
  hideModel?: boolean;
}

/** Model dropdown rows: the host's last-known CLI catalog (values = full
 *  provider IDs, sent verbatim to spawn) — falling back to the static registry
 *  only when this host has never produced a catalog. The catalog 'default' row
 *  is folded into the Auto option (Auto = no --model = CLI default) — but its
 *  resolvedModel is surfaced in the Auto label ("Auto (Opus 5 1M)") so the
 *  user knows WHAT Auto launches before starting. */
export function useModelOptions(host?: string | null): {
  options: Array<{ value: string; label: string }>;
  /** Short display name of the model Auto resolves to on this host ('' = unknown). */
  autoResolved: string;
} {
  const catalog = useHostModelCatalog(host);
  if (catalog) {
    return {
      options: sortByModelStrength(
        catalog.models.filter((m) => m.value !== 'default' && !m.disabled),
        (model) => `${model.value} ${model.resolvedModel ?? ''} ${catalogRowLabel(model)}`,
      )
        // Versioned label ("Opus 5 1M", not "Opus") — same rule as the
        // picker's catalogRowLabel: the user must see WHICH version launches.
        .map((m) => ({ value: m.value, label: catalogRowLabel(m) })),
      autoResolved: formatModelName(catalog.models.find((m) => m.value === 'default')?.resolvedModel),
    };
  }
  return {
    options: sortByModelStrength(
      SESSION_MODELS,
      (model) => `${model.cliModel} ${model.label}`,
    ).map((sm) => ({ value: sm.id, label: sm.label })),
    autoResolved: '',
  };
}

/**
 * The launcher's model dropdown, on its own so a surface can place it somewhere
 * other than the meta row (the draft column puts it in the composer's controls
 * row) without re-deriving the option list — `useModelOptions` is the single
 * source of truth for what a launch can pick.
 *
 * Renders NOTHING when the picked engine discovers its models at session start
 * (every ACP engine): there is no pre-start catalog to offer.
 */
export function MetaModelSelect({ meta, onChange, host, className }: Pick<Props, 'meta' | 'onChange' | 'host'> & { className?: string }) {
  const { options: modelOptions, autoResolved } = useModelOptions(host);
  const catalog = useEngineCatalog();
  // A previously-picked model that isn't in the current host's rows (host tab
  // switched, catalog updated) still renders — selected, clearly marked — so
  // the <select> never silently shows Auto while meta.model is set.
  const orphanModel = meta.model && !modelOptions.some((o) => o.value === meta.model)
    ? meta.model : null;
  // The EFFECTIVE engine, not the stored one: a remote tab launches the default
  // engine regardless (ACP engines are local-only), so the select must show.
  const launching = engineEntry(catalog, resolveEngineForHost(meta.engine, host, catalog));
  if (launching.capabilities.modelCatalog !== 'static') return null;
  return (
    <select
      className={`sps-meta-model-select${className ? ` ${className}` : ''}`}
      value={meta.model ?? ''}
      onChange={(e) => onChange(m => ({ ...m, model: e.target.value || undefined }))}
      title="Session model — Auto lets Claude/config pick the default"
      aria-label="Session model"
    >
      <option value="">{autoResolved ? `Auto (${autoResolved})` : 'Auto'}</option>
      {modelOptions.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
      {orphanModel && <option value={orphanModel}>{orphanModel} (not in this host's catalog)</option>}
    </select>
  );
}

/** Segmented engine toggle — one button per engine in the catalog.
 *
 *  Renders ONLY on a surface that also owns the model control (`hideModel` false
 *  — the folder picker's footer, whose model control is a plain `<select>` with no
 *  provider rail). Where the model lives elsewhere the provider goes with it: the
 *  draft column's composer pill opens the shared two-pane provider|models picker,
 *  which already answers "which engine", so a second segmented control in the
 *  meta row was the same question asked twice, two rows apart.
 *
 *  Buttons the launch can't use are disabled with the reason as their tooltip: an
 *  engine whose CLI isn't installed, and every ACP engine on a remote host tab
 *  (the ACP worker is local-only for now). */
function EngineToggle({ meta, onChange, host }: Pick<Props, 'meta' | 'onChange' | 'host'>) {
  const catalog = useEngineCatalog();
  // The engine that will ACTUALLY launch (quick-start drops a local-only flag on
  // a remote tab), so the highlight mirrors effective behavior rather than the
  // stored value — see resolveEngineForHost.
  const active = resolveEngineForHost(meta.engine, host, catalog);
  return (
    <div className="sps-engine-toggle" role="group" aria-label="Coding agent engine">
      {catalog.map((entry) => {
        const lock = engineLockReason(entry, host);
        return (
          <button
            key={entry.id}
            type="button"
            className={`sps-engine-btn${entry.id === active ? ' active' : ''}`}
            disabled={!!lock}
            // Picking the default engine CLEARS the field (storage contract);
            // any other engine also clears the model, whose catalog it can't use.
            onClick={() => onChange(m => (entry.isDefault
              ? { ...m, engine: undefined }
              : { ...m, engine: normalizeEngine(entry.id), model: undefined }))}
            title={lock ?? engineTitle(entry)}
          >
            {entry.displayName}
          </button>
        );
      })}
    </div>
  );
}

/** Pin-tier picker. Lives in the PRIMARY row (not the More menu): which tier the
 *  new task lands in is a per-launch decision, so it has to be visible and one
 *  click away. The buttons are the shared PinTierPicker (same control as Quick
 *  Task). Deliberately NOT sticky: every fresh launcher opens on Satellite
 *  (freshLauncherMeta) and a pick applies to this launch only. */
function TierPicker({ meta, onChange }: Pick<Props, 'meta' | 'onChange'>) {
  return (
    <PinTierPicker
      value={meta.pinTier}
      label="Pin"
      onChange={(pinTier) => onChange(m => ({ ...m, pinTier }))}
    />
  );
}

export function MetaFooter({ meta, onChange, compact, host, hideModel = false }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // POPPED OUT of the host, like every draft-column overlay (user: overlays
  // "没有必要完全占满,大小不应该跟着 session 列走"): portalled to <body> at its
  // own fixed width and PLACED at the More button by useMenuPlacement (measure →
  // open upward → viewport clamp), instead of an absolutely-positioned child
  // whose width the host column dictated (full row width in a draft, and inside
  // a session panel its stacking context let siblings paint over it).
  const morePlacement = useMenuPlacement(moreOpen, moreBtnRef, popoverRef, {
    gap: 4,
    margin: 12,
    preferSide: 'up',
    onAnchorLost: () => setMoreOpen(false),
  });
  // Count fields the user actually CHANGED from the quick-start defaults, so a
  // fresh open shows an inactive badge, not "More · 1". Only counts controls that
  // LIVE in the menu: the pin tier moved to the primary row, where its own active
  // state is already visible.
  const nonDefaultCount = Number(meta.unread !== DEFAULT_META.unread)
    + Number(meta.priority !== DEFAULT_META.priority)
    + Number(!!meta.startDate) + Number(!!meta.endDate) + Number(!!meta.dueDate);

  useEffect(() => {
    if (!moreOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      const t = event.target as HTMLElement;
      // The date pickers' calendar popovers are PORTALLED to <body> (escaping
      // clipping ancestors), so a click inside one is outside moreRef — without
      // this exemption picking a date would slam the whole More menu shut.
      if (t.closest?.('.dp-popover')) return;
      // The popover itself is a <body> portal too now, so DOM containment must
      // be tested against BOTH the in-row trigger and the portalled panel.
      if (popoverRef.current?.contains(t)) return;
      if (!moreRef.current?.contains(t)) setMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMoreOpen(false);
    };

    document.addEventListener('mousedown', handleMouseDown);
    // Capture prevents the Escape from reaching the focused path input first.
    document.addEventListener('keydown', handleKeyDown, true);

    // a11y: the popover is a <body> portal, unreachable by tabbing from the
    // trigger. Move focus in on open and hand it back to the trigger on close —
    // but only if focus is still inside the popover (don't steal it from
    // wherever the user clicked).
    const popover = popoverRef.current;
    popover?.querySelector<HTMLElement>('button, select, input')?.focus();
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (popover?.contains(document.activeElement)) moreBtnRef.current?.focus();
    };
  }, [moreOpen]);

  return (
    <div className={`sps-meta-footer${compact ? ' compact' : ''}`}>
      <div className="sps-meta-row">
        {/* Model + provider travel together — see EngineToggle's note. */}
        {!hideModel && <MetaModelSelect meta={meta} onChange={onChange} host={host} />}
        {!hideModel && <EngineToggle meta={meta} onChange={onChange} host={host} />}
        <TierPicker meta={meta} onChange={onChange} />
        <div className="sps-meta-more" ref={moreRef}>
          {moreOpen && createPortal(
            <div
              ref={popoverRef}
              className="sps-meta-more-popover"
              role="dialog"
              aria-label="More task settings"
              // Fixed position at the More button (opens upward), viewport-
              // clamped — never sized by the host column, never off-screen.
              style={menuPlacementStyle(morePlacement)}
            >
              {/* Task dates — the same Start / End / Due trio as the Quick Task
                  form (a launch IS a task create). Same calendar semantics too:
                  Start leads, End/Due are usually empty so they ghost. Popover
                  pickers (not inline): three inline calendars would triple the
                  menu's height. */}
              <div className="sps-meta-row">
                <span className="sps-meta-label">Dates</span>
                <div className="sps-meta-dates">
                  <DatePicker
                    date={meta.startDate}
                    label="Start"
                    onChange={(startDate) => onChange(m => ({ ...m, startDate: startDate ?? undefined }))}
                  />
                  <DatePicker
                    date={meta.endDate}
                    label="End"
                    ghostWhenEmpty
                    onChange={(endDate) => onChange(m => ({ ...m, endDate: endDate ?? undefined }))}
                  />
                  <DatePicker
                    date={meta.dueDate}
                    label="Due"
                    ghostWhenEmpty
                    onChange={(dueDate) => onChange(m => ({ ...m, dueDate: dueDate ?? undefined }))}
                  />
                </div>
              </div>
              <div className="sps-meta-row">
                <button
                  type="button"
                  className={`sps-meta-toggle${meta.unread ? ' active unread' : ''}`}
                  onClick={() => onChange(m => ({ ...m, unread: !m.unread }))}
                  title="Start this task marked unread"
                >
                  <span className="sps-meta-toggle-icon">●</span>
                  <span>Mark unread</span>
                </button>
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
            </div>,
            document.body,
          )}
          <button
            type="button"
            ref={moreBtnRef}
            className={`sps-meta-more-btn${nonDefaultCount > 0 ? ' active' : ''}`}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(open => !open)}
          >
            <span>⋯ More</span>
            {nonDefaultCount > 0 && <span className="sps-meta-more-badge">· {nonDefaultCount}</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
