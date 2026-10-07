/**
 * The two slots (task-slots.tsx) and the task page (task-page.tsx).
 *
 * The slot values render INSIDE the console's own surfaces, outside `.wt-root`, so they
 * carry their own lane colours (the same two the reports use) and borrow nothing
 * from the page. Every class is `wt-` prefixed, every colour a theme token.
 */
export const TASK_CSS = `
.wt-fact, .wt-chip {
  --wt-human: var(--accent);
  --wt-agent: #af52de;
}

/* ── task.meta / session.meta: one short value beside the host's label ── */

.wt-fact {
  display: inline;
  padding: 0 4px;
  margin: 0 -4px;
  font: inherit;
  line-height: inherit;
  white-space: nowrap;
  color: inherit;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  transition: background 0.15s;
}
.wt-fact:hover { background: var(--bg-tertiary, color-mix(in srgb, var(--fg) 8%, transparent)); }
.wt-fact:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.wt-fact-v { font-weight: 600; }
.wt-fact-v.is-human { color: var(--wt-human); }
.wt-fact-v.is-agent { color: var(--wt-agent); }
.wt-fact-sep { opacity: 0.6; }

/* ── session.meta pinned to the header: a chip sized like the row's own ── */

.wt-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  font: inherit;
  font-size: 10px;
  font-weight: 500;
  line-height: 1.6;
  white-space: nowrap;
  color: var(--fg-muted);
  background: transparent;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.wt-chip:hover { background: var(--accent-subtle, color-mix(in srgb, var(--accent) 12%, transparent)); }
.wt-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.wt-chip-clock { flex-shrink: 0; opacity: 0.85; }
.wt-chip .wt-fact-v { font-weight: 500; }

/* ── The task page ── */

.wt-task-page .wt-task-head { min-width: 0; }
.wt-task-page h1 { overflow-wrap: anywhere; }
.wt-crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
}
.wt-crumb {
  padding: 0;
  font: inherit;
  font-weight: 600;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  font-size: 11px;
  color: var(--accent);
  background: none;
  border: 0;
  cursor: pointer;
}
.wt-task-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.wt-task-lanes { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.wt-task-lane {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--fg-secondary);
}
.wt-task-lane b { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.wt-task-lane.is-human b { color: var(--wt-human); }
.wt-task-lane.is-agent b { color: var(--wt-agent); }

.wt-task-sessions { display: flex; flex-wrap: wrap; gap: 6px; }
.wt-task-session {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  max-width: 100%;
  padding: 6px 10px;
  font: inherit;
  font-size: 12.5px;
  color: var(--fg);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.wt-task-session:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.wt-task-session.is-active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-elevated));
}
.wt-task-session-name {
  min-width: 0;
  max-width: 34ch;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.wt-task-session-v { display: inline-flex; gap: 4px; font-variant-numeric: tabular-nums; font-size: 11.5px; }
.wt-task-session-v .is-human, .wt-task-day-sessions .is-human { color: var(--wt-human); }
.wt-task-session-v .is-agent, .wt-task-day-sessions .is-agent { color: var(--wt-agent); }

.wt-task-days { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.wt-task-day {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
}
.wt-task-day-row {
  display: grid;
  grid-template-columns: minmax(130px, 170px) 1fr 14px;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 8px 12px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--fg);
  background: none;
  border: 0;
  cursor: pointer;
}
.wt-task-day-row:disabled { cursor: default; color: var(--fg); }
.wt-task-day-date { font-weight: 500; white-space: nowrap; }
.wt-task-day-caret { color: var(--fg-secondary); font-size: 14px; line-height: 1; text-align: center; }

.wt-task-bars { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; min-width: 0; }
.wt-task-bar { display: grid; grid-template-columns: 1fr 64px; align-items: center; gap: 8px; min-width: 0; }
.wt-task-bar i {
  display: block;
  height: 8px;
  border-radius: 4px;
  min-width: 0;
}
.wt-task-bar.is-human i { background: var(--wt-human); }
.wt-task-bar.is-agent i { background: var(--wt-agent); }
.wt-task-bar b { font-weight: 500; font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
.wt-task-bar.is-human b { color: var(--wt-human); }
.wt-task-bar.is-agent b { color: var(--wt-agent); }

.wt-task-day-sessions {
  list-style: none;
  margin: 0;
  padding: 2px 12px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--border);
}
.wt-task-day-sessions li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px 110px;
  gap: 10px;
  align-items: baseline;
  padding-top: 6px;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.wt-task-day-sessions li > span:not(.wt-task-day-session-label) { text-align: right; }
.wt-task-day-session {
  min-width: 0;
  padding: 0;
  font: inherit;
  text-align: left;
  color: var(--fg);
  background: none;
  border: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;
}
.wt-task-day-session:hover { color: var(--accent); text-decoration: underline; }
.wt-task-day-session-label { color: var(--fg-secondary); }

@media (max-width: 720px) {
  .wt-task-day-row { grid-template-columns: 1fr 14px; }
  .wt-task-day-row .wt-task-bars { grid-column: 1 / -1; grid-row: 2; }
  .wt-task-day-sessions li { grid-template-columns: minmax(0, 1fr) auto auto; }
}
`
