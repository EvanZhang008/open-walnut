/**
 * Every lifecycle action that is asked for now and carried out when something happens later
 * (a turn ends, a host confirms, a busy host frees up), with what bounds the wait and what
 * happens when it runs out. 2026-11-03: two such waits never ended. A stop the host did not
 * confirm blocked its session for good ("awaiting host confirmation"), and a task's move
 * waited 1 h 50 min for a turn whose background command kept the session `running`. The
 * rule since: each wait has a deadline and a clear result there (it runs, or it fails with a
 * reason), never pending for good.
 *
 * tests/core/sessions/lifecycle-waits-ratchet.test.ts checks every entry against its file
 * (the file exists and defines each limit) and fails on a new wait it finds that is not
 * listed: a TurnEndWait anywhere, or a module that listens for a session's status leaving
 * `running` to act later without one.
 */

export interface LifecycleWait {
  id: string;
  /** The module that keeps the wait and acts at its end. */
  file: string;
  waitsFor: string;
  /** The constants in `file` that bound it. */
  limits: string[];
  /** What happens when the wait runs out. */
  atEnd: string;
  /** Whether a server restart keeps the wait. */
  restart: string;
}

export const LIFECYCLE_WAITS: readonly LifecycleWait[] = [
  {
    id: 'engine-switch-turn-end',
    file: 'src/core/sessions/engine-switch-watch.ts',
    waitsFor: 'an engine switch or task_move asked mid-turn: the old session\'s turn to end',
    limits: ['SWITCH_BACKGROUND_GRACE_MS', 'SWITCH_PENDING_MAX_MS'],
    atEnd: 'background work its turn left: the switch runs and stops it, the new session is told; a turn or queued message: failed with the reason, the message kept, the session told',
    restart: 'resumes (engine_switch on the task, deadline from its `at`)',
  },
  {
    id: 'team-stop-turn-end',
    file: 'src/core/sessions/team-stop.ts',
    waitsFor: 'team_stop when:"turn_end": each running session\'s turn to end',
    limits: ['TEAM_BACKGROUND_GRACE_MS', 'TEAM_TURN_END_MAX_MS'],
    atEnd: 'the session is stopped anyway',
    restart: 'resumes (team_stop.at_turn_end on the root)',
  },
  {
    id: 'self-complete-stop',
    file: 'src/core/sessions/self-complete-stop.ts',
    waitsFor: 'a session that completed its own task: its turn to end before it is stopped',
    limits: ['SELF_COMPLETE_STOP_MAX_MS'],
    atEnd: 'the session is stopped',
    restart: 'ends (the session is reaped by its idle timer)',
  },
  {
    id: 'org-handover-close',
    file: 'src/core/org/handover-close.ts',
    waitsFor: 'a lead that handed over: the turn that reads its handover notice to end, then its task is closed',
    limits: ['HANDOVER_CLOSE_MAX_MS'],
    atEnd: 'its turn over (only background work left): closed; notice unread or turn still running: kept open, the unread notice withdrawn',
    restart: 'ends (the lead stays open and is no longer the project\'s contact)',
  },
  {
    id: 'session-stop-confirmation',
    file: 'src/core/sessions/session-stop.ts',
    waitsFor: 'a stop the host has not confirmed: sends and restarts of the session wait for it',
    limits: ['STOP_RETRY_DELAYS_MS', 'STOP_OFFLINE_MAX_MS'],
    atEnd: 'stopRequest.state = failed with the reason; the session takes messages again',
    restart: 'resumes (stopRequest on the record, sent again when the host connects)',
  },
  {
    id: 'daemon-upgrade-acp-turns',
    file: 'src/providers/acp-upgrade-hold.ts',
    waitsFor: 'a daemon upgrade while ACP turns are open on its host',
    limits: ['ACP_UPGRADE_HOLD_MAX_MS'],
    atEnd: 'the upgrade goes ahead',
    restart: 'resumes (the clock is kept per host in WALNUT_HOME/cache)',
  },
  {
    id: 'daemon-upgrade-exec-runs',
    file: 'src/providers/exec-runs-hold.ts',
    waitsFor: 'a daemon update while host_exec runs go on on its host (local, SSH, host network, boot-start install)',
    limits: ['EXEC_UPGRADE_HOLD_MAX_MS'],
    atEnd: 'the update goes ahead (each run also ends by its own deadline: 10 min foreground, 2 h background)',
    restart: 'resumes (the same per-host clock in WALNUT_HOME/cache as the ACP wait)',
  },
  {
    id: 'host-server-update-hold',
    file: 'src/core/host-server/update-hold.ts',
    waitsFor: 'a host server update while its host is busy',
    limits: ['DEFAULT_UPDATE_QUIET_MS', 'DEFAULT_UPDATE_MAX_BEHIND_MS'],
    atEnd: 'the update goes ahead',
    restart: 'resumes (kept on disk)',
  },
  {
    id: 'workspace-pending-start',
    file: 'src/core/workspaces/manager.ts',
    waitsFor: 'a task_start until the task\'s workspace is ready',
    limits: ['LOST_SLACK_MS'],
    atEnd: 'launch_error on the workspace, shown until Retry',
    restart: 'resumes (workspace.pending_start)',
  },
  {
    id: 'wait-resume-after-interruption',
    file: 'src/core/task-wait-resume.ts',
    waitsFor: 'a WAITING task a turn interrupted: that turn\'s end, to park it again',
    limits: ['MAX_AGE_MS'],
    atEnd: 'the turn ends as any other (NEED_ACTION)',
    restart: 'ends',
  },
  {
    id: 'wait-until-clock',
    file: 'src/core/task-wait-until.ts',
    waitsFor: 'a WAITING task\'s wait_until',
    limits: ['RECHECK_MS'],
    atEnd: 'the task is woken (or handed back with no session)',
    restart: 'resumes (wait_until on the task)',
  },
  {
    id: 'request-settle-after-report',
    file: 'src/core/sessions/report-pending.ts',
    waitsFor: 'settling a request at the target\'s turn end: its turn-end report first',
    limits: ['REPORT_PENDING_MAX_MS'],
    atEnd: 'settled without the report',
    restart: 'ends',
  },
  {
    id: 'held-subtask-notices',
    file: 'src/core/sessions/subtask-batch.ts',
    waitsFor: 'a completion notice held for an idle parent until its team settles',
    limits: ['HOLD_MAX_MS'],
    atEnd: 'released to the parent',
    restart: 'resumes (subtask-notices-held.json)',
  },
  {
    id: 'lane-turn-gate',
    file: 'src/core/sessions/lane-turn.ts',
    waitsFor: 'the next Personal AI lane turn: the earlier turn\'s end',
    limits: ['LANE_LATE_ANSWER_MAX_MS'],
    atEnd: 'the gate drains and the earlier turn is interrupted',
    restart: 'ends',
  },
  {
    id: 'cloud-send-bank',
    file: 'src/core/send-outcomes.ts',
    waitsFor: 'a phone send banked while its host is offline: the host to come back',
    limits: ['SEND_HORIZON_MS'],
    atEnd: 'settled as not sent (or unknown)',
    restart: 'resumes (SEND_QUEUE_DIR)',
  },
  {
    id: 'transfer-fork-confirm',
    file: 'src/core/transfer/transfer.ts',
    waitsFor: 'a task transfer: the new host\'s session to confirm',
    limits: ['FORK_CONFIRM_MS'],
    atEnd: 'the new task is kept for the user to check, with the reason (keepForUser)',
    restart: 'ends as unconfirmed',
  },
];

/**
 * Modules that listen for a session's status leaving `running` but carry out no deferred
 * action: they deliver or observe. Listed so the ratchet can tell them from a wait.
 */
export const TURN_END_OBSERVERS: Readonly<Record<string, string>> = {
  'src/core/sessions/subtask-notices.ts': 'delivers held notices at the parent\'s next turn; the notices themselves are bounded by HOLD_MAX_MS (held-subtask-notices)',
  'src/web/routes/quick-main-follow.ts': 'streams a quick ask\'s follow-up to the open request; the request has its own HTTP deadline',
  'src/core/hints/hint-drift-live.ts': 'reads a turn\'s lines for the reply-language correction; ends with the turn',
  'src/core/sessions/turn-end-wait.ts': 'the shared wait itself',
  'src/core/user-status-sync.ts': 'derives the user status from the session\'s status on each change; waits for nothing',
};
