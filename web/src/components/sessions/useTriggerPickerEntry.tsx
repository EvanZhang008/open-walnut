/**
 * SessionPanel's glue for "Add a trigger…" in the composer's "+" menu: the
 * action row and the popover it opens (TriggerPickerPopover). Only a session
 * with a task gets it: a trigger delivers into a task.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlusMenuAction, PlusMenuActionContext } from '@/components/chat/plus-menu-actions';
import { log } from '@/utils/log';
import { COMPOSER_ANCHOR_MAX_PX } from './useEngineSettingsEntry';
import { TriggerPickerPopover, type TriggerPickerCloseReason } from './TriggerPickerPopover';
import { TRIGGER_ACTION_ID, TRIGGER_ACTION_LABEL, TRIGGER_ACTION_TITLE } from './trigger-picker-model';

const TRIGGER_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
  </svg>
);

export function useTriggerPickerEntry(input: {
  sessionId: string;
  taskId: string | null | undefined;
  acp: boolean;
  /** False where the composer posts somewhere other than the session (a question page). */
  enabled: boolean;
  onPrefill: (text: string) => void;
}): { action: PlusMenuAction | null; popover: ReactNode } {
  const { sessionId, taskId, acp, enabled, onPrefill } = input;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);

  useEffect(() => () => setOpen(false), [sessionId]);

  const openPopover = useCallback(({ anchor, composer }: PlusMenuActionContext) => {
    anchorRef.current = anchor;
    composerRef.current = composer && composer.offsetHeight <= COMPOSER_ANCHOR_MAX_PX ? composer : null;
    setOpen(true);
    log.info('trigger', 'trigger picker opened', { sessionId, taskId: taskId ?? '' });
  }, [sessionId, taskId]);

  const close = useCallback((reason: TriggerPickerCloseReason) => {
    setOpen(false);
    log.info('trigger', 'trigger picker closed', { sessionId, reason });
  }, [sessionId]);

  const action = useMemo<PlusMenuAction | null>(() => (enabled && taskId ? {
    id: TRIGGER_ACTION_ID,
    label: TRIGGER_ACTION_LABEL,
    title: TRIGGER_ACTION_TITLE,
    icon: TRIGGER_ICON,
    onSelect: openPopover,
  } : null), [enabled, taskId, openPopover]);

  const popover = open && taskId ? (
    <TriggerPickerPopover
      key={sessionId}
      sessionId={sessionId}
      taskId={taskId}
      acp={acp}
      anchorRef={anchorRef}
      composerRef={composerRef}
      onClose={close}
      onPrefill={onPrefill}
    />
  ) : null;

  return { action, popover };
}
