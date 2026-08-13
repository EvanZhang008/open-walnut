/**
 * Plugin-declared task fields — generic console rendering.
 *
 * Plugins declare per-task fields in their manifest (`taskFields`: key, label,
 * enum type, an options route). The console renders them with ZERO plugin
 * knowledge: one "Label ▸" row per field in the task kebab menu opening a
 * portalled option flyout, and a pill wherever the task detail shows fields.
 * Values are written through PUT /api/tasks/:id/plugin-field; each plugin's
 * own push logic translates the stored value for its remote API.
 *
 * Follows the menus & overlays hard rules (web/src/AGENTS.md): the option list
 * is its OWN portalled flyout placed by useMenuPlacement (never inline growth
 * inside the parent menu), pointerdown is stopped so dnd-kit never drags the
 * row, and host menus must exempt `.task-kebab-project-flyout` clicks — this
 * flyout reuses that class family so existing outside-click guards cover it.
 */
import { useState, useEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { apiGet, apiPut } from '@/api/client';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';

// ── Types + declared-fields cache (module-level, same pattern as useIntegrations) ──

export interface PluginTaskField {
  pluginId: string;
  pluginName: string;
  key: string;
  label: string;
  type: 'enum';
  optionsRoute: string;
  optionsUrl: string;
  clearable?: boolean;
  coreField?: 'sprint';
}

export interface PluginFieldOption {
  value: string;
  label?: string;
  hint?: string;
}

let cachedFields: PluginTaskField[] | null = null;
let fieldsPromise: Promise<PluginTaskField[]> | null = null;

async function fetchDeclaredFields(): Promise<PluginTaskField[]> {
  if (cachedFields) return cachedFields;
  fieldsPromise ??= apiGet<{ fields: PluginTaskField[] }>('/api/integrations/task-fields')
    .then(r => { cachedFields = r.fields ?? []; return cachedFields; })
    .catch(() => { fieldsPromise = null; return []; });
  return fieldsPromise;
}

/** Declared plugin task fields (all enabled plugins). Cached for the session. */
export function usePluginTaskFields(): PluginTaskField[] {
  const [fields, setFields] = useState<PluginTaskField[]>(cachedFields ?? []);
  useEffect(() => {
    if (cachedFields) return;
    let alive = true;
    fetchDeclaredFields().then(f => { if (alive) setFields(f); });
    return () => { alive = false; };
  }, []);
  return fields;
}

/** Read a task's current value for a declared field (core column or ext). */
export function readPluginFieldValue(
  task: { sprint?: string; ext?: Record<string, unknown> },
  field: PluginTaskField,
): string | undefined {
  if (field.coreField === 'sprint') return task.sprint || undefined;
  const ext = task.ext?.[field.pluginId] as Record<string, unknown> | undefined;
  const v = ext?.[field.key];
  return typeof v === 'string' && v ? v : undefined;
}

/** Write a field value ('' or null clears) through the generic endpoint. */
export async function setPluginFieldValue(
  taskId: string,
  field: PluginTaskField,
  value: string | null,
): Promise<void> {
  await apiPut(`/api/tasks/${taskId}/plugin-field`, {
    pluginId: field.pluginId,
    key: field.key,
    value,
  });
}

// ── Option flyout — portalled, useMenuPlacement, lazy options fetch ──

export function PluginFieldFlyout({ open, anchorRef, field, current, onPick, onClose }: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  field: PluginTaskField;
  /** Current stored value. undefined = unset. */
  current: string | undefined;
  /** null = clear. */
  onPick: (value: string | null) => void;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<PluginFieldOption[] | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, anchorRef, listRef, {
    minHeight: 120,
    onAnchorLost: onClose,
  });

  // Options load when the flyout OPENS (fresh each time — sprint lists change),
  // not per task row and never cached by core.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setOptions(null);
    apiGet<{ options?: PluginFieldOption[]; current?: string | null }>(field.optionsUrl)
      .then(r => {
        if (!alive) return;
        setOptions(r.options ?? []);
        setSuggested(r.current ?? null);
      })
      .catch(() => { if (alive) setOptions([]); });
    return () => { alive = false; };
  }, [open, field.optionsUrl]);

  if (!open) return null;

  const row = (value: string | null, label: string, hint?: string, isSuggested?: boolean) => (
    <button
      key={value ?? '·none·'}
      className={`task-kebab-project-opt${(current ?? null) === value ? ' active' : ''}`}
      onClick={(e) => { e.stopPropagation(); onPick(value); onClose(); }}
    >
      <span className="task-kebab-project-check">{(current ?? null) === value ? '✓' : ''}</span>
      <span className="task-kebab-project-opt-name">
        {label}
        {isSuggested && <span className="plugin-field-current-mark"> · current</span>}
      </span>
      {hint && <span className="plugin-field-opt-hint">{hint}</span>}
    </button>
  );

  return createPortal(
    <div
      ref={listRef}
      // task-kebab-project-flyout: reuse the flyout class family so host menus'
      // outside-click and scroll guards (which exempt it) cover this flyout too.
      className="task-kebab-project-flyout plugin-field-flyout"
      style={menuPlacementStyle(placement)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {options === null && <div className="task-kebab-project-empty">Loading…</div>}
      {options !== null && (
        <>
          {field.clearable !== false && row(null, 'None')}
          {options.map(o => row(o.value, o.label ?? o.value, o.hint, o.value === suggested))}
          {options.length === 0 && (
            <div className="task-kebab-project-empty">No options available</div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}

// ── Kebab menu section — one "Label ▸" trigger row per declared field ──

export function PluginFieldsSection({ task, afterAction }: {
  task: { id: string; sprint?: string; ext?: Record<string, unknown> };
  afterAction: () => void;
}) {
  const fields = usePluginTaskFields();
  if (fields.length === 0) return null;
  return (
    <>
      {fields.map(f => (
        <PluginFieldRow key={`${f.pluginId}.${f.key}`} task={task} field={f} afterAction={afterAction} />
      ))}
    </>
  );
}

function PluginFieldRow({ task, field, afterAction }: {
  task: { id: string; sprint?: string; ext?: Record<string, unknown> };
  field: PluginTaskField;
  afterAction: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = readPluginFieldValue(task, field);
  return (
    <>
      <div className="task-kebab-project">
        <span className="task-kebab-project-label">{field.label}</span>
        <button
          ref={btnRef}
          className={`task-kebab-project-current${open ? ' open' : ''}`}
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        >
          <span className="task-kebab-project-current-name">{current ?? 'Set…'}</span>
          <span className="task-kebab-project-caret">▾</span>
        </button>
      </div>
      <PluginFieldFlyout
        open={open}
        anchorRef={btnRef}
        field={field}
        current={current}
        onPick={(value) => {
          if (value !== (current ?? null)) {
            setPluginFieldValue(task.id, field, value).catch(() => { /* sync_error surfaces via TASK_UPDATED */ });
          }
          afterAction();
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

// ── Interactive pills for detail views — the generic successor of the old
// hardcoded SprintPicker: one clickable pill per declared field, opening the
// same option flyout the kebab uses. Unset fields render as "+ Label".

export function PluginFieldPills({ task }: {
  task: { id: string; sprint?: string; ext?: Record<string, unknown> };
}) {
  const fields = usePluginTaskFields();
  if (fields.length === 0) return null;
  return (
    <>
      {fields.map(f => (
        <PluginFieldPill key={`${f.pluginId}.${f.key}`} task={task} field={f} />
      ))}
    </>
  );
}

export function PluginFieldPill({ task, field }: {
  task: { id: string; sprint?: string; ext?: Record<string, unknown> };
  field: PluginTaskField;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = readPluginFieldValue(task, field);
  return (
    <>
      <button
        ref={btnRef}
        className={`sprint-picker-pill${!current ? ' sprint-picker-empty-pill' : ''}`}
        title={current ? `${field.label}: ${current}` : `Set ${field.label.toLowerCase()}`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        {current || `+ ${field.label}`}
      </button>
      <PluginFieldFlyout
        open={open}
        anchorRef={btnRef}
        field={field}
        current={current}
        onPick={(value) => {
          if (value !== (current ?? null)) {
            setPluginFieldValue(task.id, field, value).catch(() => { /* sync_error surfaces via TASK_UPDATED */ });
          }
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
