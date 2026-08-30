/**
 * LaneComposerControls — the main-AI chat composer's controls row when the
 * lane engine is active: a mode pill (permission mode, Shift+Tab cycles) and
 * the model pill (opens the shared ModelPicker; live model/effort switch).
 *
 * Deliberately a SUBSET of the session composer's controls: no SideQuestion
 * "btw" drawer and no notes pill (user call, 2026-08-15) — the chat surface
 * stays minimal, everything else matches a coding session so the two
 * composers feel identical.
 *
 * All state lives on the lane SESSION record (mode/model/effort), fetched
 * here because MainPage only holds the lane's sessionId. Mutations use the
 * same endpoints the session panel uses (updateSession / setSessionModel /
 * setSessionEffort with get_settings read-back).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { SessionEngine, SessionRecord } from '@/types/session';
import type { SessionEffort } from '@open-walnut/core';
import { modelSupportsEffort, SESSION_EFFORTS, SESSION_MODE_LABELS } from '@open-walnut/core';
import { fetchSession, updateSession, setSessionModel, setSessionEffort, setCodexSessionModel } from '@/api/sessions';
import { useSessionUsage, formatModelName, getContextWindowSize, contextBadgeTitle } from '@/hooks/useSessionUsage';
import { useEnabledModes } from '@/hooks/useEnabledModes';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { engineCaps } from '@/utils/engine-capabilities';
import { ModelPicker, shortAcpModelName, type ProviderId } from '@/components/sessions/ModelPicker';

interface LaneComposerControlsProps {
  sessionId: string | null;
  /** Engine backing the lane (from useLaneSession). Default 'claude'. */
  engine?: SessionEngine;
  /** Provided ONLY while the conversation is empty: picking another provider
   *  re-mints the lane session on that engine (useLaneSession.swapEngine).
   *  Absent → the other providers render greyed + locked, like a live session. */
  onProviderSwitch?: (provider: ProviderId) => void;
}

export function LaneComposerControls({ sessionId, engine = 'claude', onProviderSwitch }: LaneComposerControlsProps) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The clicked pill — anchor for the popout picker (portalled, clip-proof).
  const pillRef = useRef<HTMLElement | null>(null);
  const enabledModes = useEnabledModes();
  const liveUsage = useSessionUsage(sessionId);
  const engineCatalog = useEngineCatalog();
  const engineUi = engineCaps(engine, engineCatalog);

  // Pull the lane record for mode/model/effort. Refresh on session change.
  useEffect(() => {
    setSession(null);
    setPickerOpen(false);
    if (!sessionId) return;
    let cancelled = false;
    fetchSession(sessionId).then((s) => { if (!cancelled && s) setSession(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId]);

  const currentMode = session?.mode || 'bypass';
  const cycleMode = useCallback(() => {
    if (!session || !sessionId) return;
    const cur = session.mode || 'bypass';
    const idx = enabledModes.indexOf(cur);
    const next = enabledModes[(idx + 1) % enabledModes.length]!;
    setSession({ ...session, mode: next });
    updateSession(sessionId, { mode: next }).catch(() => {
      setSession({ ...session, mode: cur }); // revert
    });
  }, [session, sessionId, enabledModes]);

  const handleModelSwitch = useCallback((model: string) => {
    setPickerOpen(false);
    if (!sessionId) return;
    const prev = session?.model;
    setSession((s) => s ? { ...s, model } : s);
    setSessionModel(sessionId, model).then((res) => {
      if (res.effectiveModel) setSession((s) => s ? { ...s, model: res.effectiveModel } : s);
    }).catch(() => {
      setSession((s) => s ? { ...s, model: prev } : s);
    });
  }, [sessionId, session?.model]);

  const handleEffortSwitch = useCallback((effort: SessionEffort) => {
    setPickerOpen(false);
    if (!sessionId) return;
    const prevEffort = session?.effort;
    const prevEffective = session?.effectiveEffort;
    setSession((s) => s ? { ...s, effort } : s);
    setSessionEffort(sessionId, effort).then((res) => {
      setSession((s) => s ? { ...s, effort, effectiveEffort: res.effectiveEffort ?? s.effectiveEffort } : s);
    }).catch(() => {
      setSession((s) => s ? { ...s, effort: prevEffort, effectiveEffort: prevEffective } : s);
    });
  }, [sessionId, session?.effort, session?.effectiveEffort]);

  const handleAcpModelSwitch = useCallback((modelId: string) => {
    setPickerOpen(false);
    if (!sessionId) return;
    const prev = session?.acpModel;
    const prevName = session?.acpModelName;
    if (modelId === prev) return;
    // The advertised name describes the OLD model and the pill prefers it —
    // clear it so the new id is prettified until the record comes back.
    setSession((s) => s ? { ...s, acpModel: modelId, acpModelName: undefined } : s);
    setCodexSessionModel(sessionId, modelId).catch(() => {
      setSession((s) => s ? { ...s, acpModel: prev, acpModelName: prevName } : s);
    });
  }, [sessionId, session?.acpModel, session?.acpModelName]);

  if (!sessionId) return null;

  // Model source and mode surface are capability answers, not engine ids: an
  // ACP lane shows its provider-advertised model and hides the Claude-mode pill.
  const isAcp = engineUi.isAcp;
  const rawModel = liveUsage.model || session?.model;
  const displayModel = isAcp
    // 3 tiers: the provider's own name, else prettify the id, else the engine.
    ? (session?.acpModelName
      ?? (session?.acpModel ? shortAcpModelName(session.acpModel) : engineUi.displayName))
    : formatModelName(rawModel);
  let contextPercent = liveUsage.contextPercent;
  let badgeUsage = liveUsage;
  if (contextPercent == null && liveUsage.inputTokens) {
    // The server's persisted window first: the model string tells us nothing
    // about a custom proxy model's window, and guessing 200K for one rendered
    // a 5x-wrong percent (2026-08-23). Still null ⇒ stay silent.
    const ctxSize = session?.modelMaxWindow ?? getContextWindowSize(rawModel, liveUsage.inputTokens);
    if (ctxSize != null) {
      contextPercent = Math.round(liveUsage.inputTokens / ctxSize * 100);
      badgeUsage = {
        ...liveUsage, contextWindow: ctxSize,
        autoCompactAt: liveUsage.autoCompactAt ?? session?.autoCompactAt,
      };
    }
  }

  const modeLabel = (SESSION_MODE_LABELS as Record<string, string>)[currentMode] ?? currentMode;
  const shownEffort = session?.effectiveEffort ?? session?.effort;
  const effortLabel = shownEffort
    ? SESSION_EFFORTS.find((e) => e.id === shownEffort)?.label ?? shownEffort
    : null;

  return (
    <div className="session-mode-bar">
      {/* Permission-mode cycling is a claude-CLI channel (updateSession mode);
          engines whose modes are provider config options ride ACP session
          controls instead — hidden here for now. */}
      {!engineUi.configModes && (
        <button
          className="mode-toggle-pill"
          onClick={cycleMode}
          title={`Mode: ${currentMode}. Click or Shift+Tab to cycle`}
        >
          <span className="mode-toggle-pill-label">{modeLabel}</span>
          <span className="mode-toggle-pill-shortcut">{'⇧'}Tab</span>
        </button>
      )}
      <button
        type="button"
        className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill"
        title={`${(isAcp ? session?.acpModel : rawModel) || 'Model not reported yet (Auto)'} — click to switch model / effort${onProviderSwitch ? ' / provider' : ''}`}
        onClick={(e) => { pillRef.current = e.currentTarget; setPickerOpen((v) => !v); }}
      >
        {displayModel || 'Auto'}
        {!isAcp && contextPercent != null && (
          <span
            className="session-detail-context-pct"
            style={{
              color: contextPercent > 80 ? 'var(--danger, #ff3b30)'
                : contextPercent > 50 ? 'var(--warning, #ff9500)'
                : 'var(--fg-muted)',
            }}
            title={contextBadgeTitle(badgeUsage, contextPercent)}
          >
            {' '}{contextPercent}%
          </span>
        )}
        {!isAcp && modelSupportsEffort(rawModel) && effortLabel && (
          <span className="session-detail-effort-badge" title={`Reasoning effort: ${shownEffort}`}>
            {' · '}{effortLabel}
          </span>
        )}
      </button>
      {pickerOpen && (
        <ModelPicker
          currentModel={rawModel}
          currentEffort={session?.effectiveEffort ?? session?.effort}
          sessionId={sessionId}
          host={session?.host}
          onSwitch={handleModelSwitch}
          onEffortSwitch={handleEffortSwitch}
          onClose={() => setPickerOpen(false)}
          engine={engineUi.id}
          acpCurrentModelId={session?.acpModel}
          onAcpSwitch={isAcp ? handleAcpModelSwitch : undefined}
          // Empty conversation: the provider rail is LIVE — picking the other
          // engine re-mints the lane session on it. Locked once messages exist.
          onProviderSwitch={onProviderSwitch
            ? (p) => { setPickerOpen(false); onProviderSwitch(p); }
            : undefined}
          anchorRef={pillRef}
        />
      )}
    </div>
  );
}
