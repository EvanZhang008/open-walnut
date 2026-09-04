/**
 * ComposerModelPill — the composer's model / context / effort pill, plus the
 * ModelPicker it opens.
 *
 * Extracted from SessionPanel so a SECOND surface (the side-thread drawer) can
 * render the identical control instead of growing a near-copy. The component is
 * self-contained: it owns the open state, the anchor ref and the three switch
 * calls, so a caller just drops it into a controls row.
 *
 * Two modes:
 *  · LIVE (default) — `sessionId` + `session` given. Switching a model / effort
 *    hits the session API, optimistically patched through `onOptimistic` and
 *    reverted on failure.
 *  · PENDING — `pending` given. The session does not exist yet, so NOTHING is
 *    sent: picks are reported to the caller and the picker closes. The picker
 *    runs in its draft shape (an "Auto" row, no live get_settings pull).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ModelPicker, acpModelDisplayName } from './ModelPicker';
import { modelSupportsEffort, SESSION_EFFORTS } from '@open-walnut/core';
import type { SessionEffort } from '@open-walnut/core';
import { setSessionEffort, setSessionModel, setCodexSessionModel } from '@/api/sessions';
import { useSessionUsage, formatModelName, getContextWindowSize, contextBadgeTitle } from '@/hooks/useSessionUsage';
import { useHostModelCatalog } from '@/hooks/useModelCatalog';
import { useNotifications } from '@/contexts/notifications';
import { log } from '@/utils/log';
import type { EngineUiCaps } from '@/utils/engine-capabilities';
import type { SessionRecord } from '@/types/session';

/** A surface whose session does not exist yet — the pick is the caller's to keep. */
export interface ComposerModelPillPending {
  /** Model chosen so far; undefined = Auto (no --model at spawn). */
  model?: string;
  /** Effort chosen so far. */
  effort?: SessionEffort;
  /** A model row was picked. `undefined` = the picker's "Auto" row. */
  onPick: (model: string | undefined) => void;
  /** An effort row was picked. */
  onPickEffort: (effort: SessionEffort) => void;
  /** Host the session will launch on — selects the host-level catalog cache. */
  host?: string;
  /** Folder the session will launch in — the ACP engine probe runs there. */
  cwd?: string;
  /** Offer the picker's "Auto" row (default true). Set false on a surface where
   *  "no pick" already MEANS something else — a fork inherits its parent's model,
   *  which is not the CLI's Auto, and both would report the same `undefined`. */
  allowAuto?: boolean;
}

export interface ComposerModelPillProps {
  /** The LIVE session the pill acts on. undefined = no session yet (see `pending`). */
  sessionId: string | undefined;
  /** That session's record (model, acpModel, effort, host, window fields). */
  session: SessionRecord | null | undefined;
  /** The session's engine capability view — `engineCaps(...)`, never an engine id. */
  engineUi: EngineUiCaps;
  /** Apply an optimistic (or reverted / reconciled) patch to the caller's own
   *  copy of the record. Called with the same field sets the switch handlers
   *  used to write straight into SessionPanel's `setSession`.
   *  SHALLOW MERGE semantics: a key that is absent must stay unchanged, a key
   *  set to `undefined` must be cleared (both cases are used below). */
  onOptimistic: (patch: Partial<SessionRecord>) => void;
  /** Last assistant message carrying a model + usage, for the context-percent
   *  fallback on a session with no live usage event yet. A caller without
   *  history omits it and simply gets no fallback. */
  fallbackAssistant?: { model?: string; usage?: unknown };
  /** PENDING mode: no session exists yet, so no switch API is ever called. */
  pending?: ComposerModelPillPending;
  /** Extra sentence appended to the pill's tooltip (what the pick applies to). */
  title?: string;
  /** Bump to OPEN the picker from outside — SessionPanel's `/model` command.
   *  Only the pill that receives it opens. */
  openNonce?: number;
}

export function ComposerModelPill({
  sessionId, session, engineUi, onOptimistic, fallbackAssistant, pending, title, openNonce,
}: ComposerModelPillProps) {
  const { notify } = useNotifications();
  const [pickerOpen, setPickerOpen] = useState(false);
  // The model pill — the popout picker anchors here (portal to <body>, so a
  // narrow session column can't clip the panel). Kept live by a callback ref as
  // well as the click, because the picker can also be opened WITHOUT a click
  // (the composer's `/model` command → openNonce): a null anchor makes
  // useMenuPlacement park the panel off-screen with nothing to recover it.
  const pillRef = useRef<HTMLElement | null>(null);
  const setPillEl = useCallback((el: HTMLButtonElement | null) => { pillRef.current = el; }, []);

  // External open request (`/model`): open on a CHANGED nonce only, so a
  // re-render with the same value can't re-open a picker the user just closed.
  const lastOpenNonce = useRef(openNonce);
  useEffect(() => {
    if (openNonce === undefined || openNonce === lastOpenNonce.current) return;
    lastOpenNonce.current = openNonce;
    setPickerOpen(true);
  }, [openNonce]);

  // Real-time model + context window usage
  const liveUsage = useSessionUsage(sessionId ?? null);
  const rawModel = pending
    ? pending.model
    : (liveUsage.model || session?.model || fallbackAssistant?.model);
  // Auto launch before the CLI reports its model (idle todo-launcher session):
  // the host catalog's 'default' row already knows what Auto resolves to on
  // this host — show "Auto (Opus 5 1M)" instead of a bare "Auto" so the user
  // knows what they're running from second zero.
  const hostCatalog = useHostModelCatalog(session?.host ?? pending?.host);
  const autoResolved = !rawModel
    ? formatModelName(hostCatalog?.models.find((m) => m.value === 'default')?.resolvedModel)
    : '';
  const displayModel = formatModelName(rawModel);
  let contextPercent = liveUsage.contextPercent;
  // Fallback for a page loaded with no live usage event yet (server restart, or
  // a session idle since before this mount): derive it from the last assistant
  // message's tokens. Both halves come from the SERVER when available — the
  // model string can't reveal a custom proxy model's window, and guessing 200K
  // for one was 5x wrong (2026-08-23).
  let badgeUsage = liveUsage;
  if (contextPercent == null && fallbackAssistant?.usage) {
    const u = fallbackAssistant.usage as Record<string, number>;
    const totalInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const ctxSize = session?.modelMaxWindow ?? getContextWindowSize(rawModel, totalInput);
    if (totalInput > 0 && ctxSize != null) {
      contextPercent = Math.round(totalInput / ctxSize * 100);
      badgeUsage = {
        ...liveUsage, inputTokens: totalInput, contextWindow: ctxSize,
        autoCompactAt: liveUsage.autoCompactAt ?? session?.autoCompactAt,
      };
    }
  }

  const handleModelSwitch = useCallback((model: string) => {
    setPickerOpen(false);
    if (pending) {
      // No session to switch — the caller keeps the pick. '' is the picker's
      // "Auto" row (autoRow calls onSwitch('')), which means "no --model".
      pending.onPick(model || undefined);
      return;
    }
    if (!sessionId) return;
    // Live switch via apply_flag_settings (no respawn, no message send) — same
    // mechanism as effort. Optimistically reflect it, then reconcile from the
    // get_settings read-back (effectiveModel = the CLI's true runtime model).
    const prevModel = session?.model;
    onOptimistic({ model });
    setSessionModel(sessionId, model).then((res) => {
      if (res.effectiveModel) {
        onOptimistic({ model: res.effectiveModel });
      }
    }).catch((err) => {
      console.error('Model switch failed:', err);
      onOptimistic({ model: prevModel });
    });
  }, [sessionId, session?.model, onOptimistic, pending]);

  // ACP model switch — optimistic, revert + notify on failure. Same contract
  // the retired standalone Codex picker had, now driven from the shared
  // two-pane picker's ACP pane for every ACP engine.
  const handleAcpModelSwitch = useCallback((modelId: string) => {
    setPickerOpen(false);
    if (pending) {
      pending.onPick(modelId || undefined);
      return;
    }
    if (!sessionId) return;
    const previous = session?.acpModel;
    const previousName = session?.acpModelName;
    if (modelId === previous) return;
    // Drop the advertised name with the id: it belongs to the OLD model, and the
    // pill prefers it, so keeping it would label the new model with the old name
    // until the server record comes back.
    onOptimistic({ acpModel: modelId, acpModelName: undefined });
    setCodexSessionModel(sessionId, modelId).catch((error) => {
      onOptimistic({ acpModel: previous, acpModelName: previousName });
      log.error('session-panel', 'acp model switch failed', {
        sessionId,
        modelId,
        engine: engineUi.id,
        error: error instanceof Error ? error.message : String(error),
      });
      notify({
        kind: 'operation-error',
        severity: 'error',
        title: `${engineUi.displayName} model switch failed`,
        body: error instanceof Error ? error.message : String(error),
        persistent: false,
        dedupKey: `acp-model-switch:${sessionId}:${Date.now()}`,
        sessionId,
      });
    });
  }, [sessionId, session?.acpModel, session?.acpModelName, notify, engineUi.id, engineUi.displayName, onOptimistic, pending]);

  const handleEffortSwitch = useCallback((effort: SessionEffort) => {
    setPickerOpen(false);
    if (pending) {
      pending.onPickEffort(effort);
      return;
    }
    if (!sessionId) return;
    // Optimistically reflect the requested effort so the pill/badge updates immediately.
    // Backend delivers it via apply_flag_settings, then READS BACK the CLI's true effort.
    // Reconcile effectiveEffort from the response so the badge shows what the CLI actually
    // uses (and flags an env/model override). Revert on failure (model rejected the level).
    const prevEffort = session?.effort;
    const prevEffective = session?.effectiveEffort;
    onOptimistic({ effort });
    setSessionEffort(sessionId, effort).then((res) => {
      // Trust the CLI read-back: effectiveEffort is what actually took (may differ).
      onOptimistic({ effort, ...(res.effectiveEffort ? { effectiveEffort: res.effectiveEffort } : {}) });
    }).catch((err) => {
      console.error('Effort switch failed:', err);
      onOptimistic({ effort: prevEffort, effectiveEffort: prevEffective });
    });
  }, [sessionId, session?.effort, session?.effectiveEffort, onOptimistic, pending]);

  const extraTitle = title ? ` ${title}` : '';

  // EVERY engine opens the SAME two-pane picker (provider rail | models) — an
  // ACP session just opens it on the ACP pane, with the others greyed.
  const pill = engineUi.isAcp ? (
    <button
      type="button"
      className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill"
      ref={setPillEl}
      title={`Switch ${engineUi.displayName} model${extraTitle}`}
      onClick={(e) => { pillRef.current = e.currentTarget; setPickerOpen((v) => !v); }}
    >
      {/* 3 tiers: the provider's own name (minus its provider prefix — a pill
          reading "Amazon Bedrock/Claude…" is all provider, no model), else
          prettify the id, else the engine. */}
      {acpModelDisplayName(pending ? pending.model : session?.acpModel, pending ? undefined : session?.acpModelName) ?? engineUi.displayName}
      {contextPercent != null && (
        <span className="session-detail-context-pct"> {contextPercent}%</span>
      )}
    </button>
  ) : (
    // No rawModel yet ≠ no pill: a todo-launcher quick start (empty first
    // message) idles with a model-less record until its first real turn, and
    // hiding the pill hides the ONLY model/effort entry point ("model option
    // doesn't show"). Render "Auto" — the picker itself live-pulls the truth.
    <button
      type="button"
      className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill"
      ref={setPillEl}
      title={`${rawModel || (autoResolved ? `Auto — CLI default resolves to ${autoResolved} on this host` : 'Model not reported yet (Auto)')} — click to switch model / effort${extraTitle}`}
      onClick={(e) => { pillRef.current = e.currentTarget; setPickerOpen((v) => !v); }}
    >
      {displayModel || (autoResolved ? `Auto (${autoResolved})` : 'Auto')}
      {contextPercent != null && (
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
      {modelSupportsEffort(rawModel) && (() => {
        // Badge shows the CLI's TRUE effort (effectiveEffort, read back via
        // get_settings) — falling back to the requested level. When the CLI
        // overrode the request (env / downgrade), flag it.
        //
        // NO fabricated default. This used to fall back to DEFAULT_SESSION_EFFORT
        // ('high') and render it exactly like a confirmed reading — which is how
        // the pill came to say "High" while the picker said "X-High" for the same
        // session: the user's level lives in the CLI's OWN settings.json
        // (effortLevel), which Walnut never requests, so record.effort is
        // undefined and the guess was simply wrong. An honest gap beats a
        // confident wrong number: render nothing until a real value exists (the
        // session-start read-back fills it in ~1.5s via session:settings-applied).
        const shown = pending ? pending.effort : (session?.effectiveEffort ?? session?.effort);
        if (!shown) return null;
        const overridden = !pending && session?.effectiveEffort != null && session?.effort != null
          && session.effectiveEffort !== session.effort;
        const badgeTitle = overridden
          ? `Reasoning effort: ${session!.effectiveEffort} (requested ${session!.effort}, overridden by env/model)`
          : !pending && session?.effectiveEffort
          ? `Reasoning effort: ${session.effectiveEffort} (confirmed by CLI)`
          : `Reasoning effort: ${shown} (requested — not yet confirmed by the CLI)`;
        // Same label table the picker's segments use, so one truth reads the same
        // on both surfaces ("X-High", not the raw id "xhigh").
        const label = SESSION_EFFORTS.find((e) => e.id === shown)?.label ?? shown;
        return (
          <span className="session-detail-effort-badge" title={badgeTitle}>
            {' · '}{label}{overridden ? ' ⚠' : ''}
          </span>
        );
      })()}
    </button>
  );

  return (
    <>
      {pill}
      {pickerOpen && (
        <ModelPicker
          currentModel={rawModel}
          currentEffort={pending ? pending.effort : (session?.effectiveEffort ?? session?.effort)}
          // PENDING: no sessionId ⇒ no get_settings / live-catalog pull, and the
          // ACP pane runs its DRAFT probe instead of asking a live adapter.
          sessionId={pending ? undefined : sessionId}
          host={pending ? pending.host : session?.host}
          cwd={pending?.cwd}
          onSwitch={handleModelSwitch}
          onEffortSwitch={handleEffortSwitch}
          onClose={() => setPickerOpen(false)}
          // Live session: engine is a spawn-time fact. The rail shows every
          // registered provider but the others render greyed + locked (no
          // onProviderSwitch) — start a new session to change engines.
          engine={engineUi.id}
          acpCurrentModelId={pending ? pending.model : session?.acpModel}
          onAcpSwitch={engineUi.isAcp ? handleAcpModelSwitch : undefined}
          // PENDING: "Auto" is a real choice (no --model at spawn) — the picker's
          // draft affordance reports it as onSwitch('').
          autoRow={pending && pending.allowAuto !== false
            ? { resolvedLabel: autoResolved, active: !pending.model }
            : undefined}
          anchorRef={pillRef}
        />
      )}
    </>
  );
}
