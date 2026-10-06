/**
 * The two slots (task-slots.tsx) and the task page (task-page.tsx).
 *
 * The slots render INSIDE the console's own surfaces, outside `.wt-root`, so they
 * carry their own lane colours (the same two the reports use) and borrow nothing
 * from the page. Every class is `wt-` prefixed, every colour a theme token.
 */
export const TASK_CSS = `
.wt-slot-task, .wt-slot-chip {
  --wt-human: var(--accent);
  --wt-agent: #af52de;
}

/* ── task.detail: one compact table, the whole of it a button ── */

.wt-slot-task {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  width: 100%;
  padding: 8px 10px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  color: var(--fg);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.wt-slot-task:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.wt-slot-task:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.wt-slot-grid {
  display: grid;
  grid-template-columns: auto repeat(3, minmax(52px, auto));
  column-gap: 16px;
  row-gap: 2px;
  align-items: baseline;
  min-width: 0;
}
.wt-slot-cap {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  color: var(--fg-muted);
}
.wt-slot-col { font-size: 11px; color: var(--fg-muted); text-align: right; }
.wt-slot-lane { font-weight: 600; }
.wt-slot-lane.is-human { color: var(--wt-human); }
.wt-slot-lane.is-agent { color: var(--wt-agent); }
.wt-slot-grid .wt-slot-v { text-align: right; font-variant-numeric: tabular-nums; }
.wt-slot-more {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--fg-muted);
  white-space: nowrap;
}
.wt-slot-task:hover .wt-slot-more { color: var(--accent); }

/* ── session.header: one chip, sized like the row's own ── */

.wt-slot-chip {
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
  border-radius: 10px;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  transition: background 0.15s, color 0.15s;
}
.wt-slot-chip:hover { background: var(--accent-subtle, color-mix(in srgb, var(--accent) 12%, transparent)); }
.wt-slot-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.wt-slot-chip .wt-slot-clock { flex-shrink: 0; opacity: 0.85; }
.wt-slot-chip .is-human { color: var(--wt-human); }
.wt-slot-chip .is-agent { color: var(--wt-agent); }
.wt-slot-chip .wt-slot-sep { opacity: 0.6; }

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
