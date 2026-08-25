/**
 * View C, the swimlanes. Shell + the two vertical views: styles-views.ts.
 *
 * The one geometry constant shared with TypeScript is the name column, and it lives
 * HERE as `--wt-lane-name`: the component hands over only the now-line's fraction, so
 * the column's width and the line's offset can never disagree.
 */

export const LANES_CSS = `
/* ══ View C: swimlanes ══ */

/* The name column's width is a TOKEN because the now-line has to be positioned past
   it. Spelling that width in both the CSS and the TS is what lands a now-line an hour
   off in the narrow layout; here only this value exists. */
.wt-tl { --wt-lane-name: 320px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }

.wt-tl-axis {
  display: grid;
  grid-template-columns: var(--wt-lane-name) 1fr;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.wt-tl-hours { position: relative; height: 28px; }

.wt-tl-hours span {
  position: absolute;
  top: 7px;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--fg-muted);
  white-space: nowrap;
}

.wt-tl-rows { position: relative; }

.wt-tl-row {
  display: grid;
  grid-template-columns: var(--wt-lane-name) 1fr;
  border-bottom: 1px solid var(--border);
}

.wt-tl-row:last-child { border-bottom: 0; }

.wt-tl-name {
  padding: 11px 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  border-right: 1px solid var(--border);
}

.wt-tl-dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  flex: none;
  background: var(--wt-rest);
}

/* Titles live here IN FULL (one line, real tooltip) so no bar carries text. */
.wt-tl-nm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
}

.wt-tl-tt {
  color: var(--fg-muted);
  font-weight: 600;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  flex: none;
}

.wt-tl-track { position: relative; height: 46px; }

.wt-tl-grid {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--border);
  opacity: 0.55;
}

.wt-tl-bar {
  position: absolute;
  top: 10px;
  height: 26px;
  border-radius: 6px;
  background: var(--wt-rest);
  /* The real guarantee that a 30-second touch is visible. A percentage floor can
     only ever guess the track's width; this cannot be wrong. */
  min-width: 5px;
}

/* Visual weight tracks time spent: a sub-5-minute touch is a smaller, quieter mark
   rather than a full-height block shouting as loudly as an hour of work. */
.wt-tl-bar.is-tick { top: 17px; height: 12px; border-radius: 4px; opacity: 0.75; }

.wt-tl-row.is-others { background: var(--wt-idle); }
.wt-tl-row.is-agent { background: color-mix(in srgb, var(--wt-agent) 8%, transparent); }
.wt-tl-row.is-agent .wt-tl-dot { background: var(--wt-agent); }

/* Hatched, in the one hue no task colour uses: an agent's runtime must never be
   mistakable for your own working day, even in a grayscale screenshot. */
.wt-tl-row.is-agent .wt-tl-bar {
  background: repeating-linear-gradient(
    45deg,
    color-mix(in srgb, var(--wt-agent) 55%, transparent) 0 4px,
    color-mix(in srgb, var(--wt-agent) 26%, transparent) 4px 8px
  );
}

.wt-tl-now {
  position: absolute;
  top: 0;
  bottom: 0;
  /* The row grid spans the name column, so a bare percentage would put "now" an hour
     or more to the left of the real time. The fraction comes from the component. */
  left: calc(var(--wt-lane-name) + (100% - var(--wt-lane-name)) * var(--wt-now-frac, 0));
  border-left: 2px solid var(--error);
  z-index: 4;
  pointer-events: none;
}
`
