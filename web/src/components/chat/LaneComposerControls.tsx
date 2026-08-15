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

import { useState, useEffect, useCallback } from 'react';
import type { SessionRecord } from '@/types/session';
import type { SessionEffort } from '@open-walnut/core';
import { modelSupportsEffort, SESSION_EFFORTS, SESSION_MODE_LABELS } from '@open-walnut/core';
import { fetchSession, updateSession, setSessionModel, setSessionEffort } from '@/api/sessions';
import { useSessionUsage, formatModelName, getContextWindowSize } from '@/hooks/useSessionUsage';
import { useEnabledModes } from '@/hooks/useEnabledModes';
import { ModelPicker } from '@/components/sessions/ModelPicker';

export function LaneComposerControls({ sessionId }: { sessionId: string | null }) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const enabledModes = useEnabledModes();
  const liveUsage = useSessionUsage(sessionId);

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

  if (!sessionId) return null;

  const rawModel = liveUsage.model || session?.model;
  const displayModel = formatModelName(rawModel);
  let contextPercent = liveUsage.contextPercent;
  if (contextPercent == null && liveUsage.inputTokens) {
    const ctxSize = getContextWindowSize(rawModel, liveUsage.inputTokens);
    contextPercent = Math.round(liveUsage.inputTokens / ctxSize * 100);
  }

  const modeLabel = (SESSION_MODE_LABELS as Record<string, string>)[currentMode] ?? currentMode;
  const shownEffort = session?.effectiveEffort ?? session?.effort;
  const effortLabel = shownEffort
    ? SESSION_EFFORTS.find((e) => e.id === shownEffort)?.label ?? shownEffort
    : null;

  return (
    <div className="session-mode-bar">
      <button
        className="mode-toggle-pill"
        onClick={cycleMode}
        title={`Mode: ${currentMode}. Click or Shift+Tab to cycle`}
      >
        <span className="mode-toggle-pill-label">{modeLabel}</span>
        <span className="mode-toggle-pill-shortcut">{'⇧'}Tab</span>
      </button>
      <button
        type="button"
        className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill"
        title={`${rawModel || 'Model not reported yet (Auto)'} — click to switch model / effort`}
        onClick={() => setPickerOpen((v) => !v)}
      >
        {displayModel || 'Auto'}
        {contextPercent != null && (
          <span
            className="session-detail-context-pct"
            style={{
              color: contextPercent > 80 ? 'var(--danger, #ff3b30)'
                : contextPercent > 50 ? 'var(--warning, #ff9500)'
                : 'var(--fg-muted)',
            }}
            title={`Context: ${contextPercent}%`}
          >
            {' '}{contextPercent}%
          </span>
        )}
        {modelSupportsEffort(rawModel) && effortLabel && (
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
        />
      )}
    </div>
  );
}
