import path from 'node:path';
import { PluginDatabaseClient } from '../plugins/plugin-storage.js';
import { WALNUT_HOME } from '../../constants.js';
import { TASK_DB_SCHEMA_VERSION, TASK_DB_ROUTINE_QUEUE_VERSION, TASK_DB_MAX_SUPPORTED_VERSION } from '../task-db-version.js';

let stamped: Promise<void> | null = null;

/** Stamp before writing an accepted routine wait: an older build must not reinterpret its persona or claim. */
export function ensureRoutineQueueDataVersion(): Promise<void> {
  if (stamped) return stamped;
  const run = (async () => {
    const client = new PluginDatabaseClient(path.join(WALNUT_HOME, 'tasks', 'tasks.sqlite'), undefined, { existingOnly: true });
    try {
      const result = await client.ensureUserVersion(TASK_DB_SCHEMA_VERSION, TASK_DB_ROUTINE_QUEUE_VERSION, TASK_DB_MAX_SUPPORTED_VERSION);
      if (result.status !== 'stamped' && result.status !== 'current') {
        throw new Error(`The task store cannot hold an accepted routine wait (${result.status}); nothing was queued.`);
      }
    } finally {
      await client.dispose();
    }
  })();
  const flight = run.finally(() => { if (stamped === flight) stamped = null; });
  stamped = flight;
  return flight;
}
