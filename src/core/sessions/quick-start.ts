/**
 * Quick-start core — create a task and start a real Claude Code session for it.
 *
 * Extracted from the POST /api/sessions/quick-start handler so non-HTTP callers
 * (the claude-code routine executor) can start sessions through the exact same
 * path: task creation → TASK_CREATED → SESSION_START bus emit → session-runner
 * spawns the CLI (locally or via the remote daemon).
 */

import path from 'node:path';
import { log } from '../../logging/index.js';
import { addTask, getTask, updateTask, updateTaskRaw, getCustomTiers, ensureFolderProject, resolveProjectForWrite, InvalidProjectNameError, ProjectSourceConflictError } from '../task-manager.js';
import { getSessionsForTask, updateSessionRecord } from '../session-tracker.js';
import { bus, EventNames } from '../event-bus.js';
import { migrateFocusTier, type Task, type SessionEngine } from '../types.js';
import { spillLargePromptToFile } from './quick-start-spill.js';
import { engineCaps, isAcpEngine, normalizeEngine } from '../agents/engine-registry.js';
import { resolveDefaultEngine } from '../agents/default-engine.js';
import type { FallbackDecision } from '../agents/fallback-engine.js';
import type { LaunchSourceRecord } from './project-launch-defaults.js';
import { buildAskProfilePrefix } from './ask-profile-prefix.js';
import { isPersonSource } from './send-sent-by.js';
import { heuristicShortTitle } from './task-title-brake.js';
import { ASK_WALNUT_PROJECT, GENERAL_AGENT_ID, askProjectFor, resolveAskAgent, stampedAgentId, type AskAgentRef } from './ask-agent.js';

export interface QuickStartTaskMeta {
  /** Start the new task already marked unread. */
  unread?: boolean;
  priority?: 'immediate' | 'important' | 'backlog' | 'none';
  /**
   * Built-in tier ('focus' | 'satellite' | 'wait') or a registered
   * custom tier id (ct_*).
   *
   * Three-way: a tier name pins into that tier; `null` is an explicit "do NOT
   * pin this one" (the launcher's unpin gesture); omitted means the caller has
   * no opinion and the new task takes the board default (pinned, Satellite).
   */
  pinTier?: string | null;
  /** Task dates (ISO) — same trio as POST /api/tasks; a launch IS a task create. */
  due_date?: string;
  start_date?: string;
  end_date?: string;
  /** Where the new task syncs in a project that syncs to an outside service: absent or 'local'
   *  keeps it local (a launch's default), 'project' gives it the project's source once Walnut's
   *  private-task check passed it (core/private-tasks/). */
  sync?: 'local' | 'project';
}

export interface QuickStartParams {
  message: string;
  /**
   * Prepended to the (possibly spilled) message — NOT subject to spill.
   * The HTTP route uses this for the attached-images context block, matching
   * the original handler's order: spill first, then prefix.
   */
  messagePrefix?: string;
  /**
   * One machine line appended AFTER the message the CLI receives (the phone's
   * voice-reply line, voice-reply.ts). Never part of any name, and skipped for an
   * empty launch or a slash command, which must reach the CLI byte-exact.
   */
  messageSuffix?: string;
  /**
   * The message hints the first message asks for (`on_request`, as on every later send: the
   * side panel's `object-context`, what the person asks about). Rendered by the registry as
   * Walnut blocks beside the words, never inside them (core/hints/hint-send.ts requestedHintBlocks).
   */
  hints?: import('../hints/hint-send.js').RequestedHints;
  cwd: string;
  host?: string;
  model?: string;
  mode?: string;
  /** Reasoning effort the person picked for the new session (the draft picker's Effort column).
   *  Absent = no --effort at spawn, so Claude Code's own settings decide. Native engine only:
   *  an ACP engine carries its effort in its model id, so a launch on one drops it. */
  effort?: import('../types.js').SessionEffort;
  /** The session that asks for this start (`x-walnut-caller-sid`): the launch runs at most as
   *  loose as its own mode (delegated-mode.ts capStartMode). Absent: the person, or Walnut itself. */
  callerSid?: string;
  /** `mode` came from defaults the caller did not name (its project's): a looser one comes down
   *  to the caller's mode instead of refusing the start. */
  modeImplied?: boolean;
  /** Retry mode: reuse this task instead of creating a new one. */
  existingTaskId?: string;
  /** "Start anyway": skip the host gate's claude_outdated / claude_not_logged_in refusal (host-start-gate.ts). */
  overrideReadiness?: boolean;
  /**
   * The host gate as this caller needs it. `checked`: the caller already ran it
   * (the web route runs it before images and the cwd mkdir). `deadlineMs`: the
   * gate's own wait budget. Who started the launch comes from `source`
   * (hostGateSourceFor): only a person's Start may redial a failed host.
   */
  hostGate?: { checked?: boolean; deadlineMs?: number };
  taskMeta?: QuickStartTaskMeta;
  /** Task title; defaults to "Session: <basename(cwd)>". */
  taskTitle?: string;
  /**
   * Title for the SESSION record. Without it the session is named after the
   * first 80 characters of its launch message, which is right for a human's
   * prompt and wrong for a machine one: a trigger launches with a
   * `<walnut-message>` envelope, so the session wore the raw markup as its name
   * (seen on prod) and nothing ever renamed it - the CLI titler below only runs
   * for launches that preassign a session id.
   */
  sessionTitle?: string;
  /** Task project. Omitted/empty = Inbox; the auto-organize pass below then
   *  offers to file the task under an existing project. */
  project?: string;
  /** `project` was DERIVED from the launch folder (the draft's "a folder is a
   *  project" default) — when this launch CREATES the registry row, the folder is
   *  stamped as its default_cwd so the next pick resolves straight to it. Only
   *  the folder-derived path may claim this; a server-chosen or routine-supplied
   *  project must not adopt whatever directory it happened to first run in. */
  projectFromFolder?: boolean;
  /** Event-bus source tag, e.g. 'quick-start' | 'routine'. */
  source: string;
  requestTs?: number;
  /**
   * Coding-agent engine. Omitted = INHERIT `config.defaults.engine` (resolved
   * below through resolveDefaultEngine, which answers 'claude' unless the user
   * picked another one in Settings › Sessions). A caller that names an engine
   * always wins; a caller that mints its own `preassignedSessionId` must resolve
   * the same way BEFORE deciding to mint (an ACP engine issues its own ids), so
   * the HTTP route and the mobile launch pass the resolved value explicitly.
   */
  engine?: SessionEngine;
  /**
   * The fallback engine a caller already chose for this launch (agents/fallback-engine.ts): the
   * route that mints its own session id decides before minting and hands the decision on, so
   * both read the limit once. It runs the launch on that engine and model and notes it on the task.
   */
  fallback?: FallbackDecision;
  /** The caller ran the fallback decision itself (none came of it when `fallback` is absent). */
  fallbackDecided?: boolean;
  /** Where the launch's engine, model and mode came from (project-launch-defaults.ts), noted on
   *  the task for its session's pickers. Absent: a caller that resolved no defaults; an older
   *  note is taken off, since it described another start. */
  launchSource?: LaunchSourceRecord;
  /** The caller resolved the engine itself (its project's default, the global one): an absent
   *  `engine` is Claude Code then, never the global default again. */
  engineDecided?: boolean;
  /**
   * Caller-minted session id, forwarded to the CLI as `--session-id`. Lets the
   * HTTP route return the session id in its response instead of making the UI
   * poll for it — the CLI adopts this id when it spawns. Native (claude) engine
   * only: the ACP path derives its own ids from the adapter.
   */
  preassignedSessionId?: string;
  /**
   * "Ask Walnut" launch (the draft's second tab): the session spawns with the
   * Personal AI's own profile (persona + standing memory + skills index, via
   * personal-ai-lane's buildLaneProfile) instead of as a bare coding agent.
   * Everything else is an ORDINARY quick-start — a normal task, a visible
   * session — the route just pre-fills project 'Ask Walnut' and cwd WALNUT_HOME.
   * On the native engine the profile rides the CLI's system-prompt flags. ACP
   * engines have no such channel, so there the same bundle rides the FIRST
   * MESSAGE instead (buildAskProfilePrefix) — see the prefix module for why the
   * message is the carrier every engine has.
   */
  walnutAgent?: boolean;
  /**
   * Which console agent a walnutAgent launch speaks to ('general' = the
   * Personal AI, the default; 'mentor', 'note-agent', a config-defined id).
   * Picks the persona, the project the task files under ("Ask <name>"), the
   * placeholder title and the task's `agent_id` stamp — see ask-agent.ts.
   * Unknown / non-console ids are a 400. Ignored without walnutAgent.
   */
  agentId?: string;
  /**
   * File (or reuse) the task and stop there: no session record, no
   * SESSION_START. The task's isolated workspace is made first and the session
   * started in it afterwards (core/workspaces/launch.ts).
   */
  deferStart?: boolean;
  /**
   * A new task with no folder (`cwd` empty, this machine) starts in its own task directory
   * (src/lib/task-dir.ts), made right after the task is filed: the browser extension's New
   * task, which has no folder picker. A host, an existing task or an Ask Walnut launch
   * ignores it (each has its own place).
   */
  ownTaskDir?: boolean;
}

export class QuickStartError extends Error {
  /** `body`: the full JSON answer when there is more than a sentence (the host gate's 409). */
  constructor(message: string, public statusCode: number = 400, public body?: Record<string, unknown>) {
    super(message);
    this.name = 'QuickStartError';
  }
}

/**
 * The placeholder title a quick-start task gets when the caller supplies none.
 * Exported as the single definition of "still untitled" — the session
 * auto-title hook compares against this exact string to decide whether a
 * task's title is safe to replace with an AI-generated one.
 */
export function defaultSessionTaskTitle(cwd: string): string {
  return `Session: ${path.basename(cwd.replace(/\/+$/, '') || '/')}`;
}

/** The placeholder an Ask Walnut launch mints instead of the cwd-derived one
 *  ("Session: .open-walnut" would name the data dir, which means nothing).
 *  Another agent's ask wears ITS project name ("Ask Mentor") the same way. */
export const ASK_WALNUT_PLACEHOLDER_TITLE = ASK_WALNUT_PROJECT;

/**
 * THE placeholder gate for auto-titling: returns the placeholder this task
 * still wears, or undefined when the title carries human signal. Every titling
 * trigger (launch kick, onMessageSend hook, turn-complete net, observed-message,
 * reconciler sweep) must decide through this one function — the Ask Walnut
 * placeholder was invisible to all of them while each derived its own
 * `Session: <basename>` candidates from cwd, so those tasks never got titled.
 * Try EVERY cwd the caller knows (cwd-rename-detector can move cwd after
 * launch). The Ask Walnut match is keyed on the walnut_agent flag, never the
 * bare string, so a user-typed "Ask Walnut" on an ordinary task is kept.
 * Another agent's ask is minted titled after its project ("Ask Mentor"), so a
 * walnut_agent task whose title still equals its "Ask …" project is wearing
 * that placeholder — the project is the one stamp both names derive from
 * (askProjectFor), which keeps this sync and registry-free.
 * Known limit: a walnut_agent task the user deliberately renames BACK to
 * exactly "Ask Walnut" is indistinguishable from the placeholder and may be
 * retitled — inherent to keying on the string.
 */
export function matchPlaceholderTitle(
  task: { title?: string; walnut_agent?: boolean; project?: string },
  cwds: Array<string | undefined | null>,
): string | undefined {
  const title = task.title ?? '';
  if (task.walnut_agent && title === ASK_WALNUT_PLACEHOLDER_TITLE) return title;
  // Case-insensitive: addTask canonicalises the project's casing to the
  // registry row, while the title keeps the launch's spelling.
  if (task.walnut_agent && title.startsWith('Ask ') && title.toLowerCase() === (task.project ?? '').trim().toLowerCase()) return title;
  return cwds.filter((c): c is string => !!c)
    .map(defaultSessionTaskTitle)
    .find((ph) => title === ph);
}

/**
 * A new task's title from the words that start it: their first line, cut to a row's length as the
 * title brake cuts (SESSION_TITLE_MAX). '' for no words.
 */
export function titleFromWords(message: string): string {
  const line = message.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return line ? heuristicShortTitle(line) : '';
}

/**
 * Create (or reuse) the task and emit SESSION_START. Returns the task.
 * Throws QuickStartError with an HTTP-ish statusCode on invalid input so the
 * route wrapper can map it 1:1.
 */
const continuedSessions = new WeakMap<Task, string>();

/**
 * The session a quickStartSession() call continued instead of starting one
 * (one session per task): callers answer with THIS id, not the one they minted.
 */
export function continuedSessionOf(task: Task): string | undefined {
  return continuedSessions.get(task);
}

/**
 * The launch values of a project that sets launch defaults, for a caller that resolved none, or
 * undefined (no project, or one with none). A caller that minted its session id has promised it,
 * so a project engine that issues its own ids gives way to Claude Code there, its model with it.
 */
async function projectDefaultsLaunch(params: QuickStartParams, model: string | undefined, mode: string | undefined): Promise<{
  engine: SessionEngine | undefined; model: string | undefined; mode: string | undefined;
  fallback: FallbackDecision | undefined; source: LaunchSourceRecord;
} | undefined> {
  const projectName = params.existingTaskId
    ? (await getTask(params.existingTaskId).catch(() => null))?.project
    : params.project;
  if (!projectName) return undefined;
  const { hasLaunchDefaults, pickLaunchDefaults, projectLaunchDefaultsOf } = await import('./project-launch-defaults.js');
  if (!hasLaunchDefaults(await projectLaunchDefaultsOf(projectName))) return undefined;
  const { getConfig } = await import('../config-manager.js');
  const { selfDecidesFallback } = await import('../agents/fallback-engine.js');
  const namesModel = !!model && model !== 'default';
  const pick = await pickLaunchDefaults({
    config: await getConfig(), project: projectName, host: params.host,
    named: { engine: params.engine, model, mode },
    decidesFallback: params.engine === undefined && !namesModel && selfDecidesFallback(params.source, false),
  });
  let engine = pick.engine;
  let fallback = pick.fallback ?? undefined;
  let source: LaunchSourceRecord = pick.source;
  let launchModel = pick.model ?? model;
  if (params.preassignedSessionId && params.engine === undefined && engine && engineCaps(engine).idProvisioning === 'provider-issued') {
    log.web.info(`${params.source}: the project's engine issues its own session ids; this launch keeps the id it was given and runs on Claude Code`, {
      project: projectName, engine, sessionId: params.preassignedSessionId,
    });
    engine = undefined;
    fallback = undefined;
    launchModel = model;
    source = { ...source, engine: 'global', model: namesModel ? 'task' : 'global' };
  }
  const launchMode = mode ?? pick.mode;
  return {
    engine, model: launchModel, mode: launchMode, fallback,
    source: { ...source, started: { engine: engine ?? 'claude', ...(launchModel ? { model: launchModel } : {}), ...(launchMode ? { mode: launchMode as import('../types.js').SessionMode } : {}) } },
  };
}

export async function quickStartSession(params: QuickStartParams): Promise<Task> {
  const {
    message, messagePrefix, host, existingTaskId, taskMeta,
    source, requestTs = Date.now(), preassignedSessionId, walnutAgent,
  } = params;
  let mode = params.mode;
  let { cwd } = params;
  /** A person named this VP's or lead's folder: its later spawns keep it (org-own-folder.ts). */
  let cwdByPerson: string | undefined;
  // The task's own directory is known only once the task has its id (below).
  const inOwnTaskDir = params.ownTaskDir === true && !cwd && !host && !existingTaskId && !walnutAgent;
  let model = params.model;

  // Host gate FIRST, before any write (existing task, project metadata, addTask,
  // TASK_CREATED): a refused Start leaves nothing on the board to roll back.
  if (!params.hostGate?.checked) {
    const { hostStartGate, hostGateSourceFor } = await import('./host-start-gate.js');
    const refused = await hostStartGate({
      host, model, overrideReadiness: params.overrideReadiness, source: hostGateSourceFor(source),
      ...(params.hostGate?.deadlineMs ? { deadlineMs: params.hostGate.deadlineMs } : {}),
    });
    if (refused) throw new QuickStartError(refused.error, 409, { ...refused });
  }

  let existingTask: Task | undefined;
  if (existingTaskId) {
    try {
      existingTask = await getTask(existingTaskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No task found matching')) throw new QuickStartError(`Task "${existingTaskId}" not found`, 404);
      if (msg.includes('Ambiguous ID prefix')) throw new QuickStartError(msg, 400);
      throw err;
    }
    const target = existingTask;
    const { readRouterAreas, taskArea } = await import('../router/areas.js');
    const { WALNUT_HOME } = await import('../../constants.js');
    const areas = await readRouterAreas(WALNUT_HOME).catch((error) => {
      if (target.router_area_id || target.org_role === 'router') throw error;
      return undefined;
    });
    if (target.router_area_id || target.org_role === 'router' || (areas && taskArea(areas, target.id))) {
      throw new QuickStartError('Open this area task through its own isolated conversation, not the quick launcher.', 409);
    }
  }

  // Engine, resolved BEFORE anything else reads it: every gate below
  // (`isAcpEngine`) and the SESSION_START payload must see the engine this
  // launch will ACTUALLY run on, so a launch that named none behaves exactly as
  // if the caller had passed the configured default.
  //
  // normalizeEngine keeps the storage/wire contract intact: the default engine
  // stays ABSENT ('claude' is never written out), so a config with no
  // `defaults.engine` produces a byte-identical payload to before.
  let engine = params.engine;
  // The default engine out of usage: a launch that named neither an engine nor a model starts on
  // the fallback (agents/fallback-engine.ts), unless the caller already decided it.
  let fallback = params.fallback;
  const { selfDecidesFallback } = await import('../agents/fallback-engine.js');
  let fallbackDecided = !!params.fallbackDecided;
  let engineDecided = !!params.engineDecided;
  let launchSource = params.launchSource;
  // The task's project's launch defaults (project-launch-defaults.ts) for a caller that resolved
  // none (a routine's run, a watcher, a notification repair, an org autostart): new tasks of a
  // project start on them on every path. The web's new task and the phone resolve them first and
  // pass launchSource; Ask Walnut keeps its own rules. A project that sets none changes nothing.
  if (!launchSource && !engineDecided && !fallback && !fallbackDecided && !walnutAgent) {
    const picked = await projectDefaultsLaunch(params, model, mode);
    if (picked) {
      ({ engine, model, mode, fallback } = picked);
      launchSource = picked.source;
      engineDecided = true;
      fallbackDecided = true;
    }
  }
  // A session starts work at most as loose as itself, a project's default mode included.
  if (params.callerSid) {
    const { capStartMode } = await import('./delegated-mode.js');
    const asked = params.modeImplied ? undefined : params.mode;
    const capped = await capStartMode(params.callerSid, asked);
    mode = mode !== undefined && mode !== asked ? await capStartMode(params.callerSid, mode, { implied: true }) : capped;
    if (launchSource?.started) launchSource = { ...launchSource, started: { ...launchSource.started, ...(mode ? { mode: mode as import('../types.js').SessionMode } : {}) } };
  }
  const selfDecides = !fallbackDecided && !fallback && selfDecidesFallback(source, walnutAgent);
  // Only a launch whose engine was decided here (or by its caller) writes or clears the note: a
  // workspace's replay, the phone or a repair leaves the task's note as it is.
  const decides = !!fallback || fallbackDecided || selfDecides;
  if (fallback) {
    engine = normalizeEngine(fallback.engine);
    model = fallback.model;
  } else if (selfDecides && engine === undefined && (!model || model === 'default')) {
    const { getConfig } = await import('../config-manager.js');
    const config = await getConfig();
    const { resolveFallbackLaunch } = await import('../agents/fallback-engine.js');
    const decided = await resolveFallbackLaunch(config, resolveDefaultEngine(config, { host }), host).catch(() => null);
    // A minted id is a promise only the native engine keeps (see below): such a launch stays.
    if (decided && !(preassignedSessionId && engineCaps(decided.engine).idProvisioning === 'provider-issued')) {
      fallback = decided;
      engine = normalizeEngine(decided.engine);
      model = decided.model;
    }
  }
  if (engine === undefined && !fallback && !engineDecided) {
    const { getConfig } = await import('../config-manager.js');
    const inherited = normalizeEngine(resolveDefaultEngine(await getConfig(), { host }));
    // A caller that minted its own session id has already PROMISED it: it rides
    // an HTTP answer (the frozen /api/v1 launch, the notification repair) or IS
    // the run's identity (a subagent's runId). An engine that issues its own ids
    // cannot keep that promise — the id would name a session that never exists,
    // and the client would sit on "Untitled session" forever. So the INHERITED
    // engine yields to the promise; an engine the caller named explicitly still
    // wins over both (that caller knows what it asked for). The one surface that
    // supports both resolves the engine BEFORE deciding to mint (the quick-start
    // route), so it never lands here.
    if (inherited && preassignedSessionId && engineCaps(inherited).idProvisioning === 'provider-issued') {
      log.web.info(`${source}: the configured default engine issues its own session ids — this launch keeps the id it was given and runs on the native engine`, {
        configured: inherited, sessionId: preassignedSessionId,
      });
    } else {
      engine = inherited;
    }
  }

  // The effort the person picked: only the native engine takes it as a spawn flag.
  const pickedEffort = params.effort && !isAcpEngine(engine) ? params.effort : undefined;

  // "Ask Walnut": resolve the agent's profile up front — the same bundle
  // (persona + standing memory + skills index + walnut MCP mount) and the same
  // chat-tuned effort a main-chat lane spawns with. Resolved BEFORE any task
  // write so a failure here fails the launch cleanly instead of leaving a task
  // whose session never got its persona.
  let walnutProfile: { profile: import('../types.js').SessionProfile; effort: import('../types.js').SessionEffort } | undefined;
  /**
   * ACP asks only: the profile's prompt half, carried by the FIRST MESSAGE
   * because an ACP engine has no system-prompt channel (ask-profile-prefix.ts).
   * Empty for the native engine, which rides the spawn flags as before.
   */
  let askProfilePrefix = '';
  let askAgent: AskAgentRef | undefined;
  if (walnutAgent) {
    // A retry on an existing ask names no agent; the task's own stamp says
    // whose persona it runs, so a Mentor ask is never resumed as Walnut.
    const stamped = !params.agentId && existingTaskId ? await stampedAgentId(existingTaskId) : undefined;
    askAgent = await resolveAskAgent(params.agentId ?? stamped);
    if (!askAgent) throw new QuickStartError(`Unknown console agent "${params.agentId}"`, 400);
    const { getConfig } = await import('../config-manager.js');
    const { buildLaneProfile } = await import('./personal-ai-lane.js');
    // USER.md rides the session context where the engine takes one; elsewhere the prefix carries it.
    // Main's and a lead's session context carries the routing rules (their role); an ask's does not.
    const orgNode = existingTaskId
      ? await (await import('../task-manager.js')).getTask(existingTaskId).then((t) => t.org_role === 'main' || t.org_role === 'lead', () => false)
      : false;
    const built = await buildLaneProfile(await getConfig(), askAgent.id, {
      userInSessionContext: engineCaps(engine).walnutSessionContext,
      routingInSessionContext: engineCaps(engine).walnutSessionContext && orgNode,
      compactSkills: isAcpEngine(engine),
    });
    if (isAcpEngine(engine)) {
      // One builder, two carriers. The spawn cannot take the bundle here, so it
      // becomes the launch message's prefix instead — an ACP ask that launched
      // without it would be a bare provider chat wearing Walnut's task.
      // `effort` is deliberately dropped: on ACP it is a per-session config
      // option, not a spawn argument, so there is nothing to forward it to.
      askProfilePrefix = buildAskProfilePrefix(built.profile);
    } else {
      walnutProfile = built;
      // The lane's medium is the FIRST-RUN default only: an effort the user picked
      // for an earlier Ask Walnut (in its picker, or via config) carries forward,
      // gated on the model this launch actually spawns being able to take it.
      const { getAskWalnutLaunchPrefs, resolveAskWalnutEffort } = await import('./ask-walnut-launch.js');
      const remembered = await getAskWalnutLaunchPrefs();
      walnutProfile.effort = resolveAskWalnutEffort(remembered.effort, model, walnutProfile.effort);
      // A level picked on this launch's own picker wins over the remembered one.
      if (pickedEffort) walnutProfile.effort = pickedEffort;
    }
  }
  // `let`, not const: a launcher can carry a project name the human has since
  // DELETED (the draft column remembers its last pick for as long as the tab
  // lives). The registry resolves that to Inbox — or to the survivor of a
  // rename — and the launch must use whatever it decided, for the task, the
  // session record and the folder stamp alike.
  let project = params.project?.trim() ?? '';
  // Captured at creation: "the caller did not file this task anywhere" is the
  // gate for the auto-organize pass at the end. Reading task.project later
  // would race the pass's own write on a retry.
  const callerSuppliedProject = project !== '';

  // Spill-to-disk: messages above the inline limit are saved to a temp file and
  // replaced with a short pointer prompt so Claude reads the full context via the Read tool.
  let sessionMessage = message;
  let largePromptFile: { localPath: string; originalLength: number } | undefined;
  const spill = spillLargePromptToFile(message);
  if (spill) {
    sessionMessage = spill.promptWithPointer;
    largePromptFile = { localPath: spill.filePath, originalLength: spill.originalLength };
    log.web.info(`${source}: spilled large prompt to file`, {
      filePath: spill.filePath,
      originalLength: spill.originalLength,
      host,
    });
  }
  // What every NAME derives from, captured before either Walnut-built prefix goes
  // on: the session title and the task description must read the request, not the
  // configuration Walnut wrapped around it. Taken post-spill on purpose, so a
  // spilled launch is still named by its pointer text exactly as before.
  const namingMessage = sessionMessage;
  // Reference cards, exactly as session:send appends them to a later message
  // (reference-cards.ts): a `<task-ref/>` the composer put in the launch message
  // is an opaque id to the model until the card names the task and its state.
  // After the naming capture, so no title reads the card; before the prefixes,
  // so the human's words stay first. Slash commands are exempt for the same
  // reason as on the send path. Best-effort: buildReferenceCards never throws.
  if (!message.startsWith('/')) {
    const { buildReferenceCards, appendReferenceCards } = await import('./reference-cards.js');
    const refCards = await buildReferenceCards(message);
    if (refCards) sessionMessage = appendReferenceCards(sessionMessage, refCards);
    // Escaped like every send (hints/hint-format.ts), so a Walnut-shaped block in
    // the words is never taken for one of Walnut's hints, and shows as typed.
    const { escapeHintTags } = await import('../hints/hint-format.js');
    sessionMessage = escapeHintTags(sessionMessage);
    // Last of the human-side text, after the cards: a reply-style line is read
    // best nearest the end (the same placement the send path uses).
    if (params.messageSuffix && message.trim()) sessionMessage = `${sessionMessage}\n\n${params.messageSuffix}`;
    if (params.hints) {
      const { requestedHintBlocks } = await import('../hints/hint-send.js');
      sessionMessage = await requestedHintBlocks(sessionMessage, params.hints);
    }
  }
  if (messagePrefix) {
    sessionMessage = messagePrefix + sessionMessage;
  }
  // The ACP ask's persona goes FIRST — it frames everything after it, including
  // the caller's own prefix (the attached-images context block).
  if (askProfilePrefix) {
    sessionMessage = askProfilePrefix + sessionMessage;
  }

  let updatedTask: Task;

  if (existingTaskId) {
    // Retry mode: reuse existing task, archive error sessions.
    // Note: footer taskMeta picks (unread/priority/pinTier) are
    // intentionally IGNORED on retry — we preserve the original task's metadata.
    updatedTask = existingTask!;
    // An Ask Walnut launch ON an existing plain task (task-row ▶ → Ask Walnut)
    // makes it a Personal-AI task from here on: stamp the marker, because every
    // Ask Walnut behaviour keys on it, never on the project — the amber title,
    // the chat slot's list of asks, the model/effort launch memory and the
    // persona drift repair would all skip this session otherwise. General agent
    // only: agent_id is create-time data (updateTask does not take it), and a
    // stamp without it would have the repair rebuild the wrong persona.
    // The org is off: Main or a VP is started only by a person (sessions/task-start.ts).
    const { refuseOrgStartWhileOff } = await import('./task-start.js');
    await refuseOrgStartWhileOff(updatedTask, source);
    if (walnutAgent && !updatedTask.walnut_agent && askAgent?.id === GENERAL_AGENT_ID) {
      updatedTask = (await updateTask(updatedTask.id, { walnut_agent: true }, { source })).task;
    }
    // One session per task (one-session-per-task.ts): a task that already
    // holds a conversation continues it; one whose start never got a turn is
    // retired here and replaced by the session below.
    const { continueTaskConversation, taskConversation } = await import('./task-session-claim.js');
    const conversation = await taskConversation(updatedTask.id, { retire: true });
    if (!conversation && (!host || host === '__local__' || host === 'local')) {
      // The folder a task with no folder starts in is its own directory, made by its start
      // (task-launch-plan.ts), also here: a draft opened on it (Chat on a project lead).
      const { taskDirForHost, ensureTaskDirOnHost } = await import('./task-dir-place.js');
      if (cwd && cwd === await taskDirForHost(updatedTask.id, '__local__')) await ensureTaskDirOnHost(updatedTask.id, '__local__');
    }
    if (!conversation) {
      // A VP or lead runs in its own task directory unless a person named this folder (org-own-folder.ts).
      const { ownFolderStartCwd } = await import('./org-own-folder.js');
      const own = await ownFolderStartCwd(updatedTask, host, { cwd, callerSid: params.callerSid, source });
      if (own?.kind === 'own') {
        const { ensureTaskDirOnHost } = await import('./task-dir-place.js');
        const made = await ensureTaskDirOnHost(updatedTask.id, host);
        if ('error' in made) throw new QuickStartError(`Task ${updatedTask.id} could not make its task directory (${made.error}).`, made.status);
        cwd = made.path;
      } else if (own?.kind === 'person') {
        cwdByPerson = cwd;
      }
    }
    if (conversation) {
      const { refuseDifferentPlace, moveFromLostHost } = await import('./task-start.js');
      // Its session's host cannot be reached: the launch moves the task there (host-lost.ts).
      const moved = host !== undefined
        ? await moveFromLostHost(updatedTask, { taskIdPrefix: updatedTask.id, host, message: sessionMessage, source, ...(params.engine ? { engine: params.engine } : {}) })
        : null;
      if (moved) {
        const movedTask = await getTask(updatedTask.id);
        if (moved.sessionId) continuedSessions.set(movedTask, moved.sessionId);
        return movedTask;
      }
      refuseDifferentPlace(updatedTask, conversation, { ...(host !== undefined ? { host } : {}), ...(params.engine ? { engine: params.engine } : {}) });
      await continueTaskConversation(conversation, { text: sessionMessage, source });
      const continuedTask = await getTask(updatedTask.id);
      continuedSessions.set(continuedTask, conversation.claudeSessionId);
      return continuedTask;
    }
  } else {
    // Normal mode: create new task. Ask Walnut gets its own placeholder — the
    // generic one is "Session: <basename(cwd)>", which for WALNUT_HOME reads
    // "Session: .open-walnut" (the data dir's name means nothing to the user).
    const placeholderTitle = askAgent ? askProjectFor(askAgent) : defaultSessionTaskTitle(cwd);
    // A task in its own directory has no folder to name it: the person's own words do, at once,
    // cut as the title brake cuts (the board, search and approvals read it; review round 5: every
    // such task read "Session: <its id>" until a model titled it, and never when none did).
    const wordsTitle = inOwnTaskDir && !params.taskTitle?.trim() ? titleFromWords(message) : '';
    const title = params.taskTitle?.trim() || wordsTitle || placeholderTitle;
    // A folder-derived project is decided HERE, not trusted from the draft:
    // the folder's own project, else a new one named after the folder, made
    // unique against the registry and created with the folder stamped on it
    // (ensureFolderProject; the rule is in folder-project.ts). The draft shows
    // the same answer, but an older window, or two drafts on two same-named
    // folders, can carry a name another folder already owns. Only a
    // folder-derived pick may bind a folder, and an EXISTING row's folder is
    // never rewritten. A rare addTask failure leaves an empty (reusable)
    // project behind, which is harmless next to failing the launch.
    //
    // Any other name a launcher carries can be one the human has since DELETED:
    // the draft column remembers its last pick for as long as the tab lives,
    // and that is how a project deleted at 21:15 was re-created by a launch at
    // 19:35 the same evening. Resolve first (read-only): a removed project
    // becomes Inbox, a renamed one follows to its survivor. Deliberately NOT a
    // create: minting the row here with a 'local' claim would take the name
    // away from whichever provider would otherwise claim it.
    if (project && params.projectFromFolder) {
      const own = (await ensureFolderProject(cwd, host, `${source}:launch`)).name;
      if (own !== project) {
        log.web.info(`${source}: folder project decided by the server`, { cwd, host, from: project, to: own || 'Inbox' });
      }
      project = own;
    } else if (project) {
      const resolved = await resolveProjectForWrite(project, `${source}:launch`);
      if (resolved.blocked) {
        log.web.warn(`${source}: launch project was deleted — filing the task in the Inbox`, { project });
        project = '';
      } else {
        if (resolved.name !== project) {
          log.web.info(`${source}: launch project resolved`, { from: project, to: resolved.name });
        }
        project = resolved.name;
      }
    }
    // Pin decision, made BEFORE the create so the task is born pinned in one
    // write: `null` = the caller explicitly opted out (the launcher's unpin
    // gesture, a routine run); anything else joins the board.
    const pinNewTask = taskMeta?.pinTier !== null;
    // Tier resolved to a value addTask will accept, BEFORE the create, so the
    // pin AND its tier land in ONE store write (the old create → setFocusTier
    // pair could half-land and silently drop the task into Satellite).
    //
    // Deliberately LENIENT here, unlike the task-create REST edges: the
    // launcher persists the last tier in localStorage, so after the user
    // deletes that tier in Settings a stale ct_* arrives on every launch. That
    // is a stale remembered pick, not a caller error — downgrade it to
    // Satellite (what setFocusTier used to self-heal it to) rather than failing
    // the launch. See the matching note in web/routes/sessions.ts.
    let bornTier: string | undefined;
    if (pinNewTask && taskMeta?.pinTier && taskMeta.pinTier !== 'satellite') {
      // A remembered pick may also be a retired built-in ('backlog'): it lands
      // in that tier's successor rather than Satellite.
      const requested = migrateFocusTier(taskMeta.pinTier);
      const known = ['focus', 'wait'].includes(requested)
        || (await getCustomTiers()).some((t) => t.id === requested);
      if (known) bornTier = requested;
      else {
        log.web.warn(`${source}: unknown pinTier on launch, filing in Satellite`, {
          tier: taskMeta.pinTier,
        });
      }
    }
    let task: Task;
    try {
      // ONE store write: cwd/priority/dates ride the create instead of a
      // follow-up updateTask. Every task op is a whole-store read-modify-write
      // behind one lock, so each op this path sheds is real launch latency —
      // under machine load the old create → update → tier → re-read chain
      // convoyed to 20-30s of "Starting…" (2026-08-26).
      ({ task } = await addTask({
        title,
        project,
        // A launch is local unless its creator picked the project's service (the draft's Sync chip).
        ...(taskMeta?.sync === 'project' ? {} : { source: 'local' as const }),
        cwd,
        // 'none' is a sentinel meaning "don't write priority" — lets a caller
        // omit the field without clearing an existing value.
        ...(taskMeta?.priority && taskMeta.priority !== 'none' ? { priority: taskMeta.priority } : {}),
        // Dates ride the create too (route already validated they parse).
        ...(taskMeta?.due_date ? { due_date: taskMeta.due_date } : {}),
        ...(taskMeta?.start_date ? { start_date: taskMeta.start_date } : {}),
        ...(taskMeta?.end_date ? { end_date: taskMeta.end_date } : {}),
        ...(pinNewTask ? { pinned: true } : {}),
        ...(bornTier ? { focus_tier: bornTier } : {}),
        // The per-task Personal-AI marker — task lists key the amber title on
        // THIS, never on the project name (an ordinary task filed under the
        // same project must not light up).
        ...(walnutAgent ? { walnut_agent: true } : {}),
        // Whose ask (absent for the Personal AI): the drawer's per-agent list
        // and the drift repair read it back.
        ...(askAgent && askAgent.id !== GENERAL_AGENT_ID ? { agent_id: askAgent.id } : {}),
      }));
    } catch (err) {
      // Client-supplied project seed the registry rejects — a caller error, not
      // a server fault. Name gate (path separators etc.) → 400; provider-claimed
      // project → 409, same mapping as every other addTask route.
      if (err instanceof InvalidProjectNameError) throw new QuickStartError(err.message, 400);
      if (err instanceof ProjectSourceConflictError) throw new QuickStartError(err.message, 409);
      throw err;
    }
    if (inOwnTaskDir) {
      // The folder the task runs in is its own directory, named after its id, so it is made
      // and recorded now, with the placeholder the launch auto-title looks for (its basename).
      const { ensureTaskDirOnHost } = await import('./task-dir-place.js');
      const made = await ensureTaskDirOnHost(task.id, '__local__');
      if ('error' in made) throw new QuickStartError(`The new task's own directory could not be made: ${made.error}`, made.status);
      cwd = made.path;
      ({ task } = await updateTask(task.id, { cwd, ...(params.taskTitle?.trim() || wordsTitle ? {} : { title: defaultSessionTaskTitle(cwd) }) }, { source }));
      // A cut of longer words: Walnut's fast model may name it better, in the background, only
      // while the task still wears the cut.
      if (wordsTitle && wordsTitle !== message.trim()) {
        const id = task.id;
        void import('./task-title-brake.js').then(({ refineShortTitle }) => refineShortTitle(id, wordsTitle, message));
      }
    }
    // One rare follow-up write left: `unread` doesn't ride AddTaskInput. The
    // tier no longer needs one — it rode the create above.
    const wantsUnread = taskMeta?.unread === true;
    if (wantsUnread) {
      await updateTask(task.id, { unread: true }, { source });
    }
    // Common path (no unread): the addTask return IS the final task — skip the
    // whole-store re-read that used to run on every launch.
    updatedTask = wantsUnread ? await getTask(task.id) : task;
  }

  await (await import('../recent-task-touch.js')).recordRecentTaskTouch(updatedTask.id, source, new Date(requestTs).toISOString());

  if (!existingTaskId) {
    // A deferred start says so: no SESSION_START follows this create yet, so a listener that
    // treats a new task as a delivered launch (triage/runs.ts) waits for the real start.
    bus.emit(EventNames.TASK_CREATED, { task: updatedTask, ...(params.deferStart ? { deferredStart: true as const } : {}) }, ['web-ui'], { source });
  }

  // A start targeting a remote host is deliberate (human click or a routine the
  // user configured) — forget any cached connection failure so we reconnect
  // fresh rather than fast-fail.
  if (host) {
    const { clearDaemonFailureCache } = await import('../../providers/daemon-connection.js');
    clearDaemonFailureCache(host);
  }

  // Why this task runs on another engine (the session panel's banner, task_get); a retry that
  // starts on the default engine again takes an older note off. Written before a deferred start
  // returns: its replay runs on the engine decided here. With it, where the launch's engine, model
  // and mode came from (its session's pickers say so).
  const notes: Partial<Pick<Task, 'engine_fallback' | 'launch_source'>> = {
    ...(fallback || (decides && updatedTask.engine_fallback) ? { engine_fallback: fallback?.note ?? null } : {}),
    ...(launchSource ? { launch_source: launchSource } : decides && updatedTask.launch_source ? { launch_source: null } : {}),
  };
  if (Object.keys(notes).length > 0) {
    try {
      const written = await updateTaskRaw(updatedTask.id, notes, { source, emitEvent: true });
      if (written.task) updatedTask = written.task;
    } catch (err) {
      log.web.warn(`${source}: launch notes not written`, { taskId: updatedTask.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (params.deferStart) return updatedTask;

  // Seed the session record BEFORE the spawn when the id is caller-minted.
  //
  // Why this is required, not just nice: returning the id lets the UI mount the
  // real session panel immediately, and that panel's first act is
  // GET /api/sessions/:id. Until the spawn is confirmed (~200ms local, seconds
  // for a cold remote daemon) no record exists, so that GET 404s — and a 404 is
  // treated as "session does not exist" (not a transient error), so the panel
  // would settle permanently into its "Untitled session" empty state. Writing a
  // minimal row up front makes the read succeed from the first frame; the spawn's
  // own persistSessionRecord then fills in pid/outputFile/model (it takes the
  // "row exists" branch and updates in place — same id, so no duplicate).
  //
  // Safe against the orphan sweepers: a pid-less non-terminal row is only reaped
  // after a 2-minute grace period on last_status_change (session-health-monitor's
  // ORPHAN_GRACE_MS), which is far longer than any spawn.
  if (preassignedSessionId && !isAcpEngine(engine)) {
    try {
      const { createSessionRecord } = await import('../session-tracker.js');
      // An EXISTING task keeps its project (the retry branch above never
      // re-files it), so its session record must say the same — not whatever
      // the caller's launch payload carried. Concretely: an Ask Walnut launch
      // on a task-row draft arrives with the ask project ("Ask Walnut") while
      // the task stays where the user filed it.
      await createSessionRecord(preassignedSessionId, updatedTask.id, existingTaskId ? updatedTask.project ?? '' : project, cwd, {
        title: updatedTask.title,
        mode: mode as import('../types.js').SessionMode | undefined,
        host,
        // Ask Walnut: the persona lives on the RECORD so a cold --resume
        // rebuilds it (same contract as a chat lane's record).
        ...(walnutProfile ? { profile: walnutProfile.profile, effort: walnutProfile.effort } : pickedEffort ? { effort: pickedEffort } : {}),
        // No turn has begun (the CLI isn't up yet) — 'running' would show a
        // phantom "working…" badge on a session that hasn't started.
        initialProcessStatus: 'idle',
        // Marks "no pid YET" so the liveness overlay doesn't read the missing pid
        // as a dead process and persist 'stopped' on a session just launched.
        initialStatusReason: 'awaiting_spawn',
      });
      if (cwdByPerson) {
        const { updateSessionRecord } = await import('../session-tracker.js');
        await updateSessionRecord(preassignedSessionId, { cwdByPerson });
      }
    } catch (err) {
      // Non-fatal: the spawn path persists the record too. Worst case the UI's
      // first metadata read 404s and the panel shows its empty state briefly.
      log.web.warn(`${source}: pre-spawn session record seed failed`, {
        sessionId: preassignedSessionId, taskId: updatedTask.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Emit SESSION_START event (sessionMessage includes image path annotations if the caller prepended them)
  bus.emit(EventNames.SESSION_START, {
    taskId: updatedTask.id,
    message: sessionMessage,
    // A person's own words are attributed; the runner frames anything else as Walnut's (send-frame.ts).
    ...(isPersonSource(source) ? { attributed: true as const } : {}),
    // Only when a prefix was actually applied, so the payload every other
    // launcher emits stays byte-identical.
    ...(namingMessage !== sessionMessage ? { namingMessage } : {}),
    ...(params.sessionTitle?.trim() ? { title: params.sessionTitle.trim() } : {}),
    cwd,
    project,
    mode,
    model,
    host,
    largePromptFile,
    requestTs,
    engine,
    // Ask Walnut: the spawn takes the Personal AI profile + chat-tuned effort.
    ...(walnutProfile ? { profile: walnutProfile.profile, effort: walnutProfile.effort } : pickedEffort ? { effort: pickedEffort } : {}),
    // Named even when the profile rode the spawn: an ACP ask has no profile on
    // the wire, and this is what tells the runner to mount Walnut's own tools.
    ...(walnutAgent ? { walnutAgent: true } : {}),
    // ACP (codex) mints its own ids inside the adapter — only forward for native.
    ...(preassignedSessionId && !isAcpEngine(engine) ? { preassignedSessionId } : {}),
  }, ['session-runner'], { source });

  // TEXT-FIRST auto-title: the launch message rides SESSION_START, which the
  // hook dispatcher never maps to onMessageSend — without this kick the task
  // would keep its `Session: <basename>` placeholder until the user's SECOND
  // message. Fire-and-forget (the helper polls for the CLI spawn internally);
  // native engine only — ACP mints its own ids and has no control pipe. The
  // placeholder check here skips callers with a real title (fix-walnut,
  // routines, retries of an already-titled task) without the helper's poll.
  const launchPlaceholder = matchPlaceholderTitle(updatedTask, [cwd]);
  if (preassignedSessionId && !isAcpEngine(engine) && message.trim() && launchPlaceholder) {
    import('../session-hooks/builtins.js')
      .then(({ autoTitleFromLaunch }) => autoTitleFromLaunch(preassignedSessionId, updatedTask.id, message, cwd, launchPlaceholder))
      .catch((err) => log.web.warn(`${source}: launch auto-title failed`, {
        taskId: updatedTask.id, error: err instanceof Error ? err.message : String(err),
      }));
  }

  // AUTO-ORGANIZE: fast-model project placement, replacing the old client-side
  // "[Quick Start] …move the task" wake-up of the Personal AI agent. Only for
  // tasks the caller left unfiled — a caller that supplied a project
  // (fix-walnut, routines) placed the task deliberately; retries were already
  // organized (or deliberately left) on the original launch. Gated off in
  // test servers (real ~/.aws → live Bedrock calls + mid-assertion task moves).
  const { backgroundAiDisabled } = await import('../cheap-model.js');
  if (!existingTaskId && !backgroundAiDisabled() && !callerSuppliedProject) {
    import('../session-organize.js')
      .then(({ organizeQuickStartTask }) => organizeQuickStartTask(updatedTask.id, cwd, message))
      .catch((err) => log.web.warn(`${source}: auto-organize failed`, {
        taskId: updatedTask.id, error: err instanceof Error ? err.message : String(err),
      }));
  }

  log.web.info(`${source}: created task + started session`, {
    taskId: updatedTask.id, cwd, host, project: project || 'Inbox', retry: !!existingTaskId,
    ...(engine ? { engine } : {}),
    // One grep answers "did this ask get its persona, and how" — the ACP carrier
    // is invisible in the record (no profile is stored for it).
    ...(walnutAgent ? { askProfileCarrier: askProfilePrefix ? 'message' : 'profile' } : {}),
  });

  return updatedTask;
}
