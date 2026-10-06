/**
 * useBulkTaskSettings — the Pinned row and the plugin field rows (Sprint, …) for a folder's or a
 * project's right-click menu, wired to the shared stores. The rows themselves are built by the pure
 * functions in `bulk-task-settings.ts`; this hook supplies the live data (task store, focus bar,
 * declared plugin fields), asks before a large write, and owns the field picker, which outlives the
 * menu that opened it (running a row closes the menu).
 *
 * Every surface that draws a folder or project menu gets these rows from the hook inside that
 * menu, so no surface threads pin or field handlers of its own.
 */
import { type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import type { ContextMenuItem } from '@/utils/context-menu';
import type { FocusTier } from '@/api/focus';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';
import { useConfirm } from '@/hooks/useConfirm';
import { folderSubtreeIds } from '@/hooks/useTasks';
import * as ICONS from '../common/Icons';
import { TIER_COLORS, TIER_OPTIONS } from './TaskKebabMenu';
import { PluginFieldFlyout, readPluginFieldValue, usePluginTaskFields, type PluginTaskField } from './PluginFieldPicker';
import { useCursorFlyout, type CursorPoint } from './CursorFlyout';
import {
  buildFieldRows, buildPinnedPills, bulkConfirmCopy, commonTier, commonValue,
  folderMemberTasks, projectMemberTasks, type BulkNoun, type CommonValue, type TierPillOption,
} from './bulk-task-settings';

/** Which tasks a menu acts on. */
export type BulkScope = { kind: 'folder'; groupId: string } | { kind: 'project'; project: string };

export interface BulkTaskSettingsHandle {
  /** The menu's rows for this scope, read when the menu opens. `point` anchors the field picker. */
  rows: (scope: BulkScope, point: CursorPoint) => { pinned: ContextMenuItem[]; fields: ContextMenuItem[] };
  /** The field picker; render it beside the menu. */
  node: ReactNode;
}

const fieldId = (field: PluginTaskField) => `${field.pluginId}.${field.key}`;

export function useBulkTaskSettings(): BulkTaskSettingsHandle {
  const store = useTasksContextSafe();
  const focusBar = useFocusBarContextSafe();
  const fields = usePluginTaskFields();
  const confirm = useConfirm();
  const picker = useCursorFlyout<{ field: PluginTaskField; ids: string[]; common: CommonValue }>();

  const membersOf = (scope: BulkScope): Task[] => {
    if (!store) return [];
    return scope.kind === 'folder'
      ? folderMemberTasks(store.tasks, folderSubtreeIds(scope.groupId, store.folderMeta))
      : projectMemberTasks(store.tasks, scope.project);
  };

  const tierOptions = (): TierPillOption[] => [
    ...TIER_OPTIONS.map((t) => ({ value: t.value, label: t.label, icon: t.icon, color: TIER_COLORS[t.value] })),
    ...(focusBar?.customTiers ?? []).map((ct) => ({
      value: ct.id, label: ct.label, icon: ICONS.ICON_TIER_CUSTOM, color: 'var(--tier-custom)',
    })),
  ];

  const asked = async (copy: ReturnType<typeof bulkConfirmCopy>): Promise<boolean> =>
    copy === null || await confirm(copy);

  const rows: BulkTaskSettingsHandle['rows'] = (scope, point) => {
    const members = membersOf(scope);
    const ids = members.map((t) => t.id);
    const noun: BulkNoun = scope.kind;
    const options = tierOptions();
    const pinned = focusBar
      ? buildPinnedPills({
        options,
        common: commonTier(members, (t) => focusBar.tierOf(t.id)),
        count: ids.length,
        noun,
        onPick: (tier: FocusTier | null) => {
          const tierLabel = tier === null ? null : options.find((o) => o.value === tier)?.label ?? tier;
          void asked(bulkConfirmCopy({ kind: 'tier', tierLabel }, ids.length))
            .then((ok) => { if (ok) void focusBar.setTierBulk(ids, tier); });
        },
      })
      : [];
    const fieldRows = store
      ? buildFieldRows({
        fields: fields.map((field) => ({
          id: fieldId(field),
          label: field.label,
          common: commonValue(members, (t) => readPluginFieldValue(t, field)),
        })),
        count: ids.length,
        noun,
        onOpen: (id) => {
          const field = fields.find((f) => fieldId(f) === id);
          if (!field) return;
          picker.open({ field, ids, common: commonValue(members, (t) => readPluginFieldValue(t, field)) }, point);
        },
      })
      : [];
    return { pinned, fields: fieldRows };
  };

  const open = picker.state;
  const node = open && (
    <PluginFieldFlyout
      open
      anchorRef={picker.noTrigger}
      anchorPoint={open.point}
      field={open.payload.field}
      current={open.payload.common.kind === 'same' ? open.payload.common.value : undefined}
      mixed={open.payload.common.kind === 'mixed'}
      onPick={(value) => {
        const { field, ids, common } = open.payload;
        // Re-picking what every task already has is a dismiss, not a write.
        const unchanged = common.kind === 'same' ? value === common.value : common.kind === 'none' && value === null;
        if (!store || unchanged) return;
        void asked(bulkConfirmCopy({ kind: 'field', fieldLabel: field.label, valueLabel: value }, ids.length))
          .then((ok) => { if (ok) void store.batchSetPluginField(ids, field, value); });
      }}
      onClose={picker.close}
    />
  );

  return { rows, node };
}
