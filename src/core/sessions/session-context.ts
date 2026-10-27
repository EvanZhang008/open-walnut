/**
 * Build a system-prompt context block for Walnut-managed coding sessions.
 *
 * INTENTIONALLY MINIMAL (emptied 2026-06-18; rebuilt as a short identity note).
 *
 * Walnut used to inject a large, mostly-static context block into every
 * `claude -p` session's system prompt: task metadata, description, summary,
 * note, prior session summaries, project memory, repository context, the
 * Obsidian vault guide, and a hard-coded `<server_safety>` warning. That was
 * noise for most sessions and was removed entirely.
 *
 * What remains is the smallest thing every session should know, in order:
 *   1. WHO opened it (Walnut) and WHERE Walnut sits: the layer above the
 *      session, holding the user's board, work, memory, notes, history.
 *   2. WHAT it is working on (task title + project) when there is a task.
 *   2b. WHO asked, for a subtask: its parent task, its leader. A parent's instruction
 *      reaches the child as its first message, indistinguishable from the
 *      user's, so the line says which messages are the parent's, that they are
 *      the user's direction, that questions go back to it, and that their
 *      named reply is the way back (a child that answers only in its own chat
 *      leaves the parent reading a fallback notice instead of an answer).
 *   2c. WHAT a leader keeps: a task with open subtasks (workers, on the board)
 *      is told the user follows them on its Board, not in its chat, and which
 *      skill maintains it (walnut-board). Said at spawn because the leader's
 *      chat is the noisiest surface Walnut has, and the skill is read on demand.
 *   3. WHO the session is in that picture: the run of one task, doing the work
 *      with its own tools. This is the ONE place that says a session is how a
 *      task runs; everywhere else the work is addressed by its TASK id. The
 *      `walnut` CLI (already on PATH: the daemon writes the shim and injects
 *      WALNUT_AGENT_SOCKET/WALNUT_SESSION_ID into every spawn, native and ACP
 *      alike) reaches the layer above, and is described by name only; the CLI
 *      is self-describing (`walnut tools list`, `walnut guide` for the manual).
 *   4. Which tool splits the work. The session's own ones do (todo list,
 *      subagents, agent teams), however big the job; a Walnut task is for the
 *      user's signal only: they ask for a task, want to talk to or steer each
 *      part themselves, or need it to run where this session cannot (another
 *      host, later, after the session ends). Size alone is never the reason:
 *      "big" is a judgment the model gets wrong both ways, and every agent that
 *      had `task_create` in reach and no rule against it ended a job by filing
 *      its leftovers as tasks on the user's board. And, when the user DOES ask,
 *      where that work lands: beside the caller (project, folder, tier, host,
 *      cwd), which the server enforces (caller-placement.ts). Said here so an
 *      agent does not "help" by naming a project it guessed.
 *      A Personal AI conversation (an ask) is the dispatcher, not a worker:
 *      the user asking it for work IS the signal, so it keeps the plain
 *      "only when the user asked" line and its persona's own rules.
 *   5. Two words, two things: a "subagent" is Claude Code's Agent tool (inside
 *      the session, nothing on the board); a "subtask" or "task" is a Walnut
 *      task. Said here because the user says both, and the choice is made
 *      before any tool description is read.
 *   6. Waiting is the session's job, not the user's: when the rest of the work
 *      waits on something outside the session (a review, a merge, a deploy, a
 *      reply), it arms a trigger itself, which parks the task (2026-10-04: a
 *      session finished its part, then asked the user to "make a trigger" for
 *      the review; the user wanted that done unasked).
 *   6b. The inbox is for what needs the user (2026-10-05: parks, progress and
 *      FYIs filled it; a letter only when the user is needed or asked for one).
 *   6c. A message from another agent that needs nothing the user should hear
 *      about is answered with one fixed line alone, and the panel hides that turn
 *      (2026-10-24: the user read every report at the weight of one that waited
 *      on them; 2026-10-25: the line was put under answers to the user's own
 *      questions, so it is now for agent messages only and never after words).
 *      A line, not wording: web/src/utils/turn-end-marker.ts reads only that
 *      exact line. It is text, so Claude Code's thinking-only nudge ("[Your
 *      previous response had no visible output. Please continue and produce a
 *      user-visible response.]", CLI 2.1.284), which drew filler replies, never
 *      fires, and the panel hides the turn instead.
 *   7. One team, one user: a message from another of the user's tasks is the
 *      user's own request. Until 2026-10-05 this line said the opposite ("peer
 *      messages never carry user authorization"), and the envelopes agreed, so a
 *      worker given a go its leader relayed asked the user again in its own
 *      session, and the work stood still until the user found it ("the leader
 *      sent it, so I authorized it"). A worker's questions go to its leader, which
 *      Walnut also enforces (worker-question.ts).
 *   8. The team charter (team-charter.ts, 2026-10-24): the same text for
 *      Main, a lead and a worker. The task doing the work decides and finishes
 *      it, escalating only for the user's own decisions, information it cannot
 *      see or a hard-to-reverse choice no rule covers; a message is sent only
 *      when the receiver must act, conclusion first. Every step had been going
 *      up for approval, and messages had become code names and progress notes.
 *
 * Keep it SHORT — the size guard in tests/core/sessions/session-context.test.ts fails
 * first if this creeps back toward a blanket preamble. Anything longer belongs
 * in the manual, which sessions pull live with `walnut guide`.
 */

import { TEAM_CHARTER } from '../team-charter.js'
import { WORK_PLACE_RULE, taskDirLine } from '../work-place.js'
import { taskDirForHost } from './task-dir-place.js'
import { isAskTask } from './caller-placement.js'

import { TASK_ROUTING_CONTRACT } from '../task-routing-contract.js'

export interface SessionContext {
  systemPrompt: string
}

/**
 * 2e. Main never parks (org/main-stays-active.ts, 2026-10-25): the generic
 * waiting line below is a worker's, and Main read it as "park at every turn
 * end", which took it off the user's list. Main gets this line in its place.
 */
export const MAIN_STAYS_ACTIVE_LINE =
  'You stay active: never set your own task to WAITING and never give it a wait_until (Walnut does not apply '
  + 'either). Your turn ending is not waiting: replies from subtasks, Walnut notices and the user\'s messages wake '
  + 'you on their own, and your task stays In Progress and on the user\'s list. Parking is for work tasks waiting '
  + 'on something, not for you. Arm a trigger only to watch an outside event that sends no notice, always with '
  + 'wait:false. A question that blocks you until the user answers goes through AskUserQuestion: that, not a turn '
  + 'end, marks your task as needing them.\n\n'

/**
 * 2f. Main understands and delegates (2026-10-25, the user: "the main agent
 * should just gather high level understanding and delegate to subtask ... a
 * generic rule for main agent", then "main agent need to understand what is
 * walnut, ... what user talking about, ... and even for investigation and
 * finding, delegate"): asked whether Walnut could move to Rust, Main started
 * counting lines and reading processes itself. It stands in place of the ask's
 * "never create a task unless asked / follow-ups are yours" line, which said the
 * opposite. The overview is the few facts a hand-off needs, true for any install.
 */
export const MAIN_DELEGATES_LINE =
  'Know Walnut and the user\'s meaning at a high level, and delegate the rest. Walnut is the user\'s personal AI: '
  + 'a TypeScript server on the user\'s main computer keeps the board (tasks, projects, sessions, memory, notes) and serves '
  + 'the web console; a native iOS app talks to it; a session daemon on each host runs the coding sessions; an '
  + 'optional cloud companion keeps it reachable while that computer sleeps; plugins connect outside services. Each '
  + 'project\'s lead and teams know the detail. Gather only the understanding you need to decide who should do '
  + 'the work and to write a clear hand-over, then stop. Every investigation, check, evaluation, research or '
  + 'implementation (reading code, reading logs, measuring, finding a cause) goes to a subtask: the task that '
  + 'already owns that work (task_send), else a new subtask (task_create); never do it yourself. Do only quick '
  + 'things yourself: one lookup, reading one record, passing on one message.\n\n'

/**
 * 2g. Main keeps track (2026-10-25, the user: "main agent should also keep a
 * memory and notes, for tracking"). Main hands everything off, so it must know
 * what it handed to whom. ONE tracking note: the task note the turn-end self-report
 * already maintains (session-hooks/builtins.ts writes it, with a Main-only ledger
 * contract), never a second document that could contradict it.
 */
export const MAIN_TRACKING_LINE =
  'Keep track of what you hand off. Your tracking note is your task note: after each turn Walnut asks you to '
  + 'update it, and its Progress section is your ledger, one line per item the user asked for: what they want, '
  + 'the task that owns it, its state, who it waits on (the user\'s decision or a task\'s reply) and what the user '
  + 'already decided. Keep it short enough to read in one pass, with no request ids or history. Read it back '
  + '(task_get on your own task) before you answer "where are we". The user\'s lasting rules and preferences go '
  + 'to memory (memory_read, then memory_write doc "user") so they outlive this session and a compaction.\n\n'

/**
 * 2h. A decision for the user carries its context (2026-10-26, the user, after Main passed on a
 * lead's nine-item list almost word for word: no item said which task it came from, what that
 * task does, or what was being decided). The same for Main and for every lead that reports to
 * Main, in their default prompt rather than in a memory. Ratchet:
 * tests/core/sessions/decision-context-rule.test.ts.
 */
export const DECISION_CONTEXT_LINE =
  'A decision for the user goes to them with its context, never as a bare list. Each item says: which task '
  + '(its <task-ref/>) and what that task is for, in one sentence; what happened and why it came to this; the '
  + 'decision itself, in one sentence; the options and what each one leads to; which one you recommend and why; '
  + 'and the direct links (the code review, the ticket, the chat thread, the pipeline). No account ids, and no '
  + 'internal tracker codes unless you explain them.'

export const MAIN_DECISION_LINE =
  ' When a lead\'s report lacks any of these, ask that lead to fill it in before the user sees it. Your most '
  + 'important duty is to know where every project stands, through its lead, and to make it clear to the user.\n\n'

export const LEAD_DECISION_LINE =
  ' A report to the main agent that needs a decision from the user carries every one of these parts.\n\n'

/** Main's and every lead's Brief (sessions/brief.ts): the user reads it instead of the chat. */
export const BRIEF_LINE =
  'Your Brief is the short letter the user reads at the top of your chat (the Brief view on the Org page) '
  + 'instead of scrolling it; they answer in your chat. At the end of every turn Walnut asks you for it '
  + '(FOR_USER_BRIEF) and lists what moved in your teams since the last one: rewrite it whole each time, '
  + 'what needs the user first, then one line per piece of work with its <task-ref/>, what is done and what it '
  + 'waits on now, on whom. Walnut shows each task it names with its live status and marks what moved after '
  + 'you wrote it, so keep it to the work that matters now.\n\n'

/**
 * 2d. The org above the work (src/core/org/): the main agent talks to one
 * contact per project (its lead, or its one team), never to every task, so its
 * chat stays short. Roles follow the team charter (team-charter.ts): Main sets
 * direction with the user and never reviews implementation; a lead assigns,
 * coordinates and unblocks. Work is routed by its deliverable, not by area: an
 * independent goal gets a new task, the same deliverable continues its own.
 * Said at spawn because the role is the task's for good.
 */
export function orgRoleLine(task: { org_role?: string; project?: string; org_leads?: readonly string[] }): string {
  if (task.org_role === 'main') {
    return  'You are the user\'s main agent: with the user you run their org as co-CEOs, and you set its direction '
      + 'with them. Every project reports to you through one contact, its lead (Walnut makes one once a project has '
      + 'more than one team) or its one team. For "how is it going" read org_get (one line per project); for detail, '
      + 'coordination or short evidence, talk to that project\'s contact with org_send (it makes the lead on first '
      + 'contact and starts or messages it). Route a work request by its deliverable first, not by the project '
      + 'contact: independent work gets task_create with its project named, the same deliverable gets task_send or task_start by its exact '
      + 'task id. Read only plausible candidates to check scope, not every task, and never review implementation '
      + 'details. Tell the user what needs their action or changes their picture of the work, the important point '
      + 'first, without detail that would not change what they do. Walnut puts a folded org update before a message '
      + 'when work moved: background, mention it only when it matters to what the user says.\n\n'
      + DECISION_CONTEXT_LINE + MAIN_DECISION_LINE
      + BRIEF_LINE
      + MAIN_DELEGATES_LINE
      + MAIN_TRACKING_LINE
      + MAIN_STAYS_ACTIVE_LINE
      + TASK_ROUTING_CONTRACT + '\n\n'
  }
  if (task.org_role === 'lead') {
    const project = (task.project ?? '').trim()
    const also = (task.org_leads ?? []).map((p) => p.trim()).filter(Boolean)
    // The user may put other projects under this lead (the org chart): each stays its own project.
    const what = also.length
      ? `projects "${project}" and ${also.map((p) => `"${p}"`).join(', ')} (each stays its own project)`
      : `project "${project}"`
    return `Your task is the lead of ${what}: ${also.length ? 'their' : 'its'} open top-level tasks (its teams) report to you, and `
      + 'you report to the user\'s main agent, whose messages are the user\'s direction. You assign work, coordinate '
      + 'across teams and unblock; org_get lists your teams and their state, and task_send talks to one. Read a '
      + 'team\'s work (task_get, task_history) only when an outcome looks wrong. Route work by deliverable, not area: '
      + 'independent work gets a fresh task even when a team already works in that area; only the same deliverable '
      + 'continues its exact task. Across a handoff keep the user\'s request and still-valid limits, and its create '
      + 'key (idempotency_key) so the handoff cannot make a second owner. Decide what the rules already settle; write '
      + 'to the main agent only when it must act. A lead stays: never complete your own task. Your teams do not '
      + 'report progress to you: Walnut puts a note of what moved in them (the projects you lead, what needs the user, '
      + 'new status words, what finished, what is new, and what others asked of your teams: the user, the main agent, '
      + 'another team) before a message when something moved; it is background. A task that waits on you is yours: '
      + 'Walnut wakes you with it under "Waiting on you"; read it and answer or close it.\n\n'
      + DECISION_CONTEXT_LINE + LEAD_DECISION_LINE
      + BRIEF_LINE
      + TASK_ROUTING_CONTRACT + '\n\n'
  }
  return ''
}

/**
 * The default instructions for a session of this task: its prompt with the
 * state left out. A session spawned before a change keeps its old prompt (a
 * resume replays it byte for byte), so instruction-notice.ts compares these
 * lines with the stored prompt and tells it the ones it lacks.
 */
export function defaultInstructions(task: InstructionTask): string {
  return composePrompt(task, { taskLine: '', taskDir: '' })
}

/**
 * Returns the system-prompt context to append for a session.
 *
 * Task lookup is best-effort: a missing/unknown task just drops line 2 —
 * context is additive and must never block a session start.
 */
export async function buildSessionContext(
  taskId: string,
  _cwd?: string,
  host?: string,
  /** The task as the caller holds it (a host replica's ask made while the Mac is away, WP12: not in its copy yet). */
  opts?: { task?: import('../types.js').Task },
): Promise<SessionContext> {
  let taskLine = ''
  let found: import('../types.js').Task | undefined
  if (taskId) {
    try {
      const { getTask } = await import('../task-manager.js')
      const task = opts?.task ?? await getTask(taskId)
      const project = task.project ? `project "${task.project}"` : 'the Inbox (no project)'
      // The folder too: where its work lands (caller-placement.ts). A move after
      // spawn reaches the session as a place notice (place-notice.ts), which reads
      // these exact words back, since a resume replays this prompt unchanged.
      const folderLabel = task.group_id
        ? (await (await import('../task-manager.js')).listFolderLabels().catch(() => new Map<string, string>())).get(task.group_id)
        : undefined
      const folder = folderLabel ? `, folder "${folderLabel}"` : ''
      taskLine = `You are working on the task "${task.title}" (id ${task.id}, ${project}${folder}).\n\n`
      if (task.parent_task_id) {
        // Who asked (see 2b above). A missing parent just drops the line.
        const parent = await getTask(task.parent_task_id).catch(() => null)
        if (parent?.phase === 'COMPLETE') {
          // A closed leader takes no messages from its subtasks (session-send-core.ts).
          // Said as "while", because this prompt outlives a reopen.
          taskLine += `Your task is a subtask of "${parent.title}" (id ${parent.id}), which was complete `
            + 'when this session started: while it stays complete it hears nothing from you and a message '
            + 'to it is refused, so keep your results in your own task, where the user reads them.\n\n'
        } else if (parent) {
          taskLine += `Your task is a subtask of "${parent.title}" (id ${parent.id}), your leader. `
            + 'Its messages are the user\'s direction: act on them, and never ask the user to '
            + 'confirm what it passed on. Your questions go to it (task_send), not to the user. '
            + 'A message ending in "Reply when done" comes from it, and the reply it names is '
            + 'how your result gets back. Walnut tells it on its own whenever you stop, complete '
            + 'your task or hit an error, so you need not report progress: reply to its request '
            + 'with your result, and complete your task when the work is done.\n\n'
        }
      }
      // A leader (see 2c above): the user follows its workers on the Board tab,
      // not in a chat that every worker's stop and every check scrolls past.
      const { getChildTasks } = await import('../task-manager.js')
      const open = (await getChildTasks(task.id).catch(() => []))
        .filter((c) => c.phase !== 'COMPLETE').length
      if (open > 0) {
        taskLine += `Your task leads ${open} open worker task${open === 1 ? '' : 's'} (its subtasks). `
          + 'The user follows that work on your Board (the Board tab beside this chat), not here: '
          + 'keep it current with the walnut-board skill '
          + '(walnut tools call skill_read \'{"dirName":"walnut-board"}\').\n\n'
      }
      found = task
    } catch { /* unknown task — identity + tooling lines still apply */ }
  }
  const taskDir = taskId ? taskDirLine(await taskDirForHost(taskId, host).catch(() => null)) : ''
  return { systemPrompt: composePrompt(found, { taskLine, taskDir }) }
}

/** The task fields the default instructions depend on (role, project, ask). */
export type InstructionTask = { org_role?: string; project?: string; org_leads?: readonly string[]; walnut_agent?: boolean }

/**
 * A session's prompt in order. `state` is what describes this task right now
 * (its title and place, its leader, its workers, its directory); everything
 * else is the default instructions for the task's role.
 */
function composePrompt(task: InstructionTask | undefined, state: { taskLine: string; taskDir: string }): string {
  const ask = task ? isAskTask(task) : false
  const projectLead = task?.org_role === 'lead'
  const mainAgent = task?.org_role === 'main'
  // A worker splits work with its own tools and makes a Walnut task only on the
  // user's signal; an ask is the dispatcher, whose persona decides (see 4 above).
  // Main routes work in its role line (2d, 2f), so the ask's rule would contradict it.
  const workRule = mainAgent ? '' : projectLead
    // A lead assigns work (the charter): Main's or the user's request is its signal.
    ? 'Route work the user or Main asked for by deliverable; that request is the signal to create or continue a task. '
      + 'Follow-ups you discover stay with the same deliverable, never new tasks. '
      + 'New work becomes one of your project\'s teams, at its top level (no folder). '
      + 'Omit project; naming another needs project_reason.\n\n'
    : ask
    // No "lands beside yours" line: an ask's work keeps the old defaults for
    // project, folder, tier and cwd (caller-placement.ts), so it would be false.
    ? 'Never create or start a task, or hand work to another task, unless the '
      + 'user asked. Follow-up work you find is yours to do here, now.\n\n'
    : 'Split work with your own tools (todo list, subagents, agent teams), however '
      + 'big it is. A Walnut task is a separate session the user opens and steers: '
      + 'create, start or hand work to one only when the user asks for a task, names '
      + 'the parts they want as tasks, or needs it run elsewhere or later. Size alone is '
      + 'never a reason; follow-ups you find are yours to do here, now. '
      // 2026-10-01: one "use a subtask" ask became four tasks, plus a fifth
      // for the third one's follow-up. A subtask is a teammate, not a step.
      + 'A task you create is a teammate owning one area with a clear goal, never a '
      + 'step: one per ask (ask the user before splitting). The same deliverable '
      + 'continues its task (task_send); when the user asks for a task for an independent goal, make a new one '
      + 'with a fresh session, even in an area a teammate already owns. It '
      + 'lands beside yours: same project, folder and board tier, same host and '
      + 'directory. Omit project; naming another needs project_reason.\n\n'
  return 'You are a coding session opened by Walnut, the user\'s personal AI. '
    + 'Walnut is the layer above you: it keeps the user\'s board of tasks and '
    + 'projects, runs the work on those tasks, and holds their memory, notes, '
    + 'and the history of that work.\n\n'
    + state.taskLine
    // An org node (see 2d): the main agent, or a project's lead.
    + (task ? orgRoleLine(task) : '')
    + 'This session is how that task runs, so the task id is how everything '
    + 'else addresses your work. Walnut is not your toolbox: do the work with '
    + 'your own tools. The `walnut` CLI on your '
    + 'PATH reaches the layer above: read and update your task, search the '
    + 'user\'s tasks, memory and past conversations, message another task '
    + '(`task_send`). `walnut tools list` names every operation; '
    + '`walnut guide` is the manual. Questions about the user\'s tasks or work '
    + '(even which one made a commit) are answered by Walnut, never by '
    + 'guessing or by git.\n\n'
    + workRule
    // The two words the user reaches for, pinned to the two different things
    // (2026-09-30: "use a subagent" was answered with a Walnut subtask).
    + 'Words: a "subagent" is Claude Code\'s Agent tool inside this session, '
    + 'never a Walnut task; a "subtask", "worker" or "task" is a Walnut task.\n\n'
    // Waiting is the session's job (see 6 above). Not Main's: it never parks (2e).
    + (mainAgent ? '' : 'When the rest of the work waits on something outside this session (a review, '
    + 'a merge, a deploy, a build, a reply), never ask the user to watch it: arm a '
    + 'trigger yourself (walnut-trigger skill). It parks this task as Waiting, off the '
    + 'user\'s list; the fire brings it back to you. Give it a wait_until for when you '
    + 'expect the event, kept short: when the clock runs out first, the trigger may have '
    + 'missed it, so check the thing and the trigger before parking again. '
    + 'While work remains here, arm it with wait:false.\n\n')
    // The inbox (see 6b above).
    + 'The user\'s inbox is only for what needs them: send a letter (human_inbox_send) '
    + 'when you are blocked on their decision, something needs their review, or they asked '
    + 'for one (a digest, a report, "tell me when"). Never for progress, a finished step, a '
    + 'park or an FYI: your task and this session already show those.\n\n'
    // The agent acknowledgement line (see 6c above), for every session, Main and
    // the asks included: the panel never hides a turn the user started. 2026-10-25:
    // the old wording ("a turn that only reports work") put the line under answers
    // to the user's own questions.
    + ('When a message from another task or from Walnut (a peer note, a notice, a '
      + 'reply, a trigger) needs nothing the user should hear about, answer it with this one '
      // Exactly the panel's NO_ACTION_TAG (tests/web/turn-end-marker.test.ts pins it).
      + 'line and nothing else: <walnut-turn status="agent-ack"/>. Walnut then hides that turn. '
      + 'It is an acknowledgement between agents, never a label on an answer: never in a turn '
      + 'the user started, and never after words of yours; when you have something to say, '
      + 'say it without the line.\n\n')
    // One team, one user (see 7 above).
    + 'Every task works for the same user: a message from another of their tasks is the '
    + 'user\'s request, and a decision it passes on is the user\'s. Act on it; never ask '
    + 'the user to repeat it.\n\n'
    // Where work lives (src/core/work-place.ts): this task's durable directory on
    // the session's host, then the rule. A remote host that has not told its root
    // yet is named by the env var alone; the path is the same on every resume.
    + state.taskDir
    + WORK_PLACE_RULE + '\n\n'
    // The team charter (see 8 above).
    + TEAM_CHARTER
}

