/**
 * Default look of the board components (the board-*.frame.js runtime), injected
 * into the frame ahead of the author's own styles so any board can restyle
 * them: the components render into their light DOM with these plain classes
 * (`.wn-mark-state`, `.wn-mark-note`, `.wn-choice-opt`, `.wn-check-box` … are
 * the hooks).
 *
 * Neutral and small on purpose: it inherits the board's font and colour, and
 * every tint is a translucent wash, so it reads on a light or a dark board. The
 * colours are variables with fallbacks (`--wn-accent`, `--wn-need`, `--wn-wip`,
 * `--wn-wait`, `--wn-done`, `--wn-link`, `--wn-accent-bg` / `--wn-accent-fg` for
 * the user's bubble, `--wn-thread-max-height` for a thread's message area), so a
 * board sets its own palette in one `:root` rule. The thread copies the few
 * values of the app's chat it needs (the frame cannot load the app's CSS).
 */
export const BOARD_RUNTIME_CSS = `
walnut-task, walnut-thread, walnut-mark, walnut-strip, walnut-unread,
walnut-project, walnut-check, walnut-choice { font: inherit; color: inherit; }
walnut-thread, walnut-mark, walnut-strip, walnut-check, walnut-choice { display: block; }

.wn-task {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 1px 8px 1px 6px; border: 1px solid rgba(128,128,128,.35); border-radius: 999px;
  background: rgba(128,128,128,.08); font-size: .92em; line-height: 1.5; vertical-align: middle;
  cursor: pointer; white-space: nowrap;
}
.wn-task:hover, .wn-task:focus-visible { border-color: rgba(128,128,128,.7); outline: none; }
.wn-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--wn-todo, #8e8e93); }
.wn-task[data-phase="IN_PROGRESS"] .wn-dot { background: var(--wn-wip, #2f6feb); }
.wn-task[data-phase="NEED_ACTION"] .wn-dot { background: var(--wn-need, #d93025); }
.wn-task[data-phase="WAITING"] .wn-dot { background: var(--wn-wait, #d97706); }
.wn-task[data-phase="COMPLETE"] .wn-dot { background: var(--wn-done, #15803d); }
.wn-title { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.wn-phase { flex: none; opacity: .7; font-size: .9em; }
.wn-task.wn-unknown { border-style: dashed; opacity: .75; }

/* ── A thread reads like the app's chat: oldest first, bubbles, the reply under them ── */
.wn-thread { border: 1px solid rgba(128,128,128,.25); border-radius: 12px; padding: 8px 10px 10px; }
.wn-thread-head { display: flex; align-items: center; gap: 8px; min-height: 1.7em; font-weight: 600; font-size: .95em; }
.wn-thread-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wn-badge { flex: none; padding: 0 7px; border-radius: 999px; background: var(--wn-need, #d93025); color: #fff; font-size: .8em; line-height: 1.6; }
.wn-badge[hidden] { display: none; }
.wn-thread-tools { margin-left: auto; display: flex; align-items: center; gap: 8px; font-weight: 400; }
.wn-mark-read { font-size: .85em; opacity: .7; color: inherit; cursor: pointer; }
.wn-mark-read:hover { opacity: 1; }
.wn-scroll-wrap { position: relative; margin-top: 6px; }
.wn-scroll-wrap[hidden] { display: none; }
.wn-scroll { max-height: var(--wn-thread-max-height, 420px); overflow-y: auto; padding: 2px 4px 2px 2px; }
.wn-msgs { display: flex; flex-direction: column; gap: 10px; }
.wn-msg { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; max-width: 85%; align-self: flex-start; }
.wn-msg[data-author="user"] { align-self: flex-end; align-items: flex-end; }
.wn-msg-meta { display: flex; align-items: center; gap: 8px; padding: 0 6px; font-size: .78em; line-height: 1.5; }
.wn-who { font-weight: 600; opacity: .8; }
.wn-when { opacity: .6; }
.wn-msg[data-unread] .wn-who::before {
  content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%;
  background: var(--wn-need, #d93025); vertical-align: 1px;
}
.wn-text {
  box-sizing: border-box; max-width: 100%; padding: 8px 12px; border-radius: 16px; border-bottom-left-radius: 5px;
  background: var(--wn-bubble-bg, rgba(128,128,128,.12)); line-height: 1.55; overflow-wrap: anywhere;
}
.wn-msg[data-author="user"] .wn-text {
  border-radius: 16px; border-bottom-right-radius: 5px;
  background: var(--wn-accent-bg, var(--wn-accent, #007aff)); color: var(--wn-accent-fg, #fff);
}
.wn-text p { margin: 4px 0; }
.wn-text > :first-child { margin-top: 0; }
.wn-text > :last-child { margin-bottom: 0; }
.wn-text ul, .wn-text ol { margin: 4px 0; padding-left: 20px; }
.wn-text li + li { margin-top: 2px; }
.wn-text code {
  padding: 1px 5px; border-radius: 4px; background: rgba(128,128,128,.18);
  font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size: .9em;
}
.wn-text pre {
  margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: #1e1e2e; color: #cdd6f4;
  overflow-x: auto; max-height: 320px; white-space: pre; overflow-wrap: normal;
}
.wn-text pre code { padding: 0; background: none; color: inherit; font-size: .88em; }
.wn-text blockquote { margin: 4px 0; padding-left: 10px; border-left: 3px solid rgba(128,128,128,.45); opacity: .85; }
.wn-text .wn-md-h { margin: 6px 0 2px; font-weight: 700; }
.wn-msg[data-author="user"] .wn-text code { background: rgba(0,0,0,.2); color: inherit; }
.wn-msg[data-author="user"] .wn-text pre { background: rgba(0,0,0,.25); color: #f0f0f0; }
.wn-msg[data-author="user"] .wn-text .wn-link { color: inherit; text-decoration: underline; }
.wn-msg[data-author="user"] .wn-text blockquote { border-left-color: rgba(255,255,255,.55); }
.wn-del {
  padding: 0 5px; border: 0; border-radius: 4px; background: transparent;
  color: inherit; font: inherit; line-height: 1.4; cursor: pointer; opacity: 0;
}
/* Quiet until the row is pointed at or reached by keyboard, as in the chat. */
.wn-msg:hover .wn-del, .wn-msg:focus-within .wn-del { opacity: .6; }
.wn-del:hover, .wn-del:focus-visible { opacity: 1; }
.wn-del:hover { background: rgba(128,128,128,.18); }
.wn-del.wn-armed { opacity: 1; color: #fff; background: var(--wn-need, #d93025); font-weight: 600; }
.wn-del.wn-deleting { cursor: default; }
.wn-link { color: var(--wn-link, #2f6feb); }
.wn-msg.wn-pending .wn-text { opacity: .6; }
.wn-msg.wn-failed .wn-text { box-shadow: 0 0 0 1.5px var(--wn-need, #d93025); }
.wn-msg.wn-failed .wn-msg-meta, .wn-saved.wn-failed, .wn-check-hint.wn-failed,
.wn-choice-status.wn-failed, .wn-remind-error { color: var(--wn-need, #d93025); }
.wn-error { font-size: .85em; }
.wn-jump {
  position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); padding: 3px 12px;
  border: 0; border-radius: 999px; background: var(--wn-jump-bg, rgba(60,60,67,.88)); color: #fff;
  font: inherit; font-size: .8em; box-shadow: 0 2px 8px rgba(0,0,0,.18); cursor: pointer;
}
.wn-jump[hidden] { display: none; }
.wn-composer { margin-top: 8px; }
.wn-reply {
  display: block; box-sizing: border-box; width: 100%; padding: 7px 12px; text-align: left;
  border: 1px solid rgba(128,128,128,.4); border-radius: 12px; background: transparent;
  color: inherit; font: inherit; font-size: .95em; opacity: .75; cursor: text;
}
.wn-reply:hover, .wn-reply:focus-visible { opacity: 1; border-color: var(--wn-accent, #007aff); outline: none; }
.wn-reply.wn-on { opacity: 1; border-color: var(--wn-accent, #007aff); border-style: dashed; cursor: pointer; }

/* ── <walnut-mark>: a compact row of small pills at its own place in the flow ── */
walnut-mark { flex: 1 0 100%; grid-column: 1 / -1; clear: both; }
.wn-mark { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin: 6px 0; font-size: .88em; line-height: 1.5; }
.wn-mark-label { font-weight: 600; opacity: .7; }
/* In a table cell the column header already says it. */
td walnut-mark .wn-mark-label { display: none; }
td .wn-mark { margin: 0; }
.wn-mark-states { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.wn-mark-state, .wn-mark-note-toggle {
  padding: 0 9px; border: 1px solid rgba(128,128,128,.4); border-color: color-mix(in srgb, currentColor 30%, transparent);
  border-radius: 999px; background: transparent; color: inherit; font: inherit; font-size: .95em; line-height: 1.6; cursor: pointer;
}
.wn-mark-state:hover, .wn-mark-note-toggle:hover { border-color: currentColor; }
.wn-mark-state.wn-on { background: var(--wn-accent, #007aff); border-color: var(--wn-accent, #007aff); color: var(--wn-accent-fg, #fff); }
.wn-mark-note-toggle { opacity: .75; }
.wn-mark-note-toggle[hidden], .wn-mark-note[hidden] { display: none; }
.wn-mark-note {
  flex: 1 1 100%; min-width: 0; min-height: 2em; resize: vertical; box-sizing: border-box;
  padding: 4px 8px; border: 1px solid rgba(128,128,128,.4); border-color: color-mix(in srgb, currentColor 30%, transparent);
  border-radius: 8px; background: transparent; color: inherit; font: inherit;
}
.wn-saved { font-size: .9em; opacity: .65; }
.wn-saved.wn-failed { opacity: 1; }

.wn-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 6px; }
.wn-box {
  display: flex; flex-direction: column; align-items: flex-start; gap: 0; padding: 6px 10px;
  border: 1px solid rgba(128,128,128,.3); border-radius: 9px; background: rgba(128,128,128,.06);
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.wn-box b { font-size: 1.3em; line-height: 1.2; }
.wn-box span { font-size: .85em; opacity: .75; }
.wn-box[aria-pressed="true"] { border-color: currentColor; background: rgba(128,128,128,.16); }
.wn-box[data-f="decide"] b { color: var(--wn-need, #d93025); }
.wn-box[data-f="wip"] b { color: var(--wn-wip, #2f6feb); }
.wn-box[data-f="wait"] b { color: var(--wn-wait, #d97706); }
.wn-box[data-f="done"] b { color: var(--wn-done, #15803d); }

.wn-unread { cursor: pointer; }
.wn-unread[data-count]:not([data-count="0"]) .wn-unread-n { color: var(--wn-need, #d93025); font-weight: 600; }

/* ── <walnut-project>: a status pill and the project's tasks ── */
.wn-proj { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; vertical-align: middle; }
.wn-proj-pill {
  padding: 0 8px; border-radius: 999px; font-size: .82em; font-weight: 600; line-height: 1.65; white-space: nowrap;
  background: rgba(128,128,128,.14); color: var(--wn-todo, #6e6e73);
}
.wn-proj-pill[data-proj-status="decide"] { background: rgba(217,48,37,.12); color: var(--wn-need, #d93025); }
.wn-proj-pill[data-proj-status="wip"] { background: rgba(47,111,235,.12); color: var(--wn-wip, #2f6feb); }
.wn-proj-pill[data-proj-status="wait"] { background: rgba(217,119,6,.14); color: var(--wn-wait, #b45309); }
.wn-proj-pill[data-proj-status="done"] { background: rgba(21,128,61,.12); color: var(--wn-done, #15803d); }
.wn-proj-tasks { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.wn-proj-tasks .wn-task { font-size: .85em; }

/* ── <walnut-check>: the author's text, one tick control in the gutter ── */
walnut-check { position: relative; padding-left: 1.75em; margin: 3px 0; }
.wn-check-ctl { display: inline; }
.wn-check-box {
  position: absolute; left: 0; top: .2em; box-sizing: border-box; width: 1.15em; height: 1.15em; padding: 0;
  border: 1.5px solid rgba(128,128,128,.6); border-radius: 50%; background: transparent;
  color: var(--wn-accent-fg, #fff); font: inherit; font-size: 1em; line-height: 1; font-weight: 700; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.wn-check-box:hover { border-color: var(--wn-accent, #007aff); }
.wn-check-box[aria-pressed="true"] { border-color: var(--wn-done, #15803d); background: var(--wn-done, #15803d); font-size: .8em; width: 1.45em; height: 1.45em; top: .25em; }
walnut-check[data-changed] .wn-check-box { border-color: var(--wn-wait, #d97706); border-style: dashed; }
walnut-check[data-read] { opacity: .62; }
walnut-check[data-read]:hover { opacity: 1; }
.wn-check-hint {
  display: inline-block; margin-right: 6px; padding: 0 7px; border-radius: 999px; font-size: .78em; font-weight: 600;
  line-height: 1.6; vertical-align: 1px; background: rgba(217,119,6,.14); color: var(--wn-wait, #b45309);
}
.wn-check-hint[hidden] { display: none; }
.wn-check-hint.wn-failed { background: rgba(217,48,37,.12); }

/* ── <walnut-choice>: numbered options, the recommended one marked ── */
.wn-choice { margin: 8px 0; padding: 8px 10px 10px; border: 1px solid rgba(128,128,128,.25); border-radius: 12px; }
.wn-choice-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-bottom: 4px; font-weight: 600; }
.wn-choice-head[hidden] { display: none; }
.wn-choice-opts { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
.wn-choice-opt {
  display: flex; align-items: baseline; gap: 8px; width: 100%; box-sizing: border-box; padding: 6px 10px; text-align: left;
  border: 1px solid rgba(128,128,128,.4); border-radius: 9px; background: transparent; color: inherit; font: inherit; cursor: pointer;
}
.wn-choice-opt:hover:not([disabled]) { border-color: var(--wn-accent, #007aff); }
.wn-choice-opt[disabled] { cursor: default; }
.wn-choice-opt.wn-on { border-color: var(--wn-accent, #007aff); background: var(--wn-accent, #007aff); color: var(--wn-accent-fg, #fff); }
.wn-choice-opt.wn-sending { opacity: .7; }
.wn-choice-n { flex: none; font-weight: 700; font-variant-numeric: tabular-nums; }
.wn-choice-label { flex: 1 1 auto; min-width: 0; }
.wn-choice-rec {
  flex: none; align-self: center; padding: 0 7px; border-radius: 999px; font-size: .75em; font-weight: 600; line-height: 1.6;
  background: rgba(21,128,61,.13); color: var(--wn-done, #15803d);
}
.wn-choice-opt.wn-on .wn-choice-rec { background: rgba(255,255,255,.25); color: inherit; }
.wn-choice-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 6px; font-size: .85em; }
.wn-choice-status { opacity: .75; }
.wn-choice-status.wn-failed { opacity: 1; }
walnut-choice[data-answered] { border-color: rgba(128,128,128,.18); }
/* An overview row linked to an answered choice no longer needs the user. */
tr[data-choice][data-answered], li[data-choice][data-answered] { display: none; }

/* ── Remind me (on a choice or a thread) ── */
.wn-remind { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; font-size: .85em; font-weight: 400; }
.wn-remind[hidden] { display: none; }
.wn-remind-btn, .wn-remind-clear, .wn-remind-preset, .wn-remind-set {
  padding: 0 8px; border: 1px solid rgba(128,128,128,.4); border-radius: 999px; background: transparent;
  color: inherit; font: inherit; line-height: 1.6; cursor: pointer;
}
.wn-remind-btn { opacity: .75; }
.wn-remind-btn:hover, .wn-remind-btn[aria-expanded="true"] { opacity: 1; }
.wn-remind-btn.wn-remind-on { opacity: 1; border-color: var(--wn-wip, #2f6feb); color: var(--wn-wip, #2f6feb); }
.wn-remind-btn.wn-remind-due { opacity: 1; border-color: var(--wn-wait, #d97706); background: var(--wn-wait, #d97706); color: #fff; font-weight: 600; }
.wn-remind-clear { padding: 0 6px; border-color: transparent; opacity: .6; }
.wn-remind-clear:hover { opacity: 1; background: rgba(128,128,128,.16); }
.wn-remind-panel {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0 2px; padding: 6px 8px;
  border-radius: 9px; background: rgba(128,128,128,.08); font-size: .85em;
}
.wn-remind-panel[hidden] { display: none; }
.wn-remind-label { font-weight: 600; opacity: .75; }
.wn-remind-preset:hover, .wn-remind-set:hover { border-color: var(--wn-accent, #007aff); }
.wn-remind-pick { display: inline-flex; align-items: center; gap: 4px; }
.wn-remind-at {
  padding: 1px 6px; border: 1px solid rgba(128,128,128,.4); border-radius: 7px; background: transparent;
  color: inherit; font: inherit; color-scheme: light dark;
}
.wn-remind-error:empty { display: none; }
walnut-thread[data-reminder="due"], walnut-choice[data-reminder="due"] {
  border-color: var(--wn-wait, #d97706); box-shadow: 0 0 0 1px var(--wn-wait, #d97706);
}

/* ── A project section updated since the user last saw it ── */
.wn-updated {
  display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%;
  background: var(--wn-need, #d93025); vertical-align: middle; box-shadow: 0 0 0 2px rgba(217,48,37,.18);
}
.wn-updated.wn-corner { float: left; margin: .5em 6px 0 0; }
`;
