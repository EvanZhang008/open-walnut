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
import type { DraftFieldOwner, DraftOwnedField } from '../draft-column';
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
import { useShowPriority } from '@/hooks/useShowPriority';
import { sortByModelStrength } from '@/utils/model-strength-order';
import { catalogRowLabel } from '../ModelPicker';

interface Props {
  meta: QuickStartTaskMeta;
  onChange: (updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
  compact: boolean;
  /** Host the session will spawn on (null/undefined = local; drives which
   *  host's model catalog fills the dropdown). */
  host?: string | null;
  /** Per-field owners of the host draft's task fields (DraftColumn.fieldOwner).
   *  When given, the More badge counts only fields the user owns: a date the
   *  background parse filled is not something the user changed. endDate follows
   *  startDate's owner. Omitted: every non-default field counts, as before. */
  ownedFields?: Readonly<Partial<Record<DraftOwnedField, DraftFieldOwner>>>;
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
 *  Sits next to the model `<select>` because the two are one decision: the
 *  footer's model control is a plain select with no provider rail, so the
 *  engine needs its own control here. (The draft column asks neither question
 *  in its launch bar: its composer pill opens the shared two-pane provider|models
 *  picker, which answers both.)
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
            // Picking the default engine CLEARS the field (storage contract).
            // ANY actual engine change also clears the model — catalogs don't
            // overlap in either direction (an ACP id must not ride a claude
            // launch as --model, nor a claude id an ACP launch's acpConfig).
            onClick={() => onChange(m => (entry.isDefault
              ? { ...m, engine: undefined, ...(entry.id !== active ? { model: undefined } : {}) }
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
 *  Task). Deliberately NOT sticky: every fresh launcher opens on the default
 *  tier (DEFAULT_META, Focus) and a pick applies to this launch only. The draft
 *  column's launch bar dropped its tier row (see DraftLaunchBar); its More menu
 *  (DraftTaskMenuPopover) edits the same meta, so a pick here and a pick there agree. */
function TierPicker({ meta, onChange }: Pick<Props, 'meta' | 'onChange'>) {
  return (
    <PinTierPicker
      value={meta.pinTier}
      label="Pin"
      onChange={(pinTier) => onChange(m => ({ ...m, pinTier }))}
    />
  );
}

type OwnedFields = Readonly<Partial<Record<DraftOwnedField, DraftFieldOwner>>>;

/**
 * The More badge's count: fields changed from the quick-start defaults that the
 * menu draws (priority only while shown). With `ownedFields` a field counts only
 * when the user owns it, so an AI-written date is not "More · 1" (C65).
 */
export function metaFooterEditCount(meta: QuickStartTaskMeta, showPriority: boolean, ownedFields?: OwnedFields): number {
  const owned = (f: DraftOwnedField) => !ownedFields || !!ownedFields[f];
  return Number(meta.unread !== DEFAULT_META.unread && owned('unread'))
    + Number(showPriority && meta.priority !== DEFAULT_META.priority && owned('priority'))
    + Number(!!meta.startDate && owned('startDate')) + Number(!!meta.endDate && owned('startDate'))
    + Number(!!meta.dueDate && owned('dueDate'));
}

/** `ownedFields` plus every field the footer changed since the picker opened:
 *  an edit made here is the user's before the confirm rebases it in. */
export function withFooterEdits(
  ownedFields: OwnedFields | undefined, opened: QuickStartTaskMeta | null, meta: QuickStartTaskMeta,
): OwnedFields | undefined {
  if (!ownedFields || !opened) return ownedFields;
  const out: Partial<Record<DraftOwnedField, DraftFieldOwner>> = { ...ownedFields };
  if (meta.unread !== opened.unread) out.unread = 'user';
  if (meta.priority !== opened.priority) out.priority = 'user';
  if (meta.startDate !== opened.startDate || meta.endDate !== opened.endDate) out.startDate = 'user';
  if (meta.dueDate !== opened.dueDate) out.dueDate = 'user';
  return out;
}

export function MetaFooter({ meta, onChange, compact, host, ownedFields }: Props) {
  const showPriority = useShowPriority();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // POPPED OUT of the host, like every launcher overlay (user: overlays need
  // not fill the column, and must not size with the session column): portalled
  // to <body> at its own fixed width and PLACED at the More button by
  // useMenuPlacement (measure → open upward → viewport clamp), instead of an
  // absolutely-positioned child
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
  // A field the menu does not draw must not be counted: with priority hidden the
  // badge would read "More · 1" for a value the user cannot see or change here.
  // With `ownedFields` a field counts only when the user owns it (C65).
  const nonDefaultCount = metaFooterEditCount(meta, showPriority, ownedFields);

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
        <MetaModelSelect meta={meta} onChange={onChange} host={host} />
        <EngineToggle meta={meta} onChange={onChange} host={host} />
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
                  <span>Start unread</span>
                </button>
              </div>
              {showPriority && (
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
              )}
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
            <span>More</span>
            {nonDefaultCount > 0 && <span className="sps-meta-more-badge">· {nonDefaultCount}</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
