// No imports: the router's stamp worker reads these without loading the synchronous task store.
export const TASK_DB_SCHEMA_VERSION = 13
// Stamped only once a non-empty isolated area is saved, so a build that predates areas refuses the store.
export const TASK_DB_ROUTER_VERSION = 14
// A queued routine carries its persona and batch claim; older queue readers must refuse it.
export const TASK_DB_ROUTINE_QUEUE_VERSION = 15
export const TASK_DB_MAX_SUPPORTED_VERSION = 15
