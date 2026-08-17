import { taskRefTag } from '../utils/entity-refs.js';
import { performMobileLaunch, validateDelegateLaunchBody } from './sessions/mobile-launch.js';
import { QuickStartError } from './sessions/quick-start.js';
import { startSessionForTask } from './sessions/task-start.js';

export interface DelegateWorkInput {
  taskId?: string;
  message: string;
  cwd?: string;
  title?: string;
  project?: string;
  host?: string;
  model?: string;
  mode?: string;
  engine?: 'claude' | 'codex';
}

export interface DelegateWorkResult {
  action: 'created_started' | 'resumed' | 'started_existing';
  accepted: true;
  taskId: string;
  title: string;
  sessionId?: string;
  ref: string;
}

export async function delegateWork(
  input: DelegateWorkInput,
  source: string,
): Promise<DelegateWorkResult> {
  if (!input || typeof input !== 'object') throw new QuickStartError('delegate input is required', 400);
  if (typeof input.message !== 'string' || !input.message.trim()) {
    throw new QuickStartError('message must be a non-empty string', 400);
  }

  if (input.taskId) {
    const creationOnlyFields = ['cwd', 'title', 'project', 'host', 'model', 'mode', 'engine'] as const;
    const mixed = creationOnlyFields.filter((field) => input[field] !== undefined);
    if (mixed.length > 0) {
      throw new QuickStartError(
        `Existing-task delegation accepts only taskId and message; remove: ${mixed.join(', ')}`,
        400,
      );
    }
    const result = await startSessionForTask({
      taskIdPrefix: input.taskId,
      resume: true,
      prompt: input.message,
      source,
    });
    return {
      action: result.action === 'resume' ? 'resumed' : 'started_existing',
      accepted: true,
      taskId: result.taskId,
      title: result.title,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ref: taskRefTag(result.taskId, result.title),
    };
  }

  const launchInput = validateDelegateLaunchBody({
    cwd: input.cwd,
    message: input.message,
    taskTitle: input.title,
    project: input.project,
    host: input.host,
    model: input.model,
    mode: input.mode,
    engine: input.engine,
  });
  const result = await performMobileLaunch(launchInput, source);
  return {
    action: 'created_started',
    accepted: true,
    taskId: result.taskId,
    title: result.title,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ref: taskRefTag(result.taskId, result.title),
  };
}
