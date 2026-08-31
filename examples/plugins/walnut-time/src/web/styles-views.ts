/**
 * The timeline shell (view switcher, totals) and the two VERTICAL views: the tape and
 * the chapters. Page chrome and the reports are in styles-base.ts, the swimlanes in
 * styles-lanes.ts.
 *
 * The `.wt-tt-nav*` rules dress the day nav, which the Overview's scope bar mounts too
 * (day-nav.tsx). They stay here, next to the surface they were designed on, rather than
 * being split across two files the day a second caller appeared.
 *
 * Both vertical views lean on one shared idea: nothing important is written inside a
 * coloured rectangle. A chapter puts its title on a card, so no label is ever
 * truncated to fit a block and a 30-second touch is as readable as an hour.
 *
 * This file also carries the ONE narrow-canvas block for the whole app, and it must
 * stay last in the injected order (styles.ts) so its overrides win.
 */

export const VIEWS_CSS = `
/* ══ Timeline shell ══ */

.wt-tt { display: flex; flex-direction: column; gap: 14px; outline: none; }

.wt-tt:focus-visible {
  box-shadow: 0 0 0 2px var(--accent-subtle);
  border-radius: 10px;
}

.wt-tt-nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.wt-tt-nav-btn, .wt-tt-nav-reset {
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--fg);
  border-radius: 8px;
  height: 28px;
  min-width: 28px;
  padding: 0 9px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.wt-tt-nav-btn:hover:not(:disabled), .wt-tt-nav-reset:hover:not(:disabled) { background: var(--bg-hover); }
.wt-tt-nav-btn:disabled, .wt-tt-nav-reset:disabled { opacity: 0.4; cursor: default; }

.wt-tt-nav-date {
  font-size: 16px;
  font-weight: 650;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.wt-tt-nav-today {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--accent);
  font-style: normal;
}

/* A segmented control: one visible group, not three loose buttons. */
.wt-tt-switch {
  display: inline-flex;
  margin-left: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 2px;
  gap: 2px;
}

.wt-tt-switch-btn {
  border: 0;
  background: transparent;
  color: var(--fg-secondary);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  padding: 5px 12px;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
}

.wt-tt-switch-btn:hover { color: var(--fg); }

.wt-tt-switch-btn.is-active {
  background: var(--bg-elevated);
  color: var(--fg);
  box-shadow: var(--card-shadow);
}

.wt-tt-agents-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--fg-secondary);
  cursor: pointer;
}

.wt-tt-totals {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 13px;
}

.wt-tt-total { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.wt-tt-total-side { color: var(--fg-muted); font-size: 12.5px; }

.wt-tt-swatch { width: 9px; height: 9px; border-radius: 3px; flex: none; }
.wt-tt-swatch-human { background: var(--wt-human); }

.wt-tt-swatch-agent {
  background: repeating-linear-gradient(
    45deg,
    var(--wt-agent) 0 3px,
    color-mix(in srgb, var(--wt-agent) 45%, transparent) 3px 6px
  );
}

.wt-tt-swatch-screen { background: var(--wt-screen); }
.wt-tt-total-screen { color: var(--wt-screen); }

.wt-tt-unplaced { color: var(--fg-muted); font-size: 12px; margin-left: auto; }

/* A full page, not a 740px panel: the plot gets the viewport's height, with a floor
   so a short window still shows a usable slab of the day. */
.wt-tt-scroll {
  overflow-y: auto;
  overflow-x: hidden;
  border-radius: 10px;
  max-height: min(1000px, calc(100vh - 340px));
  min-height: 380px;
}

/* ══ View A: attention tape ══ */

.wt-tp {
  display: grid;
  /* minmax(0,1fr) so a long ranked title can never push the ribbon narrow. The page
     has room the settings panel never had, so the rank column is 320px here. */
  grid-template-columns: 64px minmax(0, 1fr) 320px;
  gap: 0 22px;
  align-items: start;
}

.wt-tp-gutter { position: relative; }

.wt-tp-hour {
  position: absolute;
  right: 8px;
  transform: translateY(-50%);
  font-size: 11px;
  color: var(--fg-muted);
  white-space: nowrap;
}

/* The ribbon. Its BACKGROUND is the idle time: segments are drawn on top of it, so
   "away from the computer" needs no rectangle of its own and no legend entry. */
.wt-tp-ribbon {
  position: relative;
  border-radius: 10px;
  background: var(--wt-idle);
  overflow: hidden;
}

.wt-tp-rule {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px solid var(--border);
  pointer-events: none;
}

.wt-tp-seg {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.15;
  overflow: hidden;
  white-space: nowrap;
  transition: filter 120ms ease, opacity 120ms ease;
}

/* Consecutive segments get a hairline of the ribbon's own light, not a gap: a gap
   would read as idle time that did not happen. This is the one rule that lets a
   burst of switching read as texture instead of a single muddy band. */
.wt-tp-seg.is-joined { border-top: 1px solid rgba(255, 255, 255, 0.55); }

.wt-tp-seg-title {
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
}

.wt-tp-seg small {
  font-weight: 500;
  opacity: 0.88;
  flex: none;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
}

.wt-tp-seg.is-dim { opacity: 0.28; }
.wt-tp-seg.is-lit { filter: brightness(1.1); }

.wt-tp-now {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 2px solid var(--error);
  z-index: 5;
  pointer-events: none;
}

.wt-tp-now i {
  position: absolute;
  left: 0;
  top: -4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--error);
}

.wt-tp-now span {
  position: absolute;
  right: 6px;
  top: -16px;
  font-size: 11px;
  font-weight: 700;
  color: var(--error);
}

/* STICKY, and this is a real fix rather than polish. The ranked list shares the
   ribbon's scroller, and the view lands its scroll near the now-line, so on a tall
   page the list opened already scrolled past its own heading and its three biggest
   rows: the day's answer was off-screen on arrival. */
.wt-tp-rank {
  position: sticky;
  top: 0;
  align-self: start;
}

.wt-tp-rank h4 {
  margin: 2px 0 8px;
  font-size: 11px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--fg-muted);
  font-weight: 700;
}

.wt-tp-rrow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 8px;
  font-size: 13px;
  /* Pinned, not inherited: a 1.5 body line-height made a one-line row 31px tall,
     which is indistinguishable from a wrapped row when measured. */
  line-height: 1.35;
  cursor: default;
}

.wt-tp-rrow:hover, .wt-tp-rrow.is-lit { background: var(--bg-hover); }

.wt-tp-dot { width: 9px; height: 9px; border-radius: 3px; flex: none; }
.wt-tp-dot-quick { background: var(--fg-muted); opacity: 0.5; }

.wt-tp-rname {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.wt-tp-rtime {
  color: var(--fg-muted);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  flex: none;
}

.wt-tp-rrow.is-quick .wt-tp-rname { color: var(--fg-muted); }

.wt-tp-more {
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12.5px;
  padding: 5px 8px;
  cursor: pointer;
  text-align: left;
  display: block;
}

.wt-tp-more:hover { text-decoration: underline; }

/* ══ View B: chapters ══ */

.wt-tc { display: flex; flex-direction: column; gap: 4px; padding-right: 4px; }

/* The same 64px rail as the tape, so switching views does not shift the content
   sideways. It labels the hour a chapter STARTS in, a coarse rail, because the cards
   are a flow and each one prints its own exact range. */
.wt-tc-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 0 22px;
  align-items: start;
}

.wt-tc-hour {
  padding-top: 12px;
  text-align: right;
  font-size: 11px;
  color: var(--fg-muted);
  white-space: nowrap;
}

.wt-tc-idle {
  margin: 4px 0 4px 86px;
  font-size: 11.5px;
  color: var(--fg-muted);
  opacity: 0.75;
}

.wt-tc-card {
  border: 1px solid var(--border);
  background: var(--card-bg);
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.wt-tc-card.is-open {
  border-color: var(--border-strong);
  box-shadow: var(--card-shadow-hover);
}

/* The whole card is the toggle, so the click target is the thing you're reading. */
.wt-tc-head {
  display: grid;
  gap: 7px;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--fg);
  text-align: left;
  padding: 14px 18px;
  cursor: pointer;
  font: inherit;
  align-content: start;
}

.wt-tc-head:hover { background: var(--bg-hover); }

.wt-tc-when {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

.wt-tc-what {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 15px;
  font-weight: 700;
}

.wt-tc-dot { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.wt-tc-glyph { font-style: normal; font-size: 13px; color: var(--fg-muted); flex: none; }

.wt-tc-title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.wt-tc-tag {
  font-style: normal;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  color: var(--accent);
  flex: none;
}

/* The composition bar. Segment widths are the chapter's real shares and always sum
   to it: the remainder is a segment, never a rounding error. */
.wt-tc-comp {
  display: flex;
  height: 10px;
  border-radius: 5px;
  overflow: hidden;
  background: var(--wt-idle);
}

.wt-tc-comp i { display: block; height: 100%; min-width: 2px; }

.wt-tc-parts {
  font-size: 12px;
  color: var(--fg-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.wt-tc-detail { padding: 0 18px 16px; }

/* ── Narrow canvas (a split view, or a phone-width window) ── */

@media (max-width: 1000px) {
  .wt-root { padding: 20px 18px 40px; }

  .wt-tp { grid-template-columns: 48px minmax(0, 1fr); gap: 0 14px; }
  /* One column: the list is BELOW the ribbon here, so pinning it would park a
     full-width block over the tape as you scroll into it. */
  .wt-tp-rank { grid-column: 1 / -1; margin-top: 14px; position: static; }
  .wt-tc-row { grid-template-columns: 48px minmax(0, 1fr); gap: 0 14px; }
  .wt-tc-idle { margin-left: 62px; }
  .wt-tl { --wt-lane-name: 180px; }
  .wt-bar-row { grid-template-columns: minmax(120px, 220px) 1fr 68px; }
}
`
