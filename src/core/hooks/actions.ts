/**
 * Declarative hook actions — what a config-defined hook can DO.
 *
 * Part of the unified hook system (dispatcher: core/session-hooks/dispatcher.ts;
 * this directory holds the declarative/config layer and will absorb
 * session-hooks/ in a later move).
 *
 * There is deliberately NO shell_command action: config.yaml is writable via
 * PUT /api/config from any authenticated client (including mobile/cloud), so a
 * shell action would turn a settings write into remote code execution. Code-
 * level hooks (~/.open-walnut/hooks/*.mjs) are the escape hatch — they require
 * filesystem access to install.
 */

import { bus } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { HookContext, HookDefinition, SessionHookContext, TaskHookContext } from '../session-hooks/types.js';

// ── Action union ──

export interface SendMessageToSessionAction {
  type: 'send_message_to_session';
  message: string;
  interrupt?: boolean;
}

export interface NotifyAction {
  type: 'notify';
  title?: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface RunAgentAction {
  type: 'run_agent';
  agentId: string;
  prompt?: string;
  model?: string;
}

export interface LogAction {
  type: 'log';
  level?: 'info' | 'warn';
  message?: string;
}

export type HookAction = SendMessageToSessionAction | NotifyAction | RunAgentAction | LogAction;

// ── Template rendering ──
// Whitelisted placeholders only — no expression evaluation. A missing key
// renders as ''. Config-supplied strings must never reach an evaluator.

function templateValue(ctx: HookContext, key: string): string {
  const isTask = 'domain' in ctx && ctx.domain === 'task';
  const taskCtx = isTask ? ctx as TaskHookContext : null;
  const sessionCtx = !isTask ? ctx as SessionHookContext : null;
  const task = taskCtx?.task ?? sessionCtx?.task;
  switch (key) {
    case 'task.title': return task?.title ?? '';
    case 'task.id': return task?.id ?? '';
    case 'task.phase': return task?.phase ?? '';
    case 'task.project': return task?.project ?? '';
    case 'oldPhase': return taskCtx?.oldPhase ?? '';
    case 'newPhase': return taskCtx?.newPhase ?? '';
    case 'sessionId': return (taskCtx?.sessionId ?? sessionCtx?.sessionId) ?? '';
    case 'event': return ctx.event ?? '';
    default: return '';
  }
}

export function renderTemplate(template: string, ctx: HookContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => templateValue(ctx, key));
}

// ── Describe (for the registry / UI) ──

export function describeAction(action: HookAction | { type: string }): string {
  switch (action.type) {
    case 'send_message_to_session': {
      const a = action as SendMessageToSessionAction;
      return `Send message: "${a.message.slice(0, 120)}${a.message.length > 120 ? '…' : ''}"`;
    }
    case 'notify': {
      const a = action as NotifyAction;
      return `Notify: "${a.message.slice(0, 120)}${a.message.length > 120 ? '…' : ''}"`;
    }
    case 'run_agent': {
      const a = action as RunAgentAction;
      return `Invoke agent: ${a.agentId}`;
    }
    case 'log':
      return 'Write a log line';
    default:
      return `Unknown action: ${action.type}`;
  }
}

// ── Execution ──

export async function executeHookAction(hook: HookDefinition, ctx: HookContext): Promise<void> {
  const action = hook.action as HookAction | undefined;
  if (!action) return;

  const isTask = 'domain' in ctx && ctx.domain === 'task';
  const taskCtx = isTask ? ctx as TaskHookContext : null;
  const sessionCtx = !isTask ? ctx as SessionHookContext : null;
  const sessionId = taskCtx ? (taskCtx.sessionId ?? taskCtx.task?.session_id) : sessionCtx?.sessionId;
  const taskId = taskCtx?.taskId ?? sessionCtx?.taskId;

  switch (action.type) {
    case 'send_message_to_session': {
      if (!sessionId) {
        log.session.info('hook action skipped — no session attached', { hookId: hook.id, taskId });
        return;
      }
      const { sendMessageToSession } = await import('../session-message-queue.js');
      // source 'hook:<id>' is load-bearing: the dispatcher drops task events
      // from hook:* sources to break hook→update→hook loops.
      await sendMessageToSession(sessionId, renderTemplate(action.message, ctx), {
        source: `hook:${hook.id}`,
        taskId,
        interrupt: action.interrupt,
      });
      break;
    }

    case 'notify': {
      const { addNotification } = await import('../notifications/store.js');
      await addNotification({
        kind: 'hook',
        severity: action.severity ?? 'info',
        title: renderTemplate(action.title ?? hook.name, ctx),
        body: renderTemplate(action.message, ctx),
        dedupKey: `hook:${hook.id}:${taskId ?? sessionId ?? ''}:${ctx.event ?? ''}`,
        sessionId,
        taskId,
      });
      break;
    }

    case 'run_agent': {
      const promptBody = action.prompt
        ? renderTemplate(action.prompt, ctx)
        : `[Hook: ${hook.id}] Context:\n${JSON.stringify(ctx, null, 2)}`;
      bus.emit('subagent:start', {
        agentId: action.agentId,
        task: promptBody,
        taskId,
        model: action.model,
      }, ['subagent-runner'], { source: `hook:${hook.id}` });
      break;
    }

    case 'log': {
      const line = action.message ? renderTemplate(action.message, ctx) : `hook ${hook.id} fired`;
      log.session[action.level ?? 'info'](line, { hookId: hook.id, sessionId, taskId, event: ctx.event });
      break;
    }

    default:
      // Forward compatibility: a config written against a newer build must
      // not throw — warn and skip.
      log.session.warn('unknown hook action type — skipped', {
        hookId: hook.id, actionType: (action as { type: string }).type,
      });
  }
}
