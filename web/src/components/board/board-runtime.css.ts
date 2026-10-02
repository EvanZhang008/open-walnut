/**
 * Default look of the board components (board-runtime.frame.js), injected into
 * the frame ahead of the author's own styles so any board can restyle them: the
 * components render into their light DOM with these plain classes.
 *
 * Neutral and small on purpose: it inherits the board's font and colour, and
 * every tint is a translucent wash, so it reads on a light or a dark board. The
 * phase colours are variables with fallbacks (`--wn-todo` …), so a board can
 * set its own palette in one `:root` rule.
 */
export const BOARD_RUNTIME_CSS = `
walnut-task, walnut-thread, walnut-mark, walnut-strip, walnut-unread { font: inherit; color: inherit; }
walnut-thread, walnut-mark, walnut-strip { display: block; }

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

.wn-thread { border: 1px solid rgba(128,128,128,.25); border-radius: 10px; padding: 8px 10px; }
.wn-thread-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: .95em; }
.wn-thread-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wn-badge { flex: none; padding: 0 7px; border-radius: 999px; background: var(--wn-need, #d93025); color: #fff; font-size: .8em; line-height: 1.6; }
.wn-badge[hidden] { display: none; }
.wn-mark-read { margin-left: auto; font-weight: 400; font-size: .85em; opacity: .7; color: inherit; cursor: pointer; }
.wn-mark-read:hover { opacity: 1; }
.wn-composer { display: flex; gap: 6px; align-items: flex-end; margin: 6px 0; }
.wn-input {
  flex: 1 1 auto; min-width: 0; min-height: 2.4em; resize: vertical; box-sizing: border-box;
  padding: 5px 8px; border: 1px solid rgba(128,128,128,.4); border-radius: 8px;
  background: transparent; color: inherit; font: inherit; font-size: .95em;
}
.wn-send, .wn-retry {
  flex: none; padding: 4px 12px; border: 1px solid rgba(128,128,128,.45); border-radius: 8px;
  background: rgba(128,128,128,.1); color: inherit; font: inherit; font-size: .9em; cursor: pointer;
}
.wn-send:hover { background: rgba(128,128,128,.2); }
.wn-msgs { display: flex; flex-direction: column; gap: 6px; }
.wn-msg { max-width: 88%; align-self: flex-start; padding: 5px 9px; border-radius: 9px; background: rgba(128,128,128,.09); font-size: .95em; }
.wn-msg[data-author="user"] { align-self: flex-end; background: var(--wn-accent-bg, rgba(47,111,235,.12)); }
.wn-msg[data-unread] { box-shadow: inset 3px 0 0 var(--wn-need, #d93025); }
.wn-msg-meta { display: flex; gap: 8px; font-size: .8em; opacity: .7; }
.wn-who { font-weight: 600; }
.wn-text { overflow-wrap: anywhere; }
.wn-link { color: var(--wn-link, #2f6feb); }
.wn-pending { opacity: .55; }
.wn-failed { color: var(--wn-need, #d93025); }
.wn-msg.wn-failed { box-shadow: inset 0 0 0 1px var(--wn-need, #d93025); }
.wn-error { font-size: .85em; }

.wn-mark { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; font-size: .92em; }
.wn-mark-label { font-weight: 600; opacity: .8; }
.wn-mark-states { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.wn-mark-state { font: inherit; font-size: .92em; color: inherit; background: transparent; border: 1px solid rgba(128,128,128,.4); border-radius: 999px; padding: 1px 9px; cursor: pointer; }
.wn-mark-state:hover { border-color: rgba(128,128,128,.8); }
.wn-mark-state.wn-on { background: #2f6feb; border-color: #2f6feb; color: #fff; }
.wn-mark-note {
  flex: 1 1 220px; min-width: 0; min-height: 2em; resize: vertical; box-sizing: border-box;
  padding: 4px 8px; border: 1px solid rgba(128,128,128,.4); border-radius: 6px;
  background: transparent; color: inherit; font: inherit;
}
.wn-saved { font-size: .85em; opacity: .7; }
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
`;
