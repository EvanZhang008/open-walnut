/**
 * Page chrome and the two report tabs: tokens, header, tab bar, filters, stat
 * cards, per-task bars, the 7-day trend. The timeline and its three views live in
 * styles-views.ts, and styles.ts joins the two.
 *
 * Two rules shape both files. First, EVERY class is prefixed `wt-`: injected CSS is
 * global while the plugin is mounted, and the console already ships a Time Tracking
 * section whose classes would otherwise collide with these. Second, every colour is
 * a host theme token (or a mix of one), never a hard-coded grey, so the app follows
 * the light and dark themes without knowing which one is on.
 */
export const BASE_CSS = `
.wt-root {
  --wt-human: var(--accent);
  /* iOS purple: reads as "not me" next to the accent, and no task colour uses it. */
  --wt-agent: #af52de;
  --wt-focus: var(--tier-focus, var(--accent));
  /* The trend's non-focus half. --tier-focus resolves to the accent, so a stack of
     accent-on-accent had no visible split; this is the same hue, stepped back. */
  --wt-other: color-mix(in srgb, var(--accent) 42%, var(--fg-muted));
  /* Idle / away. A MIX, not --bg-secondary: in the dark theme that token is
     byte-identical to the card background, so idle time would have no shape and the
     tape's whole "grey = away" idea would silently stop working. */
  --wt-idle: color-mix(in srgb, var(--fg-muted) 14%, transparent);
  /* Aggregated remainder (a bar or a dot). Has to hold its own next to a task colour. */
  --wt-rest: color-mix(in srgb, var(--fg-muted) 45%, transparent);

  box-sizing: border-box;
  max-width: 1240px;
  margin: 0 auto;
  padding: 26px 32px 56px;
  color: var(--fg);
  font-family: inherit;
}

.wt-root *, .wt-root *::before, .wt-root *::after { box-sizing: border-box; }
.wt-root h1 { margin: 4px 0 6px; font-size: 24px; line-height: 1.2; }
.wt-root h2 { margin: 0; font-size: 14px; font-weight: 600; }
.wt-root h4 { margin: 0; }
.wt-root p { margin: 0; }

/* ── Header ── */

.wt-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.wt-header p {
  color: var(--fg-secondary);
  font-size: 13px;
  max-width: 68ch;
}

.wt-kicker {
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.wt-refresh {
  padding: 7px 16px;
  border: 0;
  border-radius: var(--radius-sm, 8px);
  background: var(--accent);
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.wt-refresh:hover:not(:disabled) { background: var(--accent-hover); }
.wt-refresh:disabled { opacity: 0.5; cursor: default; }

/* ── Tabs (the page's own three views) ── */

.wt-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  width: fit-content;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm, 8px);
  margin-bottom: 18px;
}

.wt-tab {
  border: 0;
  background: transparent;
  padding: 7px 18px;
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--fg-secondary);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.wt-tab:hover { color: var(--fg); }

.wt-tab.is-active {
  background: var(--card-bg);
  color: var(--fg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

/* ── Filters ── */

.wt-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 22px;
}

.wt-pills {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm, 8px);
  width: fit-content;
}

.wt-pill {
  border: 0;
  background: transparent;
  padding: 6px 14px;
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
  color: var(--fg-secondary);
  cursor: pointer;
}

.wt-pill:hover { color: var(--fg); }

.wt-pill.is-active {
  background: var(--card-bg);
  color: var(--fg);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.wt-filter-field { display: inline-flex; align-items: center; gap: 6px; }
.wt-filter-label { font-size: 12px; color: var(--fg-secondary); }

.wt-filter-field select {
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--fg);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
}

.wt-degraded {
  margin-bottom: 16px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--warning);
  border-radius: var(--radius-sm, 8px);
  color: var(--fg-secondary);
  font-size: 13px;
}

.wt-empty, .wt-section-hint { font-size: 12px; color: var(--fg-muted); }

/* ── Report stats + bars ── */

.wt-stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  margin-bottom: 22px;
}

.wt-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 16px 18px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 12px);
  min-width: 0;
}

.wt-stat-value {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

/* A task title, not a number: smaller and clipped to one line. */
.wt-stat-value.is-text {
  font-size: 15px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.wt-stat-human .wt-stat-value { color: var(--wt-human); }
.wt-stat-agent .wt-stat-value { color: var(--wt-agent); }
.wt-stat-label { font-size: 12px; color: var(--fg-secondary); }
.wt-stat-hint { font-size: 11px; color: var(--fg-muted); }

/* The parallel-agents caption. Never a headline number. */
.wt-agent-note {
  margin: -10px 0 22px;
  font-size: 12px;
  color: var(--fg-secondary);
}

.wt-section { margin-bottom: 26px; }

.wt-section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}

.wt-bars { display: flex; flex-direction: column; gap: 6px; }

.wt-bar-row {
  display: grid;
  grid-template-columns: minmax(160px, 320px) 1fr 72px;
  align-items: center;
  gap: 14px;
}

.wt-bar-label { display: flex; align-items: center; gap: 6px; min-width: 0; }

.wt-bar-title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
}

.wt-bar-track {
  height: 14px;
  background: color-mix(in srgb, var(--border) 60%, transparent);
  border-radius: 4px;
  overflow: hidden;
}

.wt-bar-fill { height: 100%; border-radius: 4px; }
.wt-bar-fill-human { background: var(--wt-human); }
.wt-bar-fill-agent { background: var(--wt-agent); }

.wt-bar-value {
  text-align: right;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.wt-bar-value-human { color: var(--wt-human); }
.wt-bar-value-agent { color: var(--wt-agent); }

/* ── 7-day trend (plain divs, no chart dependency) ── */

.wt-trend {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  height: 170px;
  padding: 10px 8px 0;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 12px);
}

.wt-trend-day {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  gap: 6px;
}

.wt-trend-stack {
  flex: 1 1 auto;
  width: 100%;
  max-width: 56px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  border-radius: 4px 4px 0 0;
  overflow: hidden;
  background: color-mix(in srgb, var(--border) 45%, transparent);
}

.wt-trend-seg { width: 100%; }
.wt-trend-focus { background: var(--wt-focus); }
.wt-trend-other { background: var(--wt-other); }

.wt-trend-label {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

.wt-trend-day.is-today .wt-trend-label { color: var(--fg); font-weight: 600; }

.wt-legend {
  display: flex;
  gap: 16px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--fg-secondary);
}

.wt-legend-item { display: inline-flex; align-items: center; gap: 6px; }

.wt-swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: 0 0 auto;
}

/* No agent swatch: the reports keep the lanes in separate TABS, and the timeline's
   agent legend has its own hatched .wt-tt-swatch-agent (styles-views.ts). */
.wt-swatch-human { background: var(--wt-other); }
.wt-swatch-focus { background: var(--wt-focus); border-radius: 50%; }
`
