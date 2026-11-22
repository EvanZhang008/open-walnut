/**
 * The draft's More menu as both rows use it (the launch bar's pills row, and the v6 lower row of
 * the experiment `project_first_start`): the menu controller (useDraftDecisionMenu), the decision
 * chips, "Use Walnut's pick" labels and the task-field writes, read once.
 */
import { useMemo, useRef } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';
import { useShowPriorityState } from '@/hooks/useShowPriority';
import type { DraftColumn, DraftTaskField, DraftTaskFieldPatch } from './draft-column';
import {
  customTierLabelLookup, draftDecisionChips, draftDecisionsKeyVisible, draftSuggestionLabel, draftWalnutPicks,
  type DraftDecisionCtx,
} from './draft-decisions';
import { useDraftDecisionMenu } from './DraftDecisionRow';

export function useDraftMoreMenu(draft: DraftColumn, opts: {
  getComposer: () => HTMLTextAreaElement | null;
  composerText: string;
  openMenuNonce?: number;
  onTaskFieldChange?: (draftId: string, patch: DraftTaskFieldPatch) => void;
  onReturnFieldToWalnut?: (draftId: string, field: DraftTaskField) => void;
}) {
  const { getComposer, composerText, openMenuNonce, onTaskFieldChange, onReturnFieldToWalnut } = opts;
  const moreRef = useRef<HTMLButtonElement>(null);
  const menu = useDraftDecisionMenu({ getComposer, composerText, openMenuNonce, moreRef });
  // Decision chips: data from the pure catalog, words from the app's tables.
  const decisionsOn = !!onTaskFieldChange;
  const focusBar = useFocusBarContextSafe();
  const priorityVisible = useShowPriorityState();
  const customTiers = focusBar?.customTiers;
  const tierLabel = useMemo(() => customTierLabelLookup(customTiers ?? []), [customTiers]);
  const ctx: DraftDecisionCtx = {
    tierLabel,
    // Outside the provider (isolated surfaces) there are no custom tiers to wait for.
    customTiersLoaded: focusBar ? focusBar.customTiersLoaded : true,
    priorityVisible,
    now: new Date(),
  };
  const decisionChips = decisionsOn ? draftDecisionChips(draft, ctx) : [];
  const keyVisible = draftDecisionsKeyVisible(draft, composerText, decisionChips);
  const walnutPicks = useMemo(() => {
    if (!decisionsOn || !onReturnFieldToWalnut) return undefined;
    const raw = draftWalnutPicks(draft, { priorityVisible });
    const labels: Partial<Record<DraftTaskField, string>> = {};
    for (const [f, v] of Object.entries(raw) as [DraftTaskField, string][]) {
      labels[f] = draftSuggestionLabel(f, v, { tierLabel, now: new Date() });
    }
    return labels;
  }, [decisionsOn, onReturnFieldToWalnut, draft, priorityVisible, tierLabel]);
  const handleTaskFieldChange = useLeanCallback(
    (patch: DraftTaskFieldPatch) => onTaskFieldChange?.(draft.id, patch),
    [onTaskFieldChange, draft.id],
  );
  const handleReturnToWalnut = useLeanCallback(
    (field: DraftTaskField) => onReturnFieldToWalnut?.(draft.id, field),
    [onReturnFieldToWalnut, draft.id],
  );
  return { menu, moreRef, decisionsOn, priorityVisible, decisionChips, keyVisible, walnutPicks, handleTaskFieldChange, handleReturnToWalnut };
}
