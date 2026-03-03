/**
 * Built-in session hooks.
 *
 * These are the default hooks that ship with Walnut.
 * They can be overridden or disabled via config.
 */

import { bus } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { SessionHookDefinition, OnTurnCompletePayload, OnTurnErrorPayload, OnMessageSendPayload } from './types.js';

/**
 * turn-complete-triage: Dispatches a triage subagent on turn completion.
 * Hook: onTurnComplete. Replaces the hardcoded triage block in server.ts.
 */
export const turnCompleteTriageHook: SessionHookDefinition = {
  id: 'turn-complete-triage',
  name: 'Turn Complete Triage (onTurnComplete)',
  description: 'Dispatches triage subagent when a session turn completes successfully.',
  hooks: ['onTurnComplete'],
  priority: 50,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const p = payload as OnTurnCompletePayload;
    if (!p.taskId) return; // No task → no triage

    // Skip triage for embedded subagent sessions (provider='embedded').
    if (p.session?.provider === 'embedded') return;

    try {
      const { DEFAULT_TRIAGE_AGENT_ID } = await import('../agent-registry.js');
      const { getConfig } = await import('../config-manager.js');
      const config = await getConfig();
      const triageAgentId = config.agent?.session_triage_agent ?? DEFAULT_TRIAGE_AGENT_ID;

      // Build recent notification history so triage can avoid duplicates
      let notificationContext = '';
      try {
        const { getTriageEntries } = await import('../chat-history.js');
        const { entries } = await getTriageEntries(10, p.taskId);
        // Filter to entries that actually triggered main agent notification (notification === false)
        const notified = entries.filter(e => e.notification === false);
        if (notified.length > 0) {
          const lines = notified.slice(0, 5).map(e => {
            const ts = e.timestamp ? new Date(e.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
            // Extract the notification content from the triage output
            const contentStr = typeof e.content === 'string' ? e.content : '';
            const match = contentStr.match(/<main_agent_notify>([\s\S]*?)<\/main_agent_notify>/);
            const summary = match ? match[1].trim() : (contentStr.slice(0, 150) || '(no content)');
            return `[${ts}] ${summary}`;
          });
          notificationContext = `<recent_notifications>\nThese are the most recent notifications you sent to the main agent for this task:\n${lines.join('\n')}\n</recent_notifications>`;
        }
      } catch (err) {
        log.session.warn('failed to load notification history for triage', {
          taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
        });
      }

      const sessionType = p.isPlanSession ? 'plan-mode ' : '';
      const triageTask = `A Claude Code ${sessionType}session just finished for task ${p.taskId}. Session ID: ${p.sessionId}. Turn index: ${p.turnIndex ?? 'unknown'}.\n\nThe <session_history> context below contains recent assistant messages with [index] labels. Use these to determine the current phase. If you need full details of a specific message, call get_session_history with index=N.`;

      bus.emit('subagent:start', {
        agentId: triageAgentId,
        task: triageTask,
        taskId: p.taskId,
        context_override: { taskId: p.taskId, sessionId: p.sessionId },
        ...(notificationContext ? { context: notificationContext } : {}),
      }, ['subagent-runner'], { source: 'turn-complete-triage' });

      log.session.info('turn-complete-triage hook: dispatched', {
        sessionId: p.sessionId,
        taskId: p.taskId,
        agentId: triageAgentId,
      });
    } catch (err) {
      log.session.error('turn-complete-triage hook failed', {
        sessionId: p.sessionId,
        taskId: p.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

/**
 * message-send-triage: Dispatches a lightweight triage subagent on user message send.
 * Classifies user intent, updates task.summary.Latest, logs the interaction.
 */
export const messageSendTriageHook: SessionHookDefinition = {
  id: 'message-send-triage',
  name: 'Message Send Triage',
  description: 'Dispatches lightweight triage subagent when a user sends a message to a session.',
  hooks: ['onMessageSend'],
  priority: 60,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const p = payload as OnMessageSendPayload;
    if (!p.taskId) return; // No task → skip

    // Skip subagent sends (provider='embedded') to prevent loop
    if (p.session?.provider === 'embedded') return;

    try {
      const { DEFAULT_MESSAGE_SEND_TRIAGE_AGENT_ID } = await import('../agent-registry.js');
      const { getConfig } = await import('../config-manager.js');
      const config = await getConfig();
      const agentId = config.agent?.message_send_triage_agent ?? DEFAULT_MESSAGE_SEND_TRIAGE_AGENT_ID;

      const triageTask = `User sent a message to session ${p.sessionId} for task ${p.taskId}.\n\nMessage:\n${(p.message ?? '').slice(0, 2000)}`;

      bus.emit('subagent:start', {
        agentId,
        task: triageTask,
        taskId: p.taskId,
        context_override: { taskId: p.taskId, sessionId: p.sessionId },
      }, ['subagent-runner'], { source: 'message-send-triage' });

      log.session.info('message-send-triage hook: dispatched', {
        sessionId: p.sessionId,
        taskId: p.taskId,
        agentId,
      });
    } catch (err) {
      log.session.error('message-send-triage hook failed', {
        sessionId: p.sessionId,
        taskId: p.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

/**
 * session-error-notify: Logs session errors.
 */
export const sessionErrorNotifyHook: SessionHookDefinition = {
  id: 'session-error-notify',
  name: 'Session Error Notify',
  description: 'Logs session errors for monitoring.',
  hooks: ['onTurnError'],
  priority: 90,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const p = payload as OnTurnErrorPayload;
    log.session.warn('session hook: turn error detected', {
      sessionId: p.sessionId,
      taskId: p.taskId,
      error: p.error?.slice(0, 200),
      isSessionError: p.isSessionError,
    });
  },
};

/** All built-in hook definitions. */
export const builtinHooks: SessionHookDefinition[] = [
  turnCompleteTriageHook,
  messageSendTriageHook,
  sessionErrorNotifyHook,
];
