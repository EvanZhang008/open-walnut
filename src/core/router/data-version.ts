import fs from 'node:fs/promises'
import path from 'node:path'
import { PluginDatabaseClient } from '../plugins/plugin-storage.js'
import { TASK_DB_MAX_SUPPORTED_VERSION, TASK_DB_ROUTER_VERSION, TASK_DB_SCHEMA_VERSION } from '../task-db-version.js'

export class RouterDataVersionError extends Error {
  readonly code = 'router_data_version'
  readonly status = 503
  constructor(message: string) {
    super(message)
    this.name = 'RouterDataVersionError'
  }
}

export function routerTaskDbPath(home: string): string {
  return path.join(home, 'tasks', 'tasks.sqlite')
}

type StampClient = Pick<PluginDatabaseClient, 'ensureUserVersion' | 'dispose'>

// The store is opened as it is: an empty, damaged or newer file is refused by a read, never written.
const openExisting = (file: string): StampClient => new PluginDatabaseClient(file, undefined, { existingOnly: true })

// Only the worker takes the write lock, rechecking the version before it stamps.
export async function ensureRouterDataVersion(home: string, openClient: (file: string) => StampClient = openExisting): Promise<number> {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new RouterDataVersionError('The Walnut home for the task store must be an absolute path.')
  const file = routerTaskDbPath(home)
  // The worker would create a missing file; an unopened store is refused instead.
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new RouterDataVersionError('The task store does not exist yet, so no isolated area can be saved. Nothing was changed.')
  let client: StampClient | undefined
  try {
    client = openClient(file)
    const outcome = await client.ensureUserVersion(TASK_DB_SCHEMA_VERSION, TASK_DB_ROUTER_VERSION, TASK_DB_MAX_SUPPORTED_VERSION)
    switch (outcome.status) {
      case 'stamped':
      case 'current':
        return outcome.current
      case 'newer':
        throw new RouterDataVersionError(`The task store is version ${outcome.current}, newer than this Walnut supports (${TASK_DB_MAX_SUPPORTED_VERSION}). Nothing was changed.`)
      case 'older':
        throw new RouterDataVersionError(`The task store is version ${outcome.current}, not yet upgraded by this Walnut. Nothing was changed.`)
      default:
        throw new RouterDataVersionError('The task store version could not be read. Nothing was changed.')
    }
  } catch (error) {
    if (error instanceof RouterDataVersionError) throw error
    throw new RouterDataVersionError(`The task store could not be checked or stamped (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`)
  } finally {
    await client?.dispose().catch(() => undefined)
  }
}
