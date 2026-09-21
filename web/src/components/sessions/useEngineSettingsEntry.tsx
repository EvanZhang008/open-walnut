/**
 * SessionPanel's glue for the "Engine settings" row in the composer's "+" menu.
 *
 * ChatInput stays feature-ignorant: it renders whatever `plusMenuActions` its
 * owner hands it. This hook builds that one action for a session and owns the
 * popover it opens (open state, anchor, close reasons).
 *
 * Three-state gate: before the engine catalog has answered, the row is
 * present but disabled ("Checking what this engine supports"), so a cold start
 * never looks like an engine without settings; a failed catalog read says so
 * and points at Settings; only a hydrated catalog that says the engine has no
 * settings surface removes the row (and its divider) entirely.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlusMenuAction, PlusMenuActionContext } from '@/components/chat/plus-menu-actions';
import { useEngineCatalogHydration } from '@/hooks/useEngineCatalog';
import type { EngineUiCaps } from '@/utils/engine-capabilities';
import { hostLabel, menuActionTitle, shortenCwd } from '@/utils/engine-settings-copy';
import { log } from '@/utils/log';
import { EngineSettingsPopover, type EngineSettingsCloseReason } from './EngineSettingsPopover';

export const ENGINE_SETTINGS_ACTION_ID = 'engine-settings';
export const ENGINE_SETTINGS_PENDING_TITLE = 'Checking what this engine supports';
export const ENGINE_SETTINGS_FAILED_TITLE = 'Could not read the engine list; open Settings › Engines';
/** A composer box up to this tall (one or two lines of draft) anchors the popover's bottom; taller, the "+" row does. */
export const COMPOSER_ANCHOR_MAX_PX = 120;

export interface EngineSettingsEntryInput {
  sessionId: string;
  session: { engine?: string; host?: string; cwd?: string } | null | undefined;
  engineUi: Pick<EngineUiCaps, 'id' | 'displayName' | 'ownSettings'>;
  onOpenPath?: (path: string) => void;
}

export interface EngineSettingsEntry {
  /** Undefined when the engine is known to have no settings surface: no row, no divider. */
  plusMenuActions: PlusMenuAction[] | undefined;
  popover: ReactNode;
}

export function useEngineSettingsEntry({ sessionId, session, engineUi, onOpenPath }: EngineSettingsEntryInput): EngineSettingsEntry {
  const hydration = useEngineCatalogHydration();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  /** The composer box the "+" sits in, when short enough to anchor the popover's bottom to (see openPopover). */
  const composerRef = useRef<HTMLElement | null>(null);
  const engine = session?.engine ?? engineUi.id;
  const host = session?.host;
  const cwd = session?.cwd;

  // A replaced or unmounted session must not leave the popover behind.
  useEffect(() => () => setOpen(false), [sessionId]);

  const openPopover = useCallback(({ anchor, composer }: PlusMenuActionContext) => {
    anchorRef.current = anchor;
    // The popover's bottom clears the composer BOX while that box is a line or
    // two of draft (the textarea stays clickable, and that click closes the
    // popover and lands the caret in one go). A tall draft would push the box
    // up and squeeze the rows, which are what the popover is for, so
    // past this height the bottom sits on the "+" row instead.
    composerRef.current = composer && composer.offsetHeight <= COMPOSER_ANCHOR_MAX_PX ? composer : null;
    setOpen(true);
    log.info('settings', 'engine settings popover opened', { sessionId, engine, host: host ?? '', cwd: cwd ?? '' });
  }, [sessionId, engine, host, cwd]);

  const closePopover = useCallback((reason: EngineSettingsCloseReason) => {
    setOpen(false);
    log.info('settings', 'engine settings popover closed', { sessionId, engine, reason });
  }, [sessionId, engine]);

  const plusMenuActions = useMemo<PlusMenuAction[] | undefined>(() => {
    const base = { id: ENGINE_SETTINGS_ACTION_ID, label: 'Engine settings' };
    if (hydration === 'pending') return [{ ...base, disabled: true, title: ENGINE_SETTINGS_PENDING_TITLE, onSelect: () => {} }];
    if (hydration === 'failed') return [{ ...base, disabled: true, title: ENGINE_SETTINGS_FAILED_TITLE, onSelect: () => {} }];
    if (!engineUi.ownSettings) return undefined;
    const cwdShort = cwd ? shortenCwd(cwd) : '';
    return [{ ...base, title: menuActionTitle(engineUi.displayName, cwdShort, hostLabel(host)), onSelect: openPopover }];
  }, [hydration, engineUi.ownSettings, engineUi.displayName, cwd, host, openPopover]);

  const popover = open && sessionId ? (
    <EngineSettingsPopover
      key={sessionId}
      sessionId={sessionId}
      engine={engine}
      displayName={engineUi.displayName}
      host={host}
      cwd={cwd}
      anchorRef={anchorRef}
      composerRef={composerRef}
      open={open}
      onClose={closePopover}
      onOpenPath={onOpenPath}
    />
  ) : null;

  return { plusMenuActions, popover };
}
