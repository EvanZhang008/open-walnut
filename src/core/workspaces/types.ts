/**
 * Task workspaces: the shapes the server, the web client and the task row share.
 * Pure types (the web build imports this file through src/core/types.ts).
 *
 * A task's workspace is an isolated working copy made for it on ONE host: a git
 * worktree on its own branch (built-in `git-worktree`), or whatever a plugin
 * provider builds (for a monorepo tool, a folder holding several package
 * repositories). The daemon on that host does the work (workspace-core.ts); the
 * server only decides and records (manager.ts).
 */

/**
 * requested  asked for, nothing started yet (a start will create it first)
 * creating   the host is making it (`job_id` names the daemon job)
 * ready      made; sessions of the task run in `cwd`
 * failed     creation failed; `error` says why, Retry starts over
 * removing   the host is removing it
 * removed    gone (the record stays so the task can say what it had)
 * kept       a cleanup decided not to remove it; `kept_reason` says why. It still
 *            exists and sessions still run in it.
 */
export type WorkspaceState = 'requested' | 'creating' | 'ready' | 'failed' | 'removing' | 'removed' | 'kept'

export interface TaskWorkspaceRepo {
  path: string
  name?: string
  branch?: string
}

/** A launch waiting for the workspace: replayed once it is ready. */
export interface WorkspacePendingStart {
  via: 'quick-start' | 'task-start'
  message: string
  messagePrefix?: string
  model?: string
  mode?: string
  engine?: string
  /** The client-owned session id of a draft launch (quick-start only). */
  session_id?: string
  caller_sid?: string
  expect_reply?: boolean
  reply_timeout_secs?: number
  source?: string
  at: string
}

export interface TaskWorkspace {
  provider: string
  provider_name?: string
  /** The host the workspace lives on: '__local__' or a config.hosts key. */
  host: string
  /**
   * The Walnut that made it: the realpath of its WALNUT_HOME. A server with another
   * home (a test server over copied data, with the real HOME) never resumes, launches,
   * cleans up or removes it; starting a new session in it is ordinary use.
   */
  home?: string
  /** The folder it was made from (the task's cwd at the time). */
  anchor: string
  root?: string
  /** Where sessions start: the root, or the anchor's sub-folder inside it. */
  cwd?: string
  branch?: string
  base_ref?: { name?: string; sha?: string }
  /** git-worktree: the main checkout that owns the worktree. */
  source_repo?: string
  repos: TaskWorkspaceRepo[]
  /** The provider's input fields as the user filled them. */
  inputs?: Record<string, unknown>
  state: WorkspaceState
  error?: string
  error_code?: string
  progress?: string
  kept_reason?: string
  /** The branch a removal left behind because it holds commits found nowhere else. */
  branch_kept?: boolean
  job_id?: string
  /** The name the folder and branch are derived from, fixed at the first request so a retry finds the same place. */
  name?: string
  /** While `removing`: what asked, and the state to go back to if the host refuses. */
  removal?: { trigger: 'manual' | 'complete'; from: 'ready' | 'kept' }
  pending_start?: WorkspacePendingStart
  /** The workspace is ready but the session waiting for it could not start (Retry starts it again). */
  launch_error?: string
  created_at?: string
  updated_at?: string
}

/** One provider the UI can offer for a folder. */
export interface WorkspaceCandidate {
  provider: string
  displayName: string
  priority: number
  builtin: boolean
  /** The provider recognizes the folder (a git repository; a plugin's marker). */
  claimed: boolean
  root?: string
  branch?: string
  reason?: string
  inputSchema?: WorkspaceInputSchema
}

/** The subset of JSON Schema a provider's input fields may use. */
export interface WorkspaceInputSchema {
  type?: 'object'
  properties?: Record<string, WorkspaceInputField>
  required?: string[]
}

export interface WorkspaceInputField {
  type: 'string' | 'boolean' | 'array'
  title?: string
  description?: string
  /** For a string: a fixed list of choices. */
  enum?: string[]
  default?: unknown
  /** For an array: its items are strings. */
  items?: { type: 'string' }
  placeholder?: string
}

/** What the probe found, in the words a confirm dialog or a task note can use. */
export interface WorkspaceProbeSummary {
  rootExists: boolean
  clean: boolean
  merged: boolean
  problems: string[]
  repos: Array<{
    path: string; name?: string; dirty: boolean; changes: number; unreadable: boolean; merged: boolean | null; exists: boolean
    /** Entries git ignores (the first few) and how many: a removal deletes them too. */
    ignored?: string[]; ignoredCount?: number
  }>
  branch?: string
  branchMerged?: boolean | null
}
