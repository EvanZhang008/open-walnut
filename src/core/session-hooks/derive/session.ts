/**
 * Session-domain event → hook point derivation.
 *
 * Moved VERBATIM from dispatcher.ts (mapEventToHookPoints) when the dispatcher
 * went domain-agnostic — every comment here is a shipped incident; do not
 * simplify. The per-session state map is owned by the dispatcher and passed in.
 */

import { EventNames } from '../../event-bus.js';
import type { BusEvent } from '../../event-bus.js';
import type { SessionMode } from '../../types.js';
import type {
  HookPoint,
  OnSessionStartPayload,
  OnMessageSendPayload,
  OnTurnStartPayload,
  OnToolUsePayload,
  OnPlanCompletePayload,
  OnModeChangePayload,
  OnTurnCompletePayload,
  OnTurnErrorPayload,
  OnToolResultPayload,
  OnCronFiredPayload,
  OnSessionWillReapPayload,
} from '../types.js';
import { log } from '../../../logging/index.js';

// ── Per-session derived state ──

export interface SessionState {
  awaitingFirstResponse: boolean;
  turnIndex: number;
  lastMode?: SessionMode;
  lastActivityAt: number;
}

export function getOrCreateSessionState(states: Map<string, SessionState>, sessionId: string): SessionState {
  let state = states.get(sessionId);
  if (!state) {
    state = {
      awaitingFirstResponse: false,
      turnIndex: 0,
      lastActivityAt: Date.now(),
    };
    states.set(sessionId, state);
  }
  return state;
}

export interface DerivedHookPoint {
  hookPoint: HookPoint;
  extraPayload: Record<string, unknown>;
}

export function deriveSessionHookPoints(
  event: BusEvent,
  states: Map<string, SessionState>,
  onSessionEnded: (sessionId: string) => void,
): DerivedHookPoint[] {
  const data = event.data as Record<string, unknown>;
  const results: DerivedHookPoint[] = [];
  const sessionId = (data.sessionId ?? '') as string;

  switch (event.name) {
    case EventNames.SESSION_STARTED: {
      results.push({
        hookPoint: 'onSessionStart',
        extraPayload: {
          mode: (data.mode ?? data.provider) as string | undefined,
          host: data.host as string | undefined,
          project: data.project as string | undefined,
        } satisfies Partial<OnSessionStartPayload>,
      });
      // Init session state
      states.set(sessionId, {
        awaitingFirstResponse: false,
        turnIndex: 0,
        lastMode: data.mode as SessionMode | undefined,
        lastActivityAt: Date.now(),
      });
      break;
    }

    case EventNames.SESSION_SEND: {
      const state = getOrCreateSessionState(states, sessionId);
      state.awaitingFirstResponse = true;
      // Skip onMessageSend for automated sources (triage session_send, subagent-runner,
      // peer-session gateway sends). User-initiated sources (web-ui, cli, web-api) fire hooks normally.
      if (event.source !== 'agent' && event.source !== 'subagent-runner' && event.source !== 'peer') {
        results.push({
          hookPoint: 'onMessageSend',
          extraPayload: {
            message: data.message as string,
            isResume: state.turnIndex > 0,
            source: event.source,
          } satisfies Partial<OnMessageSendPayload>,
        });
      }
      break;
    }

    case EventNames.SESSION_TEXT_DELTA:
    case EventNames.SESSION_TOOL_USE: {
      const state = getOrCreateSessionState(states, sessionId);
      state.lastActivityAt = Date.now();

      // Derived: onTurnStart fires on first response after send
      if (state.awaitingFirstResponse) {
        state.awaitingFirstResponse = false;
        state.turnIndex++;
        results.push({
          hookPoint: 'onTurnStart',
          extraPayload: {
            turnIndex: state.turnIndex,
          } satisfies Partial<OnTurnStartPayload>,
        });
      }

      // Tool use events
      if (event.name === EventNames.SESSION_TOOL_USE) {
        const toolName = (data.toolName ?? data.name ?? '') as string;
        results.push({
          hookPoint: 'onToolUse',
          extraPayload: {
            toolName,
            toolUseId: data.toolUseId as string,
            input: data.input as Record<string, unknown> | undefined,
          } satisfies Partial<OnToolUsePayload>,
        });

        // Derived: onPlanComplete when ExitPlanMode is called
        if (toolName === 'ExitPlanMode') {
          results.push({
            hookPoint: 'onPlanComplete',
            extraPayload: {
              planFile: data.planContent as string | undefined,
            } satisfies Partial<OnPlanCompletePayload>,
          });
        }
      }
      break;
    }

    case EventNames.SESSION_TOOL_RESULT: {
      results.push({
        hookPoint: 'onToolResult',
        extraPayload: {
          toolUseId: data.toolUseId as string,
          result: data.result as string,
        } satisfies Partial<OnToolResultPayload>,
      });
      break;
    }

    case EventNames.SESSION_STATUS_CHANGED: {
      const state = getOrCreateSessionState(states, sessionId);
      const newMode = data.mode as SessionMode | undefined;
      const oldMode = state.lastMode;

      // Derived: onModeChange when mode differs
      if (newMode && oldMode && newMode !== oldMode) {
        results.push({
          hookPoint: 'onModeChange',
          extraPayload: {
            previousMode: oldMode,
            newMode,
          } satisfies Partial<OnModeChangePayload>,
        });
        state.lastMode = newMode;
      }
      break;
    }

    case EventNames.SESSION_RESULT: {
      // Skip hooks entirely when team subagents OR background workflow tasks are
      // still active. The lead session emits intermediate `result` events while
      // polling for teammate messages, and a dynamic-workflow turn emits one result
      // per background subagent completion — neither should trigger triage
      // (onTurnComplete). The session manager already withholds the SESSION_RESULT
      // emit during background work; this is defense-in-depth on the flag.
      if (data.teamActive || data.backgroundActive) {
        log.session.info('SESSION_RESULT skipped — background work active', {
          sessionId, teamActive: data.teamActive, backgroundActive: data.backgroundActive,
        });
        break;
      }

      const isError = data.isError as boolean | undefined;
      const state = getOrCreateSessionState(states, sessionId);

      if (isError) {
        results.push({
          hookPoint: 'onTurnError',
          extraPayload: {
            error: data.result as string ?? data.error as string ?? 'unknown error',
            isSessionError: false,
          } satisfies Partial<OnTurnErrorPayload>,
        });
      } else {
        results.push({
          hookPoint: 'onTurnComplete',
          extraPayload: {
            result: data.result as string ?? '',
            totalCost: data.totalCost as number | undefined,
            duration: data.duration as number | undefined,
            turnIndex: state.turnIndex,
            isPlanSession: state.lastMode === 'plan',
          } satisfies Partial<OnTurnCompletePayload>,
        });
      }
      break;
    }

    case EventNames.SESSION_ERROR: {
      // delivery_failed = message never reached the CLI (SSH/daemon down) —
      // no turn ran, so onTurnError hooks (triage, notify, …) must not fire.
      // The batch is back in 'pending'; the UI was told via SESSION_BATCH_FAILED.
      if (data.errorKind === 'delivery_failed') break;
      results.push({
        hookPoint: 'onTurnError',
        extraPayload: {
          error: data.error as string ?? 'unknown error',
          isSessionError: true,
        } satisfies Partial<OnTurnErrorPayload>,
      });
      break;
    }

    case EventNames.SESSION_CRON_FIRED: {
      // A CLI scheduled task fired inside this session (daemon-detected marker,
      // re-emitted as a structured event by the session reader). domain:'cron'
      // rides the payload so cross-domain handlers can discriminate.
      results.push({
        hookPoint: 'onCronFired',
        extraPayload: {
          domain: 'cron',
          cronTaskId: data.cronTaskId as string | undefined,
          createdBySessionId: data.createdBySessionId as string | undefined,
          foreign: data.foreign === true,
        } satisfies Partial<OnCronFiredPayload> & { domain: 'cron' },
      });
      break;
    }

    case EventNames.SESSION_WILL_REAP: {
      // The idle reaper is about to kill this session's CLI. Unlike
      // session:ended (per-turn UI refresh, no hook point — see below), this
      // event comes from the reap decision itself and fires once per idle
      // episode, so a hook bound here runs once, before the process dies.
      // Session state is deliberately NOT cleared: the CLI is still alive and
      // the reap can still be averted by a fresh message.
      results.push({
        hookPoint: 'onSessionWillReap',
        extraPayload: {
          host: data.host as string | undefined,
          remainingMs: data.remainingMs as number,
          idleDurationMs: data.idleDurationMs as number,
          idleTimeoutMs: data.idleTimeoutMs as number,
          reason: (data.reason ?? 'idle_timeout') as 'idle_timeout',
          warnedAt: data.warnedAt as string,
        } satisfies Partial<OnSessionWillReapPayload>,
      });
      break;
    }

    case EventNames.SESSION_ENDED: {
      // No hook point maps here anymore. session:ended is a UI-refresh signal
      // emitted after EVERY turn (server.ts), NOT a real end-of-session — the
      // former 'onSessionEnd'/'onSessionIdle' hook points were removed because
      // that misnomer made hooks fire per-turn (the session-summary-gist bug).
      // Keep only the state cleanup: payload cache is rebuilt fresh next turn.
      states.delete(sessionId);
      onSessionEnded(sessionId);
      break;
    }
  }

  return results;
}
